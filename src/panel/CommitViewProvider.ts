import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { bumpTrailingVTag, GitService } from '../git/GitService';
import { FastPushFlags, FastPushSettingsStore } from '../fastPush/settings';
import {
	CommitMessagePrefixFlags,
	CommitMessagePrefixSettingsStore,
} from '../commitMessage/prefixSettings';
import {
	expandPrefixTemplate,
	enforcePromptRequiredPrefix,
	stripLeadingVersionDatePrefix,
} from '../commitMessage/prefixTemplate';
import { UpdateAllSelectionStore } from '../updateAll/selectionStore';
import { notifyGitError } from '../git/gitOutput';
import { showTimedInfoMessage } from '../ui/notify';
import { CommitRepoResult, HostToWebview, WebviewToHost, WorkspaceSnapshot } from './messages';
import { PushDialogProvider } from './PushDialogProvider';

export class CommitViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'copyIdeaGitUi.commitView';
	private static readonly activityBarId = 'workbench.view.extension.copyIdeaGitUi';

	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];
	private busy = false;
	/**
	 * First-paint / open refresh in flight — webview shows Loading instead of empty Changes.
	 * Distinct from `busy` (operation overlay) so status wait does not look like a freeze.
	 */
	private panelLoading = false;
	/** Skip mid-operation snapshot pushes so the UI updates once, like IDEA. */
	private snapshotDeferredWhileBusy = false;
	/** Coalesce rapid onDidChange → snapshot pushes (status + dirty edits). */
	private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	/** Skip posting when a silent poll produced the same file list (avoids resetting scroll). */
	private lastSnapshotFingerprint = '';
	/** Coalesce deferred ignored-file scans after a status-only first paint. */
	private ignoredRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** In-flight status-only panel refresh (open / visibility) — coalesce overlaps. */
	private statusOnlyRefreshPromise?: Promise<void>;
	/** Bust webview media cache only when commit.js/css actually change. */
	private loadedMediaVersion = '';
	private selected?: { repoRoot: string; path: string; staged: boolean };
	private operationChain: Promise<void> = Promise.resolve();
	private pendingFocusMessage = false;
	private pendingExpandChanges = false;
	private updateAllOpen = false;
	private updateAllResolver?: (repoRoots: string[] | undefined) => void;
	private pendingUpdateAllRepos?: Array<{ rootPath: string; name: string; checked: boolean }>;
	private fastPushConfirmOpen = false;
	private fastPushCommitResolver?: (message: string | undefined) => void;
	/** In-flight commit-log fetch keyed by normalized repo root (dedupe concurrent loads). */
	private commitLogInFlight?: { key: string; promise: Promise<void> };
	private readonly fastPushSettings: FastPushSettingsStore;
	private readonly commitPrefixSettings: CommitMessagePrefixSettingsStore;
	private readonly updateAllSelection: UpdateAllSelectionStore;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitService,
		private readonly pushDialog: PushDialogProvider,
		private readonly onInstallKeybindings: () => Promise<void>,
		private readonly waitForGitInit: () => Promise<void>,
		context: vscode.ExtensionContext
	) {
		this.fastPushSettings = new FastPushSettingsStore(context);
		this.commitPrefixSettings = new CommitMessagePrefixSettingsStore(context);
		this.updateAllSelection = new UpdateAllSelectionStore(context);
		this.disposables.push(
			this.git.onDidChange(() => {
				if (this.busy) {
					this.snapshotDeferredWhileBusy = true;
					return;
				}
				this.schedulePushSnapshot();
			})
		);
	}

	dispose(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
		if (this.ignoredRefreshTimer) {
			clearTimeout(this.ignoredRefreshTimer);
			this.ignoredRefreshTimer = undefined;
		}
		this.git.setCommitPanelVisible(false);
		this.resolveUpdateAll(undefined);
		this.resolveFastPushCommit(undefined);
		this.fastPushConfirmOpen = false;
		this.disposables.forEach((d) => d.dispose());
	}

	isUpdateAllDialogOpen(): boolean {
		return this.updateAllOpen;
	}

	isFastPushConfirmOpen(): boolean {
		return this.fastPushConfirmOpen;
	}

	isVisible(): boolean {
		return !!this.view?.visible;
	}

	/** Ask the open Fast Push confirm dialog to proceed (second Ctrl+Alt+K). */
	submitFastPushConfirm(): void {
		if (!this.fastPushConfirmOpen) {
			return;
		}
		this.post({ type: 'fastPushConfirmSubmit' });
	}

	/** Ask the open Update All dialog to submit the current selection (second Ctrl+T). */
	submitUpdateAllDialog(): void {
		if (!this.updateAllOpen) {
			return;
		}
		this.post({ type: 'updateAllSubmit' });
	}

	/**
	 * Show repository selection dialog before pull-all.
	 * Resolves to selected repo roots, or undefined when cancelled.
	 */
	async confirmUpdateAll(
		repos: Array<{ rootPath: string; name: string }>
	): Promise<string[] | undefined> {
		this.resolveUpdateAll(undefined);
		const confirmed = new Promise<string[] | undefined>((resolve) => {
			this.updateAllResolver = resolve;
		});
		this.updateAllOpen = true;
		this.pendingUpdateAllRepos = this.updateAllSelection.resolve(repos);
		await this.reveal(false, false);
		this.tryShowUpdateAllDialog();
		return confirmed;
	}

	private tryShowUpdateAllDialog(): void {
		if (!this.updateAllOpen || !this.pendingUpdateAllRepos || !this.view || !this.updateAllResolver) {
			return;
		}
		this.post({
			type: 'showUpdateAllDialog',
			payload: { repos: this.pendingUpdateAllRepos },
		});
	}

	private resolveUpdateAll(repoRoots: string[] | undefined): void {
		const resolve = this.updateAllResolver;
		this.updateAllResolver = undefined;
		this.updateAllOpen = false;
		this.pendingUpdateAllRepos = undefined;
		resolve?.(repoRoots);
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;
		this.git.setCommitPanelVisible(webviewView.visible);

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};

		try {
			this.loadedMediaVersion = this.getMediaVersion();
			webviewView.webview.html = this.getHtml(webviewView.webview);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			webviewView.webview.html = `<!DOCTYPE html><html><body><p>Pink Hunk Git failed to load: ${message}</p></body></html>`;
		}

		this.disposables.push(
			webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg)),
			webviewView.onDidChangeVisibility(() => {
				this.git.setCommitPanelVisible(webviewView.visible);
				if (!webviewView.visible) {
					return;
				}
				const mediaVersion = this.getMediaVersion();
				if (mediaVersion !== this.loadedMediaVersion) {
					this.loadedMediaVersion = mediaVersion;
					try {
						webviewView.webview.html = this.getHtml(webviewView.webview);
					} catch {
						// keep existing html
					}
				}
				// Soft reopen: paint cached repo.state, catch up status in background.
				void this.softRefreshAndPush();
			})
		);

		void (async () => {
			this.panelLoading = true;
			await this.pushSnapshot();
			try {
				await this.waitForGitInit();
			} finally {
				this.panelLoading = false;
			}
			// First paint from vscode.git in-memory state — do not await full discovery/status.
			// If discovery still has 0 repos, snapshot.loading keeps the Working overlay up.
			await this.pushSnapshot();
			if (webviewView.visible) {
				void this.softRefreshAndPush();
			}
		})();
	}

	async reveal(focusMessage = false, expandChanges = false): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.focusSideBar');
		await vscode.commands.executeCommand(CommitViewProvider.activityBarId);
		if (this.view) {
			this.view.show(true);
			this.git.setCommitPanelVisible(true);
		} else {
			await vscode.commands.executeCommand(`${CommitViewProvider.viewType}.focus`);
		}
		// Soft first paint, then full status in background (Ctrl+K should feel instant).
		await this.softRefreshAndPush();
		void this.refreshAndPush({ ignored: false });
		if (expandChanges) {
			this.expandChangesGroups();
		}
		if (focusMessage) {
			this.focusCommitMessage();
		}
	}

	private focusCommitMessage(): void {
		if (this.view) {
			this.post({ type: 'focusMessage' });
		} else {
			this.pendingFocusMessage = true;
		}
	}

	private expandChangesGroups(): void {
		if (this.view) {
			this.post({ type: 'expandChanges' });
		} else {
			this.pendingExpandChanges = true;
		}
	}

	async showDiffForSelection(): Promise<void> {
		await this.reveal();
		this.post({ type: 'triggerShowDiff' });
	}

	async openFileForSelection(): Promise<void> {
		await this.reveal();
		this.post({ type: 'triggerOpenFile' });
	}

	async revealSelectionInExplorer(): Promise<void> {
		await this.reveal();
		this.post({ type: 'triggerRevealInExplorer' });
	}

	async selectFileInPanel(repoRoot: string, filePath: string, staged: boolean): Promise<void> {
		this.git.setActiveRepository(repoRoot);
		this.setSelection(repoRoot, filePath, staged);
		await this.pushSnapshot();
		this.post({ type: 'selectFile', repoRoot, path: filePath, staged });
	}

	private async openFile(repoRoot: string, relativePath: string): Promise<void> {
		const fsPath = this.toFsPath(repoRoot, relativePath);
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
		} catch {
			vscode.window.showErrorMessage(`File not found on disk: ${relativePath}`);
			return;
		}
		const uri = vscode.Uri.file(fsPath);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
	}

	private async revealInExplorer(repoRoot: string, relativePath: string): Promise<void> {
		const fsPath = this.toFsPath(repoRoot, relativePath);
		const uri = vscode.Uri.file(fsPath);
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			vscode.window.showErrorMessage(`File not found on disk: ${relativePath}`);
			return;
		}
		await vscode.commands.executeCommand('revealInExplorer', uri);
	}

	async rollbackForSelection(): Promise<void> {
		await this.reveal();
		this.post({ type: 'triggerRollback' });
	}

	async addToGit(): Promise<void> {
		await this.reveal();
		this.post({ type: 'triggerAddToGit' });
	}

	async triggerCommit(): Promise<void> {
		await this.reveal(true, false);
		this.post({ type: 'triggerCommit' });
	}

	async triggerCommitAndPush(): Promise<void> {
		await this.reveal(true, false);
		this.post({ type: 'triggerCommitAndPush' });
	}

	async triggerFastPush(options?: { requireConfirm?: boolean }): Promise<void> {
		await this.reveal();
		if (options?.requireConfirm) {
			const capability = await this.git.getCommitMessageGeneratorAvailability();
			const settings = this.fastPushSettings.getEffective(capability);
			const wantedGenerate =
				(this.fastPushSettings.getWorkspace() ?? this.fastPushSettings.getGlobal())
					.autoGenerateCommit;
			const steps = [
				wantedGenerate ? 'Prepare commit message (AI or manual fallback)' : 'Use Commit Message box',
				'Commit',
			];
			if (settings.autoNewTag) {
				steps.push('Auto-bump remote v* tag');
			}
			if (settings.autoPush) {
				steps.push('Push (auto-merge on reject)');
			} else {
				steps.push('Open Push dialog');
			}
			this.fastPushConfirmOpen = true;
			this.post({
				type: 'showFastPushConfirmDialog',
				payload: {
					steps,
					shortcutLabel: process.platform === 'darwin' ? 'Cmd+Alt+K' : 'Ctrl+Alt+K',
				},
			});
			return;
		}
		this.post({ type: 'triggerFastPush' });
	}

	private async stageUnversionedPaths(
		paths?: Array<{ repoRoot: string; path: string }>
	): Promise<void> {
		if (!paths?.length) {
			return;
		}
		const fsPaths = paths.map(({ repoRoot, path: rel }) => this.toFsPath(repoRoot, rel));
		await this.git.stageMany(fsPaths, { force: true });
	}

	private async generateCommitMessage(
		checkedChanges: Array<{ repoRoot: string; path: string }>,
		unversionedPaths?: Array<{ repoRoot: string; path: string }>
	): Promise<void> {
		this.post({ type: 'generateCommitMessageState', busy: true });
		try {
			if (!checkedChanges.length && !(unversionedPaths?.length)) {
				throw new Error('Select files to include before generating a commit message.');
			}
			await this.git.applyCommitSelection(checkedChanges);
			await this.stageUnversionedPaths(unversionedPaths);
			await this.git.refresh();
			const generated = await this.git.generateCommitMessageWithAi(
				checkedChanges,
				unversionedPaths,
				this.commitPrefixSettings.getEffectivePrompt()
			);
			const message = this.applyConfiguredCommitPrefix(generated);
			this.post({ type: 'setMessage', message });
		} catch (err) {
			const message = await notifyGitError(err);
			this.post({ type: 'error', message });
		} finally {
			this.post({ type: 'generateCommitMessageState', busy: false });
		}
	}

	/**
	 * Fast Push: optionally generate commit message → commit → optionally auto bump v-tag → optionally push.
	 * Steps follow Fast Push settings (workspace overrides global).
	 * If auto-generate is blocked or fails, prompt for a manual commit message and continue.
	 * On push rejection auto-merge; unresolved conflicts fall back to Push conflict UI.
	 * If auto-tag is on but cannot bump, open Push dialog + New Tag modal.
	 */
	private async handleFastPush(
		checkedChanges: Array<{ repoRoot: string; path: string }>,
		unversionedPaths?: Array<{ repoRoot: string; path: string }>,
		providedMessage?: string
	): Promise<void> {
		if (!checkedChanges.length && !(unversionedPaths?.length)) {
			throw new Error('Select files to include before Fast Push.');
		}

		const capability = await this.git.getCommitMessageGeneratorAvailability();
		const settings = this.fastPushSettings.getEffective(capability);
		const wantedGenerate =
			(this.fastPushSettings.getWorkspace() ?? this.fastPushSettings.getGlobal()).autoGenerateCommit;

		const stepLabels = ['Commit message', 'Commit'];
		if (settings.autoNewTag) {
			stepLabels.push('New tag');
		}
		if (settings.autoPush) {
			stepLabels.push('Push');
		}
		const total = stepLabels.length;
		let completed = 0;
		const report = (label: string) => {
			this.post({
				type: 'fastPushProgress',
				current: completed,
				total,
				label,
			});
		};
		const completeStep = () => {
			completed = Math.min(completed + 1, total);
			this.post({
				type: 'fastPushProgress',
				current: completed,
				total,
				label: completed >= total ? 'Done' : stepLabels[completed] || 'Working…',
			});
		};

		await this.git.applyCommitSelection(checkedChanges);
		await this.stageUnversionedPaths(unversionedPaths);
		await this.git.refresh();

		report('Preparing commit message…');
		let message = '';
		let generateBlockReason: string | undefined;

		if (wantedGenerate) {
			if (!capability.available) {
				generateBlockReason =
					capability.reason ||
					'Auto-generate commit requires Cursor (generate commit command) or GitHub Copilot in VS Code.';
			} else {
				this.post({ type: 'generateCommitMessageState', busy: true });
				try {
					message = this.applyConfiguredCommitPrefix(
						(
							await this.git.generateCommitMessageWithAi(
								checkedChanges,
								unversionedPaths,
								this.commitPrefixSettings.getEffectivePrompt()
							)
						).trim()
					);
					if (message) {
						this.post({ type: 'setMessage', message });
					} else {
						generateBlockReason = 'Auto-generate commit returned an empty message.';
					}
				} catch (err) {
					generateBlockReason = err instanceof Error ? err.message : String(err);
				} finally {
					this.post({ type: 'generateCommitMessageState', busy: false });
				}
			}
		} else {
			message = (providedMessage || '').trim();
		}

		if (!message) {
			const reason =
				generateBlockReason ||
				(wantedGenerate
					? 'Auto-generate commit was blocked. Enter a commit message to continue Fast Push.'
					: 'Enter a commit message to continue Fast Push.');
			report('Waiting for commit message…');
			const entered = await this.promptFastPushCommitMessage(reason, providedMessage);
			if (!entered) {
				return;
			}
			message = entered;
			this.post({ type: 'setMessage', message });
		}
		completeStep();

		report('Committing…');
		// Re-apply checkbox selection immediately before commit (files may change during AI / prompt).
		const committed = await this.git.commitSelection(message, checkedChanges, unversionedPaths);
		showTimedInfoMessage(formatCommittedMessage(committed));
		this.post({ type: 'clearMessage' });
		completeStep();

		const roots = committed.map((repo) => repo.rootPath);
		let createdTags = false;

		if (settings.autoNewTag) {
			report('Creating tag…');
			const tagPlans: Array<{ root: string; name: string; nextTag: string }> = [];
			for (const root of roots) {
				const snap = this.git.getWorkspaceSnapshot().repositories.find(
					(r) =>
						r.rootPath.replace(/\\/g, '/').toLowerCase() ===
						root.replace(/\\/g, '/').toLowerCase()
				);
				const name = snap?.name ?? root;
				let latest: string | undefined;
				try {
					latest = await this.git.getLatestRemoteTag(root);
				} catch {
					latest = undefined;
				}
				const nextTag = bumpTrailingVTag(latest);
				if (!nextTag) {
					vscode.window.showWarningMessage(
						`Cannot auto-increment tag${latest ? ` from "${latest}"` : ''} for ${name}. Create a tag manually.`
					);
					await this.pushDialog.show({ pendingPushRoots: roots, openNewTag: true });
					return;
				}
				tagPlans.push({ root, name, nextTag });
			}

			for (const plan of tagPlans) {
				try {
					await this.git.createTagAtHead(plan.root, plan.nextTag);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					vscode.window.showWarningMessage(
						`Failed to create tag ${plan.nextTag} on ${plan.name}: ${detail}. Create a tag manually.`
					);
					await this.pushDialog.show({ pendingPushRoots: roots, openNewTag: true });
					return;
				}
			}

			createdTags = true;
			const tagSummary =
				tagPlans.length === 1
					? `Created tag ${tagPlans[0].nextTag}.`
					: `Created tags: ${tagPlans.map((p) => `${p.name}=${p.nextTag}`).join(', ')}.`;
			showTimedInfoMessage(tagSummary);
			completeStep();
		}

		if (settings.autoPush) {
			report('Pushing…');
			await this.pushDialog.pushWithAutoMerge(roots, { pushTags: createdTags });
			completeStep();
			return;
		}

		await this.pushDialog.show({
			pendingPushRoots: roots,
			openNewTag: false,
		});
	}

	private async promptFastPushCommitMessage(
		reason: string,
		draft?: string
	): Promise<string | undefined> {
		this.resolveFastPushCommit(undefined);
		const result = new Promise<string | undefined>((resolve) => {
			this.fastPushCommitResolver = resolve;
		});
		this.post({
			type: 'showFastPushCommitDialog',
			payload: { reason, draft: (draft || '').trim() },
		});
		return result;
	}

	private resolveFastPushCommit(message: string | undefined): void {
		const resolve = this.fastPushCommitResolver;
		this.fastPushCommitResolver = undefined;
		resolve?.(message);
	}

	private async postFastPushSettings(): Promise<void> {
		const capability = await this.git.getCommitMessageGeneratorAvailability();
		this.post({ type: 'fastPushSettings', payload: this.fastPushSettings.getPayload(capability) });
	}

	private async postCommitMessagePrefixSettings(): Promise<void> {
		this.post({ type: 'commitMessagePrefixSettings', payload: this.commitPrefixSettings.getPayload() });
	}

	private async saveCommitMessagePrefixSettings(
		workspace: CommitMessagePrefixFlags,
		global: CommitMessagePrefixFlags
	): Promise<void> {
		const payload = await this.commitPrefixSettings.save(workspace, global);
		this.post({ type: 'commitMessagePrefixSettings', payload });
		showTimedInfoMessage(
			'Commit message generation settings saved. Workspace overrides Global in this folder.'
		);
	}

	private applyConfiguredCommitPrefix(message: string): string {
		const text = (message || '').trim();
		if (!text) {
			return text;
		}
		const effective = this.commitPrefixSettings.getEffective();
		const rawPrompt = effective.promptEnabled ? effective.prompt || '' : '';

		// 1) Mandatory prompt requirements are enforced in code (not left to the model).
		let next = this.enforcePromptOnWholeOrMultiRepo(text, rawPrompt);

		// 2) Optional Prefix field still wins when enabled (after expanding date tokens).
		if (!effective.enabled) {
			return next;
		}
		const prefix = expandPrefixTemplate((effective.prefix || '').trim());
		if (!prefix) {
			return next;
		}

		return this.mapMultiRepoBodies(next, (body) => this.applyPrefixToSingleMessage(body, prefix));
	}

	/** Apply prompt-required prefix to a single message or each multi-repo body. */
	private enforcePromptOnWholeOrMultiRepo(message: string, rawPrompt: string): string {
		if (!rawPrompt.trim()) {
			return expandPrefixTemplate(message);
		}
		return this.mapMultiRepoBodies(message, (body) =>
			enforcePromptRequiredPrefix(body, rawPrompt)
		);
	}

	private mapMultiRepoBodies(message: string, mapBody: (body: string) => string): string {
		const text = message.trim();
		const multiRepoHeaderRe = /^###\s+\[[^\]]+]\s+\(.+\)\s*$/m;
		if (!multiRepoHeaderRe.test(text)) {
			return mapBody(text);
		}

		const lines = text.split('\n');
		const out: string[] = [];
		let currentHeader: string | undefined;
		let currentBody: string[] = [];
		const headerLineRe = /^###\s+\[[^\]]+]\s+\(.+\)\s*$/;

		const flush = () => {
			if (!currentHeader) {
				return;
			}
			out.push(currentHeader);
			const bodyText = currentBody.join('\n').trim();
			if (bodyText) {
				out.push(mapBody(bodyText));
			}
			currentHeader = undefined;
			currentBody = [];
		};

		for (const line of lines) {
			if (headerLineRe.test(line.trim())) {
				flush();
				currentHeader = line.trim();
				currentBody = [];
				continue;
			}
			if (currentHeader) {
				currentBody.push(line);
			}
		}
		flush();
		return out.length ? out.join('\n\n').trim() : mapBody(text);
	}

	private applyPrefixToSingleMessage(message: string, prefix: string): string {
		let text = expandPrefixTemplate(message.trim());
		if (!text) {
			return text;
		}
		// Drop model/prompt vYYYYMMDD#N so the configured Prefix field wins.
		if (/^v\d{8}#\d+$/u.test(prefix)) {
			text = stripLeadingVersionDatePrefix(text).trim();
		}
		if (text.startsWith(`${prefix} `) || text === prefix) {
			return text;
		}
		return `${prefix} ${text}`;
	}

	private async clearGlobalCommitMessagePrefixSettings(): Promise<void> {
		const payload = await this.commitPrefixSettings.clearGlobal();
		this.post({ type: 'commitMessagePrefixSettings', payload });
		showTimedInfoMessage('Global commit message generation settings cleared.');
	}

	private async saveFastPushSettings(workspace: FastPushFlags, global: FastPushFlags): Promise<void> {
		const capability = await this.git.getCommitMessageGeneratorAvailability();
		const payload = await this.fastPushSettings.save(workspace, global, capability);
		this.post({ type: 'fastPushSettings', payload });
		showTimedInfoMessage('Fast Push settings saved. Workspace overrides Global in this folder.');
	}

	private async startRollbackFlow(msg: {
		repoRoot: string;
		path: string;
		staged: boolean;
	}): Promise<void> {
		const isUntracked = this.git.isUntracked(msg.path, msg.repoRoot);
		try {
			await this.git.openRollbackDiff(msg.path, msg.repoRoot);
		} catch {
			// Diff may fail for some edge cases; still show confirm dialog
		}
		this.post({
			type: 'showRollbackDialog',
			payload: { ...msg, isUntracked },
		});
	}

	private async startRollbackBatchFlow(
		paths: Array<{ repoRoot: string; path: string; staged: boolean }>,
		unversionedGroup = false
	): Promise<void> {
		if (!paths.length) {
			return;
		}
		const allUntracked =
			unversionedGroup || paths.every((p) => this.git.isUntracked(p.path, p.repoRoot));
		const allStaged = !allUntracked && paths.every((p) => p.staged);
		const previewTarget = paths[0];
		if (previewTarget) {
			try {
				await this.git.openRollbackDiff(previewTarget.path, previewTarget.repoRoot);
			} catch {
				// Diff may fail for some edge cases; still show confirm dialog
			}
		}
		this.post({
			type: 'showRollbackDialog',
			payload: {
				repoRoot: paths[0].repoRoot,
				path: paths[0].path,
				staged: allStaged || paths[0].staged,
				isUntracked: allUntracked,
				batch: true,
				allUntracked,
				paths,
			},
		});
	}

	private setSelection(
		repoRoot: string,
		filePath: string | null,
		staged: boolean,
		groupSelection = false
	): void {
		if (!filePath) {
			this.selected = undefined;
			void vscode.commands.executeCommand(
				'setContext',
				'copyIdeaGitUi.hasSelection',
				!!groupSelection
			);
			return;
		}
		this.selected = { repoRoot, path: filePath, staged };
		void vscode.commands.executeCommand('setContext', 'copyIdeaGitUi.hasSelection', true);
	}

	/**
	 * Refresh Git status and push a snapshot to the webview.
	 * Pass `ignored: false` to skip the slow `--ignored` scan on first paint;
	 * ignored entries are filled in shortly after via `scheduleIgnoredRefresh`.
	 */
	private async refreshAndPush(options?: {
		showLoading?: boolean;
		ignored?: boolean;
	}): Promise<void> {
		const includeIgnored = options?.ignored !== false;
		if (!includeIgnored && this.statusOnlyRefreshPromise) {
			await this.statusOnlyRefreshPromise;
			return;
		}

		const run = this.runRefreshAndPush(options);
		if (!includeIgnored) {
			this.statusOnlyRefreshPromise = run.finally(() => {
				if (this.statusOnlyRefreshPromise === run) {
					this.statusOnlyRefreshPromise = undefined;
				}
			});
		}
		await run;
	}

	/**
	 * Fast path for panel open / visibility: show current snapshot immediately.
	 * Avoids full-workspace status (that races startup discovery and duplicates
	 * work vscode.git already did). Status only the active repo when discovery
	 * is idle; newly opened roots are handled in GitService background init.
	 */
	private async softRefreshAndPush(): Promise<void> {
		await this.waitForGitInit();
		await this.pushSnapshot();
		if (!this.git.isDiscovering()) {
			this.git.scheduleActiveRepoStatus();
		}
		this.scheduleIgnoredRefresh();
	}

	private async runRefreshAndPush(options?: {
		showLoading?: boolean;
		ignored?: boolean;
	}): Promise<void> {
		await this.waitForGitInit();
		const includeIgnored = options?.ignored !== false;
		const showLoading = !!options?.showLoading;
		if (showLoading) {
			this.panelLoading = true;
			await this.pushSnapshot();
		}
		try {
			await this.git.refresh({ ignored: includeIgnored });
		} finally {
			if (showLoading) {
				this.panelLoading = false;
			}
		}
		await this.pushSnapshot();
		if (!includeIgnored) {
			this.scheduleIgnoredRefresh();
		}
	}

	/** Best-effort ignored scan after a status-only first paint (coalesced). */
	private scheduleIgnoredRefresh(): void {
		if (this.ignoredRefreshTimer) {
			clearTimeout(this.ignoredRefreshTimer);
		}
		this.ignoredRefreshTimer = setTimeout(() => {
			this.ignoredRefreshTimer = undefined;
			void (async () => {
				try {
					await this.git.refreshIgnoredFiles();
					if (!this.busy) {
						await this.pushSnapshot();
					} else {
						this.snapshotDeferredWhileBusy = true;
					}
				} catch {
					// Ignored listing is optional for the Changes list.
				}
			})();
		}, 0);
	}

	private async onMessage(msg: WebviewToHost): Promise<void> {
		// Lightweight messages: do not run a full git refresh (avoids UI freezes).
		if (msg.type === 'loadCommitLog') {
			await this.waitForGitInit();
			await this.pushCommitLog(msg.repoRoot);
			return;
		}
		if (msg.type === 'openCommitChanges') {
			try {
				await this.git.openCommitChanges(msg.repoRoot, msg.hash);
			} catch (err) {
				const message = await notifyGitError(err);
				this.post({ type: 'error', message });
			}
			return;
		}
		if (msg.type === 'copyCommitHash') {
			await vscode.env.clipboard.writeText(msg.hash);
			vscode.window.setStatusBarMessage('Commit hash copied', 2000);
			return;
		}
		if (msg.type === 'copyCommitMessage') {
			try {
				const text =
					typeof msg.text === 'string' && msg.text.trim()
						? msg.text.replace(/\s+$/u, '')
						: await this.git.getCommitMessageText(msg.repoRoot, msg.hash);
				await vscode.env.clipboard.writeText(text);
				vscode.window.setStatusBarMessage('Commit message copied', 2000);
			} catch (err) {
				const message = await notifyGitError(err);
				this.post({ type: 'error', message });
			}
			return;
		}
		if (msg.type === 'updateSelection') {
			this.setSelection(msg.repoRoot, msg.path, msg.staged, !!msg.groupSelection);
			return;
		}
		if (msg.type === 'switchRepo') {
			try {
				this.git.setActiveRepository(msg.repoRoot);
				this.setSelection(msg.repoRoot, null, false);
				await this.pushSnapshot();
			} catch (err) {
				const message = await notifyGitError(err);
				this.post({ type: 'error', message });
			}
			return;
		}
		try {
			switch (msg.type) {
				case 'ready':
					// Status refresh is owned by resolveWebviewView / visibility / reveal.
					// Avoid a duplicate full status+ignored pass on every webview bootstrap.
					await this.pushSnapshot();
					await this.postFastPushSettings();
					await this.postCommitMessagePrefixSettings();
					if (this.pendingExpandChanges) {
						this.pendingExpandChanges = false;
						this.expandChangesGroups();
					}
					if (this.pendingFocusMessage) {
						this.pendingFocusMessage = false;
						this.focusCommitMessage();
					}
					this.tryShowUpdateAllDialog();
					break;
				case 'addToGit':
					await this.withBusy(async () => {
						// Batch by repo — per-file add+status races with refresh on index.lock.
						const fsPaths = msg.paths.map(({ repoRoot, path: rel }) =>
							this.toFsPath(repoRoot, rel)
						);
						await this.git.stageMany(fsPaths, { force: true });
					});
					break;
				case 'stageAll':
					await this.withBusy(async () => {
						await this.git.stageAll(msg.staged);
					});
					break;
				case 'openDiff':
					await this.git.openDiffInEditor(msg.path, msg.staged, msg.repoRoot);
					break;
				case 'openFile':
					await this.openFile(msg.repoRoot, msg.path);
					break;
				case 'revealInExplorer':
					await this.revealInExplorer(msg.repoRoot, msg.path);
					break;
				case 'rollback':
					await this.startRollbackFlow(msg);
					break;
				case 'rollbackBatch':
					await this.startRollbackBatchFlow(msg.paths, msg.unversionedGroup);
					break;
				case 'rollbackConfirm':
					await this.withBusy(async () => {
						await this.git.rollbackFile(msg.path, msg.repoRoot, msg.staged);
					});
					break;
				case 'rollbackBatchConfirm':
					await this.withBusy(async () => {
						await this.git.rollbackMany(msg.paths);
					});
					break;
				case 'rollbackCancel':
					break;
				case 'commit':
					await this.withBusy(async () => {
						const committed = await this.git.commitSelection(
							msg.message,
							msg.checkedChanges ?? [],
							msg.unversionedPaths
						);
						showTimedInfoMessage(formatCommittedMessage(committed));
						this.post({ type: 'clearMessage' });
					});
					break;
				case 'commitAndPush':
					await this.withBusy(async () => {
						const committed = await this.git.commitSelection(
							msg.message,
							msg.checkedChanges ?? [],
							msg.unversionedPaths
						);
						showTimedInfoMessage(formatCommittedMessage(committed));
						this.post({ type: 'clearMessage' });
						await this.pushDialog.show({
							pendingPushRoots: committed.map((repo) => repo.rootPath),
						});
					});
					break;
				case 'openPushDialog':
					await this.pushDialog.show(
						msg.repoRoot ? { pendingPushRoots: [msg.repoRoot] } : undefined
					);
					break;
				case 'pullRepo': {
					const root = (msg.repoRoot || '').trim();
					if (!root) {
						break;
					}
					const label =
						this.git
							.getWorkspaceSnapshot()
							.repositories.find((r) =>
								r.rootPath.replace(/\\/g, '/').toLowerCase() ===
								root.replace(/\\/g, '/').toLowerCase()
							)?.name ?? 'repository';
					await this.withBusy(async () => {
						const result = await this.git.pullAllRepositories(undefined, [root]);
						if (!result.failed.length) {
							showTimedInfoMessage(`Pulled ${result.succeeded[0] ?? label}.`);
							return;
						}
						const details = result.failed
							.map(({ repository, error }) => `${repository}: ${error}`)
							.join('\n');
						vscode.window.showWarningMessage(
							`Pull failed for ${label}.\n${details}`,
							{ modal: true }
						);
					}, `Pulling ${label}…`);
					break;
				}
				case 'fastPush':
					await this.withBusy(async () => {
						await this.handleFastPush(
							msg.checkedChanges ?? [],
							msg.unversionedPaths,
							msg.message
						);
					}, 'Fast Push…');
					break;
				case 'fastPushCommitConfirm':
					this.resolveFastPushCommit((msg.message || '').trim() || undefined);
					break;
				case 'fastPushCommitCancel':
					this.resolveFastPushCommit(undefined);
					break;
				case 'fastPushConfirmAck':
					this.fastPushConfirmOpen = false;
					break;
				case 'fastPushConfirmCancel':
					this.fastPushConfirmOpen = false;
					break;
				case 'getFastPushSettings':
					await this.postFastPushSettings();
					break;
				case 'saveFastPushSettings':
					await this.saveFastPushSettings(msg.workspace, msg.global);
					break;
				case 'getCommitMessagePrefixSettings':
					await this.postCommitMessagePrefixSettings();
					break;
				case 'saveCommitMessagePrefixSettings':
					await this.saveCommitMessagePrefixSettings(msg.workspace, msg.global);
					break;
				case 'clearCommitMessagePrefixGlobal':
					await this.clearGlobalCommitMessagePrefixSettings();
					break;
				case 'generateCommitMessage':
					await this.generateCommitMessage(msg.checkedChanges ?? [], msg.unversionedPaths);
					break;
				case 'updateAllConfirm':
					if (msg.selections?.length) {
						await this.updateAllSelection.setMany(msg.selections);
					}
					this.resolveUpdateAll(msg.repoRoots ?? []);
					break;
				case 'updateAllCancel':
					this.resolveUpdateAll(undefined);
					break;
				case 'updateAllSelectionChanged':
					await this.updateAllSelection.setMany(msg.selections ?? []);
					if (this.pendingUpdateAllRepos) {
						const checked = new Map(
							(msg.selections ?? []).map((s) => [
								s.rootPath.replace(/\\/g, '/').toLowerCase(),
								s.checked,
							])
						);
						this.pendingUpdateAllRepos = this.pendingUpdateAllRepos.map((repo) => ({
							...repo,
							checked:
								checked.get(repo.rootPath.replace(/\\/g, '/').toLowerCase()) ??
								repo.checked,
						}));
					}
					break;
				case 'refresh':
					await this.withBusy(async () => {
						await this.refreshAndPush({ ignored: true });
					}, 'Refreshing…');
					break;
				case 'installKeybindings':
					await this.onInstallKeybindings();
					break;
				case 'openGitExtension':
					await vscode.commands.executeCommand('workbench.extensions.search', '@builtin git');
					break;
			}
		} catch (err) {
			const message = await notifyGitError(err);
			this.post({ type: 'error', message });
		} finally {
			if (shouldRefreshAfterMessage(msg.type)) {
				await this.refreshAndPush();
			}
		}
	}

	private async withBusy(fn: () => Promise<void>, message?: string): Promise<void> {
		const run = this.operationChain.then(async () => {
			this.busy = true;
			this.snapshotDeferredWhileBusy = false;
			this.post({ type: 'busy', busy: true, message });
			try {
				await this.git.runWithUserLogging(fn);
			} finally {
				// Push an up-to-date snapshot before clearing busy so a quick Commit /
				// Fast Push cannot collect checkbox paths from a pre-add UI state
				// (applyCommitSelection would then unstage the just-added files).
				try {
					if (this.snapshotDeferredWhileBusy) {
						this.snapshotDeferredWhileBusy = false;
					}
					await this.pushSnapshot();
				} catch {
					// Snapshot failure must not leave the panel stuck busy.
				}
				this.busy = false;
				this.post({ type: 'busy', busy: false });
			}
		});
		this.operationChain = run.catch(() => undefined);
		await run;
	}

	private async pushCommitLog(repoRoot?: string): Promise<void> {
		const key = (repoRoot || '').replace(/\\/g, '/').toLowerCase();
		if (this.commitLogInFlight?.key === key) {
			await this.commitLogInFlight.promise;
			return;
		}
		const promise = (async () => {
			try {
				if (!this.git.getActiveRepository()) {
					// Clear webview "Loading…" without toasting a startup race as ERROR.
					this.post({
						type: 'commitLog',
						payload: {
							repoRoot: repoRoot || '',
							repoName: '',
							commits: [],
						},
					});
					return;
				}
				const payload = await this.git.getCommitLog(repoRoot);
				this.post({ type: 'commitLog', payload });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/No Git repository selected/i.test(message)) {
					this.post({
						type: 'commitLog',
						payload: {
							repoRoot: repoRoot || '',
							repoName: '',
							commits: [],
						},
					});
					return;
				}
				const detailed = await notifyGitError(err);
				this.post({ type: 'error', message: detailed });
			}
		})().finally(() => {
			if (this.commitLogInFlight?.promise === promise) {
				this.commitLogInFlight = undefined;
			}
		});
		this.commitLogInFlight = { key, promise };
		await promise;
	}

	private schedulePushSnapshot(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
		}
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.pushSnapshot();
		}, 40);
	}

	private async pushSnapshot(): Promise<void> {
		const snapshot = this.git.getWorkspaceSnapshot();
		const loading = !!snapshot.loading || this.panelLoading;
		const payload = {
			...snapshot,
			busy: this.busy,
			loading,
			hint: loading
				? snapshot.hint || 'Loading Git…'
				: snapshot.hint,
		};
		const fingerprint = fingerprintWorkspaceSnapshot(payload);
		if (fingerprint === this.lastSnapshotFingerprint) {
			return;
		}
		this.lastSnapshotFingerprint = fingerprint;
		this.post({
			type: 'snapshot',
			payload,
		});
	}

	private toFsPath(repoRoot: string, relativePath: string): string {
		return path.join(repoRoot, relativePath);
	}

	private getMediaVersion(): string {
		try {
			const jsPath = path.join(this.extensionUri.fsPath, 'media', 'commit.js');
			const cssPath = path.join(this.extensionUri.fsPath, 'media', 'commit.css');
			const jsMtime = fs.statSync(jsPath).mtimeMs;
			const cssMtime = fs.statSync(cssPath).mtimeMs;
			return `${Math.max(jsMtime, cssMtime)}`;
		} catch {
			return Date.now().toString();
		}
	}

	private post(message: HostToWebview): void {
		if (this.view) {
			void this.view.webview.postMessage(message);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const mediaVersion = this.getMediaVersion();
		const styleUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'commit.css'))
			.with({ query: `v=${mediaVersion}` });
		const scriptUri = webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'commit.js'))
			.with({ query: `v=${mediaVersion}` });
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Commit</title>
</head>
<body class="sidebar-mode">
  <div id="app">
    <div class="panel-toolbar">
      <span class="toolbar-title">Git</span>
      <div class="toolbar-actions">
        <button id="installKeysBtn" type="button" title="Install extension keybindings">⌨</button>
        <button id="locateBtn" type="button" title="Reveal selected file in Explorer">⌖</button>
        <button id="refreshBtn" type="button" title="Refresh Git status">↻</button>
        <span class="toolbar-sep" aria-hidden="true"></span>
        <div class="toolbar-view-options">
          <button id="viewOptionsBtn" type="button" title="View Options" aria-label="View Options" aria-haspopup="menu" aria-expanded="false">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M8 3C4.5 3 1.7 5.1 1 8c.7 2.9 3.5 5 7 5s6.3-2.1 7-5c-.7-2.9-3.5-5-7-5Zm0 8.2A3.2 3.2 0 1 1 8 4.8a3.2 3.2 0 0 1 0 6.4Zm0-1.7A1.5 1.5 0 1 0 8 6.5a1.5 1.5 0 0 0 0 3Z"/>
            </svg>
          </button>
          <div id="viewOptionsMenu" class="view-options-menu hidden" role="menu">
            <div class="view-options-label">Group By</div>
            <label class="view-options-item" role="menuitemcheckbox">
              <input id="groupByDirectoryChk" type="checkbox" />
              <span>Directory</span>
            </label>
            <label class="view-options-item" role="menuitemcheckbox">
              <input id="groupByModuleChk" type="checkbox" />
              <span>Module</span>
            </label>
            <div class="view-options-label">Show</div>
            <label class="view-options-item" role="menuitemcheckbox">
              <input id="showIgnoredFilesChk" type="checkbox" />
              <span>Ignored Files</span>
            </label>
          </div>
        </div>
        <button id="expandAllBtn" type="button" title="Expand All (uses selected group / repository / folder when selected)" aria-label="Expand All">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M2 2.5h12v1H2v-1zm0 10h12v1H2v-1zM8 4l3.25 3.25H9.1V10H6.9V7.25H4.75L8 4zm0 8 3.25-3.25H9.1V8.5H6.9v.25H4.75L8 12z"/>
          </svg>
        </button>
        <button id="collapseAllBtn" type="button" title="Collapse All (uses selected group / repository / folder when selected)" aria-label="Collapse All">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M2 2.5h12v1H2v-1zm0 10h12v1H2v-1zM8 7.25 4.75 4h2.15v2.75h2.2V4h2.15L8 7.25zm0 1.5 3.25 3.25H9.1V9.25H6.9v2.75H4.75L8 8.75z"/>
          </svg>
        </button>
      </div>
    </div>
    <div id="banner" class="banner hidden"></div>
    <div id="repoBar" class="repo-bar hidden">
      <select id="repoSelect" title="Follows the repo of the active editor by default; switch manually if needed" aria-label="Current repository"></select>
    </div>
    <div class="main">
      <aside class="file-pane">
        <div class="pane-header">
          <span>Changes</span>
          <div class="pane-actions">
            <button id="stageAll" title="Include all changes in commit" type="button">+</button>
            <button id="unstageAll" title="Exclude all changes from commit" type="button">−</button>
          </div>
        </div>
        <div id="fileList" class="file-list"></div>
      </aside>
      <div id="commitForm" class="commit-form collapsed">
        <div class="commit-form-header">
          <button id="commitFormToggle" class="commit-form-toggle" type="button" title="Expand or collapse commit message" aria-expanded="false">▸</button>
          <span class="commit-form-title">Commit Message</span>
        </div>
        <div class="commit-form-body">
          <div class="message-field">
            <div id="messageResize" class="message-resize" title="Drag to resize" role="separator" aria-orientation="horizontal" tabindex="0"></div>
            <textarea id="message" placeholder="Commit Message" rows="4"></textarea>
            <div class="generate-msg-actions">
              <button id="generateMsgBtn" class="generate-msg-btn" type="button" title="Generate Commit Message" aria-label="Generate Commit Message">
                <svg class="generate-msg-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M7.5 1.5 8.4 4.2 11 5.1 8.4 6 7.5 8.7 6.6 6 4 5.1 6.6 4.2 7.5 1.5Zm4.3 5.2.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Zm-7.6 2.4.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5Z"/>
                </svg>
                <span class="generate-msg-spinner" aria-hidden="true"></span>
              </button>
              <button id="generateMsgSettingsBtn" class="generate-msg-settings-btn" type="button" title="Commit message generation settings" aria-label="Commit message generation settings">⚙</button>
            </div>
          </div>
          <div id="formError" class="form-error hidden"></div>
          <div class="commit-actions">
            <button id="commitBtn" class="primary" type="button" title="Commit (Ctrl+Enter)">Commit</button>
            <div id="commitPushSplit" class="commit-push-split">
              <button id="commitPushBtn" type="button" title="Commit and Push (Ctrl+Shift+Enter)">Commit and Push</button>
              <button id="commitPushMenuBtn" class="commit-push-caret" type="button" title="More push options" aria-label="More push options" aria-haspopup="menu" aria-expanded="false">▾</button>
              <div id="commitPushMenu" class="commit-push-menu hidden" role="menu">
                <div class="commit-push-menu-row">
                  <button id="fastPushBtn" class="commit-push-menu-item" type="button" role="menuitem" title="Fast Push (Ctrl+Alt+K)">Fast Push</button>
                  <button id="fastPushSettingsBtn" class="commit-push-menu-gear" type="button" title="Fast Push settings" aria-label="Fast Push settings">⚙</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <section id="commitLogPane" class="commit-log-pane collapsed">
        <div class="commit-log-header">
          <button id="commitLogToggle" class="commit-log-toggle" type="button" title="Expand or collapse commit log" aria-expanded="false">▸</button>
          <span class="commit-log-title">Commit Log</span>
          <select id="commitLogRepo" title="Repository for commit history" aria-label="Commit log repository"></select>
          <button id="commitLogRefresh" type="button" title="Refresh commit log">↻</button>
        </div>
        <div id="commitLogList" class="commit-log-list"></div>
      </section>
    </div>
  </div>

  <div id="contextMenu" class="context-menu hidden"></div>
  <div id="commitLogTip" class="commit-log-tip hidden" role="tooltip" aria-hidden="true">
    <pre id="commitLogTipBody" class="commit-log-tip-body"></pre>
  </div>
  <button id="commitLogTipCopy" class="commit-log-tip-copy hidden" type="button" title="Copy commit message" aria-label="Copy commit message">Copy</button>

  <div id="rollbackModal" class="modal hidden">
    <div class="modal-card">
      <h2 id="rollbackTitle">Rollback</h2>
      <p id="rollbackSummary"></p>
      <div class="modal-actions">
        <button id="rollbackCancel" type="button">Cancel</button>
        <button id="rollbackConfirm" class="danger" type="button">Rollback</button>
      </div>
    </div>
  </div>

  <div id="expandCollapseAllModal" class="modal hidden">
    <div class="modal-card">
      <h2 id="expandCollapseAllTitle">Expand All</h2>
      <p id="expandCollapseAllSummary">No group, repository, or folder is selected. This will apply to all files in the Commit panel. Continue?</p>
      <div class="modal-actions">
        <button id="expandCollapseAllCancel" type="button">Cancel</button>
        <button id="expandCollapseAllConfirm" class="primary" type="button">Continue</button>
      </div>
    </div>
  </div>

  <div id="keysModal" class="modal hidden">
    <div class="modal-card">
      <h2>Install Keybindings</h2>
      <p id="keysSummary">This will write extension keybindings to your user keybindings.json and may override existing bindings (Ctrl+K, Ctrl+Shift+K, Ctrl+Enter, Ctrl+Shift+Enter, Ctrl+D, F4, Ctrl+Alt+Z, Ctrl+Alt+K). Continue?</p>
      <div class="modal-actions">
        <button id="keysCancel" type="button">Cancel</button>
        <button id="keysConfirm" class="primary" type="button">Install</button>
      </div>
    </div>
  </div>

  <div id="updateAllModal" class="modal hidden">
    <div class="modal-card modal-card-wide">
      <h2>Update Repositories</h2>
      <p id="updateAllSummary">Select repositories to pull and update.</p>
      <div id="updateAllRepoList" class="update-all-repo-list" role="group" aria-label="Repositories"></div>
      <p id="updateAllHint" class="update-all-hint">Press Ctrl+T again or click Pull to update the selected repositories. Checkmarks are remembered for next time.</p>
      <div class="modal-actions">
        <button id="updateAllCancel" type="button">Cancel</button>
        <button id="updateAllConfirm" class="primary" type="button">Pull</button>
      </div>
    </div>
  </div>

  <div id="fastPushConfirmModal" class="modal hidden">
    <div class="modal-card">
      <h2>Confirm Fast Push</h2>
      <p id="fastPushConfirmSummary" class="fast-push-confirm-summary"></p>
      <ol id="fastPushConfirmSteps" class="fast-push-confirm-steps"></ol>
      <p id="fastPushConfirmHint" class="fast-push-confirm-hint"></p>
      <div class="modal-actions">
        <button id="fastPushConfirmCancel" type="button">Cancel</button>
        <button id="fastPushConfirmOk" class="primary" type="button">Fast Push</button>
      </div>
    </div>
  </div>

  <div id="fastPushCommitModal" class="modal hidden">
    <div class="modal-card modal-card-wide">
      <h2>Commit Message Required</h2>
      <p id="fastPushCommitReason" class="fast-push-commit-reason"></p>
      <label class="fast-push-commit-label" for="fastPushCommitInput">Commit message</label>
      <textarea id="fastPushCommitInput" class="fast-push-commit-input" rows="4" placeholder="Enter commit message" spellcheck="true"></textarea>
      <div id="fastPushCommitError" class="form-error hidden"></div>
      <div class="modal-actions">
        <button id="fastPushCommitCancel" type="button">Cancel</button>
        <button id="fastPushCommitConfirm" class="primary" type="button">Continue</button>
      </div>
    </div>
  </div>

  <div id="fastPushSettingsModal" class="modal hidden">
    <div class="modal-card modal-card-wide">
      <h2>Fast Push Settings</h2>
      <p class="fast-push-settings-hint">Choose which steps Fast Push runs. Each option has Workspace and Global checkboxes. Workspace overrides Global in the current folder. Defaults: Auto-generate commit on, Auto new tag off, Auto push on.</p>
      <div class="fast-push-settings-table" role="table" aria-label="Fast Push settings">
        <div class="fast-push-settings-row head" role="row">
          <span class="fast-push-settings-feature" role="columnheader">Step</span>
          <label class="fast-push-settings-scope" role="columnheader" title="Applies only to this workspace and overrides Global">Workspace</label>
          <label class="fast-push-settings-scope" role="columnheader" title="Default for all workspaces that have no Workspace override">Global</label>
        </div>
        <div class="fast-push-settings-row" id="fpGenerateRow" role="row">
          <span class="fast-push-settings-feature" title="When on, generate a commit message with AI before committing. When off, the Commit Message box is used.">Auto-generate commit</span>
          <label class="fast-push-settings-scope"><input id="fpWsGenerate" type="checkbox" /></label>
          <label class="fast-push-settings-scope"><input id="fpGlGenerate" type="checkbox" /></label>
        </div>
        <div id="fpGenerateUnavailable" class="fast-push-settings-note hidden" role="note"></div>
        <div class="fast-push-settings-row" role="row">
          <span class="fast-push-settings-feature" title="When on, bump the latest remote v* tag (trailing number +1) after commit. If bump fails, opens Push + New Tag. When off, skip tagging.">Auto new tag</span>
          <label class="fast-push-settings-scope"><input id="fpWsTag" type="checkbox" /></label>
          <label class="fast-push-settings-scope"><input id="fpGlTag" type="checkbox" /></label>
        </div>
        <div class="fast-push-settings-row" role="row">
          <span class="fast-push-settings-feature" title="When on, push after commit/tag (auto-merge on reject; conflicts use manual merge UI). When off, open the Push dialog for manual push.">Auto push</span>
          <label class="fast-push-settings-scope"><input id="fpWsPush" type="checkbox" /></label>
          <label class="fast-push-settings-scope"><input id="fpGlPush" type="checkbox" /></label>
        </div>
      </div>
      <div class="modal-actions">
        <button id="fastPushSettingsCancel" type="button">Cancel</button>
        <button id="fastPushSettingsSave" class="primary" type="button">Save</button>
      </div>
    </div>
  </div>

  <div id="commitMsgPrefixModal" class="modal hidden">
    <div class="modal-card modal-card-wide">
      <h2>Commit Message Generation Settings</h2>
      <p class="fast-push-settings-hint">Configure an optional prefix and a <strong>mandatory</strong> generation prompt for auto-generated commit messages. When Force generation prompt is on, the prompt is injected into generation and also enforced afterwards in code (e.g. <code>vyyyyMMdd#000</code> / Chinese). Workspace overrides Global. Tokens <code>yyyyMMdd</code> / <code>YYYYMMDD</code> expand to today's local date.</p>
      <label class="fast-push-commit-label" for="cmpPrefixInput">Prefix</label>
      <input id="cmpPrefixInput" class="commit-prefix-single-input" type="text" placeholder="e.g. vyyyyMMdd#000" />
      <label class="fast-push-commit-label" for="cmpPromptInput">Generation prompt</label>
      <textarea id="cmpPromptInput" class="commit-prompt-input" rows="4" placeholder="e.g. 用中文生成提交信息。type(scope) 保持英文。"></textarea>
      <div class="fast-push-settings-table" role="table" aria-label="Commit message generation settings">
        <div class="fast-push-settings-row head" role="row">
          <span class="fast-push-settings-feature" role="columnheader">Apply</span>
          <label class="fast-push-settings-scope" role="columnheader" title="Applies only to this workspace and overrides Global">Workspace</label>
          <label class="fast-push-settings-scope" role="columnheader" title="Default for all workspaces that have no Workspace override">Global</label>
        </div>
        <div class="fast-push-settings-row commit-prefix-row" role="row">
          <span class="fast-push-settings-feature">Prefix on auto-generated message</span>
          <label class="fast-push-settings-scope"><input id="cmpWsEnabled" type="checkbox" /></label>
          <label class="fast-push-settings-scope"><input id="cmpGlEnabled" type="checkbox" /></label>
        </div>
        <div class="fast-push-settings-row commit-prefix-row" role="row">
          <span class="fast-push-settings-feature">Force generation prompt</span>
          <label class="fast-push-settings-scope"><input id="cmpWsPromptEnabled" type="checkbox" /></label>
          <label class="fast-push-settings-scope"><input id="cmpGlPromptEnabled" type="checkbox" /></label>
        </div>
      </div>
      <div class="modal-actions">
        <button id="commitMsgPrefixClearGlobal" type="button" title="Clear the Global prefix/prompt and disable them">Clear Global</button>
        <button id="commitMsgPrefixCancel" type="button">Cancel</button>
        <button id="commitMsgPrefixSave" class="primary" type="button">Save</button>
      </div>
    </div>
  </div>

  <div id="panelLoadingOverlay" class="panel-loading-overlay hidden" aria-live="polite" aria-busy="true">
    <div class="panel-loading-box">
      <div class="panel-loading-spinner" aria-hidden="true"></div>
      <div class="panel-loading-copy">
        <div id="panelLoadingTitle" class="panel-loading-title">Working…</div>
        <div id="panelLoadingProgress" class="panel-loading-progress hidden">0/0</div>
        <div id="panelLoadingBar" class="panel-loading-bar hidden" aria-hidden="true">
          <div id="panelLoadingBarFill" class="panel-loading-bar-fill"></div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/**
 * After mutating Git ops, refresh status so Changes stay in sync.
 * Skip for messages that already refreshed, only read UI, or do not touch the index.
 */
function shouldRefreshAfterMessage(type: WebviewToHost['type']): boolean {
	switch (type) {
		case 'ready':
		case 'refresh':
		case 'openDiff':
		case 'openFile':
		case 'revealInExplorer':
		case 'rollback':
		case 'rollbackBatch':
		case 'rollbackCancel':
		case 'openPushDialog':
		case 'pullRepo':
		case 'fastPushCommitConfirm':
		case 'fastPushCommitCancel':
		case 'fastPushConfirmAck':
		case 'fastPushConfirmCancel':
		case 'getFastPushSettings':
		case 'saveFastPushSettings':
		case 'getCommitMessagePrefixSettings':
		case 'saveCommitMessagePrefixSettings':
		case 'clearCommitMessagePrefixGlobal':
		case 'generateCommitMessage':
		case 'updateAllConfirm':
		case 'updateAllCancel':
		case 'updateAllSelectionChanged':
		case 'installKeybindings':
		case 'openGitExtension':
			return false;
		default:
			return true;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function formatCommittedMessage(committed: CommitRepoResult[]): string {
	if (committed.length === 1) {
		const repo = committed[0];
		return `Committed to ${repo.name}${repo.branch ? ` (${repo.branch})` : ''}.`;
	}
	const names = committed.map((r) => r.name).join(', ');
	return `Committed to ${committed.length} repositories: ${names}.`;
}

function fingerprintWorkspaceSnapshot(
	payload: WorkspaceSnapshot & { busy?: boolean; loading?: boolean }
): string {
	const changeKey = (item: { path: string; status: string; unsaved?: boolean }) =>
		`${item.path}:${item.status}:${item.unsaved ? 1 : 0}`;
	return JSON.stringify({
		ok: payload.ok,
		error: payload.error,
		loading: !!payload.loading,
		busy: !!payload.busy,
		hint: payload.hint,
		activeRepoRoot: payload.activeRepoRoot,
		repos: (payload.repositories ?? []).map((repo) => ({
			root: repo.rootPath,
			ok: repo.ok,
			branch: repo.branch,
			ahead: repo.ahead,
			behind: repo.behind,
			hint: repo.hint,
			syncMode: repo.syncMode,
			staged: repo.staged.map(changeKey),
			unstaged: repo.unstaged.map(changeKey),
			unversioned: repo.unversioned.map(changeKey),
			ignored: (repo.ignored ?? []).map(changeKey),
		})),
	});
}
