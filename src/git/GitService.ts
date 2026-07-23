import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);
import { API, Change, GitErrorCodes, GitExtension, Repository, Status } from '../git/git';
import {
	formatGitShellCommand,
	logGitFail,
	logGitOk,
	logGitStart,
	setUserGitLogging,
} from './gitOutput';
import {
	ChangeItem,
	CommitLogItem,
	CommitRepoResult,
	DiffResult,
	RepoSnapshot,
	SyncMode,
	WorkspaceSnapshot,
} from '../panel/messages';
import { PushCommitItem, PushTarget } from '../panel/pushMessages';
import {
	buildLocaleFallbackMessage,
	formatCommitMessageStyle,
	generateCommitMessageWithLanguageModel,
	resolveCommitMessageLocale,
	rewriteCommitMessageForLocale,
	withTemporaryCommitLanguageRule,
} from '../commitMessage/generateCommitMessage';

const MAX_DIFF_BYTES = 1_000_000;

export class PushRejectedError extends Error {
	readonly kind = 'push-rejected' as const;

	constructor(message: string) {
		super(message);
		this.name = 'PushRejectedError';
	}
}

export type SyncResult =
	| { status: 'ok'; mode: SyncMode }
	| { status: 'conflict'; mode: SyncMode; conflicts: ChangeItem[]; message: string }
	| { status: 'failed'; mode: SyncMode; message: string };

export type PullAllResult = {
	succeeded: string[];
	failed: Array<{ repository: string; error: string }>;
};

export class GitService implements vscode.Disposable {
	private api: API | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private repoDisposables: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private lastKnownFileUri: vscode.Uri | undefined;
	private contextUri: vscode.Uri | undefined;
	private activeRepoRoot: string | undefined;
	/** Manual repo pick from the UI; cleared when the focused editor file maps to a repo. */
	private pinnedRepoRoot: string | undefined;
	private fileWatchersSetup = false;
	private editorListenersSetup = false;
	private pendingFolderWatch = false;
	private initState: 'pending' | 'ready' | 'failed' = 'pending';
	private initError = '';

	async init(): Promise<{ ok: true } | { ok: false; error: string }> {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension) {
			this.initState = 'failed';
			this.initError = 'VS Code Git extension is not available.';
			this._onDidChange.fire();
			return { ok: false, error: this.initError };
		}

		if (!extension.isActive) {
			await extension.activate();
		}

		const gitExtension = extension.exports;
		if (!gitExtension.enabled) {
			this.initState = 'failed';
			this.initError = 'VS Code Git extension is disabled. Please enable it to use this panel.';
			this._onDidChange.fire();
			return { ok: false, error: this.initError };
		}

		this.api = gitExtension.getAPI(1);
		this.disposables.push(
			this.api.onDidChangeState(() => {
				this.bindRepositoryEvents();
				this._onDidChange.fire();
			}),
			this.api.onDidOpenRepository(() => {
				this.bindRepositoryEvents();
				this._onDidChange.fire();
			}),
			this.api.onDidCloseRepository(() => {
				this.bindRepositoryEvents();
				this._onDidChange.fire();
			})
		);

		await this.waitForGitApiInitialized();

		this.bindRepositoryEvents();
		this.setupWorkspaceWatchers();

