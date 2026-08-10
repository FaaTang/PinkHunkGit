import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);
import { API, Change, GitErrorCodes, GitExtension, Repository, Status } from '../git/git';
import {
	formatGitError,
	formatGitShellCommand,
	logGitFail,
	logGitOk,
	logGitStart,
	setUserGitLogging,
} from './gitOutput';
import { isLikelyCloneUrl, parseCloneUrl } from './cloneUrl';
import {
	ChangeItem,
	CommitLogItem,
	CommitRepoResult,
	DiffResult,
	RepoSnapshot,
	SyncMode,
	WorkspaceSnapshot,
} from '../panel/messages';
import { PushCommitItem, PushCommitDetails, PushTarget } from '../panel/pushMessages';
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

export type CloneProgress = {
	phase: 'counting' | 'compressing' | 'receiving' | 'resolving' | 'updating' | 'other';
	overallPercent?: number;
	percent?: number;
	downloadedKB?: number;
	totalKB?: number;
	speedKBps?: number;
	detail: string;
};

export type CloneTask = {
	promise: Promise<string>;
	cancel: () => void;
};

export type GitProxyStatus = {
	currentProxy?: string;
	usingSessionProxy: boolean;
};

export class GitService implements vscode.Disposable {
	private api: API | undefined;
	private gitExecutable = 'git';
	private configuredGitProxy: string | undefined;
	private sessionGitProxy: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private repoDisposables: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	/** While > 0, skip auto refresh so file watchers cannot race user git writes (index.lock). */
	private refreshSuspended = 0;
	/** Coalesce repo-state events during suspended ops; flush once afterwards. */
	private changePendingWhileSuspended = false;
	private lastKnownFileUri: vscode.Uri | undefined;
	private contextUri: vscode.Uri | undefined;
	private activeRepoRoot: string | undefined;
	/** Manual repo pick from the UI; cleared when the focused editor file maps to a repo. */
	private pinnedRepoRoot: string | undefined;
	private fileWatchersSetup = false;
	private editorListenersSetup = false;
	private initState: 'pending' | 'ready' | 'failed' = 'pending';
	private initError = '';
	private pendingDiffAdvance: { repoRoot: string; path: string } | undefined;
	private pendingDiffRetreat: { repoRoot: string; path: string } | undefined;
	private diffNavDecorationType: vscode.TextEditorDecorationType | undefined;
	/** Cached ignored paths per repo root (from `git status --ignored`). */
	private ignoredByRoot = new Map<string, ChangeItem[]>();
	private ignoredRefreshInFlight: Promise<void> | undefined;
	/** Incremental refresh queue: only status these repo roots (unless pendingStatusAll). */
	private pendingStatusRoots = new Set<string>();
	private pendingStatusAll = false;
	private pendingIgnoredRoots = new Set<string>();
	private pendingIgnoredAll = false;
	private refreshInFlight: Promise<void> | undefined;
	private refreshQueued = false;
	private discoverReposInFlight: Promise<void> | undefined;

	async init(): Promise<{ ok: true } | { ok: false; error: string }> {
		this.gitExecutable = await this.resolveGitExecutable();
		this.configuredGitProxy = await this.readConfiguredGitProxy();
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
		await this.ensureWorkspaceRepositoriesDiscovered();

		this.initState = 'ready';
		this._onDidChange.fire();
		return { ok: true };
	}

	private async resolveGitExecutable(): Promise<string> {
		const configValue = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
		const candidates = Array.isArray(configValue)
			? configValue
			: typeof configValue === 'string'
				? [configValue]
				: [];
		for (const raw of candidates) {
			const candidate = raw.trim();
			if (!candidate) {
				continue;
			}
			try {
				await execFile(candidate, ['--version'], {
					maxBuffer: 256 * 1024,
					env: process.env,
				});
				return candidate;
			} catch {
				// Try next configured path.
			}
		}
		return 'git';
	}

	private async readConfiguredGitProxy(): Promise<string | undefined> {
		const fromEnv =
			process.env.HTTPS_PROXY ||
			process.env.https_proxy ||
			process.env.HTTP_PROXY ||
			process.env.http_proxy;
		if (fromEnv?.trim()) {
			return fromEnv.trim();
		}
		const readKey = async (key: string): Promise<string | undefined> => {
			try {
				const { stdout } = await execFile(this.gitExecutable, ['config', '--get', key], {
					maxBuffer: 256 * 1024,
					env: process.env,
				});
				const value = bufferToString(stdout).trim();
				return value || undefined;
			} catch {
				return undefined;
			}
		};
		return (await readKey('https.proxy')) || (await readKey('http.proxy'));
	}

	getGitProxyStatus(): GitProxyStatus {
		return {
			currentProxy: this.sessionGitProxy || this.configuredGitProxy,
			usingSessionProxy: Boolean(this.sessionGitProxy),
		};
	}

	setSessionGitProxy(proxy?: string): void {
		const value = proxy?.trim();
		this.sessionGitProxy = value || undefined;
	}

