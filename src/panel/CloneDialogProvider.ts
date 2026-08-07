import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseCloneUrl, protocolLabel } from '../git/cloneUrl';
import { CloneProgress, CloneTask, GitService } from '../git/GitService';
import {
	CloneDialogPayload,
	CloneHostToWebview,
	CloneWebviewToHost,
} from './cloneMessages';

const RECENT_URLS_KEY = 'pinkHunkGit.clone.recentUrls';
const MAX_RECENT_URLS = 15;

export class CloneDialogProvider implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private busy = false;
	private webviewReady = false;
	private readonly disposables: vscode.Disposable[] = [];
	/** Panel-scoped listeners; cleared each time the webview panel is disposed. */
	private panelDisposables: vscode.Disposable[] = [];
	private activeCloneTask: CloneTask | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitService,
		private readonly context: vscode.ExtensionContext
	) {}

	dispose(): void {
		this.panel?.dispose();
		this.disposePanelDisposables();
		this.disposables.forEach((d) => d.dispose());
	}

	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active, false);
			await this.sendState();
			return;
		}

		this.webviewReady = false;
		this.disposePanelDisposables();
		this.panel = vscode.window.createWebviewPanel(
			'copyIdeaGitUi.cloneDialog',
			'Clone Repository',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
			}
		);

		this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'commit.svg');
		this.panel.webview.html = this.getHtml(this.panel.webview);

		this.panelDisposables.push(
			this.panel.webview.onDidReceiveMessage((msg: CloneWebviewToHost) => void this.onMessage(msg)),
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.webviewReady = false;
				this.busy = false;
				this.activeCloneTask = undefined;
				// Drop refs only — emitters are already tearing down; avoid dispose re-entrancy.
				this.panelDisposables = [];
			})
		);

		await this.sendState();
	}

	close(): void {
		this.cancelActiveClone();
		const panel = this.panel;
		this.panel = undefined;
		this.webviewReady = false;
		this.busy = false;
		this.disposePanelDisposables();
		panel?.dispose();
	}

	private disposePanelDisposables(): void {
		const items = this.panelDisposables;
		this.panelDisposables = [];
		items.forEach((d) => d.dispose());
	}

	private getRecentUrls(): string[] {
		const stored = this.context.globalState.get<string[]>(RECENT_URLS_KEY);
		if (!Array.isArray(stored)) {
			return [];
		}
		return stored.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_RECENT_URLS);
	}

	private async saveRecentUrl(url: string): Promise<void> {
		const trimmed = url.trim();
		if (!trimmed) {
			return;
		}
		const next = [trimmed, ...this.getRecentUrls().filter((item) => item !== trimmed)].slice(
			0,
			MAX_RECENT_URLS
		);
		await this.context.globalState.update(RECENT_URLS_KEY, next);
	}

	private getDefaultParentDirectory(): string {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			return path.dirname(folder.uri.fsPath);
		}
		return os.homedir();
	}

	private async sendState(): Promise<void> {
		const proxyStatus = this.git.getGitProxyStatus();
		const payload: CloneDialogPayload = {
			recentUrls: this.getRecentUrls(),
			defaultDirectory: this.getDefaultParentDirectory(),
			currentProxy: proxyStatus.currentProxy,
			usingSessionProxy: proxyStatus.usingSessionProxy,
			busy: this.busy,
		};
		this.post({ type: 'state', payload });
		if (this.panel) {
			this.panel.title = 'Clone Repository';
		}
	}

	private async onMessage(msg: CloneWebviewToHost): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
					this.webviewReady = true;
					await this.sendState();
					break;
				case 'cancel':
					if (this.busy) {
						this.cancelActiveClone();
						break;
					}
					this.close();
					break;
				case 'cancelClone':
					this.cancelActiveClone();
					break;
				case 'setSessionProxy':
					this.git.setSessionGitProxy(msg.proxy);
					await this.sendState();
					break;
				case 'urlChanged': {
					const parsed = parseCloneUrl(msg.url || '');
					this.post({
						type: 'protocolDetected',
						protocol: protocolLabel(parsed.protocol),
					});
					break;
				}
				case 'pickDirectory':
					await this.handlePickDirectory(msg.url);
					break;
				case 'clone':
					await this.handleClone(msg.url, msg.directory);
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes('Clone was force-cancelled.')) {
				this.post({ type: 'error', message });
				void vscode.window.showInformationMessage(message);
				return;
			}
			this.post({ type: 'error', message });
			vscode.window.showErrorMessage(message);
		}
	}

	private async handlePickDirectory(url?: string): Promise<void> {
		const result = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: 'Select Folder',
			defaultUri: vscode.Uri.file(this.getDefaultParentDirectory()),
		});
		if (!result?.length) {
			return;
		}

		let directory = result[0].fsPath;
		const parsed = parseCloneUrl(url || '');
		const repoName = parsed.repoName;
		if (repoName) {
			const base = path.basename(directory);
			if (base.toLowerCase() !== repoName.toLowerCase()) {
				directory = path.join(directory, repoName);
			}
		}
		this.post({ type: 'directoryPicked', directory });
	}

	private async handleClone(url: string, directory: string): Promise<void> {
		const trimmedUrl = (url || '').trim();
		const trimmedDir = (directory || '').trim();
		if (!trimmedUrl) {
			this.post({ type: 'error', message: 'URL is required.' });
			return;
		}
		if (!trimmedDir) {
			this.post({ type: 'error', message: 'Directory is required.' });
			return;
		}

		if (this.activeCloneTask) {
			this.post({ type: 'error', message: 'A clone task is already running.' });
			return;
		}

		let clonedPath = '';
		await this.withBusy(async () => {
			let reportProgress: ((progress: CloneProgress) => void) | undefined;
			const task = this.git.startCloneRepository(trimmedUrl, trimmedDir, (progress) => {
				this.handleCloneProgress(progress);
				reportProgress?.(progress);
			});
			this.activeCloneTask = task;
			try {
				clonedPath = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Cloning repository…',
						cancellable: true,
					},
					async (progress, token) => {
						token.onCancellationRequested(() => {
							this.cancelActiveClone();
						});
						reportProgress = (p: CloneProgress) => {
							if (typeof p.percent === 'number') {
								progress.report({
									increment: 0,
									message: `${p.percent}% ${p.detail}`,
								});
							} else {
								progress.report({ message: p.detail });
							}
						};
						return task.promise;
					}
				);
			} finally {
				this.activeCloneTask = undefined;
			}
		}, 'Cloning…');

		if (!clonedPath) {
			return;
		}

		await this.saveRecentUrl(trimmedUrl);
		this.post({ type: 'cloneSuccess', path: clonedPath });
		this.close();

		const open = 'Open';
		const openNew = 'Open in New Window';
		const choice = await vscode.window.showInformationMessage(
			`Cloned to ${clonedPath}`,
			open,
			openNew
		);

		if (choice === open) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(clonedPath), false);
		} else if (choice === openNew) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(clonedPath), true);
		}
	}

	private async withBusy(fn: () => Promise<void>, message?: string): Promise<void> {
		this.busy = true;
		this.post({ type: 'busy', busy: true, message });
		try {
			await this.git.runWithUserLogging(fn);
		} finally {
			this.busy = false;
			this.post({ type: 'busy', busy: false });
		}
	}

	private handleCloneProgress(progress: CloneProgress): void {
		this.post({
			type: 'cloneProgress',
			phase: progress.phase,
			percent: progress.overallPercent ?? progress.percent,
			detail: progress.detail,
			downloadedKB: progress.downloadedKB,
			totalKB: progress.totalKB,
			speedKBps: progress.speedKBps,
		});
	}

	private cancelActiveClone(): void {
		if (!this.activeCloneTask) {
			return;
		}
		this.activeCloneTask.cancel();
		this.post({ type: 'busy', busy: true, message: 'Cancelling clone…' });
	}

	private post(message: CloneHostToWebview): void {
		if (message.type === 'close') {
			this.close();
			return;
		}
		void this.panel?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'clone.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'clone.js'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Clone Repository</title>
</head>
<body>
  <div class="dialog-backdrop">
    <div class="clone-dialog">
      <header class="dialog-header">
        <h1>Clone Repository</h1>
        <button id="closeBtn" class="icon" type="button" title="Close">×</button>
      </header>
      <div class="dialog-body">
        <div class="clone-layout">
          <aside class="clone-sidebar" aria-label="Clone sources">
            <div class="sidebar-item selected" role="option" aria-selected="true">
              <span class="sidebar-icon" aria-hidden="true">⎇</span>
              <span>Repository URL</span>
            </div>
          </aside>
          <section class="clone-form">
            <div class="field">
              <label class="field-label" for="vcsSelect">Version control:</label>
              <select id="vcsSelect" class="field-input" disabled>
                <option selected>Git</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="urlInput">URL:</label>
              <div class="field-row">
                <input id="urlInput" class="field-input" type="text" list="urlHistory" autocomplete="off" spellcheck="false" placeholder="https://… or git@…" />
                <span id="protocolBadge" class="protocol-badge empty" title="Detected protocol"></span>
              </div>
              <datalist id="urlHistory"></datalist>
            </div>
            <div class="field">
              <label class="field-label" for="directoryInput">Directory:</label>
              <div class="field-row">
                <input id="directoryInput" class="field-input" type="text" spellcheck="false" />
                <button id="browseBtn" class="browse-btn" type="button" title="Browse">…</button>
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="proxyInput">Git Proxy (session only):</label>
              <div class="field-row">
                <input id="proxyInput" class="field-input" type="text" spellcheck="false" placeholder="http://127.0.0.1:7890" />
                <button id="applyProxyBtn" class="browse-btn" type="button" title="Apply">Set</button>
                <button id="clearProxyBtn" class="browse-btn" type="button" title="Clear">Clear</button>
              </div>
              <p id="proxyMeta" class="field-note"></p>
            </div>
            <p id="formError" class="field-error hidden"></p>
          </section>
        </div>
      </div>
      <footer class="dialog-footer">
        <button id="cloneBtn" class="primary" type="button">Clone</button>
        <button id="cancelBtn" type="button">Cancel</button>
      </footer>
    </div>
  </div>
  <div id="loadingOverlay" class="loading-overlay hidden">
    <div class="loading-box">
      <div class="loading-spinner" aria-hidden="true"></div>
      <div class="loading-content">
        <div class="loading-head">
          <span id="loadingMessage">Cloning…</span>
          <span id="stageBadge" class="stage-badge hidden"></span>
        </div>
        <div id="progressWrap" class="progress-wrap hidden">
          <div class="progress-track">
            <div id="progressBar" class="progress-bar"></div>
          </div>
          <span id="progressText" class="progress-text"></span>
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