		this.initState = 'ready';
		this._onDidChange.fire();
		return { ok: true };
	}

	markInitFailed(error: string): void {
		this.initState = 'failed';
		this.initError = error;
		this._onDidChange.fire();
	}

	private setupWorkspaceWatchers(): void {
		if (!this.editorListenersSetup) {
			this.editorListenersSetup = true;
			this.disposables.push(
				vscode.window.onDidChangeActiveTextEditor((editor) => {
					if (editor?.document.uri.scheme === 'file') {
						this.rememberFileUri(editor.document.uri);
					}
					this.scheduleRefresh();
				}),
				vscode.workspace.onDidChangeTextDocument((event) => {
					if (event.document.uri.scheme === 'file') {
						this.rememberFileUri(event.document.uri);
						this.scheduleRefresh();
					}
				}),
				vscode.workspace.onDidSaveTextDocument((doc) => {
					if (doc.uri.scheme === 'file') {
						this.scheduleRefresh();
					}
				})
			);
		}

		if (this.fileWatchersSetup) {
			return;
		}

		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			if (!this.pendingFolderWatch) {
				this.pendingFolderWatch = true;
				this.disposables.push(
					vscode.workspace.onDidChangeWorkspaceFolders(() => {
						this.setupWorkspaceWatchers();
					})
				);
			}
			return;
		}

		this.fileWatchersSetup = true;
		for (const folder of folders) {
			const pattern = new vscode.RelativePattern(folder, '**/*');
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			this.disposables.push(
				watcher,
				watcher.onDidChange(() => this.scheduleRefresh()),
				watcher.onDidCreate(() => this.scheduleRefresh()),
				watcher.onDidDelete(() => this.scheduleRefresh())
			);
		}
	}

	/**
	 * Wait until the built-in Git API is ready.
	 * Must re-check state after subscribe to avoid a hang if `initialized`
	 * fired between the initial check and the listener attachment.
	 */
	private async waitForGitApiInitialized(timeoutMs = 15_000): Promise<void> {
		if (!this.api || this.api.state === 'initialized') {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const api = this.api!;
			let settled = false;

			const finish = (err?: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				sub.dispose();
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			};

			const sub = api.onDidChangeState((state) => {
				if (state === 'initialized') {
					finish();
				}
			});

			const timer = setTimeout(() => {
				// Continue with best-effort Git API access; blocking init leaves the
				// Commit webview blank because the extension never finishes activating.
				console.warn(
					'Pink Hunk Git: timed out waiting for Git API initialization; continuing anyway.'
				);
				finish();
			}, timeoutMs);

			// Race: state may have flipped to initialized before the listener ran.
			if (api.state === 'initialized') {
				finish();
			}
		});
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.repoDisposables.forEach((d) => d.dispose());
		this.disposables.forEach((d) => d.dispose());
		this._onDidChange.dispose();
	}

	async runWithUserLogging<T>(fn: () => Promise<T>): Promise<T> {
		setUserGitLogging(true);
		try {
			return await fn();
		} finally {
			setUserGitLogging(false);
		}
	}

	getRepositoryCount(): number {
		return this.api?.repositories.length ?? 0;
	}

	async pullAllRepositories(
		onProgress?: (repository: string, index: number, total: number) => void
	): Promise<PullAllResult> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		const repositories = [...this.api.repositories];
		if (!repositories.length) {
			throw new Error('Current workspace does not contain a Git repository.');
		}

		const result: PullAllResult = { succeeded: [], failed: [] };
		for (const [index, repo] of repositories.entries()) {
			const name = this.repoDisplayName(repo.rootUri.fsPath);
			onProgress?.(name, index + 1, repositories.length);
			try {
				await this.runGitApi(repo, 'pull', '', () => repo.pull());
				await this.runGitApi(repo, 'status', '', () => repo.status().catch(() => undefined));
				result.succeeded.push(name);
			} catch (err) {
				result.failed.push({ repository: name, error: formatGitError(err) });
			}
		}

		this.bindRepositoryEvents();
		this._onDidChange.fire();
		return result;
	}

	/** Call before opening Commit so we keep the repo for the file being edited. */
	rememberEditorContext(): void {
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (uri?.scheme === 'file') {
			this.contextUri = uri;
			this.rememberFileUri(uri);
			const repo = this.api?.getRepository(uri);
			if (repo) {
				this.setActiveRepository(repo.rootUri.fsPath);
			}
		}
	}

	setActiveRepository(root: string): void {
		const repo = this.api?.repositories.find((r) => pathsEqual(r.rootUri.fsPath, root));
		if (!repo) {
			throw new Error('Repository not found in workspace.');
		}
		this.activeRepoRoot = repo.rootUri.fsPath;
		this.pinnedRepoRoot = repo.rootUri.fsPath;
	}

	getActiveRepository(): Repository | undefined {
		this.ensureActiveRepository();
		if (!this.api || !this.activeRepoRoot) {
			return undefined;
		}
		return this.api.repositories.find((r) => pathsEqual(r.rootUri.fsPath, this.activeRepoRoot!));
	}

	getWorkspaceSnapshot(): WorkspaceSnapshot {
		const emptyActive: RepoSnapshot = {
			ok: false,
			rootPath: '',
			name: '',
			staged: [],
			unstaged: [],
			unversioned: [],
		};

		if (!this.api) {
			if (this.initState === 'pending') {
				return {
					ok: false,
					loading: true,
					hint: 'Loading Git...',
					repositories: [],
					active: emptyActive,
				};
			}
			return {
				ok: false,
				error: this.initError || 'VS Code Git extension is not available.',
				repositories: [],
				active: emptyActive,
			};
		}

		const repos = this.api.repositories;
		if (!repos.length) {
			return {
				ok: false,
				error: 'Current folder is not a Git repository.',
				repositories: [],
				active: emptyActive,
			};
		}

		this.ensureActiveRepository();
		const activeRepo = this.getActiveRepository();
		if (!activeRepo) {
			return {
				ok: false,
				error: 'No Git repository selected.',
				repositories: [],
				active: emptyActive,
			};
		}

		const repositories = repos.map((repo) => this.buildSnapshotForRepo(repo));
		const active =
			repositories.find((r) => pathsEqual(r.rootPath, activeRepo.rootUri.fsPath)) ??
			this.buildSnapshotForRepo(activeRepo);

		return {
			ok: true,
			activeRepoRoot: active.rootPath,
			repositories,
			active,
		};
	}

	/** @deprecated use getWorkspaceSnapshot */
	getSnapshot(): RepoSnapshot {
		return this.getWorkspaceSnapshot().active;
	}

	private ensureActiveRepository(): void {
		if (!this.api?.repositories.length) {
			return;
		}

		if (this.pinnedRepoRoot) {
			const pinned = this.api.repositories.find((r) =>
				pathsEqual(r.rootUri.fsPath, this.pinnedRepoRoot!)
			);
			if (pinned) {
				this.activeRepoRoot = pinned.rootUri.fsPath;
				return;
			}
			this.pinnedRepoRoot = undefined;
		}

		const fromEditor = this.repoForUri(vscode.window.activeTextEditor?.document.uri);
		if (fromEditor) {
			this.activeRepoRoot = fromEditor.rootUri.fsPath;
			return;
		}

		const current = this.activeRepoRoot
			? this.api.repositories.find((r) => pathsEqual(r.rootUri.fsPath, this.activeRepoRoot!))
			: undefined;
		if (current) {
			return;
		}

		const resolved = this.resolveRepositoryFromContext();
		if (resolved) {
			this.activeRepoRoot = resolved.rootUri.fsPath;
		}
	}

	private resolveRepositoryFromContext(): Repository | undefined {
		if (!this.api) {
			return undefined;
		}

		const candidates = [
			vscode.window.activeTextEditor?.document.uri,
			this.lastKnownFileUri,
			this.contextUri,
		];
		for (const uri of candidates) {
			const repo = this.repoForUri(uri);
			if (repo) {
				return repo;
			}
		}

		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const repo = this.api.getRepository(folder.uri);
			if (repo) {
				return repo;
			}
		}

		return this.api.repositories[0];
	}

	private buildSnapshotForRepo(repo: Repository): RepoSnapshot {
		const root = repo.rootUri.fsPath;
		const head = repo.state.HEAD;
		const remotes = repo.state.remotes.map((r) => r.name);
		const staged = repo.state.indexChanges.map((c) => this.toChangeItem(c, root, true));

		const untrackedFromGit = [
			...(repo.state.untrackedChanges ?? []),
			...repo.state.workingTreeChanges.filter((c) => c.status === Status.UNTRACKED),
		];
		let unversioned = dedupeByPath(
			untrackedFromGit.map((c) => this.toChangeItem(c, root, false))
		);

		const trackedWorking = repo.state.workingTreeChanges.filter(
			(c) => c.status !== Status.UNTRACKED
		);
		const unstaged = dedupeByPath(
			[...trackedWorking, ...repo.state.mergeChanges]
				.map((c) => this.toChangeItem(c, root, false))
				.filter((item) => !staged.some((s) => pathsEqual(s.path, item.path)))
		);

		const knownPaths = new Set(
			[...staged, ...unstaged, ...unversioned].map((item) => item.path.toLowerCase())
		);
		const untrackedPaths = new Set(
			untrackedFromGit.map((c) =>
				path.relative(root, c.uri.fsPath).replace(/\\/g, '/').toLowerCase()
			)
		);
		const dirtyItems = this.collectDirtyDocuments(root, knownPaths, untrackedPaths);
		const dirtyUnstaged = dirtyItems.filter((item) => item.status !== '?');
		const dirtyUnversioned = dirtyItems.filter((item) => item.status === '?');
		unversioned = dedupeByPath([...unversioned, ...dirtyUnversioned]);

		const allUnstaged = [...unstaged, ...dirtyUnstaged];

		let hint: string | undefined;
		if (dirtyItems.some((item) => item.unsaved)) {
			hint = 'Unsaved edits (tab dot) are listed; save files before commit.';
		}

		const conflictFiles = this.getConflictItems(repo);
		const syncMode = this.detectSyncMode(repo);

		return {
			ok: true,
			hint,
			rootPath: root,
			name: this.repoDisplayName(root),
			branch: head?.name,
			ahead: head?.ahead,
			behind: head?.behind,
			upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
			remotes,
			staged,
			unstaged: allUnstaged,
			unversioned,
			conflictFiles,
			syncMode,
		};
	}

	private repoDisplayName(root: string): string {
		const folder = vscode.workspace.workspaceFolders?.find((f) =>
			pathsEqual(f.uri.fsPath, root)
		);
		if (folder) {
			return folder.name;
		}
		return path.basename(root);
	}

	private countChanges(repo: Repository): number {
		return (
			repo.state.indexChanges.length +
			repo.state.workingTreeChanges.length +
			repo.state.mergeChanges.length +
			(repo.state.untrackedChanges?.length ?? 0)
		);
	}

	async refresh(): Promise<void> {
		if (!this.api?.repositories.length) {
			this.bindRepositoryEvents();
			this._onDidChange.fire();
			return;
		}

		// Note: do NOT call the built-in 'git.refresh' command here. Without a repository
		// argument it opens a "Choose a repository" quick pick in multi-repo workspaces.
		await Promise.all(this.api.repositories.map((repo) => repo.status().catch(() => undefined)));

		this.bindRepositoryEvents();
		this._onDidChange.fire();
	}

	scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			void this.refresh();
		}, 250);
	}

	async stage(fsPath: string): Promise<void> {
		await this.ensureSaved(fsPath);
		const repo = this.requireRepoForFsPath(fsPath);
		await this.runGitApi(repo, 'add', this.formatPaths([fsPath]), () => repo.add([fsPath]));
	}

	async unstage(fsPath: string): Promise<void> {
		const repo = this.requireRepoForFsPath(fsPath);
		await this.runGitApi(repo, 'revert (unstage)', this.formatPaths([fsPath]), () =>
			repo.revert([fsPath])
		);
	}

	/** Apply Commit-panel checkboxes to the Git index right before committing. */
	async applyCommitSelection(
		checked: Array<{ repoRoot: string; path: string }>
	): Promise<void> {
		const workspace = this.getWorkspaceSnapshot();
		if (!workspace.ok) {
			throw new Error(workspace.error ?? 'Repository unavailable');
		}

		for (const snap of workspace.repositories) {
			if (!snap.ok) {
				continue;
			}

			const checkedSet = new Set(
				checked
					.filter((entry) => pathsEqual(entry.repoRoot, snap.rootPath))
					.map((entry) => entry.path.toLowerCase())
			);
			const changes = this.getTrackedChangeItems(snap);
			const repo = this.requireRepoByRoot(snap.rootPath);
			const toStage: string[] = [];
			const toUnstage: string[] = [];

			for (const item of changes) {
				const include = checkedSet.has(item.path.toLowerCase());
				if (include && !item.staged) {
					toStage.push(item.fsPath);
				} else if (!include && item.staged) {
					toUnstage.push(item.fsPath);
				}
			}

			if (toStage.length) {
				for (const fsPath of toStage) {
					await this.ensureSaved(fsPath);
				}
				await this.runGitApi(repo, 'add', this.formatPaths(toStage), () => repo.add(toStage));
			}
			if (toUnstage.length) {
				await this.runGitApi(repo, 'revert (unstage)', this.formatPaths(toUnstage), () =>
					repo.revert(toUnstage)
				);
			}
		}
	}

	/**
	 * Recent commit history for the Commit Log panel (follows selected repository).
	 */
	async getCommitLog(
		repoRoot?: string,
		limit = 40
	): Promise<{
		repoRoot: string;
		repoName: string;
		branch?: string;
		commits: CommitLogItem[];
	}> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		const root = repo.rootUri.fsPath;
		const name = path.basename(root);
		const branch = repo.state.HEAD?.name;
		const max = Math.max(1, Math.min(limit, 100));
		try {
			const raw = await this.queryGit(root, [
				'log',
				'-n',
				String(max),
				'--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%D',
				'--date=short',
			]);
			return { repoRoot: root, repoName: name, branch, commits: parseCommitLog(raw) };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to load commit log: ${detail}`);
		}
	}

	/** Open the selected commit's changes (multi-diff when available, otherwise patch preview). */
	async openCommitChanges(repoRoot: string, hash: string): Promise<void> {
		const repo = this.requireRepoByRoot(repoRoot);
		const commit = hash.trim();
		if (!commit) {
			throw new Error('Commit hash is empty.');
		}

		try {
			await vscode.commands.executeCommand('git.viewCommit', repo.rootUri, commit);
			return;
		} catch {
			// Fall through to patch preview when the built-in command is unavailable.
		}

		const patch = await this.queryGit(repo.rootUri.fsPath, [
			'show',
			'--stat',
			'--patch',
			'--format=fuller',
			commit,
		]);
		const doc = await vscode.workspace.openTextDocument({
			content: patch || `(empty commit ${commit})`,
			language: 'diff',
		});
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
	}

	async getCommitMessageText(repoRoot: string, hash: string): Promise<string> {
		const commit = hash.trim();
		if (!commit) {
			throw new Error('Commit hash is empty.');
		}
		const message = await this.queryGit(repoRoot, ['log', '-1', '--pretty=format:%B', commit]);
		return message.replace(/\s+$/u, '');
	}

	/**
	 * Generate a commit message for the current selection.
	 * 1) vscode.lm when available (VS Code + Copilot)
	 * 2) Cursor/Copilot SCM command with a temporary `.cursorrules` language hint
	 * 3) Locale fallback (Chinese summary) if AI still returns the wrong language
	 */
	async generateCommitMessageWithAi(
		checkedChanges: Array<{ repoRoot: string; path: string }>,
		unversionedPaths?: Array<{ repoRoot: string; path: string }>
	): Promise<string> {
		const repo = this.resolveRepoForGenerate(checkedChanges, unversionedPaths);
		if (!repo) {
			throw new Error('No repository found.');
		}

		const relativePaths = [
			...checkedChanges
				.filter((entry) => pathsEqual(entry.repoRoot, repo.rootUri.fsPath))
				.map((entry) => entry.path),
			...(unversionedPaths ?? [])
				.filter((entry) => pathsEqual(entry.repoRoot, repo.rootUri.fsPath))
				.map((entry) => entry.path),
		];

		try {
			const viaLm = await generateCommitMessageWithLanguageModel(repo, relativePaths);
			if (viaLm?.trim()) {
				const normalized = this.ensureLocaleCommitMessage(viaLm.trim(), relativePaths);
				repo.inputBox.value = normalized;
				return normalized;
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (typeof vscode.lm?.selectChatModels === 'function') {
				const models = await Promise.resolve(vscode.lm.selectChatModels()).catch(() => []);
				if (models.length) {
					throw new Error(`Failed to generate commit message: ${detail}`);
				}
			}
		}

		const viaScm = await withTemporaryCommitLanguageRule(repo.rootUri.fsPath, () =>
			this.generateCommitMessageViaScmCommand(repo)
		);
		const normalized = this.ensureLocaleCommitMessage(viaScm.trim(), relativePaths);
		repo.inputBox.value = normalized;
		return normalized;
	}

	private ensureLocaleCommitMessage(message: string, relativePaths: string[]): string {
		const locale = resolveCommitMessageLocale();
		let text = message.trim();
		if (locale.wantsCjk && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text)) {
			text = buildLocaleFallbackMessage(relativePaths, text) ?? text;
		}
		return formatCommitMessageStyle(text, relativePaths);
	}

	private async generateCommitMessageViaScmCommand(repo: Repository): Promise<string> {
		const commandId = await this.resolveGenerateCommitMessageCommand();
		if (!commandId) {
			throw new Error(
				'Generate Commit Message requires Cursor, or GitHub Copilot in VS Code.'
			);
		}

		const previous = repo.inputBox.value;
		const sentinel = `__pink_hunk_git_generating_${Date.now()}__`;
		repo.inputBox.value = sentinel;

		try {
			await vscode.commands.executeCommand(commandId, repo.rootUri);
		} catch (err) {
			if (repo.inputBox.value === sentinel) {
				repo.inputBox.value = previous;
			}
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to generate commit message: ${detail}`);
		}

		const generated = await this.waitForGeneratedCommitMessage(repo, sentinel, previous);
		if (!generated.trim()) {
			throw new Error('No commit message was generated. Ensure there are staged changes.');
		}
		const rewritten = await rewriteCommitMessageForLocale(generated);
		if (rewritten?.trim()) {
			return rewritten.trim();
		}
		return generated;
	}

	private resolveRepoForGenerate(
		checkedChanges: Array<{ repoRoot: string; path: string }>,
		unversionedPaths?: Array<{ repoRoot: string; path: string }>
	): Repository | undefined {
		const roots = [
			...checkedChanges.map((entry) => entry.repoRoot),
			...(unversionedPaths ?? []).map((entry) => entry.repoRoot),
		];
		const active = this.getActiveRepository();
		if (active && roots.some((root) => pathsEqual(root, active.rootUri.fsPath))) {
			return active;
		}
		const preferred = roots[0];
		if (preferred) {
			const match = this.api?.repositories.find((r) => pathsEqual(r.rootUri.fsPath, preferred));
			if (match) {
				return match;
			}
		}
		return active ?? this.api?.repositories[0];
	}

	private async resolveGenerateCommitMessageCommand(): Promise<string | undefined> {
		const commands = await vscode.commands.getCommands(true);
		const cursorCmd = 'cursor.generateGitCommitMessage';
		const copilotCmd = 'github.copilot.git.generateCommitMessage';
		if (commands.includes(cursorCmd)) {
			return cursorCmd;
		}
		if (commands.includes(copilotCmd)) {
			return copilotCmd;
		}
		return undefined;
	}

	private async waitForGeneratedCommitMessage(
		repo: Repository,
		sentinel: string,
		previous: string,
		timeoutMs = 800
	): Promise<string> {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const current = repo.inputBox.value;
			if (current !== sentinel) {
				return current;
			}
			await delay(100);
		}
		if (repo.inputBox.value === sentinel) {
			repo.inputBox.value = previous;
		}
		throw new Error(
			'Failed to generate commit message. Check the notification for details, or try again from the Source Control view.'
		);
	}

	private getTrackedChangeItems(snap: RepoSnapshot): ChangeItem[] {
		const map = new Map<string, ChangeItem>();
		for (const item of snap.unstaged) {
			if (item.status === '?') {
				continue;
			}
			map.set(item.path.toLowerCase(), { ...item, staged: false });
		}
		for (const item of snap.staged) {
			map.set(item.path.toLowerCase(), { ...item, staged: true });
		}
		return [...map.values()];
	}

	async stageAll(stage: boolean): Promise<void> {
		const workspace = this.getWorkspaceSnapshot();
		if (!workspace.ok) {
			throw new Error(workspace.error ?? 'Repository unavailable');
		}

		for (const snap of workspace.repositories) {
			if (!snap.ok) {
				continue;
			}
			const repo = this.requireRepoByRoot(snap.rootPath);
			if (stage) {
				// Unversioned files must be added via right-click "Add to Git".
				for (const item of snap.unstaged) {
					if (item.unsaved) {
						await this.ensureSaved(item.fsPath);
					}
				}
				const paths = snap.unstaged.map((c) => c.fsPath);
				if (paths.length) {
					await this.runGitApi(repo, 'add', this.formatPaths(paths), () => repo.add(paths));
				}
			} else if (snap.staged.length) {
				const paths = snap.staged.map((c) => c.fsPath);
				await this.runGitApi(repo, 'revert (unstage all)', this.formatPaths(paths), () =>
					repo.revert(paths)
				);
			}
		}
	}

	/** Stage tracked Changes only (exclude Unversioned Files). Used by Ctrl+K open. */
	async stageTrackedChanges(): Promise<void> {
		const workspace = this.getWorkspaceSnapshot();
		if (!workspace.ok) {
			return;
		}

		for (const snap of workspace.repositories) {
			if (!snap.ok || !snap.unstaged.length) {
				continue;
			}
			const repo = this.requireRepoByRoot(snap.rootPath);
			for (const item of snap.unstaged) {
				if (item.unsaved) {
					await this.ensureSaved(item.fsPath);
				}
			}
			await this.runGitApi(
				repo,
				'add (tracked changes)',
				this.formatPaths(snap.unstaged.map((c) => c.fsPath)),
				() => repo.add(snap.unstaged.map((c) => c.fsPath))
			);
		}
	}

	/**
	 * Commit staged changes in every repo that has checked files (same message).
	 */
	async commitAllStaged(message: string): Promise<CommitRepoResult[]> {
		const trimmed = message.trim();
		if (!trimmed) {
			throw new Error('Commit message cannot be empty.');
		}

		const workspace = this.getWorkspaceSnapshot();
		if (!workspace.ok) {
			throw new Error(workspace.error ?? 'Repository unavailable');
		}

		const targets = workspace.repositories.filter((r) => r.ok && r.staged.length > 0);
		if (!targets.length) {
			throw new Error('No files selected for commit.');
		}

		const committed: CommitRepoResult[] = [];
		for (const snap of targets) {
			const repo = this.requireRepoByRoot(snap.rootPath);
			const detail = `message="${this.summarizeCommitMessage(trimmed)}"`;
			await this.runGitApi(repo, 'commit', detail, () =>
				repo.commit(trimmed, { postCommitCommand: null })
			);
			committed.push({ name: snap.name, rootPath: snap.rootPath, branch: snap.branch });
		}
		return committed;
	}

	async commit(message: string): Promise<CommitRepoResult[]> {
		return this.commitAllStaged(message);
	}

	async push(repoRoot?: string, options?: { pushTags?: boolean }): Promise<void> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		// Keep the rejected repo pinned so Merge / Rebase / retry Push stay on the same repo.
		this.setActiveRepository(repo.rootUri.fsPath);
		const pushDetail = this.describePush(repo);
		const pushTags = !!options?.pushTags;
		const ahead = repo.state.HEAD?.ahead ?? 0;

		try {
			if (ahead === 0) {
				if (pushTags) {
					await this.pushAllTags(repo.rootUri.fsPath);
					return;
				}
				await this.runGitApi(repo, 'push', pushDetail, () => repo.push());
				return;
			}

			if (pushTags && this.canPushBranchWithTags(repo)) {
				const head = repo.state.HEAD!;
				const remote = head.upstream!.remote;
				const branch = head.name!;
				const upstreamBranch = head.upstream!.name;
				await this.runGitApi(
					repo,
					'push (with tags)',
					`${branch} -> ${remote}/${upstreamBranch} + tags`,
					() => this.execGit(repo.rootUri.fsPath, ['push', remote, branch, '--tags'])
				);
			} else {
				await this.runGitApi(repo, 'push', pushDetail, () => repo.push());
				if (pushTags) {
					await this.pushAllTags(repo.rootUri.fsPath);
				}
			}
		} catch (err) {
			if (isPushRejectedError(err)) {
				this.setActiveRepository(repo.rootUri.fsPath);
				throw new PushRejectedError(formatGitError(err));
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	/** Create a lightweight tag at the current HEAD of the repository. */
	async createTagAtHead(repoRoot: string, tagName: string): Promise<void> {
		const repo = this.requireRepoByRoot(repoRoot);
		const name = tagName.trim();
		if (!name) {
			throw new Error('Tag name cannot be empty.');
		}
		if (!isValidTagName(name)) {
			throw new Error(`Invalid tag name: ${name}`);
		}

		await this.runGitApi(repo, 'tag', name, async () => {
			await this.execGit(repo.rootUri.fsPath, ['tag', name]);
		});
		this._onDidChange.fire();
	}

	private canPushBranchWithTags(repo: Repository): boolean {
		const head = repo.state.HEAD;
		return !!(head?.upstream && head.name);
	}

	/** Push all local tags to the default / upstream remote. */
	private async pushAllTags(repoRoot: string): Promise<void> {
		const repo = this.requireRepoByRoot(repoRoot);
		const remotes = repo.state.remotes.map((r) => r.name);
		const upstreamRemote = repo.state.HEAD?.upstream?.remote;
		const remote =
			upstreamRemote ||
			(remotes.includes('origin') ? 'origin' : remotes[0]);
		const args = remote ? ['push', remote, '--tags'] : ['push', '--tags'];
		await this.execGit(repoRoot, args);
	}

	getPushContext(): {
		repoName: string;
		branch?: string;
		upstream?: string;
		ahead?: number;
		behind?: number;
	} {
		const snap = this.getSnapshot();
		return {
			repoName: snap.name,
			branch: snap.branch,
			upstream: snap.upstream,
			ahead: snap.ahead,
			behind: snap.behind,
		};
	}

	/** Build push targets with commits ahead of upstream for the Push dialog. */
	async getPushTargets(options?: {
		repoRoots?: string[];
		activeRepoRoot?: string;
		skipRefresh?: boolean;
	}): Promise<PushTarget[]> {
		if (!options?.skipRefresh) {
			await this.refresh();
		}
		const workspace = this.getWorkspaceSnapshot();
		const activeRoot = options?.activeRepoRoot ?? workspace.activeRepoRoot ?? workspace.active.rootPath;
		const requested = options?.repoRoots?.length ? options.repoRoots : undefined;

		let repos = workspace.repositories.filter((r) => r.ok && r.rootPath);
		if (requested?.length) {
			const wanted = new Set(requested.map((r) => r.replace(/\\/g, '/').toLowerCase()));
			repos = repos.filter((r) => wanted.has(r.rootPath.replace(/\\/g, '/').toLowerCase()));
		}

		const targets: PushTarget[] = [];
		for (const snap of repos) {
			targets.push(await this.buildPushTarget(snap));
		}
		return targets;
	}

	private async buildPushTarget(
		snap: RepoSnapshot
	): Promise<PushTarget> {
		const repo = this.requireRepoByRoot(snap.rootPath);
		const head = repo.state.HEAD;
		const branch = head?.name;
		const upstream = snap.upstream;
		const { remote, upstreamBranch } = parseUpstream(upstream, head?.upstream);

		const label =
			branch && remote && upstreamBranch
				? `${branch} \u2192 ${remote} : ${upstreamBranch}`
				: branch && upstream
					? `${branch} \u2192 ${upstream}`
					: branch ?? snap.name;

		let commits: PushCommitItem[] = [];
		if (head?.upstream) {
			try {
				const raw = await this.queryGit(snap.rootPath, [
					'log',
					`${head.upstream.remote}/${head.upstream.name}..HEAD`,
					'--pretty=format:%H|%h|%s|%an|%ad',
					'--date=short',
				]);
				commits = parsePushCommits(raw);
			} catch {
				commits = [];
			}
		}

		return {
			repoRoot: snap.rootPath,
			repoName: snap.name,
			branch,
			upstream,
			remote,
			upstreamBranch,
			ahead: snap.ahead,
			behind: snap.behind,
			label,
			commits,
		};
	}

	private async queryGit(cwd: string, args: string[]): Promise<string> {
		const command = formatGitShellCommand(args);
		logGitStart(cwd, command);
		const started = Date.now();
		try {
			const { stdout, stderr } = await execFile('git', args, {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
				env: process.env,
			});
			const output = combineGitOutput(stdout, stderr);
			logGitOk(Date.now() - started, output);
			return bufferToString(stdout).trim();
		} catch (err) {
			const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string; code?: number };
			const stderr = bufferToString(e.stderr).trim();
			const stdout = bufferToString(e.stdout).trim();
			const output = combineGitOutput(stdout, stderr);
			logGitFail(err, Date.now() - started, output);
			if (e.code === 128 && /unknown revision|bad revision|no upstream/i.test(stderr || stdout)) {
				return '';
			}
			throw new Error(stderr || stdout || e.message || String(err));
		}
	}

	/** Commits on upstream that are not in HEAD (incoming when push is rejected). */
	async getIncomingCommits(repoRoot?: string): Promise<PushCommitItem[]> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		const head = repo.state.HEAD;
		if (!head?.upstream) {
			return [];
		}
		const root = repo.rootUri.fsPath;
		const upstreamRef = `${head.upstream.remote}/${head.upstream.name}`;
		try {
			await this.execGit(root, ['fetch', head.upstream.remote, head.upstream.name]);
		} catch {
			// Continue with possibly stale remote-tracking refs.
		}
		try {
			const raw = await this.queryGit(root, [
				'log',
				`HEAD..${upstreamRef}`,
				'--pretty=format:%H|%h|%s|%an|%ad',
				'--date=short',
			]);
			return parsePushCommits(raw);
		} catch {
			return [];
		}
	}

	/** Local tracked changes that would be overwritten by merging upstream. */
	async getMergeBlockers(repoRoot?: string): Promise<string[]> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		const head = repo.state.HEAD;
		if (!head?.upstream) {
			return [];
		}
		const root = repo.rootUri.fsPath;
		const upstreamRef = `${head.upstream.remote}/${head.upstream.name}`;
		const localChanged = new Set<string>();
		for (const change of [...repo.state.indexChanges, ...repo.state.workingTreeChanges]) {
			if (change.status === Status.UNTRACKED) {
				continue;
			}
			localChanged.add(path.relative(root, change.uri.fsPath).replace(/\\/g, '/'));
		}

		let incomingChanged: string[] = [];
		try {
			const raw = await this.queryGit(root, ['diff', '--name-only', 'HEAD', upstreamRef]);
			incomingChanged = raw
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean);
		} catch {
			return [];
		}

		return incomingChanged.filter((file) => localChanged.has(file));
	}

	async syncWithUpstream(mode: SyncMode, repoRoot?: string): Promise<SyncResult> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		this.setActiveRepository(repo.rootUri.fsPath);
		this.requireUpstreamName(repo);

		try {
			await this.pullUpstream(repo, mode);
		} catch (err) {
			await repo.status().catch(() => undefined);
			const conflicts = this.getConflictItems(repo);
			if (conflicts.length || isConflictError(err)) {
				return {
					status: 'conflict',
					mode,
					conflicts: conflicts.length ? conflicts : this.getConflictItems(repo),
					message: formatGitError(err),
				};
			}
			return {
				status: 'failed',
				mode,
				message: formatGitError(err),
			};
		}

		return this.finalizeSyncResult(repo, mode);
	}

	async continueSync(repoRoot?: string): Promise<SyncResult> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		this.setActiveRepository(repo.rootUri.fsPath);
		const mode = this.detectSyncMode(repo) ?? 'merge';
		const remaining = this.getConflictItems(repo);
		if (remaining.length) {
			throw new Error(`${remaining.length} unresolved conflict file(s) remain.`);
		}

		const root = repo.rootUri.fsPath;
		try {
			if (mode === 'rebase') {
				await this.execGit(
					root,
					['-c', 'core.editor=true', '-c', 'sequence.editor=true', 'rebase', '--continue'],
					{ GIT_EDITOR: 'true', EDITOR: 'true' }
				);
			} else {
				await this.execGit(root, ['commit', '--no-edit']);
			}
		} catch (err) {
			await repo.status().catch(() => undefined);
			const conflicts = this.getConflictItems(repo);
			if (conflicts.length || isConflictError(err)) {
				return {
					status: 'conflict',
					mode,
					conflicts,
					message: formatGitError(err),
				};
			}
			throw err instanceof Error ? err : new Error(String(err));
		}

		return this.finalizeSyncResult(repo, mode);
	}

	async abortSync(repoRoot?: string): Promise<void> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		this.setActiveRepository(repo.rootUri.fsPath);
		const mode = this.detectSyncMode(repo);
		const root = repo.rootUri.fsPath;

		if (mode === 'rebase' || repo.state.rebaseCommit) {
			await this.execGit(root, ['rebase', '--abort']);
			return;
		}

		if (typeof repo.mergeAbort === 'function') {
			await this.runGitApi(repo, 'mergeAbort', '', () => repo.mergeAbort!());
			return;
		}

		await this.execGit(root, ['merge', '--abort']);
	}

	private async finalizeSyncResult(repo: Repository, mode: SyncMode): Promise<SyncResult> {
		await repo.status().catch(() => undefined);
		const conflicts = this.getConflictItems(repo);
		if (conflicts.length) {
			return {
				status: 'conflict',
				mode,
				conflicts,
				message:
					mode === 'merge'
						? 'Merge produced conflicts. Resolve them, then continue.'
						: 'Rebase produced conflicts. Resolve them, then continue.',
			};
		}

		const behind = repo.state.HEAD?.behind;
		if (typeof behind === 'number' && behind > 0) {
			const modeLabel = mode === 'merge' ? 'Merge' : 'Rebase';
			return {
				status: 'failed',
				mode,
				message: `Still ${behind} commit(s) behind remote after ${modeLabel}. Cannot push. Check upstream branch or network and retry.`,
			};
		}

		return { status: 'ok', mode };
	}

	async openConflictFile(relativePath: string, repoRoot?: string): Promise<void> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		const fsPath = path.join(repo.rootUri.fsPath, relativePath);
		const uri = vscode.Uri.file(fsPath);

		try {
			await vscode.commands.executeCommand('git.openMergeEditor', uri);
			return;
		} catch {
			// Fall through to plain editor
		}

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	/**
	 * Resolve a merge/rebase conflict by taking one side.
	 * "yours" = local branch changes; "theirs" = incoming/upstream changes.
	 */
	async resolveConflictSide(
		relativePath: string,
		side: 'yours' | 'theirs',
		mode: SyncMode,
		repoRoot?: string
	): Promise<void> {
		const repo = repoRoot ? this.requireRepoByRoot(repoRoot) : this.requireActiveRepo();
		this.setActiveRepository(repo.rootUri.fsPath);
		const root = repo.rootUri.fsPath;
		const gitSide = mode === 'rebase'
			? side === 'yours' ? '--theirs' : '--ours'
			: side === 'yours' ? '--ours' : '--theirs';
		const label = side === 'yours' ? 'yours' : 'theirs';

		await this.runGitApi(repo, 'resolve conflict', `${label} ${relativePath}`, async () => {
			await this.execGit(root, ['checkout', gitSide, '--', relativePath]);
			await this.execGit(root, ['add', '--', relativePath]);
		});
		await repo.status().catch(() => undefined);
		this._onDidChange.fire();
	}

	getConflictSnapshot(): { mode?: SyncMode; conflicts: ChangeItem[] } {
		const repo = this.requireActiveRepo();
		return {
			mode: this.detectSyncMode(repo),
			conflicts: this.getConflictItems(repo),
		};
	}

	/**
	 * Pull from the tracked upstream with an explicit merge/rebase strategy.
	 * Prefer `git pull` over separate fetch+merge so remote-tracking refs and
	 * ahead/behind stay consistent (avoids false "already up to date").
	 */
	private async pullUpstream(repo: Repository, mode: SyncMode): Promise<void> {
		const head = repo.state.HEAD;
		if (!head?.upstream) {
			throw new Error('Current branch has no upstream. Set a tracking branch before syncing.');
		}
		const remote = head.upstream.remote;
		const remoteBranch = head.upstream.name;
		const args =
			mode === 'rebase'
				? ['pull', '--rebase', remote, remoteBranch]
				: ['pull', '--no-rebase', remote, remoteBranch];
		await this.execGit(repo.rootUri.fsPath, args);
	}

	private requireUpstreamName(repo: Repository): string {
		const head = repo.state.HEAD;
		if (!head?.upstream) {
			throw new Error('Current branch has no upstream. Set a tracking branch before syncing.');
		}
		return `${head.upstream.remote}/${head.upstream.name}`;
	}

	private detectSyncMode(repo: Repository): SyncMode | undefined {
		if (repo.state.rebaseCommit) {
			return 'rebase';
		}
		if (repo.state.mergeChanges.length) {
			return 'merge';
		}
		return undefined;
	}

	private getConflictItems(repo: Repository): ChangeItem[] {
		const root = repo.rootUri.fsPath;
		return dedupeByPath(
			repo.state.mergeChanges.map((c) => {
				const item = this.toChangeItem(c, root, false);
				item.conflict = true;
				item.status = conflictStatusLetter(c.status);
				return item;
			})
		);
	}

	async openDiffInEditor(relativePath: string, _staged: boolean, repoRoot?: string): Promise<void> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		const repo = this.requireRepoByRoot(repoRoot);
		const root = repo.rootUri.fsPath;
		const fsPath = path.join(root, relativePath);
		const fileUri = vscode.Uri.file(fsPath);
		await this.ensureSaved(fsPath);

		const fileName = path.basename(relativePath);
		const title = `Commit: ${fileName}`;
		const diffOptions: vscode.TextDocumentShowOptions = {
			preview: false,
			preserveFocus: false,
			viewColumn: vscode.ViewColumn.Active,
		};

		// IDEA Commit diff: left = before (HEAD), right = current working version.
		const before = this.api.toGitUri(fileUri, 'HEAD');
		await vscode.commands.executeCommand('vscode.diff', before, fileUri, title, diffOptions);
	}

	async rollbackFile(relativePath: string, repoRoot: string): Promise<void> {
		const repo = this.requireRepoByRoot(repoRoot);
		const fsPath = path.join(repo.rootUri.fsPath, relativePath);

		if (this.isUntracked(relativePath, repoRoot)) {
			await this.runGitApi(repo, 'clean (untracked)', relativePath, () => repo.clean([fsPath]));
			await this.refresh();
			return;
		}

		await this.discardFileToHead(repo, relativePath, fsPath);
		await this.refresh();
	}

	isUntracked(relativePath: string, repoRoot: string): boolean {
		const repo = this.requireRepoByRoot(repoRoot);
		const snap = this.buildSnapshotForRepo(repo);
		return snap.unversioned.some((i) => pathsEqual(i.path, relativePath));
	}

	private async discardFileToHead(repo: Repository, relativePath: string, fsPath: string): Promise<void> {
		const restoreFn = (repo as Repository & { restore?: typeof repo.restore }).restore;
		if (typeof restoreFn === 'function') {
			try {
				await this.runGitApi(repo, 'restore (staged)', relativePath, () =>
					restoreFn.call(repo, [fsPath], { staged: true, ref: 'HEAD' })
				);
				await this.runGitApi(repo, 'restore (working tree)', relativePath, () =>
					restoreFn.call(repo, [fsPath], { ref: 'HEAD' })
				);
				return;
			} catch {
				// Fall through to git checkout / clean
			}
		}

		try {
			await this.execGit(repo.rootUri.fsPath, ['checkout', 'HEAD', '--', relativePath]);
		} catch {
			await this.runGitApi(repo, 'clean', relativePath, () => repo.clean([fsPath]));
		}
	}

	private async runGitApi<T>(
		repo: Repository,
		operation: string,
		detail: string,
		fn: () => Promise<T>
	): Promise<T> {
		const repoRoot = repo.rootUri.fsPath;
		const command = detail
			? `vscode:${operation} ${detail}`
			: `vscode:${operation}`;
		logGitStart(repoRoot, command);
		const started = Date.now();
		try {
			const result = await fn();
			logGitOk(Date.now() - started);
			return result;
		} catch (err) {
			logGitFail(err, Date.now() - started);
			throw err;
		}
	}

	private formatPaths(paths: string[]): string {
		if (!paths.length) {
			return '';
		}
		if (paths.length === 1) {
			return paths[0];
		}
		return `${paths.length} files`;
	}

	private summarizeCommitMessage(message: string): string {
		const oneLine = message.replace(/\s+/g, ' ').trim();
		if (oneLine.length <= 80) {
			return oneLine;
		}
		return `${oneLine.slice(0, 77)}...`;
	}

	private describePush(repo: Repository): string {
		const head = repo.state.HEAD;
		const branch = head?.name ?? '(detached)';
		const upstream = head?.upstream
			? `${head.upstream.remote}/${head.upstream.name}`
			: '(no upstream)';
		return `${branch} -> ${upstream}`;
	}

	private async execGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
		const command = formatGitShellCommand(args);
		logGitStart(cwd, command);
		const started = Date.now();
		try {
			const { stdout, stderr } = await execFile('git', args, {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
				env: env ? { ...process.env, ...env } : process.env,
			});
			const output = combineGitOutput(stdout, stderr);
			logGitOk(Date.now() - started, output);
		} catch (err) {
			const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
			const stderr = bufferToString(e.stderr).trim();
			const stdout = bufferToString(e.stdout).trim();
			const output = combineGitOutput(stdout, stderr);
			logGitFail(err, Date.now() - started, output);
			throw new Error(stderr || stdout || e.message || String(err));
		}
	}

	async openRollbackDiff(relativePath: string, repoRoot: string): Promise<void> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		const repo = this.requireRepoByRoot(repoRoot);
		const fsPath = path.join(repo.rootUri.fsPath, relativePath);
		const fileUri = vscode.Uri.file(fsPath);
		await this.ensureSaved(fsPath);

		const head = this.api.toGitUri(fileUri, 'HEAD');
		const title = `${relativePath} (Rollback preview)`;
		await vscode.commands.executeCommand('vscode.diff', head, fileUri, title);
	}

	async getDiff(relativePath: string, staged: boolean, repoRoot?: string): Promise<DiffResult> {
		const repo = this.requireRepoByRoot(repoRoot);
		const root = repo.rootUri.fsPath;
		const fsPath = path.join(root, relativePath);

		try {
			if (staged) {
				const unified = await repo.diffIndexWithHEAD(relativePath);
				if (!unified || !unified.trim()) {
					return { path: relativePath, staged, kind: 'empty', message: 'No staged diff for this file.' };
				}
				if (Buffer.byteLength(unified, 'utf8') > MAX_DIFF_BYTES) {
					return { path: relativePath, staged, kind: 'too-large', message: 'Diff is larger than 1MB and was not rendered.' };
				}
				if (looksBinary(unified)) {
					return { path: relativePath, staged, kind: 'binary', message: 'Binary file diff is not shown.' };
				}
				return { path: relativePath, staged, kind: 'text', unified };
			}

			const workingExists = await fileExists(fsPath);
			const openDoc = vscode.workspace.textDocuments.find((d) => pathsEqual(d.uri.fsPath, fsPath));
			const useEditorText = openDoc?.isDirty === true;

			let indexText = '';
			let hasIndex = true;
			try {
				indexText = await repo.show('', relativePath);
			} catch {
				hasIndex = false;
			}

			if (!workingExists && !hasIndex && !useEditorText) {
				return { path: relativePath, staged, kind: 'missing', message: 'File no longer exists.' };
			}

			const workingText = useEditorText
				? Buffer.from(openDoc!.getText(), 'utf8')
				: workingExists
					? await fs.readFile(fsPath)
					: Buffer.alloc(0);
			if (workingExists && isBinaryBuffer(workingText)) {
				return { path: relativePath, staged, kind: 'binary', message: 'Binary file diff is not shown.' };
			}
			if (hasIndex && looksBinary(indexText)) {
				return { path: relativePath, staged, kind: 'binary', message: 'Binary file diff is not shown.' };
			}

			const workingStr = workingExists ? workingText.toString('utf8') : '';
			if (Buffer.byteLength(workingStr, 'utf8') > MAX_DIFF_BYTES || Buffer.byteLength(indexText, 'utf8') > MAX_DIFF_BYTES) {
				return { path: relativePath, staged, kind: 'too-large', message: 'File is larger than 1MB and was not rendered.' };
			}

			const oldLineCount = indexText === '' ? 0 : indexText.split(/\r?\n/).length;
			const newLineCount = workingStr === '' ? 0 : workingStr.split(/\r?\n/).length;
			if (oldLineCount > 4000 || newLineCount > 4000) {
				return {
					path: relativePath,
					staged,
					kind: 'too-large',
					message: 'File has too many lines for in-panel diff (limit 4000).',
				};
			}

			const unified = createUnifiedDiff(indexText, workingStr, relativePath);
			if (!unified.trim()) {
				return { path: relativePath, staged, kind: 'empty', message: 'No unstaged diff for this file.' };
			}
			return { path: relativePath, staged, kind: 'text', unified };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { path: relativePath, staged, kind: 'missing', message };
		}
	}

	private collectDirtyDocuments(
		root: string,
		knownPaths: Set<string>,
		untrackedPaths: Set<string>
	): ChangeItem[] {
		const items: ChangeItem[] = [];
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.uri.scheme !== 'file' || !doc.isDirty) {
				continue;
			}
			if (!isPathInsideRoot(doc.uri.fsPath, root)) {
				continue;
			}
			const rel = path.relative(root, doc.uri.fsPath).replace(/\\/g, '/');
			if (knownPaths.has(rel.toLowerCase())) {
				continue;
			}
			items.push({
				path: rel,
				fsPath: doc.uri.fsPath,
				status: untrackedPaths.has(rel.toLowerCase()) ? '?' : 'M',
				staged: false,
				unsaved: true,
			});
		}
		return items;
	}

	private async ensureSaved(fsPath: string): Promise<void> {
		const doc = vscode.workspace.textDocuments.find((d) => pathsEqual(d.uri.fsPath, fsPath));
		if (!doc?.isDirty) {
			return;
		}
		if (await doc.save()) {
			return;
		}
		await vscode.workspace.fs.writeFile(doc.uri, Buffer.from(doc.getText(), 'utf8'));
	}

	private rememberFileUri(uri: vscode.Uri): void {
		this.lastKnownFileUri = uri;
		const repo = this.api?.getRepository(uri);
		if (!repo) {
			return;
		}
		// Focusing a workspace file resumes auto-follow for that file's repository.
		this.pinnedRepoRoot = undefined;
		this.activeRepoRoot = repo.rootUri.fsPath;
	}

	private repoForUri(uri: vscode.Uri | undefined): Repository | undefined {
		if (!this.api || !uri || uri.scheme !== 'file') {
			return undefined;
		}
		return this.api.getRepository(uri) ?? undefined;
	}

	private requireActiveRepo(): Repository {
		const repo = this.getActiveRepository();
		if (!repo) {
			throw new Error('No Git repository selected.');
		}
		return repo;
	}

	private requireRepoByRoot(repoRoot?: string): Repository {
		if (repoRoot) {
			const repo = this.api?.repositories.find((r) => pathsEqual(r.rootUri.fsPath, repoRoot));
			if (repo) {
				return repo;
			}
		}
		return this.requireActiveRepo();
	}

	private requireRepoForFsPath(fsPath: string): Repository {
		const repo = this.api?.getRepository(vscode.Uri.file(fsPath));
		if (!repo) {
			throw new Error('File is not inside a Git repository.');
		}
		return repo;
	}

	private bindRepositoryEvents(): void {
		this.repoDisposables.forEach((d) => d.dispose());
		this.repoDisposables = [];
		if (!this.api) {
			return;
		}
		for (const repo of this.api.repositories) {
			this.repoDisposables.push(
				repo.state.onDidChange(() => this._onDidChange.fire())
			);
			if (repo.onDidCommit) {
				this.repoDisposables.push(repo.onDidCommit(() => this.scheduleRefresh()));
			}
		}
	}

	private toChangeItem(change: Change, root: string, staged: boolean): ChangeItem {
		const fsPath = change.uri.fsPath;
		return {
			path: path.relative(root, fsPath).replace(/\\/g, '/'),
			fsPath,
			status: statusLetter(change.status),
			staged,
		};
	}
}