	private withSessionProxyArgs(args: string[]): string[] {
		if (!this.sessionGitProxy) {
			return args;
		}
		return [
			'-c',
			`http.proxy=${this.sessionGitProxy}`,
			'-c',
			`https.proxy=${this.sessionGitProxy}`,
			...args,
		];
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
					// Repo/active file switch only needs a cheap UI snapshot push.
					this.scheduleSnapshot();
				}),
				vscode.workspace.onDidChangeTextDocument((event) => {
					if (event.document.uri.scheme === 'file') {
						this.rememberFileUri(event.document.uri);
						// Unsaved edits are merged via collectDirtyDocuments — no git status.
						this.scheduleSnapshot();
					}
				}),
				vscode.workspace.onDidSaveTextDocument((doc) => {
					if (doc.uri.scheme === 'file') {
						this.scheduleRefresh(doc.uri);
					}
				}),
				vscode.workspace.onDidChangeWorkspaceFolders(() => {
					void this.ensureWorkspaceRepositoriesDiscovered().then(() => {
						this.bindRepositoryEvents();
						this._onDidChange.fire();
					});
				})
			);
		}

		if (this.fileWatchersSetup) {
			return;
		}

		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return;
		}

		this.fileWatchersSetup = true;
		for (const folder of folders) {
			const pattern = new vscode.RelativePattern(folder, '**/*');
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			this.disposables.push(
				watcher,
				watcher.onDidChange((uri) => this.scheduleRefresh(uri)),
				watcher.onDidCreate((uri) => this.scheduleRefresh(uri, { ignored: true })),
				watcher.onDidDelete((uri) => this.scheduleRefresh(uri, { ignored: true }))
			);
		}
	}

	/**
	 * IDEA lists every VCS root (including clean 0/0 modules). vscode.git may miss
	 * nested repos depending on scan depth / detection mode — open them ourselves.
	 */
	private async ensureWorkspaceRepositoriesDiscovered(): Promise<void> {
		if (!this.api?.openRepository) {
			return;
		}
		if (this.discoverReposInFlight) {
			await this.discoverReposInFlight;
			return;
		}

		this.discoverReposInFlight = this.discoverWorkspaceRepositories();
		try {
			await this.discoverReposInFlight;
		} finally {
			this.discoverReposInFlight = undefined;
		}
	}

	private async discoverWorkspaceRepositories(): Promise<void> {
		if (!this.api?.openRepository) {
			return;
		}

		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!folders.length) {
			return;
		}

		const configuredDepth = vscode.workspace
			.getConfiguration('git')
			.get<number>('repositoryScanMaxDepth', 1);
		// Match VS Code when unlimited (-1); otherwise at least depth 1 so sibling
		// module folders under a workspace root are found (ecp/payment, …).
		const maxDepth =
			configuredDepth < 0 ? 4 : Math.max(1, Math.min(configuredDepth || 1, 4));

		const roots = new Set<string>();
		for (const folder of folders) {
			for (const root of await this.findGitRoots(folder.uri.fsPath, maxDepth)) {
				roots.add(path.normalize(root));
			}
		}

		let opened = 0;
		for (const root of roots) {
			const uri = vscode.Uri.file(root);
			if (this.api.getRepository(uri)) {
				continue;
			}
			try {
				const repo = await this.api.openRepository(uri);
				if (repo) {
					opened += 1;
				}
			} catch {
				// Not a usable git root (or Git extension rejected it).
			}
		}

		if (opened > 0) {
			this.bindRepositoryEvents();
		}
	}

	/** Breadth-first find directories that contain a `.git` dir/file, up to maxDepth. */
	private async findGitRoots(startDir: string, maxDepth: number): Promise<string[]> {
		const found: string[] = [];
		const skipNames = new Set([
			'node_modules',
			'.git',
			'out',
			'dist',
			'build',
			'.next',
			'target',
			'vendor',
			'__pycache__',
		]);

		type QueueItem = { dir: string; depth: number };
		const queue: QueueItem[] = [{ dir: startDir, depth: 0 }];

		while (queue.length) {
			const { dir, depth } = queue.shift()!;
			if (await this.hasGitMetadata(dir)) {
				found.push(dir);
				// Still scan children: nested repos are common in multi-module trees.
			}
			if (depth >= maxDepth) {
				continue;
			}
			let entries: Array<{ name: string; isDirectory(): boolean }> = [];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || skipNames.has(entry.name) || entry.name.startsWith('.')) {
					continue;
				}
				queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
			}
		}

		return found;
	}

	private async hasGitMetadata(dir: string): Promise<boolean> {
		try {
			const gitPath = path.join(dir, '.git');
			const stat = await fs.stat(gitPath);
			return stat.isDirectory() || stat.isFile();
		} catch {
			return false;
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
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
		}
		this.repoDisposables.forEach((d) => d.dispose());
		this.disposables.forEach((d) => d.dispose());
		this._onDidChange.dispose();
	}

	async runWithUserLogging<T>(fn: () => Promise<T>): Promise<T> {
		setUserGitLogging(true);
		this.refreshSuspended += 1;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		try {
			return await fn();
		} finally {
			this.refreshSuspended = Math.max(0, this.refreshSuspended - 1);
			setUserGitLogging(false);
			if (this.refreshSuspended === 0) {
				const pending = this.changePendingWhileSuspended;
				this.changePendingWhileSuspended = false;
				// Flush UI listeners for status updates that arrived while suspended
				// (e.g. repo.status() after batch add). Dropping this caused stale
				// checkboxes and Fast Push unstaging freshly-added files.
				if (pending) {
					this._onDidChange.fire();
				}
				// One catch-up refresh after the whole batch (IDEA-style UI update).
				this.scheduleRefresh();
			}
		}
	}

	/**
	 * Clone a remote repository into `targetDirectory` via `git clone`.
	 * Does not require an existing workspace repository.
	 * @returns Absolute path of the cloned directory.
	 */
	async cloneRepository(url: string, targetDirectory: string): Promise<string> {
		const task = this.startCloneRepository(url, targetDirectory);
		return task.promise;
	}

	startCloneRepository(
		url: string,
		targetDirectory: string,
		onProgress?: (progress: CloneProgress) => void
	): CloneTask {
		const trimmedUrl = url.trim();
		const target = path.resolve(targetDirectory.trim());
		let child: ReturnType<typeof spawn> | undefined;
		let cancelled = false;
		let rejectSettle: ((reason?: unknown) => void) | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const promise = (async () => {
			if (!trimmedUrl) {
				throw new Error('Repository URL is required.');
			}
			if (!isLikelyCloneUrl(trimmedUrl)) {
				throw new Error('Repository URL is invalid. Use an HTTPS or SSH URL.');
			}
			const parsed = parseCloneUrl(trimmedUrl);
			if (parsed.protocol === 'unknown') {
				throw new Error('Unable to detect repository protocol. Use an HTTPS or SSH URL.');
			}

			const parentDir = path.dirname(target);
			await fs.mkdir(parentDir, { recursive: true });

			try {
				const stat = await fs.stat(target);
				if (stat.isDirectory()) {
					const entries = await fs.readdir(target);
					if (entries.length > 0) {
						throw new Error(`Target directory already exists and is not empty: ${target}`);
					}
				} else {
					throw new Error(`Target path already exists and is not a directory: ${target}`);
				}
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') {
					throw err;
				}
			}

			const args = this.withSessionProxyArgs(['clone', '--progress', trimmedUrl, target]);
			const command = formatGitShellCommand(args);
			logGitStart(parentDir, command);
			const started = Date.now();
			const stderrChunks: string[] = [];
			const stdoutChunks: string[] = [];
			let stderrBuffer = '';

			return await new Promise<string>((resolve, reject) => {
				rejectSettle = reject;
				child = spawn(this.gitExecutable, args, {
					cwd: parentDir,
					env: process.env,
					stdio: ['ignore', 'pipe', 'pipe'],
				});

				child.stdout?.on('data', (chunk: Buffer) => {
					const text = chunk.toString('utf8');
					stdoutChunks.push(text);
				});

				child.stderr?.on('data', (chunk: Buffer) => {
					const text = chunk.toString('utf8');
					stderrChunks.push(text);
					stderrBuffer += text;
					const lines = stderrBuffer.split(/\r?\n|\r/);
					stderrBuffer = lines.pop() ?? '';
					for (const line of lines) {
						const parsedProgress = parseCloneProgressLine(line);
						if (parsedProgress) {
							onProgress?.(parsedProgress);
						}
					}
				});

				child.on('error', (err) => {
					if (killTimer) {
						clearTimeout(killTimer);
						killTimer = undefined;
					}
					logGitFail(err, Date.now() - started);
					reject(err);
				});

				child.on('close', (code) => {
					if (killTimer) {
						clearTimeout(killTimer);
						killTimer = undefined;
					}
					const tailLine = stderrBuffer.trim();
					if (tailLine) {
						const parsedTail = parseCloneProgressLine(tailLine);
						if (parsedTail) {
							onProgress?.(parsedTail);
						}
					}
					const output = combineGitOutput(stdoutChunks.join(''), stderrChunks.join(''));
					if (cancelled) {
						const cancelError = new Error('Clone was force-cancelled.');
						logGitFail(cancelError, Date.now() - started, output);
						reject(cancelError);
						return;
					}
					if (code === 0) {
						logGitOk(Date.now() - started, output);
						resolve(target);
						return;
					}
					const message = (stderrChunks.join('').trim() || stdoutChunks.join('').trim() || `git clone failed with exit code ${code}`).trim();
					const err = new Error(message);
					logGitFail(err, Date.now() - started, output);
					reject(err);
				});
			});
		})();

		return {
			promise,
			cancel: () => {
				cancelled = true;
				if (!child || child.exitCode !== null) {
					return;
				}
				try {
					child.kill('SIGTERM');
				} catch {
					// ignore
				}
				killTimer = setTimeout(() => {
					if (!child || child.exitCode !== null) {
						return;
					}
					try {
						child.kill('SIGKILL');
					} catch {
						// ignore
					}
				}, 1200);
				// If process doesn't emit close due to abnormal environment, fail-safe reject.
				setTimeout(() => {
					if (child && child.exitCode === null) {
						try {
							child.kill('SIGKILL');
						} catch {
							// ignore
						}
					}
					rejectSettle?.(new Error('Clone was force-cancelled.'));
				}, 5000);
			},
		};
	}

	getRepositoryCount(): number {
		return this.api?.repositories.length ?? 0;
	}

	getRepositoryList(): Array<{ rootPath: string; name: string }> {
		if (!this.api) {
			return [];
		}
		return this.api.repositories.map((repo) => ({
			rootPath: repo.rootUri.fsPath,
			name: this.repoDisplayName(repo.rootUri.fsPath),
		}));
	}

	async pullAllRepositories(
		onProgress?: (repository: string, index: number, total: number) => void,
		repoRoots?: string[]
	): Promise<PullAllResult> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		let repositories = [...this.api.repositories];
		if (repoRoots?.length) {
			const wanted = new Set(repoRoots.map((root) => root.replace(/\\/g, '/').toLowerCase()));
			repositories = repositories.filter((repo) =>
				wanted.has(repo.rootUri.fsPath.replace(/\\/g, '/').toLowerCase())
			);
		}
		if (!repositories.length) {
			throw new Error(
				repoRoots?.length
					? 'No selected Git repositories to update.'
					: 'Current workspace does not contain a Git repository.'
			);
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

	/** True until `init()` finishes (success or failure). */
	isInitPending(): boolean {
		return this.initState === 'pending';
	}

	getWorkspaceSnapshot(): WorkspaceSnapshot {
		const emptyActive: RepoSnapshot = {
			ok: false,
			rootPath: '',
			name: '',
			staged: [],
			unstaged: [],
			unversioned: [],
			ignored: [],
		};

		// Keep showing Loading while vscode.git is still activating / discovering roots.
		// `api` may already be set mid-init; treating that as a hard error flashes
		// "No Git repository selected" before repositories appear a few seconds later.
		if (this.initState === 'pending') {
			return {
				ok: false,
				loading: true,
				hint: 'Loading Git...',
				repositories: [],
				active: emptyActive,
			};
		}

		if (!this.api) {
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
			ignored: this.ignoredByRoot.get(root) ?? [],
			conflictFiles,
			syncMode,
		};
	}

	/** Refresh ignored-file cache (traditional mode: dirs as single entries). */
	async refreshIgnoredFiles(repoRoots?: string[]): Promise<void> {
		if (!this.api?.repositories.length) {
			this.ignoredByRoot.clear();
			return;
		}
		const repos = repoRoots?.length
			? this.api.repositories.filter((repo) =>
					repoRoots.some((root) => pathsEqual(repo.rootUri.fsPath, root))
				)
			: [...this.api.repositories];
		if (!repos.length) {
			return;
		}

		const isFull = !repoRoots?.length;
		if (isFull && this.ignoredRefreshInFlight) {
			await this.ignoredRefreshInFlight;
			return;
		}
		if (!isFull && this.ignoredRefreshInFlight) {
			// A full scan already covers these roots.
			await this.ignoredRefreshInFlight;
			return;
		}

		const task = (async () => {
			await Promise.all(
				repos.map(async (repo) => {
					const root = repo.rootUri.fsPath;
					try {
						const items = await this.listIgnoredFiles(root);
						this.ignoredByRoot.set(root, items);
					} catch {
						if (!this.ignoredByRoot.has(root)) {
							this.ignoredByRoot.set(root, []);
						}
					}
				})
			);
			if (isFull) {
				const liveRoots = repos.map((r) => r.rootUri.fsPath);
				for (const key of [...this.ignoredByRoot.keys()]) {
					if (!liveRoots.some((root) => pathsEqual(root, key))) {
						this.ignoredByRoot.delete(key);
					}
				}
			}
		})();

		if (isFull) {
			this.ignoredRefreshInFlight = task;
		}
		try {
			await task;
		} finally {
			if (isFull && this.ignoredRefreshInFlight === task) {
				this.ignoredRefreshInFlight = undefined;
			}
		}
	}

	private async listIgnoredFiles(root: string): Promise<ChangeItem[]> {
		// Do NOT pass -uno: Git treats it as hiding ignored entries too.
		// traditional mode lists ignored dirs as a single `!! path/` line.
		const raw = await this.queryGit(root, [
			'status',
			'--porcelain=v1',
			'--ignored=traditional',
		]);
		if (!raw) {
			return [];
		}
		const items: ChangeItem[] = [];
		const seen = new Set<string>();
		for (const line of raw.split(/\r?\n/)) {
			if (!line.startsWith('!! ')) {
				continue;
			}
			let rel = unescapeGitPath(line.slice(3));
			rel = rel.replace(/\\/g, '/');
			const directory = rel.endsWith('/');
			if (directory) {
				rel = rel.replace(/\/+$/, '');
			}
			if (!rel) {
				continue;
			}
			const key = rel.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			items.push({
				path: rel,
				fsPath: path.join(root, ...rel.split('/')),
				status: 'I',
				staged: false,
				directory,
			});
		}
		return items.sort((a, b) => a.path.localeCompare(b.path));
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

	/**
	 * Full status refresh for all repositories (manual refresh / after git ops).
	 * Includes ignored scan once — not used on every keystroke or single-file save.
	 */
	async refresh(): Promise<void> {
		if (this.refreshSuspended > 0) {
			return;
		}
		await this.ensureWorkspaceRepositoriesDiscovered();
		this.pendingStatusAll = true;
		this.pendingIgnoredAll = true;
		this.pendingStatusRoots.clear();
		this.pendingIgnoredRoots.clear();
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		await this.flushRefresh();
	}

	/**
	 * Debounced incremental refresh for a single changed file's repository.
	 * Pass no uri for a full catch-up (e.g. after suspended batch ops).
	 */
	scheduleRefresh(uri?: vscode.Uri, options?: { ignored?: boolean }): void {
		if (this.refreshSuspended > 0) {
			return;
		}

		if (!uri) {
			this.pendingStatusAll = true;
			if (options?.ignored) {
				this.pendingIgnoredAll = true;
			}
		} else {
			const needsIgnored = options?.ignored || pathNeedsIgnoredRefresh(uri.fsPath);
			// Ignore .git chatter (index, FETCH_HEAD, …) except exclude-style paths.
			if (isGitInternalPath(uri.fsPath) && !needsIgnored) {
				return;
			}
			const repo = this.api?.getRepository(uri);
			if (!repo) {
				return;
			}
			const root = repo.rootUri.fsPath;
			if (!isGitInternalPath(uri.fsPath)) {
				this.pendingStatusRoots.add(root);
			}
			if (needsIgnored) {
				this.pendingIgnoredRoots.add(root);
			}
			if (
				!this.pendingStatusAll &&
				!this.pendingStatusRoots.size &&
				!this.pendingIgnoredAll &&
				!this.pendingIgnoredRoots.size
			) {
				return;
			}
		}

		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.flushRefresh();
		}, 250);
	}

	/** Cheap UI update from dirty docs / active editor — no git process. */
	scheduleSnapshot(): void {
		if (this.refreshSuspended > 0) {
			this.changePendingWhileSuspended = true;
			return;
		}
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
		}
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			this._onDidChange.fire();
		}, 50);
	}

	private async flushRefresh(): Promise<void> {
		if (this.refreshSuspended > 0) {
			return;
		}
		if (this.refreshInFlight) {
			this.refreshQueued = true;
			return;
		}

		const statusAll = this.pendingStatusAll;
		const statusRoots = [...this.pendingStatusRoots];
		const ignoredAll = this.pendingIgnoredAll;
		const ignoredRoots = [...this.pendingIgnoredRoots];
		this.pendingStatusAll = false;
		this.pendingStatusRoots.clear();
		this.pendingIgnoredAll = false;
		this.pendingIgnoredRoots.clear();

		const run = (async () => {
			if (!this.api?.repositories.length) {
				this.bindRepositoryEvents();
				this.ignoredByRoot.clear();
				this._onDidChange.fire();
				return;
			}

			const repos = statusAll
				? this.api.repositories
				: this.api.repositories.filter((repo) =>
						statusRoots.some((root) => pathsEqual(repo.rootUri.fsPath, root))
					);

			// Note: do NOT call the built-in 'git.refresh' command here. Without a repository
			// argument it opens a "Choose a repository" quick pick in multi-repo workspaces.
			if (repos.length) {
				await Promise.all(repos.map((repo) => repo.status().catch(() => undefined)));
			}

			if (ignoredAll) {
				await this.refreshIgnoredFiles();
			} else if (ignoredRoots.length) {
				await this.refreshIgnoredFiles(ignoredRoots);
			}

			this.bindRepositoryEvents();
			this._onDidChange.fire();
		})();

		this.refreshInFlight = run;
		try {
			await run;
		} finally {
			if (this.refreshInFlight === run) {
				this.refreshInFlight = undefined;
			}
			if (this.refreshQueued) {
				this.refreshQueued = false;
				void this.flushRefresh();
			}
		}
	}

	async stage(fsPath: string, options?: { force?: boolean }): Promise<void> {
		await this.stageMany([fsPath], options);
	}

	/**
	 * Stage many paths in as few git writes as possible (group by repo, chunk args).
	 * Avoids per-file add+status races that produce index.lock errors on large modules.
	 */
	async stageMany(fsPaths: string[], options?: { force?: boolean }): Promise<void> {
		if (!fsPaths.length) {
			return;
		}

		for (const fsPath of fsPaths) {
			await this.ensureSaved(fsPath);
		}

		const byRepo = new Map<Repository, string[]>();
		for (const fsPath of fsPaths) {
			const repo = this.requireRepoForFsPath(fsPath);
			const list = byRepo.get(repo);
			if (list) {
				list.push(fsPath);
			} else {
				byRepo.set(repo, [fsPath]);
			}
		}

		for (const [repo, paths] of byRepo) {
			if (options?.force) {
				const relatives = paths.map((fsPath) =>
					path.relative(repo.rootUri.fsPath, fsPath).replace(/\\/g, '/')
				);
				for (const args of chunkGitArgs(['add', '-f', '--'], relatives)) {
					await this.execGitWithIndexLockRetry(repo.rootUri.fsPath, args);
				}
				await this.runGitApi(repo, 'status', '', () => repo.status().catch(() => undefined));
				continue;
			}
			await this.runGitApi(repo, 'add', this.formatPaths(paths), () => repo.add(paths));
		}
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
			const repo = this.requireRepoByRoot(snap.rootPath);
			const toStage: string[] = [];
			const toUnstage: string[] = [];
			const trackedUnstaged = snap.unstaged.filter((item) => item.status !== '?');
			const seenStage = new Set<string>();
			const seenUnstage = new Set<string>();

			for (const item of trackedUnstaged) {
				const key = item.path.toLowerCase();
				if (!checkedSet.has(key) || seenStage.has(key)) {
					continue;
				}
				seenStage.add(key);
				toStage.push(item.fsPath);
			}
			for (const item of snap.staged) {
				const key = item.path.toLowerCase();
				if (checkedSet.has(key) || seenUnstage.has(key)) {
					continue;
				}
				seenUnstage.add(key);
				toUnstage.push(item.fsPath);
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

	/** Full commit details for the Push dialog (message, author, changed files). */
	async getPushCommitDetails(repoRoot: string, hash: string): Promise<PushCommitDetails> {
		const commit = hash.trim();
		if (!commit) {
			throw new Error('Commit hash is empty.');
		}
		const repo = this.requireRepoByRoot(repoRoot);
		const root = repo.rootUri.fsPath;
		const metaRaw = await this.queryGit(root, [
			'log',
			'-1',
			'--pretty=format:%H%n%h%n%an%n%ae%n%ad%n%s',
			'--date=format:%Y/%m/%d at %H:%M',
			commit,
		]);
		const lines = metaRaw.split(/\r?\n/);
		const fullHash = (lines[0] || commit).trim();
		const shortHash = (lines[1] || fullHash.slice(0, 8)).trim();
		const author = (lines[2] || '').trim();
		const email = (lines[3] || '').trim();
		const date = (lines[4] || '').trim();
		const subject = (lines[5] || '').trim();
		const messageRaw = await this.queryGit(root, ['log', '-1', '--pretty=format:%B', commit]);
		const message = (messageRaw || subject).replace(/\s+$/u, '');

		const filesRaw = await this.queryGit(root, [
			'show',
			'--name-status',
			'--format=',
			'--find-renames',
			fullHash,
		]);
		const files = parseCommitNameStatus(filesRaw);

		return {
			repoRoot: root,
			repoName: this.repoDisplayName(root),
			hash: fullHash,
			shortHash,
			subject,
			message,
			author,
			email,
			date,
			files,
		};
	}

	/** Diff a file between parent and commit (or open commit content if newly added). */
	async openCommitFileDiff(repoRoot: string, hash: string, relativePath: string): Promise<void> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}
		const commit = hash.trim();
		const rel = relativePath.replace(/\\/g, '/');
		if (!commit || !rel) {
			throw new Error('Commit hash or path is empty.');
		}
		const repo = this.requireRepoByRoot(repoRoot);
		const fsPath = path.join(repo.rootUri.fsPath, rel);
		const fileUri = vscode.Uri.file(fsPath);
		const right = this.api.toGitUri(fileUri, commit);
		const parentRef = `${commit}^`;
		let parentHasFile = false;
		try {
			await execFile(this.gitExecutable, ['cat-file', '-e', `${parentRef}:${rel}`], {
				cwd: repo.rootUri.fsPath,
				maxBuffer: 1024 * 1024,
				env: process.env,
			});
			parentHasFile = true;
		} catch {
			parentHasFile = false;
		}

		const title = `${path.basename(rel)} (${commit.slice(0, 8)})`;
		if (parentHasFile) {
			const left = this.api.toGitUri(fileUri, parentRef);
			await vscode.commands.executeCommand('vscode.diff', left, right, title, {
				preview: true,
				preserveFocus: false,
			});
			return;
		}
		const doc = await vscode.workspace.openTextDocument(right);
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
	}

	/**
	 * Generate a commit message for the current selection.
	 * 1) vscode.lm when available (VS Code + Copilot)
	 * 2) Cursor/Copilot SCM command with a temporary `.cursorrules` language hint
	 * 3) Locale fallback (Chinese summary) if AI still returns the wrong language
	 * @param customPrompt Optional mandatory user instruction forced into generation.
	 */
	async generateCommitMessageWithAi(
		checkedChanges: Array<{ repoRoot: string; path: string }>,
		unversionedPaths?: Array<{ repoRoot: string; path: string }>,
		customPrompt?: string
	): Promise<string> {
		const grouped = this.groupSelectedPathsByRepo(checkedChanges, unversionedPaths);
		if (!grouped.length) {
			throw new Error('No repository found.');
		}

		const prompt = (customPrompt || '').trim();
		const generatedByRepo: Array<{ repo: Repository; message: string }> = [];
		for (const item of grouped) {
			const message = await this.generateCommitMessageForRepo(item.repo, item.relativePaths, prompt);
			generatedByRepo.push({ repo: item.repo, message });
		}

		if (generatedByRepo.length === 1) {
			const single = generatedByRepo[0];
			single.repo.inputBox.value = single.message;
			return single.message;
		}

		const merged = this.formatMultiRepoCommitMessage(generatedByRepo);
		for (const item of generatedByRepo) {
			item.repo.inputBox.value = item.message;
		}
		return merged;
	}

	private groupSelectedPathsByRepo(
		checkedChanges: Array<{ repoRoot: string; path: string }>,
		unversionedPaths?: Array<{ repoRoot: string; path: string }>
	): Array<{ repo: Repository; relativePaths: string[] }> {
		const grouped = new Map<string, { repo: Repository; relativePaths: string[] }>();
		const all = [...checkedChanges, ...(unversionedPaths ?? [])];
		for (const entry of all) {
			const repo = this.requireRepoByRoot(entry.repoRoot);
			const key = normalizePathKey(repo.rootUri.fsPath);
			const existing = grouped.get(key);
			if (existing) {
				if (!existing.relativePaths.some((p) => pathsEqual(p, entry.path))) {
					existing.relativePaths.push(entry.path);
				}
				continue;
			}
			grouped.set(key, { repo, relativePaths: [entry.path] });
		}
		return [...grouped.values()];
	}

	private async generateCommitMessageForRepo(
		repo: Repository,
		relativePaths: string[],
		customPrompt = ''
	): Promise<string> {
		try {
			const viaLm = await generateCommitMessageWithLanguageModel(
				repo,
				relativePaths,
				customPrompt
			);
			if (viaLm?.trim()) {
				return this.ensureLocaleCommitMessage(viaLm.trim(), relativePaths);
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

		const viaScm = await withTemporaryCommitLanguageRule(
			repo.rootUri.fsPath,
			() => this.generateCommitMessageViaScmCommand(repo, customPrompt),
			customPrompt
		);
		return this.ensureLocaleCommitMessage(viaScm.trim(), relativePaths);
	}

	private formatMultiRepoCommitMessage(items: Array<{ repo: Repository; message: string }>): string {
		return items
			.map((item) => {
				const name = this.repoDisplayName(item.repo.rootUri.fsPath);
				const root = item.repo.rootUri.fsPath;
				return [
					`### [${name}] (${root})`,
					item.message.trim(),
				].join('\n');
			})
			.join('\n\n');
	}

	private ensureLocaleCommitMessage(message: string, relativePaths: string[]): string {
		const locale = resolveCommitMessageLocale();
		let text = message.trim();
		if (locale.wantsCjk && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text)) {
			text = buildLocaleFallbackMessage(relativePaths, text) ?? text;
		}
		return formatCommitMessageStyle(text, relativePaths);
	}

	private async generateCommitMessageViaScmCommand(
		repo: Repository,
		customPrompt = ''
	): Promise<string> {
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
		const rewritten = await rewriteCommitMessageForLocale(generated, customPrompt);
		if (rewritten?.trim()) {
			return rewritten.trim();
		}
		return generated;
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

	/**
	 * Whether AI commit-message generation can run in this environment.
	 * Needs a vscode.lm chat model, or Cursor / GitHub Copilot generate-commit command.
	 */
	async getCommitMessageGeneratorAvailability(): Promise<{
		available: boolean;
		reason?: string;
		provider?: 'language-model' | 'cursor' | 'copilot';
	}> {
		if (typeof vscode.lm?.selectChatModels === 'function') {
			try {
				const models = await Promise.resolve(vscode.lm.selectChatModels());
				if (models.length) {
					return { available: true, provider: 'language-model' };
				}
			} catch {
				// fall through to SCM commands
			}
		}

		const commandId = await this.resolveGenerateCommitMessageCommand();
		if (commandId === 'cursor.generateGitCommitMessage') {
			return { available: true, provider: 'cursor' };
		}
		if (commandId === 'github.copilot.git.generateCommitMessage') {
			return { available: true, provider: 'copilot' };
		}

		return {
			available: false,
			reason:
				'Auto-generate commit requires Cursor (generate commit command) or GitHub Copilot in VS Code.',
		};
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
		const perRepoMessage = parseMultiRepoCommitMessage(trimmed);
		for (const snap of targets) {
			const repo = this.requireRepoByRoot(snap.rootPath);
			const repoMessage = (perRepoMessage.get(normalizePathKey(snap.rootPath)) || trimmed).trim();
			const detail = `message="${this.summarizeCommitMessage(repoMessage)}"`;
			await this.runGitApi(repo, 'commit', detail, () =>
				repo.commit(repoMessage, { postCommitCommand: null })
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

	/**
	 * Latest remote tag name for the default / upstream remote (version-sorted).
	 * Returns undefined when there is no remote, no tags, or the lookup fails.
	 */
	async getLatestRemoteTag(repoRoot: string): Promise<string | undefined> {
		const repo = this.requireRepoByRoot(repoRoot);
		const remote = this.resolveDefaultRemote(repo);
		if (!remote) {
			return undefined;
		}
		const raw = await this.queryGit(repo.rootUri.fsPath, ['ls-remote', '--tags', '--refs', remote]);
		if (!raw) {
			return undefined;
		}
		const tags: string[] = [];
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			const tab = trimmed.lastIndexOf('\t');
			const ref = tab >= 0 ? trimmed.slice(tab + 1) : trimmed.split(/\s+/).pop() || '';
			const prefix = 'refs/tags/';
			if (ref.startsWith(prefix)) {
				tags.push(ref.slice(prefix.length));
			}
		}
		if (!tags.length) {
			return undefined;
		}
		tags.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
		return tags[0];
	}

	private canPushBranchWithTags(repo: Repository): boolean {
		const head = repo.state.HEAD;
		return !!(head?.upstream && head.name);
	}

	private resolveDefaultRemote(repo: Repository): string | undefined {
		const remotes = repo.state.remotes.map((r) => r.name);
		const upstreamRemote = repo.state.HEAD?.upstream?.remote;
		return (
			upstreamRemote ||
			(remotes.includes('origin') ? 'origin' : remotes[0])
		);
	}

	/** Push all local tags to the default / upstream remote. */
	private async pushAllTags(repoRoot: string): Promise<void> {
		const repo = this.requireRepoByRoot(repoRoot);
		const remote = this.resolveDefaultRemote(repo);
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

		const branchWithRepo = branch ? `${branch} (${snap.name})` : undefined;
		const label =
			branchWithRepo && remote && upstreamBranch
				? `${branchWithRepo} \u2192 ${remote} : ${upstreamBranch}`
				: branchWithRepo && upstream
					? `${branchWithRepo} \u2192 ${upstream}`
					: branchWithRepo ?? snap.name;

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
			const runArgs = this.withSessionProxyArgs(args);
			const { stdout, stderr } = await execFile(this.gitExecutable, runArgs, {
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
		await this.ensureSaved(fsPath);

		const fileName = path.basename(relativePath);
		const title = `Commit: ${fileName}  [F6 Previous / F7 Next]`;
		const diffOptions: vscode.TextDocumentShowOptions = {
			preview: false,
			preserveFocus: false,
			viewColumn: vscode.ViewColumn.Active,
		};

		await this.openHeadWorkingDiff(repo, relativePath, fsPath, title, diffOptions);
	}

	async navigateDiffNextChangeOrFile(): Promise<
		| {
				openedNextFile: false;
		  }
		| {
				openedNextFile: true;
				next: { repoRoot: string; path: string; staged: boolean };
		  }
	> {
		const current = this.resolveActiveDiffTarget();
		if (!current) {
			await vscode.commands.executeCommand('workbench.action.editor.nextChange');
			this.pendingDiffAdvance = undefined;
			return { openedNextFile: false };
		}
		const before = this.getActiveSelectionLineCharacter();
		await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
		const afterLine = this.getActiveSelectionLine();

		// VS Code compare-editor may wrap from the last change back to the first change.
		const wrappedToTop =
			before && afterLine != null && afterLine < before.line;

		if (!wrappedToTop) {
			// Still navigating within current file.
			this.pendingDiffAdvance = undefined;
			return { openedNextFile: false };
		}

		const shouldOpenNextFile =
			!!this.pendingDiffAdvance &&
			pathsEqual(this.pendingDiffAdvance.repoRoot, current.repoRoot) &&
			pathsEqual(this.pendingDiffAdvance.path, current.path);

		if (!shouldOpenNextFile) {
			// Restore caret back to the last change (we wrapped to the first).
			this.restoreActiveSelectionTo(before!.line, before!.character);
			this.pendingDiffAdvance = current;
			vscode.window.showInformationMessage(
				'You are at the last change in the current file. Press F7 again to jump to the first change of the next file.'
			);
			return { openedNextFile: false };
		}

		// Second F7 at boundary: open next file.
		this.pendingDiffAdvance = undefined;
		const files = this.getDiffNavigationFiles(current.repoRoot);
		const index = files.findIndex((item) => pathsEqual(item.path, current.path));
		if (index < 0 || index >= files.length - 1) {
			vscode.window.showInformationMessage('This is the last change file.');
			return { openedNextFile: false };
		}

		const next = files[index + 1];
		await this.openDiffInEditor(next.path, next.staged, current.repoRoot);
		// Ensure we land on the first change in the newly opened diff.
		await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
		return { openedNextFile: true, next: { repoRoot: current.repoRoot, path: next.path, staged: next.staged } };
	}

	async navigateDiffPreviousChangeOrFile(): Promise<
		| {
				openedPreviousFile: false;
		  }
		| {
				openedPreviousFile: true;
				previous: { repoRoot: string; path: string; staged: boolean };
		  }
	> {
		const current = this.resolveActiveDiffTarget();
		if (!current) {
			await vscode.commands.executeCommand('workbench.action.editor.previousChange');
			this.pendingDiffRetreat = undefined;
			return { openedPreviousFile: false };
		}
		const before = this.getActiveSelectionLineCharacter();
		await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
		const afterLine = this.getActiveSelectionLine();

		// VS Code compare-editor may wrap from the first change back to the last change.
		const wrappedToBottom =
			before && afterLine != null && afterLine > before.line;

		if (!wrappedToBottom) {
			this.pendingDiffRetreat = undefined;
			return { openedPreviousFile: false };
		}

		const shouldOpenPreviousFile =
			!!this.pendingDiffRetreat &&
			pathsEqual(this.pendingDiffRetreat.repoRoot, current.repoRoot) &&
			pathsEqual(this.pendingDiffRetreat.path, current.path);

		if (!shouldOpenPreviousFile) {
			// Restore caret back to the first change (we wrapped to the last).
			this.restoreActiveSelectionTo(before!.line, before!.character);
			this.pendingDiffRetreat = current;
			vscode.window.showInformationMessage(
				'You are at the first change in the current file. Press F6 again to jump to the last change of the previous file.'
			);
			return { openedPreviousFile: false };
		}

		// Second F6 at boundary: open previous file.
		this.pendingDiffRetreat = undefined;
		const files = this.getDiffNavigationFiles(current.repoRoot);
		const index = files.findIndex((item) => pathsEqual(item.path, current.path));
		if (index <= 0) {
			vscode.window.showInformationMessage('This is the first change file.');
			return { openedPreviousFile: false };
		}

		const previous = files[index - 1];
		await this.openDiffInEditor(previous.path, previous.staged, current.repoRoot);
		// Ensure we land on the last change in the newly opened diff.
		await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
		return {
			openedPreviousFile: true,
			previous: { repoRoot: current.repoRoot, path: previous.path, staged: previous.staged },
		};
	}

	private resolveActiveDiffTarget(): { repoRoot: string; path: string } | undefined {
		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		let uri: vscode.Uri | undefined;
		if (activeTab?.input instanceof vscode.TabInputTextDiff) {
			uri = activeTab.input.modified;
		}
		if (!uri && vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
			uri = vscode.window.activeTextEditor.document.uri;
		}
		if (!uri || uri.scheme !== 'file') {
			return undefined;
		}

		const repo = this.repoForUri(uri);
		if (!repo) {
			return undefined;
		}
		const repoRoot = repo.rootUri.fsPath;
		const relativePath = path.relative(repoRoot, uri.fsPath).replace(/\\/g, '/');
		if (!relativePath || relativePath.startsWith('..')) {
			return undefined;
		}
		return { repoRoot, path: relativePath };
	}

	getActiveDiffTargetForPanelSync(): { repoRoot: string; path: string } | undefined {
		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!(activeTab?.input instanceof vscode.TabInputTextDiff)) {
			return undefined;
		}
		const uri = activeTab.input.modified;
		if (uri.scheme !== 'file') {
			return undefined;
		}
		const repo = this.repoForUri(uri);
		if (!repo) {
			return undefined;
		}
		const repoRoot = repo.rootUri.fsPath;
		const relativePath = path.relative(repoRoot, uri.fsPath).replace(/\\/g, '/');
		if (!relativePath || relativePath.startsWith('..')) {
			return undefined;
		}
		return { repoRoot, path: relativePath };
	}

	getDiffEntryForPanelSync(
		repoRoot: string,
		relativePath: string
	): { path: string; staged: boolean } | undefined {
		const files = this.getDiffNavigationFiles(repoRoot);
		return files.find((item) => pathsEqual(item.path, relativePath));
	}

	private getDiffNavigationFiles(repoRoot: string): Array<{ path: string; staged: boolean }> {
		const repo = this.requireRepoByRoot(repoRoot);
		const snap = this.buildSnapshotForRepo(repo);
		const tracked = this.getTrackedChangeItems(snap).map((item) => ({
			path: item.path,
			staged: item.staged,
		}));
		const unversioned = snap.unversioned.map((item) => ({
			path: item.path,
			staged: false,
		}));
		const ordered = [...tracked, ...unversioned];
		const seen = new Set<string>();
		const files: Array<{ path: string; staged: boolean }> = [];
		for (const item of ordered) {
			const key = item.path.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			files.push(item);
		}
		return files;
	}

	private captureEditorCursorState(): string {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return '';
		}
		const selection = editor.selection.active;
		return [
			editor.document.uri.toString(),
			selection.line,
			selection.character,
			editor.visibleRanges.map((r) => `${r.start.line}:${r.end.line}`).join(','),
		].join('|');
	}

	private getActiveSelectionLine(): number | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		return editor.selection.active.line;
	}

	private getActiveSelectionLineCharacter(): { line: number; character: number } | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		return { line: editor.selection.active.line, character: editor.selection.active.character };
	}

	private restoreActiveSelectionTo(line: number, character: number): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const lineText = editor.document.lineAt(line);
		const nextChar = Math.max(0, Math.min(character, lineText.range.end.character));
		const pos = new vscode.Position(line, nextChar);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
	}

	private didEditorCursorMove(before: string): boolean {
		if (!before) {
			return false;
		}
		return before !== this.captureEditorCursorState();
	}

	private async jumpToLastChangeInActiveDiff(): Promise<void> {
		let guard = 0;
		let before = this.captureEditorCursorState();
		while (guard < 100) {
			await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
			const after = this.captureEditorCursorState();
			if (!after || after === before) {
				return;
			}
			before = after;
			guard += 1;
		}
	}

	/**
	 * True when path is untracked or newly added and not present in HEAD
	 * (cannot open a valid HEAD-side diff URI).
	 */
	async isAbsentFromHead(relativePath: string, repoRoot: string): Promise<boolean> {
		if (this.isUntracked(relativePath, repoRoot)) {
			return true;
		}
		const repo = this.requireRepoByRoot(repoRoot);
		return this.isNewToHead(repo, relativePath);
	}

	/**
	 * Step back one level:
	 * - Unversioned → delete from disk
	 * - Staged Changes → unstage (INDEX_ADDED becomes Unversioned)
	 * - Unstaged tracked → restore working tree to HEAD
	 */
	async rollbackFile(relativePath: string, repoRoot: string, staged?: boolean): Promise<void> {
		await this.rollbackMany([{ path: relativePath, repoRoot, staged }]);
	}

	/**
	 * Batch rollback: group by repo and issue one clean / revert / restore (or checkout) per class.
	 */
	async rollbackMany(
		entries: Array<{ path: string; repoRoot: string; staged?: boolean }>
	): Promise<void> {
		if (!entries.length) {
			return;
		}

		type PathItem = { relativePath: string; fsPath: string };
		type Bucket = {
			repo: Repository;
			repoRoot: string;
			untracked: PathItem[];
			staged: PathItem[];
			unstaged: PathItem[];
		};
		const byRepo = new Map<string, Bucket>();

		for (const entry of entries) {
			const repo = this.requireRepoByRoot(entry.repoRoot);
			const key = repo.rootUri.fsPath.replace(/\\/g, '/').toLowerCase();
			let bucket = byRepo.get(key);
			if (!bucket) {
				bucket = { repo, repoRoot: entry.repoRoot, untracked: [], staged: [], unstaged: [] };
				byRepo.set(key, bucket);
			}
			const fsPath = path.join(repo.rootUri.fsPath, entry.path);
			if (this.isUntracked(entry.path, entry.repoRoot)) {
				bucket.untracked.push({ relativePath: entry.path, fsPath });
				continue;
			}
			const treatAsStaged = entry.staged ?? this.isStaged(entry.path, entry.repoRoot);
			if (treatAsStaged) {
				bucket.staged.push({ relativePath: entry.path, fsPath });
			} else {
				bucket.unstaged.push({ relativePath: entry.path, fsPath });
			}
		}

		for (const bucket of byRepo.values()) {
			const { repo, untracked, staged, unstaged } = bucket;
			if (untracked.length) {
				const fsPaths = untracked.map((item) => item.fsPath);
				await this.runGitApi(repo, 'clean (untracked)', this.formatPaths(fsPaths), () =>
					repo.clean(fsPaths)
				);
				for (const item of untracked) {
					if (await fileExists(item.fsPath)) {
						await fs.unlink(item.fsPath);
					}
				}
			}
			if (staged.length) {
				const fsPaths = staged.map((item) => item.fsPath);
				await this.runGitApi(repo, 'revert (unstage)', this.formatPaths(fsPaths), () =>
					repo.revert(fsPaths)
				);
			}
			if (unstaged.length) {
				await this.discardPathsToHead(repo, unstaged);
			}
		}

		await this.refresh();
	}

	isUntracked(relativePath: string, repoRoot: string): boolean {
		const repo = this.requireRepoByRoot(repoRoot);
		const snap = this.buildSnapshotForRepo(repo);
		return snap.unversioned.some((i) => pathsEqual(i.path, relativePath));
	}

	isStaged(relativePath: string, repoRoot: string): boolean {
		const repo = this.requireRepoByRoot(repoRoot);
		const snap = this.buildSnapshotForRepo(repo);
		return snap.staged.some((i) => pathsEqual(i.path, relativePath));
	}

	/** True when the path is untracked/new and does not exist in HEAD (no valid HEAD blob). */
	private async isNewToHead(repo: Repository, relativePath: string): Promise<boolean> {
		const root = repo.rootUri.fsPath;
		const matchesPath = (change: Change): boolean =>
			pathsEqual(path.relative(root, change.uri.fsPath).replace(/\\/g, '/'), relativePath);

		const allChanges = [
			...repo.state.indexChanges,
			...repo.state.workingTreeChanges,
			...(repo.state.untrackedChanges ?? []),
			...repo.state.mergeChanges,
		];
		const matched = allChanges.filter(matchesPath);
		const absentStatuses = new Set<Status>([
			Status.UNTRACKED,
			Status.INDEX_ADDED,
			Status.INTENT_TO_ADD,
			Status.BOTH_ADDED,
			Status.ADDED_BY_US,
			Status.ADDED_BY_THEM,
		]);
		// Any "added-like" status means HEAD has no blob (even if also MODIFIED after add).
		if (matched.some((c) => absentStatuses.has(c.status))) {
			return true;
		}

		// Authoritative check — do not trust status alone for tracked-looking paths.
		const headPath = relativePath.replace(/\\/g, '/');
		try {
			await execFile(this.gitExecutable, ['cat-file', '-e', `HEAD:${headPath}`], {
				cwd: root,
				maxBuffer: 1024 * 1024,
				env: process.env,
			});
			return false;
		} catch {
			return true;
		}
	}

	/** Restore working tree to HEAD for unstaged tracked changes (batched). */
	private async discardPathsToHead(
		repo: Repository,
		items: Array<{ relativePath: string; fsPath: string }>
	): Promise<void> {
		if (!items.length) {
			return;
		}
		const fsPaths = items.map((item) => item.fsPath);
		const restoreFn = (repo as Repository & { restore?: typeof repo.restore }).restore;
		if (typeof restoreFn === 'function') {
			try {
				await this.runGitApi(repo, 'restore (working tree)', this.formatPaths(fsPaths), () =>
					restoreFn.call(repo, fsPaths, { ref: 'HEAD' })
				);
				return;
			} catch {
				// Fall through to git checkout
			}
		}

		const relatives = items.map((item) => item.relativePath);
		for (const args of chunkGitArgs(['checkout', 'HEAD', '--'], relatives)) {
			await this.execGitWithIndexLockRetry(repo.rootUri.fsPath, args);
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
			throw new Error(formatGitError(err));
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
			const runArgs = this.withSessionProxyArgs(args);
			const command = formatGitShellCommand(runArgs);
		logGitStart(cwd, command);
		const started = Date.now();
		try {
				const { stdout, stderr } = await execFile(this.gitExecutable, runArgs, {
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

	/** Retry briefly when another git process (often VS Code's) holds index.lock. */
	private async execGitWithIndexLockRetry(
		cwd: string,
		args: string[],
		env?: NodeJS.ProcessEnv
	): Promise<void> {
		const maxAttempts = 6;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				await this.execGit(cwd, args, env);
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!isIndexLockError(message) || attempt === maxAttempts) {
					throw err;
				}
				await sleep(40 * attempt);
			}
		}
	}

	async openRollbackDiff(relativePath: string, repoRoot: string): Promise<void> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		const repo = this.requireRepoByRoot(repoRoot);
		const fsPath = path.join(repo.rootUri.fsPath, relativePath);
		await this.ensureSaved(fsPath);

		const title = `${relativePath} (Rollback preview)  [F6 Previous / F7 Next]`;
		await this.openHeadWorkingDiff(repo, relativePath, fsPath, title);
	}

	private maybeShowDiffNavHint(): void {
		vscode.window.showInformationMessage(
			'Diff navigation: F6 previous change/file, F7 next change/file. Press F7 (or F6) again at file boundaries.'
		);
		this.applyDiffNavTopDecoration();
	}

	private applyDiffNavTopDecoration(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		if (!this.diffNavDecorationType) {
			this.diffNavDecorationType = vscode.window.createTextEditorDecorationType({
				before: {
					contentText: ' F6/F7: Prev/Next change or file ',
					color: '#ffffff',
					backgroundColor: 'rgba(88, 122, 200, 0.35)',
					fontWeight: '600',
				},
			});
		}

		// Attach the label to the very first character of the document.
		const pos = new vscode.Position(0, 0);
		editor.setDecorations(this.diffNavDecorationType, [new vscode.Range(pos, pos)]);
	}

	/**
	 * Open left/right diff for HEAD vs working tree.
	 * When HEAD has no blob (new/untracked), open the working-tree file directly.
	 * Deleted tracked files use HEAD vs empty right document.
	 * @returns true when a compare editor was opened (F6/F7 apply).
	 */
	private async openHeadWorkingDiff(
		repo: Repository,
		relativePath: string,
		fsPath: string,
		title: string,
		diffOptions?: vscode.TextDocumentShowOptions
	): Promise<boolean> {
		if (!this.api) {
			throw new Error('VS Code Git extension is not available.');
		}

		const fileUri = vscode.Uri.file(fsPath);
		const workingExists = await fileExists(fsPath);
		const root = repo.rootUri.fsPath;
		const absentFromHead =
			this.isUntracked(relativePath, root) || (await this.isNewToHead(repo, relativePath));

		const showOpts: vscode.TextDocumentShowOptions = {
			preview: false,
			preserveFocus: false,
			viewColumn: vscode.ViewColumn.Active,
			...(diffOptions ?? {}),
		};

		// No version in HEAD → show file content (do not use toGitUri HEAD / empty-left diff).
		if (absentFromHead) {
			if (workingExists) {
				const doc = await vscode.workspace.openTextDocument(fileUri);
				await vscode.window.showTextDocument(doc, showOpts);
				return false;
			}
			const empty = await vscode.workspace.openTextDocument({ content: '' });
			await vscode.window.showTextDocument(empty, showOpts);
			return false;
		}

		const left = this.api.toGitUri(fileUri, 'HEAD');
		const right = workingExists
			? fileUri
			: (await vscode.workspace.openTextDocument({ content: '' })).uri;

		await vscode.commands.executeCommand('vscode.diff', left, right, title, diffOptions);
		this.maybeShowDiffNavHint();
		return true;
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
				repo.state.onDidChange(() => {
					if (this.refreshSuspended > 0) {
						this.changePendingWhileSuspended = true;
						return;
					}
					this._onDidChange.fire();
				})
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

/** Decode porcelain path (possibly C-quoted). */
function unescapeGitPath(raw: string): string {
	const trimmed = raw.trim();
	if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
		return trimmed;
	}
	const inner = trimmed.slice(1, -1);
	let out = '';
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i];
		if (ch !== '\\') {
			out += ch;
			continue;
		}
		const next = inner[i + 1];
		if (next === undefined) {
			out += '\\';
			break;
		}
		if (next === 'n') {
			out += '\n';
			i += 1;
		} else if (next === 't') {
			out += '\t';
			i += 1;
		} else if (next === 'r') {
			out += '\r';
			i += 1;
		} else if (next === '"' || next === '\\') {
			out += next;
			i += 1;
		} else if (next >= '0' && next <= '7') {
			let oct = next;
			let consumed = 1;
			for (let j = 2; j <= 3 && i + j < inner.length; j += 1) {
				const d = inner[i + j];
				if (d < '0' || d > '7') {
					break;
				}
				oct += d;
				consumed += 1;
			}
			out += String.fromCharCode(parseInt(oct, 8));
			i += consumed;
		} else {
			out += next;
			i += 1;
		}
	}
	return out;
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

function parseCloneProgressLine(rawLine: string): CloneProgress | undefined {
	const line = rawLine.replace(/^remote:\s*/i, '').trim();
	if (!line) {
		return undefined;
	}
	const make = (
		phase: CloneProgress['phase'],
		detail: string,
		percent?: number,
		meta?: { downloadedKB?: number; totalKB?: number; speedKBps?: number }
	): CloneProgress => ({
		phase,
		overallPercent: mapCloneOverallPercent(phase, percent),
		percent,
		downloadedKB: meta?.downloadedKB,
		totalKB: meta?.totalKB,
		speedKBps: meta?.speedKBps,
		detail: detail.trim(),
	});
	let m = /^(Enumerating|Counting) objects:\s*(\d+)%/.exec(line);
	if (m) {
		return make('counting', line, clampPercent(Number(m[2])));
	}
	m = /^Compressing objects:\s*(\d+)%/.exec(line);
	if (m) {
		return make('compressing', line, clampPercent(Number(m[1])));
	}
	m = /^Receiving objects:\s*(\d+)%/.exec(line);
	if (m) {
		const percent = clampPercent(Number(m[1]));
		const downloadedKB = parseSizeToKB(captureAmount(line));
		const speedKBps = parseSizeToKB(captureSpeed(line));
		const totalKB =
			typeof downloadedKB === 'number' && percent > 0
				? roundKB(downloadedKB / (percent / 100))
				: undefined;
		return make('receiving', line, percent, { downloadedKB, totalKB, speedKBps });
	}
	m = /^Resolving deltas:\s*(\d+)%/.exec(line);
	if (m) {
		return make('resolving', line, clampPercent(Number(m[1])));
	}
	if (/^Updating files:/i.test(line)) {
		const p = /(\d+)%/.exec(line);
		return make('updating', line, p ? clampPercent(Number(p[1])) : undefined);
	}
	if (/^Receiving objects:/i.test(line)) {
		const downloadedKB = parseSizeToKB(captureAmount(line));
		const speedKBps = parseSizeToKB(captureSpeed(line));
		return make('receiving', line, undefined, { downloadedKB, speedKBps });
	}
	if (/^Resolving deltas:/i.test(line)) {
		return make('resolving', line);
	}
	return make('other', line);
}

function clampPercent(v: number): number {
	if (!Number.isFinite(v)) {
		return 0;
	}
	return Math.max(0, Math.min(100, v));
}

function mapCloneOverallPercent(phase: CloneProgress['phase'], percent?: number): number | undefined {
	const p = typeof percent === 'number' ? clampPercent(percent) : undefined;
	switch (phase) {
		case 'counting':
			return p == null ? 2 : roundKB((p / 100) * 10);
		case 'compressing':
			return p == null ? 12 : roundKB(10 + (p / 100) * 12);
		case 'receiving':
			return p == null ? 24 : roundKB(22 + (p / 100) * 63);
		case 'resolving':
			return p == null ? 88 : roundKB(85 + (p / 100) * 13);
		case 'updating':
			return p == null ? 99 : roundKB(98 + (p / 100) * 2);
		default:
			return p;
	}
}

function captureAmount(line: string): string | undefined {
	const m = /,\s*([0-9.]+\s*[KMGT]?i?B)\s*(?:\||$)/i.exec(line);
	return m?.[1];
}

function captureSpeed(line: string): string | undefined {
	const m = /\|\s*([0-9.]+\s*[KMGT]?i?B)\/s/i.exec(line);
	return m?.[1];
}

function parseSizeToKB(raw?: string): number | undefined {
	if (!raw) {
		return undefined;
	}
	const m = /^([0-9.]+)\s*([KMGT]?i?B)$/i.exec(raw.trim());
	if (!m) {
		return undefined;
	}
	const value = Number(m[1]);
	if (!Number.isFinite(value)) {
		return undefined;
	}
	const unit = m[2].toUpperCase();
	let kb = value;
	if (unit === 'B') {
		kb = value / 1024;
	} else if (unit === 'KIB' || unit === 'KB') {
		kb = value;
	} else if (unit === 'MIB' || unit === 'MB') {
		kb = value * 1024;
	} else if (unit === 'GIB' || unit === 'GB') {
		kb = value * 1024 * 1024;
	} else if (unit === 'TIB' || unit === 'TB') {
		kb = value * 1024 * 1024 * 1024;
	}
	return roundKB(kb);
}

function roundKB(value: number): number {
	return Math.round(value * 100) / 100;
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

function parseCommitNameStatus(raw: string): Array<{ path: string; status: string }> {
	if (!raw.trim()) {
		return [];
	}
	const files: Array<{ path: string; status: string }> = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const tab = trimmed.indexOf('\t');
		if (tab < 0) {
			continue;
		}
		const statusRaw = trimmed.slice(0, tab).trim();
		const pathPart = trimmed.slice(tab + 1).trim();
		if (!pathPart) {
			continue;
		}
		// Renames: R100\told\tnew  or show as "old => new"
		const paths = pathPart.split('\t').filter(Boolean);
		const filePath = (paths[paths.length - 1] || pathPart).replace(/\\/g, '/');
		const status = statusRaw.charAt(0) || 'M';
		files.push({ path: filePath, status });
	}
	return files;
}

function parseMultiRepoCommitMessage(message: string): Map<string, string> {
	const map = new Map<string, string>();
	const lines = message.replace(/\r\n/g, '\n').split('\n');
	let currentRootKey = '';
	let currentBody: string[] = [];

	const flush = () => {
		if (!currentRootKey) {
			return;
		}
		const text = currentBody.join('\n').trim();
		if (text) {
			map.set(currentRootKey, text);
		}
	};

	for (const line of lines) {
		const header = line.match(/^###\s+\[[^\]]+]\s+\((.+)\)\s*$/);
		if (header) {
			flush();
			currentRootKey = normalizePathKey(header[1].trim());
			currentBody = [];
			continue;
		}
		if (currentRootKey) {
			currentBody.push(line);
		}
	}
	flush();
	return map;
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

/** Skip .git internals so status/index writes do not re-trigger our watchers. */
function isGitInternalPath(fsPath: string): boolean {
	const normalized = fsPath.replace(/\\/g, '/');
	return /(?:^|\/)\.git(?:\/|$)/.test(normalized);
}

/** Create/delete/.gitignore-style paths may change the ignored list. */
function pathNeedsIgnoredRefresh(fsPath: string): boolean {
	const base = path.basename(fsPath);
	if (base === '.gitignore' || base === '.ignore') {
		return true;
	}
	const normalized = fsPath.replace(/\\/g, '/');
	return normalized.endsWith('/.git/info/exclude');
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

/**
 * If tag starts with `v` and ends with digits, return the same tag with the
 * trailing number incremented (e.g. `v1.0.3` → `v1.0.4`). Otherwise undefined.
 */
export function bumpTrailingVTag(tagName: string | undefined): string | undefined {
	const name = tagName?.trim();
	if (!name || !name.startsWith('v')) {
		return undefined;
	}
	const match = /^(.*)(\d+)$/.exec(name);
	if (!match) {
		return undefined;
	}
	const next = `${match[1]}${Number(match[2]) + 1}`;
	return isValidTagName(next) ? next : undefined;
}

function isIndexLockError(message: string): boolean {
	return /index\.lock/i.test(message) || /Another git process seems to be running/i.test(message);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep git argv under typical Windows CreateProcess length limits. */
function chunkGitArgs(baseArgs: string[], pathArgs: string[], maxLen = 7000): string[][] {
	if (!pathArgs.length) {
		return [];
	}
	const chunks: string[][] = [];
	let current = [...baseArgs];
	let len = current.reduce((sum, part) => sum + part.length + 1, 0);
	for (const pathArg of pathArgs) {
		const add = pathArg.length + 1;
		if (current.length > baseArgs.length && len + add > maxLen) {
			chunks.push(current);
			current = [...baseArgs];
			len = current.reduce((sum, part) => sum + part.length + 1, 0);
		}
		current.push(pathArg);
		len += add;
	}
	if (current.length > baseArgs.length) {
		chunks.push(current);
	}
	return chunks;
}
