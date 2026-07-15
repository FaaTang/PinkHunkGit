import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, PushRejectedError } from '../git/GitService';
import { CommitRepoResult, HostToWebview, SyncMode, WebviewToHost } from './messages';

export class CommitViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'copyIdeaGitUi.commitView';
	private static readonly activityBarId = 'workbench.view.extension.copyIdeaGitUi';

	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];
	private busy = false;
	private selected?: { repoRoot: string; path: string; staged: boolean };
	private pendingFocusMessage = false;
	private pendingExpandChanges = false;
	private pendingUpdateAllRepoCount?: number;
	private updateAllResolver?: (confirmed: boolean) => void;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitService,
		private readonly onInstallKeybindings: () => Promise<void>
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
		webviewView.webview.html = this.getHtml(webviewView.webview);

		this.disposables.push(
			webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg)),
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					void this.refreshAndPush();
				}
			})
		);

		if (webviewView.visible) {
			void this.refreshAndPush();
		}
	}

	async reveal(focusPushDialog = false, focusMessage = false, expandChanges = false): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.focusSideBar');
		await vscode.commands.executeCommand(CommitViewProvider.activityBarId);
		if (this.view) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(`${CommitViewProvider.viewType}.focus`);
		}
		await this.refreshAndPush();
		if (focusPushDialog) {
			const snapshot = this.git.getWorkspaceSnapshot();
			this.post({ type: 'showPushDialog', payload: { ...snapshot, busy: this.busy } });
		}
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
			vscode.window.showWarningMessage('请先在 Commit 列表中选中一个文件。');
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
			vscode.window.showWarningMessage('请先在 Commit 列表中选中一个文件。');
			return;
		}
		await this.openFile(this.selected.repoRoot, this.selected.path);
	}

	async revealSelectionInExplorer(): Promise<void> {
		if (!this.selected) {
			vscode.window.showWarningMessage('请先在 Commit 列表中选中一个文件。');
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
			vscode.window.showWarningMessage('请先在 Commit 列表中选中一个文件。');
			return;
		}
		await this.startRollbackFlow(this.selected);
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
		await this.git.refresh();
		await this.pushSnapshot();
	}

	private async onMessage(msg: WebviewToHost): Promise<void> {
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
				case 'switchRepo':
					this.git.setActiveRepository(msg.repoRoot);
					this.setSelection(msg.repoRoot, null, false);
					break;
				case 'toggleStage':
					await this.withBusy(async () => {
						const fsPath = this.toFsPath(msg.repoRoot, msg.path);
						if (msg.currentlyStaged) {
							await this.git.unstage(fsPath);
						} else {
							await this.git.stage(fsPath);
						}
					});
					break;
				case 'stageAll':
					await this.withBusy(async () => {
						await this.git.stageAll(msg.staged);
					});
					break;
				case 'updateSelection':
					this.setSelection(msg.repoRoot, msg.path, msg.staged);
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
				case 'rollbackConfirm':
					await this.withBusy(async () => {
						await this.git.rollbackFile(msg.path, msg.repoRoot);
					});
					break;
				case 'rollbackCancel':
					break;
				case 'commit':
					await this.withBusy(async () => {
						const committed = await this.git.commitAllStaged(msg.message);
						vscode.window.showInformationMessage(formatCommittedMessage(committed));
						this.post({ type: 'clearMessage' });
					});
					break;
				case 'commitAndPush':
					await this.withBusy(async () => {
						const committed = await this.git.commitAllStaged(msg.message);
						vscode.window.showInformationMessage(formatCommittedMessage(committed));
						this.post({ type: 'clearMessage' });
						for (const repo of committed) {
							const pushed = await this.runPush(repo.rootPath);
							if (!pushed) {
								return;
							}
						}
					});
					break;
				case 'push':
					await this.withBusy(async () => {
						await this.runPush(msg.repoRoot);
					});
					break;
				case 'pushSync':
					await this.withBusy(async () => {
						await this.runPushSync(msg.mode, msg.repoRoot);
					});
					break;
				case 'syncAbort':
					await this.withBusy(async () => {
						await this.git.abortSync(msg.repoRoot);
						this.post({ type: 'closePushDialog' });
						vscode.window.showInformationMessage('已中止 Merge / Rebase。');
					});
					break;
				case 'syncContinue':
					await this.withBusy(async () => {
						await this.handleSyncResult(await this.git.continueSync(msg.repoRoot), msg.repoRoot);
					});
					break;
				case 'openConflict':
					await this.git.openConflictFile(msg.path);
					break;
				case 'askPushConfirm':
					await this.withBusy(async () => {
						await this.runPush(msg.repoRoot);
					});
					break;
				case 'askPushCancel':
				case 'pushDialogCancel':
					this.post({ type: 'closePushDialog' });
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
			if (err instanceof PushRejectedError) {
				this.postPushRejected(err.message);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
			vscode.window.showErrorMessage(message);
		} finally {
			await this.refreshAndPush();
		}
	}

	private async runPush(repoRoot?: string): Promise<boolean> {
		const workspace = this.git.getWorkspaceSnapshot();
		const snap = repoRoot
			? workspace.repositories.find((r) =>
					r.rootPath.replace(/\\/g, '/').toLowerCase() === repoRoot.replace(/\\/g, '/').toLowerCase()
				)
			: workspace.active;
		const label = snap?.name ?? 'repository';
		const upstream = snap?.upstream;
		try {
			await this.git.push(repoRoot);
			this.post({ type: 'closePushDialog' });
			vscode.window.showInformationMessage(
				`Pushed ${label}${upstream ? ` → ${upstream}` : ''}.`
			);
			return true;
		} catch (err) {
			if (err instanceof PushRejectedError) {
				this.postPushRejected(err.message, repoRoot);
				return false;
			}
			throw err;
		}
	}

	private postPushRejected(message: string, repoRoot?: string): void {
		if (repoRoot) {
			try {
				this.git.setActiveRepository(repoRoot);
			} catch {
				// Keep current active repo if root is stale.
			}
		}
		const ctx = this.git.getPushContext();
		const snap = this.git.getWorkspaceSnapshot().active;
		this.post({
			type: 'showPushRejected',
			payload: {
				message,
				repoRoot: snap.rootPath || repoRoot,
				repoName: ctx.repoName,
				branch: ctx.branch,
				upstream: ctx.upstream,
				behind: ctx.behind,
				ahead: ctx.ahead,
			},
		});
	}

	private async runPushSync(mode: SyncMode, repoRoot?: string): Promise<void> {
		const result = await this.git.syncWithUpstream(mode, repoRoot);
		await this.handleSyncResult(result, repoRoot);
	}

	private async handleSyncResult(
		result: Awaited<ReturnType<GitService['syncWithUpstream']>>,
		repoRoot?: string
	): Promise<void> {
		const ctx = this.git.getPushContext();
		const snap = this.git.getWorkspaceSnapshot().active;
		const resolvedRoot = snap.rootPath || repoRoot;

		if (result.status === 'conflict') {
			this.post({
				type: 'showSyncConflict',
				payload: {
					mode: result.mode,
					message: result.message,
					conflicts: result.conflicts,
					repoRoot: resolvedRoot,
					repoName: ctx.repoName,
					branch: ctx.branch,
					upstream: ctx.upstream,
				},
			});
			return;
		}

		if (result.status === 'failed') {
			vscode.window.showErrorMessage(result.message);
			this.postPushRejected(result.message, resolvedRoot);
			return;
		}

		const modeLabel = result.mode === 'merge' ? 'Merge' : 'Rebase';
		this.post({
			type: 'showAskPush',
			payload: {
				repoRoot: resolvedRoot,
				repoName: ctx.repoName,
				branch: ctx.branch,
				upstream: ctx.upstream,
				ahead: ctx.ahead,
				behind: ctx.behind,
				summary: `${modeLabel} 已完成。是否立即 Push 到 ${ctx.upstream || 'remote'}？`,
			},
		});
	}

	private async withBusy(fn: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.post({ type: 'busy', busy: true });
		try {
			await fn();
		} finally {
			this.busy = false;
			this.post({ type: 'busy', busy: false });
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
        <button id="installKeysBtn" type="button" title="安装本插件快捷键">⌨</button>
        <button id="locateBtn" type="button" title="在资源管理器中定位选中文件">⌖</button>
        <button id="refreshBtn" type="button" title="刷新 Git 状态">↻</button>
      </div>
    </div>
    <div id="banner" class="banner hidden"></div>
    <div id="repoBar" class="repo-bar hidden">
      <select id="repoSelect" title="默认跟随当前编辑文件所在仓库；也可手动切换" aria-label="当前仓库"></select>
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
        <textarea id="message" placeholder="Commit Message" rows="4"></textarea>
        <div id="formError" class="form-error hidden"></div>
        <div class="commit-actions">
          <button id="commitBtn" class="primary" type="button">Commit</button>
          <button id="commitPushBtn" type="button">Commit and Push…</button>
        </div>
      </div>
    </div>
  </div>

  <div id="contextMenu" class="context-menu hidden"></div>

  <div id="pushModal" class="modal hidden">
    <div class="modal-card modal-card-wide">
      <h2 id="pushTitle">Push</h2>
      <p id="pushSummary"></p>
      <ul id="pushConflictList" class="conflict-list hidden"></ul>
      <div class="modal-actions" id="pushActions">
        <button id="pushCancel" type="button">Cancel</button>
        <button id="pushConfirm" class="primary" type="button">Push</button>
        <button id="pushMerge" class="hidden" type="button">Merge</button>
        <button id="pushRebase" class="hidden" type="button">Rebase</button>
        <button id="pushAbort" class="hidden" type="button">Abort</button>
        <button id="pushContinue" class="primary hidden" type="button">Continue</button>
        <button id="pushAskNo" class="hidden" type="button">稍后</button>
        <button id="pushAskYes" class="primary hidden" type="button">Push</button>
      </div>
    </div>
  </div>

  <div id="rollbackModal" class="modal hidden">
    <div class="modal-card">
      <h2 id="rollbackTitle">Rollback</h2>
      <p id="rollbackSummary"></p>
      <div class="modal-actions">
        <button id="rollbackCancel" type="button">取消</button>
        <button id="rollbackConfirm" class="danger" type="button">回滚</button>
      </div>
    </div>
  </div>

  <div id="keysModal" class="modal hidden">
    <div class="modal-card">
      <h2>安装快捷键</h2>
      <p id="keysSummary">将把本插件快捷键写入用户 keybindings.json，并可能覆盖已有快捷键（如 Ctrl+K、Ctrl+Shift+K、Ctrl+D、F4、Ctrl+Alt+Z）。是否继续？</p>
      <div class="modal-actions">
        <button id="keysCancel" type="button">取消</button>
        <button id="keysConfirm" class="primary" type="button">安装</button>
      </div>
    </div>
  </div>

  <div id="updateAllModal" class="modal hidden">
    <div class="modal-card">
      <h2>更新所有仓库</h2>
      <p id="updateAllSummary"></p>
      <div class="modal-actions">
        <button id="updateAllCancel" type="button">取消</button>
        <button id="updateAllConfirm" class="primary" type="button">更新</button>
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
