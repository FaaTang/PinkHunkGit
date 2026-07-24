import * as vscode from 'vscode';
import * as path from 'path';
import { bumpTrailingVTag, GitService } from '../git/GitService';
import { FastPushFlags, FastPushSettingsStore } from '../fastPush/settings';
import { UpdateAllSelectionStore } from '../updateAll/selectionStore';
import { CommitRepoResult, HostToWebview, WebviewToHost } from './messages';
import { PushDialogProvider } from './PushDialogProvider';

export class CommitViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'copyIdeaGitUi.commitView';
	private static readonly activityBarId = 'workbench.view.extension.copyIdeaGitUi';

	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];
	private busy = false;
	private selected?: { repoRoot: string; path: string; staged: boolean };
	private operationChain: Promise<void> = Promise.resolve();
	private pendingFocusMessage = false;
	private pendingExpandChanges = false;
	private updateAllOpen = false;
	private updateAllResolver?: (repoRoots: string[] | undefined) => void;
	private pendingUpdateAllRepos?: Array<{ rootPath: string; name: string; checked: boolean }>;
	private fastPushCommitResolver?: (message: string | undefined) => void;
	private readonly fastPushSettings: FastPushSettingsStore;
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
		this.updateAllSelection = new UpdateAllSelectionStore(context);
		this.disposables.push(this.git.onDidChange(() => void this.pushSnapshot()));
	}

	dispose(): void {
		this.resolveUpdateAll(undefined);
		this.resolveFastPushCommit(undefined);
		this.disposables.forEach((d) => d.dispose());
	}

	isUpdateAllDialogOpen(): boolean {
		return this.updateAllOpen;
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

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};

		try {
			webviewView.webview.html = this.getHtml(webviewView.webview);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			webviewView.webview.html = `<!DOCTYPE html><html><body><p>Pink Hunk Git failed to load: ${message}</p></body></html>`;
		}

		this.disposables.push(
			webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg)),
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					void this.refreshAndPush();
				}
			})
		);

		void (async () => {
			await this.waitForGitInit();
			if (webviewView.visible) {
				await this.refreshAndPush();
			} else {
				await this.pushSnapshot();
			}
		})();
	}

	async reveal(focusMessage = false, expandChanges = false): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.focusSideBar');
		await vscode.commands.executeCommand(CommitViewProvider.activityBarId);
		if (this.view) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(`${CommitViewProvider.viewType}.focus`);
		}
		await this.refreshAndPush();
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
		if (!this.selected) {
			vscode.window.showWarningMessage('Select a file in the Commit list first.');
			return;
		}
		await this.git.openDiffInEditor(
			this.selected.path,
			this.selected.staged,
			this.selected.repoRoot
		);
	}

	async openFileForSelection(): Promise<void> {
		if (!this.selected) {
			vscode.window.showWarningMessage('Select a file in the Commit list first.');
			return;
		}
		await this.openFile(this.selected.repoRoot, this.selected.path);
	}

	async revealSelectionInExplorer(): Promise<void> {
		if (!this.selected) {
			vscode.window.showWarningMessage('Select a file in the Commit list first.');
			return;
		}
		await this.revealInExplorer(this.selected.repoRoot, this.selected.path);
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
		if (!this.selected) {
			vscode.window.showWarningMessage('Select a file in the Commit list first.');
			return;
		}
		await this.startRollbackFlow(this.selected);
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

	async triggerFastPush(): Promise<void> {
		await this.reveal();
		this.post({ type: 'triggerFastPush' });
	}

	private async stageUnversionedPaths(
		paths?: Array<{ repoRoot: string; path: string }>
	): Promise<void> {
		if (!paths?.length) {
			return;
		}
		for (const { repoRoot, path } of paths) {
			await this.git.stage(this.toFsPath(repoRoot, path));
		}
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
			const message = await this.git.generateCommitMessageWithAi(checkedChanges, unversionedPaths);
			this.post({ type: 'setMessage', message });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
			vscode.window.showErrorMessage(message);
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
					message = (await this.git.generateCommitMessageWithAi(checkedChanges, unversionedPaths)).trim();
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
		const committed = await this.git.commitAllStaged(message);
		vscode.window.showInformationMessage(formatCommittedMessage(committed));
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
			vscode.window.showInformationMessage(tagSummary);
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

	private async saveFastPushSettings(workspace: FastPushFlags, global: FastPushFlags): Promise<void> {
		const capability = await this.git.getCommitMessageGeneratorAvailability();
		const payload = await this.fastPushSettings.save(workspace, global, capability);
		this.post({ type: 'fastPushSettings', payload });
		vscode.window.showInformationMessage('Fast Push settings saved. Workspace overrides Global in this folder.');
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

	private setSelection(repoRoot: string, filePath: string | null, staged: boolean): void {
		if (!filePath) {
			this.selected = undefined;
			void vscode.commands.executeCommand('setContext', 'copyIdeaGitUi.hasSelection', false);
			return;
		}
		this.selected = { repoRoot, path: filePath, staged };
		void vscode.commands.executeCommand('setContext', 'copyIdeaGitUi.hasSelection', true);
	}

	private async refreshAndPush(): Promise<void> {
		await this.waitForGitInit();
		await this.git.refresh();
		await this.pushSnapshot();
	}

	private async onMessage(msg: WebviewToHost): Promise<void> {
		// Lightweight messages: do not run a full git refresh (avoids UI freezes).
		if (msg.type === 'loadCommitLog') {
			await this.pushCommitLog(msg.repoRoot);
			return;
		}
		if (msg.type === 'openCommitChanges') {
			try {
				await this.git.openCommitChanges(msg.repoRoot, msg.hash);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.post({ type: 'error', message });
				vscode.window.showErrorMessage(message);
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
				const text = await this.git.getCommitMessageText(msg.repoRoot, msg.hash);
				await vscode.env.clipboard.writeText(text);
				vscode.window.setStatusBarMessage('Commit message copied', 2000);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.post({ type: 'error', message });
				vscode.window.showErrorMessage(message);
			}
			return;
		}
		if (msg.type === 'updateSelection') {
			this.setSelection(msg.repoRoot, msg.path, msg.staged);
			return;
		}
		if (msg.type === 'switchRepo') {
			try {
				this.git.setActiveRepository(msg.repoRoot);
				this.setSelection(msg.repoRoot, null, false);
				await this.pushSnapshot();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.post({ type: 'error', message });
			}
			return;
		}
		try {
			switch (msg.type) {
				case 'ready':
					await this.refreshAndPush();
					await this.postFastPushSettings();
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
						for (const { repoRoot, path } of msg.paths) {
							await this.git.stage(this.toFsPath(repoRoot, path));
						}
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
						for (const { repoRoot, path, staged } of msg.paths) {
							await this.git.rollbackFile(path, repoRoot, staged);
						}
					});
					break;
				case 'rollbackCancel':
					break;
				case 'commit':
					await this.withBusy(async () => {
						await this.git.applyCommitSelection(msg.checkedChanges ?? []);
						await this.stageUnversionedPaths(msg.unversionedPaths);
						const committed = await this.git.commitAllStaged(msg.message);
						vscode.window.showInformationMessage(formatCommittedMessage(committed));
						this.post({ type: 'clearMessage' });
					});
					break;
				case 'commitAndPush':
					await this.withBusy(async () => {
						await this.git.applyCommitSelection(msg.checkedChanges ?? []);
						await this.stageUnversionedPaths(msg.unversionedPaths);
						const committed = await this.git.commitAllStaged(msg.message);
						vscode.window.showInformationMessage(formatCommittedMessage(committed));
						this.post({ type: 'clearMessage' });
						await this.pushDialog.show({
							pendingPushRoots: committed.map((repo) => repo.rootPath),
						});
					});
					break;
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
				case 'getFastPushSettings':
					await this.postFastPushSettings();
					break;
				case 'saveFastPushSettings':
					await this.saveFastPushSettings(msg.workspace, msg.global);
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
						await this.refreshAndPush();
					});
					break;
				case 'installKeybindings':
					await this.onInstallKeybindings();
					break;
				case 'openGitExtension':
					await vscode.commands.executeCommand('workbench.extensions.search', '@builtin git');
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
			vscode.window.showErrorMessage(message);
		} finally {
			await this.refreshAndPush();
		}
	}

	private async withBusy(fn: () => Promise<void>, message?: string): Promise<void> {
		const run = this.operationChain.then(async () => {
			this.busy = true;
			this.post({ type: 'busy', busy: true, message });
			try {
				await this.git.runWithUserLogging(fn);
			} finally {
				this.busy = false;
				this.post({ type: 'busy', busy: false });
			}
		});
		this.operationChain = run.catch(() => undefined);
		await run;
	}

	private async pushCommitLog(repoRoot?: string): Promise<void> {
		try {
			const payload = await this.git.getCommitLog(repoRoot);
			this.post({ type: 'commitLog', payload });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
		}
	}

	private async pushSnapshot(): Promise<void> {
		const snapshot = this.git.getWorkspaceSnapshot();
		this.post({ type: 'snapshot', payload: { ...snapshot, busy: this.busy } });
	}

	private toFsPath(repoRoot: string, relativePath: string): string {
		return path.join(repoRoot, relativePath);
	}

	private post(message: HostToWebview): void {
		if (this.view) {
			void this.view.webview.postMessage(message);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'commit.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'commit.js'));
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
            <button id="stageAll" title="Stage all" type="button">+</button>
            <button id="unstageAll" title="Unstage all" type="button">−</button>
          </div>
        </div>
        <div id="fileList" class="file-list"></div>
      </aside>
      <div class="commit-form">
        <div class="message-field">
          <div id="messageResize" class="message-resize" title="Drag to resize" role="separator" aria-orientation="horizontal" tabindex="0"></div>
          <textarea id="message" placeholder="Commit Message" rows="4"></textarea>
          <button id="generateMsgBtn" class="generate-msg-btn" type="button" title="Generate Commit Message" aria-label="Generate Commit Message">
            <svg class="generate-msg-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M7.5 1.5 8.4 4.2 11 5.1 8.4 6 7.5 8.7 6.6 6 4 5.1 6.6 4.2 7.5 1.5Zm4.3 5.2.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Zm-7.6 2.4.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5Z"/>
            </svg>
            <span class="generate-msg-spinner" aria-hidden="true"></span>
          </button>
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
