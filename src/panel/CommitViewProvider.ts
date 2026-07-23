import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/GitService';
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
	private pendingUpdateAllRepoCount?: number;
	private updateAllResolver?: (confirmed: boolean) => void;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitService,
		private readonly pushDialog: PushDialogProvider,
		private readonly onInstallKeybindings: () => Promise<void>,
		private readonly waitForGitInit: () => Promise<void>
	) {
		this.disposables.push(this.git.onDidChange(() => void this.pushSnapshot()));
	}

	dispose(): void {
		this.resolveUpdateAll(false);
		this.disposables.forEach((d) => d.dispose());
	}

	/** Show a Cursor-themed confirm dialog in the Commit panel before pull-all. */
	async confirmUpdateAll(repoCount: number): Promise<boolean> {
		this.resolveUpdateAll(false);
		const confirmed = new Promise<boolean>((resolve) => {
			this.updateAllResolver = resolve;
		});
		this.pendingUpdateAllRepoCount = repoCount;
		await this.reveal(false, false);
		this.tryShowUpdateAllDialog();
		return confirmed;
	}

	private tryShowUpdateAllDialog(): void {
		if (this.pendingUpdateAllRepoCount == null || !this.view || !this.updateAllResolver) {
			return;
		}
		this.post({
			type: 'showUpdateAllDialog',
			payload: { repoCount: this.pendingUpdateAllRepoCount },
		});
	}

	private resolveUpdateAll(confirmed: boolean): void {
		const resolve = this.updateAllResolver;
		this.updateAllResolver = undefined;
		this.pendingUpdateAllRepoCount = undefined;
		resolve?.(confirmed);
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
		const uri = vscode.Uri.file(this.toFsPath(repoRoot, relativePath));
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
	}

	private async revealInExplorer(repoRoot: string, relativePath: string): Promise<void> {
		const uri = vscode.Uri.file(this.toFsPath(repoRoot, relativePath));
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

	private async startRollbackFlow(msg: {
		repoRoot: string;
		path: string;
		staged: boolean;
	}): Promise<void> {
		const isUntracked = this.git.isUntracked(msg.path, msg.repoRoot);
		try {
			if (!isUntracked) {
				await this.git.openRollbackDiff(msg.path, msg.repoRoot);
			}
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
		const firstTracked = paths.find((p) => !this.git.isUntracked(p.path, p.repoRoot));
		if (firstTracked) {
			try {
				await this.git.openRollbackDiff(firstTracked.path, firstTracked.repoRoot);
			} catch {
				// Diff may fail for some edge cases; still show confirm dialog
			}
		}
		this.post({
			type: 'showRollbackDialog',
			payload: {
				repoRoot: paths[0].repoRoot,
				path: paths[0].path,
				staged: paths[0].staged,
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
						await this.git.rollbackFile(msg.path, msg.repoRoot);
					});
					break;
				case 'rollbackBatchConfirm':
					await this.withBusy(async () => {
						for (const { repoRoot, path } of msg.paths) {
							await this.git.rollbackFile(path, repoRoot);
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
				case 'generateCommitMessage':
					await this.generateCommitMessage(msg.checkedChanges ?? [], msg.unversionedPaths);
					break;
				case 'updateAllConfirm':
					this.resolveUpdateAll(true);
					break;
				case 'updateAllCancel':
					this.resolveUpdateAll(false);
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

	private async withBusy(fn: () => Promise<void>): Promise<void> {
		const run = this.operationChain.then(async () => {
			this.busy = true;
			this.post({ type: 'busy', busy: true });
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
          <button id="commitBtn" class="primary" type="button">Commit</button>
          <button id="commitPushBtn" type="button">Commit and Push</button>
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
      <p id="keysSummary">This will write extension keybindings to your user keybindings.json and may override existing bindings (Ctrl+K, Ctrl+Shift+K, Ctrl+D, F4, Ctrl+Alt+Z). Continue?</p>
      <div class="modal-actions">
        <button id="keysCancel" type="button">Cancel</button>
        <button id="keysConfirm" class="primary" type="button">Install</button>
      </div>
    </div>
  </div>

  <div id="updateAllModal" class="modal hidden">
    <div class="modal-card">
      <h2>Update All Repositories</h2>
      <p id="updateAllSummary"></p>
      <div class="modal-actions">
        <button id="updateAllCancel" type="button">Cancel</button>
        <button id="updateAllConfirm" class="primary" type="button">Update</button>
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