function statusLetter(status: Status): string {
	switch (status) {
		case Status.INDEX_MODIFIED:
		case Status.MODIFIED:
		case Status.TYPE_CHANGED:
		case Status.BOTH_MODIFIED:
			return 'M';
		case Status.INDEX_ADDED:
		case Status.INTENT_TO_ADD:
		case Status.ADDED_BY_US:
		case Status.ADDED_BY_THEM:
		case Status.BOTH_ADDED:
			return 'A';
		case Status.UNTRACKED:
			return '?';
		case Status.INDEX_DELETED:
		case Status.DELETED:
		case Status.DELETED_BY_US:
		case Status.DELETED_BY_THEM:
		case Status.BOTH_DELETED:
			return 'D';
		case Status.INDEX_RENAMED:
		case Status.INTENT_TO_RENAME:
			return 'R';
		case Status.INDEX_COPIED:
			return 'C';
		case Status.IGNORED:
			return 'I';
		default:
			return 'M';
	}
}

function conflictStatusLetter(status: Status): string {
	switch (status) {
		case Status.BOTH_ADDED:
		case Status.ADDED_BY_US:
		case Status.ADDED_BY_THEM:
			return 'A';
		case Status.BOTH_DELETED:
		case Status.DELETED_BY_US:
		case Status.DELETED_BY_THEM:
			return 'D';
		case Status.BOTH_MODIFIED:
		default:
			return 'C';
	}
}

