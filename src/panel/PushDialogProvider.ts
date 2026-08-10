import * as vscode from 'vscode';
import { notifyGitError } from '../git/gitOutput';
import { GitService, PushRejectedError, isValidTagName } from '../git/GitService';
import { showTimedInfoMessage } from '../ui/notify';
import {
	PushDialogPayload,
	PushHostToWebview,
	PushWebviewToHost,
} from './pushMessages';

export class PushDialogProvider implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private busy = false;
	private pendingPushRoots?: string[];
	private pendingPushTags = false;
	/** When true, remaining roots after conflict resolution resume via pushWithAutoMerge. */
	private resumeAutoMerge = false;
	private pendingOpenNewTag = false;
	private webviewReady = false;
	private readyWaiters: Array<() => void> = [];
	private dialogPhase: 'confirm' | 'alt' = 'confirm';
	private conflictContext?: { mode: import('./messages').SyncMode; repoRoot?: string };
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitService
	) {
		this.disposables.push(this.git.onDidChange(() => this.scheduleRefreshIfOpen()));
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach((d) => d.dispose());
	}

	async show(options?: { pendingPushRoots?: string[]; openNewTag?: boolean }): Promise<void> {
		this.pendingPushRoots = options?.pendingPushRoots;
		this.pendingOpenNewTag = !!options?.openNewTag;
		this.resumeAutoMerge = false;
		this.dialogPhase = 'confirm';
		this.conflictContext = undefined;
		await this.git.refresh();

		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active, false);
			await this.sendState();
			this.flushOpenNewTag();
			return;
		}

		this.webviewReady = false;
		this.panel = vscode.window.createWebviewPanel(
			'copyIdeaGitUi.pushDialog',
			'Push Commits',
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
				this.pendingPushTags = false;
				this.resumeAutoMerge = false;
				this.pendingOpenNewTag = false;
				this.webviewReady = false;
				this.conflictContext = undefined;
				this.dialogPhase = 'confirm';
				this.flushReadyWaiters();
			})
		);

		await this.sendState();
	}

	/**
	 * Push selected repos with tags. On rejection, auto-merge; if merge conflicts,
	 * open the existing conflict UI for manual resolution.
	 */
	async pushWithAutoMerge(repoRoots: string[], options?: { pushTags?: boolean }): Promise<void> {
		const pushTags = options?.pushTags !== false;
		this.pendingPushTags = pushTags;
		this.resumeAutoMerge = true;
		const roots = repoRoots.length ? repoRoots : [undefined];

		for (let i = 0; i < roots.length; i++) {
			const root = roots[i];
			const remaining = this.remainingRoots(roots, i + 1);
			this.pendingPushRoots = remaining.length ? remaining : undefined;

			const workspace = this.git.getWorkspaceSnapshot();
			const snap = root
				? workspace.repositories.find((r) => this.sameRoot(r.rootPath, root))
				: workspace.active;
			const label = snap?.name ?? 'repository';
			const upstream = snap?.upstream;
			const resolvedRoot = snap?.rootPath || root;

			try {
				await this.git.push(resolvedRoot, { pushTags });
				const tagsNote = pushTags ? ' (with tags)' : '';
				showTimedInfoMessage(
					`Pushed ${label}${upstream ? ` → ${upstream}` : ''}${tagsNote}.`
				);
				continue;
			} catch (err) {
				if (!(err instanceof PushRejectedError)) {
					throw err;
				}

				// Keep sibling roots in pendingPushRoots so conflict Continue → Ask Push can resume them.
				await this.ensureOpen();
				this.post({ type: 'busy', busy: true, message: 'Push rejected. Auto-merging…' });
				let syncResult: Awaited<ReturnType<GitService['syncWithUpstream']>>;
				try {
					syncResult = await this.git.syncWithUpstream('merge', resolvedRoot);
				} finally {
					this.post({ type: 'busy', busy: false });
				}

				if (syncResult.status === 'conflict') {
					await this.handleSyncResult(syncResult, resolvedRoot);
					return;
				}
				if (syncResult.status === 'failed') {
					this.postPushRejected(syncResult.message, resolvedRoot);
					return;
				}

				try {
					await this.git.push(resolvedRoot, { pushTags });
					showTimedInfoMessage(
						`Merged and pushed ${label}${upstream ? ` → ${upstream}` : ''}${
							pushTags ? ' (with tags)' : ''
						}.`
					);
				} catch (retryErr) {
					if (retryErr instanceof PushRejectedError) {
						this.postPushRejected(retryErr.message, resolvedRoot);
						return;
					}
					throw retryErr;
				}
			}
		}

		this.resumeAutoMerge = false;
		this.pendingPushRoots = undefined;
		if (this.panel) {
			this.close();
		}
	}

	private async ensureOpen(options?: { pendingPushRoots?: string[] }): Promise<void> {
		if (options?.pendingPushRoots?.length) {
			this.pendingPushRoots = options.pendingPushRoots;
		}
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active, false);
			await this.sendState();
			await this.waitUntilReady();
			return;
		}
		// Preserve resume flags; show() resets resumeAutoMerge for fresh confirm dialogs.
		const resumeAutoMerge = this.resumeAutoMerge;
		const pendingPushTags = this.pendingPushTags;
		const pending = this.pendingPushRoots;
		await this.show({ pendingPushRoots: options?.pendingPushRoots ?? pending });
		this.resumeAutoMerge = resumeAutoMerge;
		this.pendingPushTags = pendingPushTags;
		await this.waitUntilReady();
	}

	private waitUntilReady(): Promise<void> {
		if (this.webviewReady && this.panel) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.readyWaiters.push(resolve);
		});
	}

	private flushReadyWaiters(): void {
		const waiters = this.readyWaiters.splice(0);
		for (const resolve of waiters) {
			resolve();
		}
	}

	private flushOpenNewTag(): void {
		if (!this.pendingOpenNewTag || !this.panel || !this.webviewReady) {
			return;
		}
		this.pendingOpenNewTag = false;
		const roots =
			this.pendingPushRoots?.length
				? [...this.pendingPushRoots]
				: this.git
						.getWorkspaceSnapshot()
						.repositories.filter((r) => r.ok && r.rootPath)
						.map((r) => r.rootPath);
		this.post({ type: 'openNewTag', repoRoots: roots });
	}

	close(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.panel?.dispose();
		this.panel = undefined;
		this.pendingPushRoots = undefined;
		this.pendingPushTags = false;
		this.resumeAutoMerge = false;
		this.pendingOpenNewTag = false;
		this.webviewReady = false;
	}

	private scheduleRefreshIfOpen(): void {
		if (!this.panel) {
			return;
		}
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		// Debounce longer while confirming — frequent git events were re-posting state
		// and caused the details pane to flicker while commit details loaded.
		const delay = this.dialogPhase === 'confirm' ? 800 : 300;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshIfOpen();
		}, delay);
	}

	private async refreshIfOpen(): Promise<void> {
		if (!this.panel) {
			return;
		}
		if (this.dialogPhase === 'confirm') {
			await this.sendState({ skipRefresh: true });
			return;
		}
		if (this.conflictContext) {
			await this.refreshConflictState();
		}
	}

	private async sendState(options?: { skipRefresh?: boolean }): Promise<void> {
		const workspace = this.git.getWorkspaceSnapshot();
		const targets = await this.git.getPushTargets({
			activeRepoRoot: workspace.activeRepoRoot ?? workspace.active.rootPath,
			skipRefresh: options?.skipRefresh,
		});
		const payload: PushDialogPayload = {
			targets,
			activeRepoRoot: workspace.activeRepoRoot ?? workspace.active.rootPath,
			pendingRepoRoots: this.pendingPushRoots,
			busy: this.busy,
		};
		this.post({ type: 'state', payload });
		if (this.panel) {
			this.panel.title = 'Push Commits';
		}
	}

	private async onMessage(msg: PushWebviewToHost): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
					this.webviewReady = true;
					await this.sendState();
					this.flushOpenNewTag();
					this.flushReadyWaiters();
					break;
				case 'cancel':
					this.close();
					break;
				case 'askPushCancel': {
					// "Later" for the conflicted repo — still offer Push for remaining siblings.
					const remaining = this.pendingPushRoots?.length
						? [...this.pendingPushRoots]
						: undefined;
					this.resumeAutoMerge = false;
					if (remaining?.length) {
						await this.show({ pendingPushRoots: remaining });
					} else {
						this.close();
					}
					break;
				}
				case 'selectTarget':
					try {
						this.git.setActiveRepository(msg.repoRoot);
					} catch {
						// ignore stale root
					}
					break;
				case 'getCommitDetails': {
					try {
						const details = await this.git.getPushCommitDetails(msg.repoRoot, msg.hash);
						this.post({ type: 'commitDetails', payload: details });
					} catch (error) {
						this.post({
							type: 'error',
							message: error instanceof Error ? error.message : String(error),
						});
					}
					break;
				}
				case 'openCommitFileDiff':
					try {
						await this.git.openCommitFileDiff(msg.repoRoot, msg.hash, msg.path);
					} catch (error) {
						this.post({
							type: 'error',
							message: error instanceof Error ? error.message : String(error),
						});
					}
					break;
				case 'push':
					await this.withBusy(async () => {
						await this.runPushMany(msg.repoRoots, !!msg.pushTags);
					}, 'Pushing…');
					break;
				case 'askPushConfirm':
					await this.withBusy(async () => {
						await this.resumeAfterAskPush(msg.repoRoot, !!msg.pushTags);
					}, 'Pushing…');
					break;
				case 'pushSyncPreview':
					await this.runSyncPreview(msg.mode, msg.repoRoot);
					break;
				case 'pushSyncConfirm':
				case 'pushSync':
					await this.withBusy(async () => {
						await this.runPushSync(msg.mode, msg.repoRoot);
					}, msg.mode === 'rebase' ? 'Rebasing…' : 'Merging…');
					break;
				case 'syncAbort':
					await this.withBusy(async () => {
						await this.git.abortSync(msg.repoRoot);
						this.conflictContext = undefined;
						showTimedInfoMessage('Merge / Rebase aborted.');
						const remaining = this.pendingPushRoots?.length
							? [...this.pendingPushRoots]
							: undefined;
						this.resumeAutoMerge = false;
						if (remaining?.length) {
							await this.show({ pendingPushRoots: remaining });
						} else {
							this.close();
						}
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
					await this.git.openConflictFile(msg.path, msg.repoRoot);
					break;
				case 'resolveConflict':
					await this.withBusy(async () => {
						await this.git.resolveConflictSide(msg.path, msg.side, msg.mode, msg.repoRoot);
						await this.git.refresh();
						this.conflictContext = { mode: msg.mode, repoRoot: msg.repoRoot };
						await this.refreshConflictState();
					});
					break;
				case 'refresh':
					await this.withBusy(async () => {
						await this.git.refresh();
						await this.sendState();
					});
					break;
				case 'createTag':
					await this.handleCreateTags(msg.tags);
					break;
				case 'getPreviousRemoteTags':
					await this.handleGetPreviousRemoteTags(msg.repoRoots, msg.requestId);
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
			const message = await notifyGitError(err);
			this.post({ type: 'error', message });
		}
	}

	private async runPushMany(repoRoots?: string[], pushTags = false): Promise<void> {
		const roots: Array<string | undefined> =
			repoRoots?.length
				? repoRoots
				: this.pendingPushRoots?.length
					? [...this.pendingPushRoots]
					: [undefined];
		this.pendingPushTags = pushTags;
		this.resumeAutoMerge = false;

		for (let i = 0; i < roots.length; i++) {
			const remaining = this.remainingRoots(roots, i + 1);
			// Preserve siblings so reject → merge/conflict → Ask Push can resume them.
			this.pendingPushRoots = remaining.length ? remaining : undefined;

			const pushed = await this.runPush(roots[i], pushTags);
			if (!pushed) {
				return;
			}
		}

		this.pendingPushRoots = undefined;
		this.close();
	}

	/**
	 * After conflict Continue succeeds, Ask Push only names the conflicted repo.
	 * Push it first, then resume any remaining sibling roots from the original batch.
	 */
	private async resumeAfterAskPush(repoRoot: string | undefined, pushTags: boolean): Promise<void> {
		const tags = pushTags || this.pendingPushTags;
		const remaining = this.pendingPushRoots?.length ? [...this.pendingPushRoots] : [];
		const auto = this.resumeAutoMerge;

		if (repoRoot) {
			const pushed = await this.runPush(repoRoot, tags);
			if (!pushed) {
				// Keep remaining siblings for a later resume after this repo is fixed again.
				this.pendingPushRoots = remaining.length ? remaining : undefined;
				this.resumeAutoMerge = auto;
				this.pendingPushTags = tags;
				return;
			}
		}

		if (!remaining.length) {
			this.resumeAutoMerge = false;
			this.pendingPushRoots = undefined;
			this.close();
			return;
		}

		if (auto) {
			await this.pushWithAutoMerge(remaining, { pushTags: tags });
			return;
		}

		await this.runPushMany(remaining, tags);
	}

	private async runPush(repoRoot?: string, pushTags = false): Promise<boolean> {
		const workspace = this.git.getWorkspaceSnapshot();
		const snap = repoRoot
			? workspace.repositories.find((r) => this.sameRoot(r.rootPath, repoRoot))
			: workspace.active;
		const label = snap?.name ?? 'repository';
		const upstream = snap?.upstream;
		const ahead = snap?.ahead ?? 0;
		try {
			await this.git.push(repoRoot, { pushTags });
			if (ahead === 0 && pushTags) {
				showTimedInfoMessage(`Pushed tags for ${label}.`);
			} else {
				const tagsNote = pushTags ? ' (with tags)' : '';
				showTimedInfoMessage(
					`Pushed ${label}${upstream ? ` → ${upstream}` : ''}${tagsNote}.`
				);
			}
			return true;
		} catch (err) {
			if (err instanceof PushRejectedError) {
				this.postPushRejected(err.message, repoRoot);
				return false;
			}
			throw err;
		}
	}

	private sameRoot(a?: string, b?: string): boolean {
		if (!a || !b) {
			return a === b;
		}
		return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
	}

	private remainingRoots(roots: Array<string | undefined>, fromIndex: number): string[] {
		return roots
			.slice(fromIndex)
			.filter((root): root is string => typeof root === 'string' && root.length > 0);
	}

	private async handleCreateTags(tags: Array<{ repoRoot: string; tagName: string }>): Promise<void> {
		if (!tags.length) {
			this.post({ type: 'tagResult', success: false, message: 'Select at least one branch to tag.' });
			return;
		}
		const normalized = tags
			.map((item) => ({ repoRoot: item.repoRoot, tagName: item.tagName.trim() }))
			.filter((item) => item.repoRoot && item.tagName);
		if (!normalized.length) {
			this.post({ type: 'tagResult', success: false, message: 'Tag name cannot be empty.' });
			return;
		}
		const invalid = normalized.find((item) => !isValidTagName(item.tagName));
		if (invalid) {
			this.post({ type: 'tagResult', success: false, message: `Invalid tag name: ${invalid.tagName}` });
			return;
		}
		const succeeded: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		await this.withBusy(async () => {
			for (const { repoRoot: root, tagName } of normalized) {
				const snap = this.git.getWorkspaceSnapshot().repositories.find((r) =>
					r.rootPath.replace(/\\/g, '/').toLowerCase() === root.replace(/\\/g, '/').toLowerCase()
				);
				const name = snap?.name ?? root;
				try {
					await this.git.createTagAtHead(root, tagName);
					succeeded.push(name);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					failed.push({ name, error: message });
				}
			}
			await this.git.refresh();
			await this.sendState();
		}, 'Creating tag…');

		if (succeeded.length && !failed.length) {
			const message =
				succeeded.length === 1
					? `Created tag on ${succeeded[0]}.`
					: `Created tags on ${succeeded.length} repositories.`;
			this.post({ type: 'tagResult', success: true, message });
			showTimedInfoMessage(message);
		} else if (succeeded.length && failed.length) {
			const details = failed.map((f) => `${f.name}: ${f.error}`).join('\n');
			const message = `Created tags on ${succeeded.length} repo(s); ${failed.length} failed.`;
			this.post({ type: 'tagResult', success: false, message: `${message}\n${details}` });
			vscode.window.showWarningMessage(message, { modal: true, detail: details });
		} else if (failed.length) {
			const details = failed.map((f) => `${f.name}: ${f.error}`).join('\n');
			const message = 'Failed to create tags.';
			this.post({ type: 'tagResult', success: false, message: `${message}\n${details}` });
			vscode.window.showErrorMessage(message, { modal: true, detail: details });
		}
	}

	private async handleGetPreviousRemoteTags(repoRoots: string[], requestId: number): Promise<void> {
		if (!repoRoots.length) {
			this.post({ type: 'previousRemoteTags', requestId, items: [] });
			return;
		}

		const items = await Promise.all(
			repoRoots.map(async (root) => {
				const snap = this.git.getWorkspaceSnapshot().repositories.find((r) =>
					r.rootPath.replace(/\\/g, '/').toLowerCase() === root.replace(/\\/g, '/').toLowerCase()
				);
				const repoName = snap?.name ?? root;
				try {
					const tagName = await this.git.getLatestRemoteTag(root);
					return { repoRoot: root, repoName, tagName };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { repoRoot: root, repoName, error: message };
				}
			})
		);
		this.post({ type: 'previousRemoteTags', requestId, items });
	}

	private async refreshConflictState(): Promise<void> {
		if (!this.conflictContext) {
			return;
		}
		const { mode, repoRoot } = this.conflictContext;
		if (repoRoot) {
			try {
				this.git.setActiveRepository(repoRoot);
			} catch {
				// keep current
			}
		}
		const ctx = this.git.getPushContext();
		const snap = this.git.getWorkspaceSnapshot().active;
		const resolvedRoot = snap.rootPath || repoRoot;
		const conflicts = this.git.getConflictSnapshot().conflicts;
		this.post({
			type: 'showSyncConflict',
			payload: {
				mode,
				message:
					conflicts.length === 0
						? 'All conflicts resolved. Click Continue to finish, or Abort to cancel.'
						: mode === 'merge'
							? 'Merge produced conflicts. Select a file on the left and choose how to resolve.'
							: 'Rebase produced conflicts. Select a file on the left and choose how to resolve.',
				conflicts,
				repoRoot: resolvedRoot,
				repoName: ctx.repoName,
				branch: ctx.branch,
				upstream: ctx.upstream,
			},
		});
	}

	private postPushRejected(message: string, repoRoot?: string): void {
		this.dialogPhase = 'alt';
		this.conflictContext = undefined;
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

	private async runSyncPreview(mode: import('./messages').SyncMode, repoRoot?: string): Promise<void> {
		await this.git.runWithUserLogging(async () => {
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
			const resolvedRoot = snap.rootPath || repoRoot;

			this.post({ type: 'busy', busy: true, message: 'Loading incoming commits…' });
			try {
				await this.git.refresh();
				const [commits, blockers] = await Promise.all([
					this.git.getIncomingCommits(resolvedRoot),
					this.git.getMergeBlockers(resolvedRoot),
				]);
				this.post({
					type: 'showSyncPreview',
					payload: {
						mode,
						repoRoot: resolvedRoot,
						repoName: ctx.repoName,
						branch: ctx.branch,
						upstream: ctx.upstream,
						commits,
						blockers,
					},
				});
			} finally {
				this.post({ type: 'busy', busy: false });
			}
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
			this.conflictContext = { mode: result.mode, repoRoot: resolvedRoot };
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
		this.conflictContext = undefined;
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
        <div id="mainView" class="main-view">
          <div class="idea-layout">
            <aside id="commitsPane" class="commits-pane">
              <div id="targetList" class="target-list"></div>
              <div id="commitResize" class="commit-resize hidden" title="Drag to resize" role="separator" aria-orientation="horizontal" tabindex="0"></div>
              <div id="commitPane" class="commit-pane">
                <div id="branchMapping" class="branch-mapping"></div>
                <ul id="commitList" class="commit-list hidden"></ul>
                <div id="noCommitSelected" class="placeholder">No commits to push</div>
              </div>
            </aside>
            <section class="details-pane">
              <div class="files-pane">
                <div class="files-toolbar">
                  <div class="files-toolbar-actions">
                    <button id="expandFilesBtn" type="button" title="Expand All" aria-label="Expand All">▾▾</button>
                    <button id="collapseFilesBtn" type="button" title="Collapse All" aria-label="Collapse All">▸▸</button>
                  </div>
                </div>
                <div id="fileTree" class="file-tree"></div>
                <div id="noFileSelected" class="placeholder">Select a commit to view changed files</div>
              </div>
              <div class="commit-detail-pane">
                <div id="commitDetailMessage" class="commit-detail-message"></div>
                <div id="commitDetailMeta" class="commit-detail-meta"></div>
              </div>
            </section>
          </div>
        </div>
        <div id="altView" class="alt-view hidden">
          <div id="statusBanner" class="status-banner hidden"></div>
          <div id="altSplitPane" class="split-pane hidden">
            <div id="altLeftPane" class="alt-list-pane"></div>
            <div id="altRightPane" class="alt-detail-pane"></div>
          </div>
        </div>
      </div>
      <footer class="dialog-footer">
        <div id="footerLeft" class="footer-left">
          <label id="pushTagsOption" class="push-tags" for="pushTagsCheckbox">
            <input id="pushTagsCheckbox" type="checkbox" />
            <span>Push tags:</span>
            <span>All</span>
          </label>
          <button id="newTagBtn" type="button">New tag</button>
        </div>
        <div class="footer-actions">
          <button id="mergeBtn" class="hidden" type="button">Merge</button>
          <button id="rebaseBtn" class="hidden" type="button">Rebase</button>
          <button id="abortBtn" class="danger hidden" type="button">Abort</button>
          <button id="continueBtn" class="primary hidden" type="button">Continue</button>
          <button id="laterBtn" class="hidden" type="button">Later</button>
          <button id="pushBtn" class="primary" type="button">Push</button>
          <button id="cancelBtn" type="button">Cancel</button>
        </div>
      </footer>
    </div>
  </div>
  <div id="newTagModal" class="modal hidden">
    <div class="modal-card modal-card-wide">
      <h2>New Tag</h2>
      <p id="newTagSummary">Create tag at the current branch HEAD.</p>
      <div id="newTagRepoList" class="new-tag-repo-list" role="group" aria-label="Repositories to tag"></div>
      <div id="newTagError" class="field-error hidden"></div>
      <div class="modal-actions">
        <button id="newTagCancelBtn" type="button">Cancel</button>
        <button id="newTagConfirmBtn" class="primary" type="button">Create</button>
      </div>
    </div>
  </div>
  <div id="loadingOverlay" class="loading-overlay hidden">
    <div class="loading-box">
      <div class="loading-spinner" aria-hidden="true"></div>
      <span id="loadingMessage">Working…</span>
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
