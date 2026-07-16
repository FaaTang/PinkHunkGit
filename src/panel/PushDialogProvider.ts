import * as vscode from 'vscode';
import { GitService, PushRejectedError } from '../git/GitService';
import {
	PushDialogPayload,
	PushHostToWebview,
	PushWebviewToHost,
} from './pushMessages';

export class PushDialogProvider implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private busy = false;
	private pendingPushRoots?: string[];
	private dialogPhase: 'confirm' | 'alt' = 'confirm';
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitService
	) {
		this.disposables.push(this.git.onDidChange(() => void this.refreshIfOpen()));
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach((d) => d.dispose());
	}

	async show(options?: { pendingPushRoots?: string[] }): Promise<void> {
		this.pendingPushRoots = options?.pendingPushRoots;
		this.dialogPhase = 'confirm';
		await this.git.refresh();

		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active, false);
			await this.sendState();
			return;
		}

		const active = this.git.getWorkspaceSnapshot().active;
		const title = active.name ? `Push Commits to ${active.name}` : 'Push';

		this.panel = vscode.window.createWebviewPanel(
			'copyIdeaGitUi.pushDialog',
			title,
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
			}
		);

		this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'commit.svg');
		this.panel.webview.html = this.getHtml(this.panel.webview);

		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((msg: PushWebviewToHost) => void this.onMessage(msg)),
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.pendingPushRoots = undefined;
			})
		);

		await this.sendState();
	}

	close(): void {
		this.panel?.dispose();
		this.panel = undefined;
		this.pendingPushRoots = undefined;
	}

	private async refreshIfOpen(): Promise<void> {
		if (!this.panel || this.dialogPhase !== 'confirm') {
			return;
		}
		await this.sendState();
	}

	private async sendState(): Promise<void> {
		const workspace = this.git.getWorkspaceSnapshot();
		const targets = await this.git.getPushTargets({
			repoRoots: this.pendingPushRoots,
			activeRepoRoot: workspace.activeRepoRoot ?? workspace.active.rootPath,
		});
		const payload: PushDialogPayload = {
			targets,
			activeRepoRoot: workspace.activeRepoRoot ?? workspace.active.rootPath,
			pendingRepoRoots: this.pendingPushRoots,
			busy: this.busy,
		};
		this.post({ type: 'state', payload });
		if (this.panel && targets[0]?.repoName) {
			this.panel.title = `Push Commits to ${targets[0].repoName}`;
		}
	}

	private async onMessage(msg: PushWebviewToHost): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
					await this.sendState();
					break;
				case 'cancel':
				case 'askPushCancel':
					this.pendingPushRoots = undefined;
					this.close();
					break;
				case 'selectTarget':
					try {
						this.git.setActiveRepository(msg.repoRoot);
					} catch {
						// ignore stale root
					}
					break;
				case 'push':
					await this.withBusy(async () => {
						await this.runPushMany(msg.repoRoots, !!msg.pushTags);
					});
					break;
				case 'askPushConfirm':
					await this.withBusy(async () => {
						const roots = msg.repoRoot ? [msg.repoRoot] : this.pendingPushRoots ?? [];
						await this.runPushMany(roots.length ? roots : undefined, !!msg.pushTags);
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
						vscode.window.showInformationMessage('Merge / Rebase aborted.');
						this.close();
					});
					break;
				case 'syncContinue':
					await this.withBusy(async () => {
						await this.handleSyncResult(await this.git.continueSync(msg.repoRoot), msg.repoRoot);
					});
					break;
				case 'openConflict':
					if (msg.repoRoot) {
						try {
							this.git.setActiveRepository(msg.repoRoot);
						} catch {
							// ignore
						}
					}
					await this.git.openConflictFile(msg.path);
					break;
				case 'refresh':
					await this.withBusy(async () => {
						await this.git.refresh();
						await this.sendState();
					});
					break;
			}
		} catch (err) {
			if (err instanceof PushRejectedError) {
				let rejectedRoot: string | undefined;
				if (msg.type === 'push') {
					rejectedRoot = msg.repoRoots[0];
				} else if (msg.type === 'askPushConfirm') {
					rejectedRoot = msg.repoRoot;
				}
				this.postPushRejected(err.message, rejectedRoot);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'error', message });
			vscode.window.showErrorMessage(message);
		}
	}

	private async runPushMany(repoRoots?: string[], pushTags = false): Promise<void> {
		const roots =
			repoRoots?.length
				? repoRoots
				: this.pendingPushRoots?.length
					? [...this.pendingPushRoots]
					: [undefined];
		this.pendingPushRoots = undefined;

		for (const root of roots) {
			const pushed = await this.runPush(root, pushTags);
			if (!pushed) {
				return;
			}
		}
	}

	private async runPush(repoRoot?: string, pushTags = false): Promise<boolean> {
		const workspace = this.git.getWorkspaceSnapshot();
		const snap = repoRoot
			? workspace.repositories.find((r) =>
					r.rootPath.replace(/\\/g, '/').toLowerCase() === repoRoot.replace(/\\/g, '/').toLowerCase()
				)
			: workspace.active;
		const label = snap?.name ?? 'repository';
		const upstream = snap?.upstream;
		try {
			await this.git.push(repoRoot, { pushTags });
			this.close();
			const tagsNote = pushTags ? ' (with tags)' : '';
			vscode.window.showInformationMessage(
				`Pushed ${label}${upstream ? ` → ${upstream}` : ''}${tagsNote}.`
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
		this.dialogPhase = 'alt';
		if (repoRoot) {
			try {
				this.git.setActiveRepository(repoRoot);
			} catch {
				// keep current
			}
		}
		const ctx = this.git.getPushContext();
		const snap = this.git.getWorkspaceSnapshot().active;
		this.post({
			type: 'showRejected',
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

	private async runPushSync(mode: import('./messages').SyncMode, repoRoot?: string): Promise<void> {
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
			this.dialogPhase = 'alt';
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
		this.dialogPhase = 'alt';
		this.post({
			type: 'showAskPush',
			payload: {
				repoRoot: resolvedRoot,
				repoName: ctx.repoName,
				branch: ctx.branch,
				upstream: ctx.upstream,
				ahead: ctx.ahead,
				behind: ctx.behind,
				summary: `${modeLabel} completed. Push to ${ctx.upstream || 'remote'} now?`,
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

	private post(message: PushHostToWebview): void {
		if (message.type === 'close') {
			this.close();
			return;
		}
		void this.panel?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'push.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'push.js'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Push</title>
</head>
<body>
  <div class="dialog-backdrop">
    <div class="push-dialog">
      <header class="dialog-header">
        <h1 id="dialogTitle">Push</h1>
        <button id="closeBtn" class="icon" type="button" title="Close">×</button>
      </header>
      <div class="dialog-body">
        <div id="mainView">
          <div class="split-pane">
            <div id="targetList" class="target-list"></div>
            <div class="commit-pane">
              <ul id="commitList" class="commit-list hidden"></ul>
              <div id="noCommitSelected" class="placeholder">No commits selected</div>
            </div>
          </div>
        </div>
        <div id="altView" class="hidden" style="display:flex;flex-direction:column;flex:1;min-height:0;">
          <div id="statusBanner" class="status-banner"></div>
          <ul id="conflictList" class="conflict-list hidden"></ul>
        </div>
      </div>
      <footer class="dialog-footer">
        <label id="pushTagsOption" class="push-tags" for="pushTagsCheckbox">
          <input id="pushTagsCheckbox" type="checkbox" />
          <span>Push tags:</span>
          <span>All</span>
        </label>
        <div class="footer-actions">
          <button id="cancelBtn" type="button">Cancel</button>
          <button id="mergeBtn" class="hidden" type="button">Merge</button>
          <button id="rebaseBtn" class="hidden" type="button">Rebase</button>
          <button id="abortBtn" class="danger hidden" type="button">Abort</button>
          <button id="continueBtn" class="primary hidden" type="button">Continue</button>
          <button id="laterBtn" class="hidden" type="button">Later</button>
          <button id="pushBtn" class="primary" type="button">Push</button>
        </div>
      </footer>
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