function isPushRejectedError(err: unknown): boolean {
	const e = err as { gitErrorCode?: string; message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
	if (
		e.gitErrorCode === GitErrorCodes.PushRejected ||
		e.gitErrorCode === 'PushRejected' ||
		e.gitErrorCode === 'ForcePushWithLeaseRejected' ||
		e.gitErrorCode === 'ForcePushWithLeaseIfIncludesRejected'
	) {
		return true;
	}
	const text = `${e.message ?? ''} ${bufferToString(e.stderr)} ${bufferToString(e.stdout)} ${String(err)}`.toLowerCase();
	return (
		text.includes('non-fast-forward') ||
		text.includes('[rejected]') ||
		text.includes('updates were rejected') ||
		text.includes('failed to push some refs') ||
		text.includes('tip of your current branch is behind') ||
		(text.includes('fetch first') && text.includes('rejected'))
	);
}

function isConflictError(err: unknown): boolean {
	const e = err as { gitErrorCode?: string; message?: string; stderr?: string };
	if (e.gitErrorCode === GitErrorCodes.Conflict || e.gitErrorCode === 'Conflict') {
		return true;
	}
	const text = `${e.message ?? ''} ${e.stderr ?? ''} ${String(err)}`.toLowerCase();
	return (
		text.includes('conflict') ||
		text.includes('you need to resolve') ||
		text.includes('fix conflict') ||
		text.includes('needs merge')
	);
}

function formatGitError(err: unknown): string {
	const e = err as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
	const combined = combineGitOutput(e.stdout, e.stderr).trim();
	if (combined) {
		return combined;
	}
	if (typeof e.message === 'string' && e.message.trim()) {
		return e.message.trim();
	}
	if (err instanceof Error && err.message.trim()) {
		return err.message.trim();
	}
	return String(err);
}

function bufferToString(value: string | Buffer | undefined): string {
	if (!value) {
		return '';
	}
	return typeof value === 'string' ? value : value.toString('utf8');
}

function combineGitOutput(stdout: string | Buffer | undefined, stderr: string | Buffer | undefined): string {
	const parts = [bufferToString(stdout).trim(), bufferToString(stderr).trim()].filter(Boolean);
	return parts.join('\n');
}

function dedupeByPath(items: ChangeItem[]): ChangeItem[] {
	const map = new Map<string, ChangeItem>();
	for (const item of items) {
		const key = normalizePathKey(item.path);
		map.set(key, item);
	}
	return [...map.values()];
}

function parseUpstream(
	upstream?: string,
	headUpstream?: { remote: string; name: string }
): { remote?: string; upstreamBranch?: string } {
	if (headUpstream) {
		return { remote: headUpstream.remote, upstreamBranch: headUpstream.name };
	}
	if (!upstream) {
		return {};
	}
	const slash = upstream.indexOf('/');
	if (slash > 0) {
		return {
			remote: upstream.slice(0, slash),
			upstreamBranch: upstream.slice(slash + 1),
		};
	}
	return { upstreamBranch: upstream };
}

function parsePushCommits(raw: string): PushCommitItem[] {
	if (!raw.trim()) {
		return [];
	}
	return raw.split('\n').map((line) => {
		const [hash = '', shortHash = '', subject = '', author = '', date = ''] = line.split('|');
		return { hash, shortHash, subject, author, date };
	});
}

function parseCommitLog(raw: string): CommitLogItem[] {
	if (!raw.trim()) {
		return [];
	}
	return raw.split('\n').map((line) => {
		const [hash = '', shortHash = '', subject = '', author = '', date = '', refs = ''] =
			line.split('\x1f');
		return {
			hash,
			shortHash,
			subject,
			author,
			date,
			refs: refs.trim() || undefined,
		};
	});
}

function pathsEqual(a: string, b: string): boolean {
	return normalizePathKey(a) === normalizePathKey(b);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePathKey(p: string): string {
	const normalized = p.replace(/\\/g, '/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathInsideRoot(fsPath: string, root: string): boolean {
	const fileKey = normalizePathKey(fsPath);
	const rootKey = normalizePathKey(root).replace(/\/$/, '');
	return fileKey === rootKey || fileKey.startsWith(`${rootKey}/`);
}

async function fileExists(fsPath: string): Promise<boolean> {
	try {
		await fs.access(fsPath);
		return true;
	} catch {
		return false;
	}
}

function isBinaryBuffer(buf: Buffer): boolean {
	const len = Math.min(buf.length, 8000);
	for (let i = 0; i < len; i++) {
		if (buf[i] === 0) {
			return true;
		}
	}
	return false;
}

function looksBinary(text: string): boolean {
	return text.includes('\u0000');
}

/** Minimal unified diff for unstaged (index vs working tree). */
function createUnifiedDiff(oldText: string, newText: string, filePath: string): string {
	const oldLines = oldText === '' ? [] : oldText.split(/\r?\n/);
	const newLines = newText === '' ? [] : newText.split(/\r?\n/);
	// Drop trailing empty line caused by split on final newline
	if (oldText.endsWith('\n') || oldText.endsWith('\r\n')) {
		if (oldLines[oldLines.length - 1] === '') {
			oldLines.pop();
		}
	}
	if (newText.endsWith('\n') || newText.endsWith('\r\n')) {
		if (newLines[newLines.length - 1] === '') {
			newLines.pop();
		}
	}

	const lcs = computeLcs(oldLines, newLines);
	const hunks: string[] = [];
	let i = 0;
	let j = 0;
	let k = 0;

	type Op = { type: 'equal' | 'remove' | 'add'; line: string };
	const ops: Op[] = [];
	while (i < oldLines.length || j < newLines.length) {
		if (k < lcs.length && i < oldLines.length && oldLines[i] === lcs[k] && j < newLines.length && newLines[j] === lcs[k]) {
			ops.push({ type: 'equal', line: oldLines[i] });
			i++;
			j++;
			k++;
		} else if (j < newLines.length && (k >= lcs.length || newLines[j] !== lcs[k])) {
			ops.push({ type: 'add', line: newLines[j] });
			j++;
		} else if (i < oldLines.length && (k >= lcs.length || oldLines[i] !== lcs[k])) {
			ops.push({ type: 'remove', line: oldLines[i] });
			i++;
		} else {
			break;
		}
	}

	if (!ops.some((o) => o.type !== 'equal')) {
		return '';
	}

	hunks.push(`diff --git a/${filePath} b/${filePath}`);
	hunks.push(`--- a/${filePath}`);
	hunks.push(`+++ b/${filePath}`);

	// Single hunk covering whole file for MVP simplicity
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	hunks.push(`@@ -1,${oldCount || 0} +1,${newCount || 0} @@`);
	for (const op of ops) {
		if (op.type === 'equal') {
			hunks.push(` ${op.line}`);
		} else if (op.type === 'remove') {
			hunks.push(`-${op.line}`);
		} else {
			hunks.push(`+${op.line}`);
		}
	}
	return hunks.join('\n');
}

function computeLcs(a: string[], b: string[]): string[] {
	const n = a.length;
	const m = b.length;
	// Cap LCS matrix for very large files — caller already size-checks content
	const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			if (a[i] === b[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}
	const result: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			result.push(a[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return result;
}

export function isValidTagName(name: string): boolean {
	if (!name || name.includes('..') || name.startsWith('-') || name.endsWith('.')) {
		return false;
	}
	return /^[^\s~^:?*[\]\\]+$/.test(name);
}
