import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);
import { API, Change, GitErrorCodes, GitExtension, Repository, Status } from '../git/git';
import {
	ChangeItem,
	DiffResult,
	RepoSnapshot,
	RepoSummary,
	SyncMode,
	WorkspaceSnapshot,
} from '../panel/messages';

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
	| { status: 'conflict'; mode: SyncMode; conflicts: ChangeItem[]; message: string };

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

	async init(): Promise<{ ok: true } | { ok: false; error: string }> {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension) {
			return { ok: false, error: 'VS Code Git extension is not available.' };
		}

		if (!extension.isActive) {
			await extension.activate();
		}

		const gitExtension = extension.exports;
		if (!gitExtension.enabled) {
			return { ok: false, error: 'VS Code Git extension is disabled. Please enable it to use this panel.' };
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

		if (this.api.state !== 'initialized') {
			await new Promise<void>((resolve) => {
				const sub = this.api!.onDidChangeState((state) => {
					if (state === 'initialized') {
						sub.dispose();
						resolve();
					}
				});
			});
		}

		this.bindRepositoryEvents();

		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.disposables.push(
			watcher,
			watcher.onDidChange(() => this.scheduleRefresh()),
			watcher.onDidCreate(() => this.scheduleRefresh()),
			watcher.onDidDelete(() => this.scheduleRefresh()),
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

		return { ok: true };
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.repoDisposables.forEach((d) => d.dispose());
		this.disposables.forEach((d) => d.dispose());
		this._onDidChange.dispose();
	}

	getRepositoryCount(): number {
		return this.api?.repositories.length ?? 0;
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
			return {
				ok: false,
				error: 'VS Code Git extension is not available.',
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

		const summaries: RepoSummary[] = repos.map((repo) => {
			const snap = this.buildSnapshotForRepo(repo);
			return {
				rootPath: snap.rootPath,
				name: snap.name,
				branch: snap.branch,
				changeCount: snap.staged.length + snap.unstaged.length + snap.unversioned.length,
			};
		});

		const active = this.buildSnapshotForRepo(activeRepo);

		return {
			ok: true,
			activeRepoRoot: active.rootPath,
			repositories: summaries,
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

		await vscode.commands.executeCommand('git.refresh').then(undefined, () => undefined);
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
		await repo.add([fsPath]);
	}

	async unstage(fsPath: string): Promise<void> {
		const repo = this.requireRepoForFsPath(fsPath);
		await repo.revert([fsPath]);
	}

	async stageAll(stage: boolean): Promise<void> {
		const snap = this.getSnapshot();
		if (!snap.ok) {
			throw new Error(snap.error ?? 'Repository unavailable');
		}
		const repo = this.requireActiveRepo();
		if (stage) {
			for (const item of [...snap.unstaged, ...snap.unversioned]) {
				if (item.unsaved) {
					await this.ensureSaved(item.fsPath);
				}
			}
			const paths = [...snap.unstaged, ...snap.unversioned].map((c) => c.fsPath);
			if (paths.length) {
				await repo.add(paths);
			}
		} else {
			const paths = snap.staged.map((c) => c.fsPath);
			if (paths.length) {
				await repo.revert(paths);
			}
		}
	}

	async commit(message: string): Promise<void> {
		const repo = this.requireActiveRepo();
		const snap = this.getSnapshot();
		if (!snap.staged.length) {
			throw new Error('No staged changes. Check files to include in the commit.');
		}
		const trimmed = message.trim();
		if (!trimmed) {
			throw new Error('Commit message cannot be empty.');
		}
		await repo.commit(trimmed, { postCommitCommand: null });
	}

	async push(): Promise<void> {
		const repo = this.requireActiveRepo();
		try {
			await repo.push();
		} catch (err) {
			if (isPushRejectedError(err)) {
				throw new PushRejectedError(formatGitError(err));
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
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

	async syncWithUpstream(mode: SyncMode): Promise<SyncResult> {
		const repo = this.requireActiveRepo();
		const upstream = this.requireUpstreamName(repo);

		await this.fetchRepo(repo);

		try {
			if (mode === 'merge') {
				await this.mergeUpstream(repo, upstream);
			} else {
				await this.rebaseOntoUpstream(repo, upstream);
			}
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
			throw err instanceof Error ? err : new Error(String(err));
		}

		await repo.status().catch(() => undefined);
		const conflicts = this.getConflictItems(repo);
		if (conflicts.length) {
			return {
				status: 'conflict',
				mode,
				conflicts,
				message: `${mode === 'merge' ? 'Merge' : 'Rebase'} produced conflicts. Resolve them, then continue.`,
			};
		}

		return { status: 'ok', mode };
	}

	async continueSync(): Promise<SyncResult> {
		const repo = this.requireActiveRepo();
		const mode = this.detectSyncMode(repo) ?? 'merge';
		const remaining = this.getConflictItems(repo);
		if (remaining.length) {
			throw new Error(`还有 ${remaining.length} 个未解决的冲突文件。`);
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

		await repo.status().catch(() => undefined);
		const conflicts = this.getConflictItems(repo);
		if (conflicts.length) {
			return {
				status: 'conflict',
				mode,
				conflicts,
				message: 'Conflicts remain after continue. Resolve them, then try again.',
			};
		}

		return { status: 'ok', mode };
	}

	async abortSync(): Promise<void> {
		const repo = this.requireActiveRepo();
		const mode = this.detectSyncMode(repo);
		const root = repo.rootUri.fsPath;

		if (mode === 'rebase' || repo.state.rebaseCommit) {
			await this.execGit(root, ['rebase', '--abort']);
			return;
		}

		if (typeof repo.mergeAbort === 'function') {
			await repo.mergeAbort();
			return;
		}

		await this.execGit(root, ['merge', '--abort']);
	}

	async openConflictFile(relativePath: string): Promise<void> {
		const repo = this.requireActiveRepo();
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

	getConflictSnapshot(): { mode?: SyncMode; conflicts: ChangeItem[] } {
		const repo = this.requireActiveRepo();
		return {
			mode: this.detectSyncMode(repo),
			conflicts: this.getConflictItems(repo),
		};
	}

	private async fetchRepo(repo: Repository): Promise<void> {
		if (typeof repo.fetch === 'function') {
			await repo.fetch();
			return;
		}
		await this.execGit(repo.rootUri.fsPath, ['fetch']);
	}

	private async mergeUpstream(repo: Repository, upstream: string): Promise<void> {
		if (typeof repo.merge === 'function') {
			await repo.merge(upstream);
			return;
		}
		await this.execGit(repo.rootUri.fsPath, ['merge', upstream]);
	}

	private async rebaseOntoUpstream(repo: Repository, upstream: string): Promise<void> {
		if (typeof repo.rebase === 'function') {
			await repo.rebase(upstream);
			return;
		}
		await this.execGit(repo.rootUri.fsPath, ['rebase', upstream]);
	}

	private requireUpstreamName(repo: Repository): string {
		const head = repo.state.HEAD;
		if (!head?.upstream) {
			throw new Error('当前分支没有上游（upstream）。请先设置跟踪分支后再同步。');
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

	async openDiffInEditor(relativePath: string, staged: boolean, repoRoot?: string): Promise<void> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		const repo = this.requireRepoByRoot(repoRoot);
		const root = repo.rootUri.fsPath;
		const fsPath = path.join(root, relativePath);
		const fileUri = vscode.Uri.file(fsPath);
		await this.ensureSaved(fsPath);

		const title = `${relativePath}${staged ? ' (Staged)' : ' (Changes)'}`;
		if (staged) {
			const head = this.api.toGitUri(fileUri, 'HEAD');
			const index = this.api.toGitUri(fileUri, '');
			await vscode.commands.executeCommand('vscode.diff', head, index, title);
			return;
		}

		const index = this.api.toGitUri(fileUri, '');
		await vscode.commands.executeCommand('vscode.diff', index, fileUri, title);
	}

	async rollbackFile(relativePath: string, repoRoot: string): Promise<void> {
		const repo = this.requireRepoByRoot(repoRoot);
		const fsPath = path.join(repo.rootUri.fsPath, relativePath);

		if (this.isUntracked(relativePath, repoRoot)) {
			await repo.clean([fsPath]);
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
				await restoreFn.call(repo, [fsPath], { staged: true, ref: 'HEAD' });
				await restoreFn.call(repo, [fsPath], { ref: 'HEAD' });
				return;
			} catch {
				// Fall through to git checkout / clean
			}
		}

		try {
			await this.execGit(repo.rootUri.fsPath, ['checkout', 'HEAD', '--', relativePath]);
		} catch {
			await repo.clean([fsPath]);
		}
	}

	private async execGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
		try {
			await execFile('git', args, {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
				env: env ? { ...process.env, ...env } : process.env,
			});
		} catch (err) {
			const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
			const stderr = bufferToString(e.stderr).trim();
			const stdout = bufferToString(e.stdout).trim();
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
	const e = err as { gitErrorCode?: string; message?: string; stderr?: string };
	if (
		e.gitErrorCode === GitErrorCodes.PushRejected ||
		e.gitErrorCode === 'PushRejected' ||
		e.gitErrorCode === 'ForcePushWithLeaseRejected' ||
		e.gitErrorCode === 'ForcePushWithLeaseIfIncludesRejected'
	) {
		return true;
	}
	const text = `${e.message ?? ''} ${e.stderr ?? ''} ${String(err)}`.toLowerCase();
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
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function bufferToString(value: string | Buffer | undefined): string {
	if (!value) {
		return '';
	}
	return typeof value === 'string' ? value : value.toString('utf8');
}

function dedupeByPath(items: ChangeItem[]): ChangeItem[] {
	const map = new Map<string, ChangeItem>();
	for (const item of items) {
		const key = normalizePathKey(item.path);
		map.set(key, item);
	}
	return [...map.values()];
}

function pathsEqual(a: string, b: string): boolean {
	return normalizePathKey(a) === normalizePathKey(b);
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
