import * as vscode from 'vscode';
import { GitService } from './git/GitService';
import {
	installRecommendedKeybindings,
	promptInstallKeybindings,
} from './keybindings/installRecommendedKeybindings';
import { CommitViewProvider } from './panel/CommitViewProvider';

let gitService: GitService | undefined;
let commitViewProvider: CommitViewProvider | undefined;
let gitReady = false;
let gitInitError = 'Git service is not initialized.';
let gitInitPromise: Promise<void> | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('Copy IDEA Git UI');
	context.subscriptions.push(outputChannel);

	try {
		gitService = new GitService();
		commitViewProvider = new CommitViewProvider(context.extensionUri, gitService, async () => {
			const result = await installRecommendedKeybindings(context);
			if (!result.ok) {
				vscode.window.showErrorMessage(result.error);
			}
		});

		context.subscriptions.push(gitService, commitViewProvider);

		void vscode.commands.executeCommand('setContext', 'copyIdeaGitUi.hasSelection', false);

		// Register view + commands before Git init so the panel and Ctrl+K are
		// available even when the built-in Git extension starts slowly.
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(CommitViewProvider.viewType, commitViewProvider, {
				webviewOptions: { retainContextWhenHidden: true },
			})
		);

		context.subscriptions.push(
			vscode.commands.registerCommand('copyIdeaGitUi.openCommit', async () => {
				await ensureGitReady(true);
				if (!gitService || !commitViewProvider) {
					return;
				}
				gitService.rememberEditorContext();
				try {
					await gitService.stageTrackedChanges();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					vscode.window.showWarningMessage(`自动勾选 Changes 失败：${message}`);
				}
				await commitViewProvider.reveal(false, true, true);
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.openPush', async () => {
				if (!(await ensureGitReady(true))) {
					return;
				}
				if (!gitService || !commitViewProvider) {
					return;
				}
				gitService.rememberEditorContext();
				await commitViewProvider.reveal(true);
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.updateAllRepositories', async () => {
				if (!(await ensureGitReady(true)) || !gitService || !commitViewProvider) {
					return;
				}
				const repoCount = gitService.getRepositoryCount();
				if (!repoCount) {
					vscode.window.showWarningMessage('当前工作区没有已识别的 Git 仓库。');
					return;
				}

				const confirmed = await commitViewProvider.confirmUpdateAll(repoCount);
				if (!confirmed) {
					return;
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '正在更新所有 Git 仓库',
						cancellable: false,
					},
					async (progress) =>
						gitService!.pullAllRepositories((repository, index, total) => {
							progress.report({ message: `${repository}（${index}/${total}）` });
						})
				);

				if (!result.failed.length) {
					vscode.window.showInformationMessage(
						`已更新 ${result.succeeded.length} 个 Git 仓库。`
					);
					return;
				}

				const details = result.failed
					.map(({ repository, error }) => `${repository}: ${error}`)
					.join('\n');
				vscode.window.showWarningMessage(
					`仓库更新完成：成功 ${result.succeeded.length} 个，失败 ${result.failed.length} 个。\n${details}`,
					{ modal: true }
				);
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.openExplorer', async () => {
				await vscode.commands.executeCommand('workbench.view.explorer');
				await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.showDiff', async () => {
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.showDiffForSelection();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.openFile', async () => {
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.openFileForSelection();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.revealInExplorer', async () => {
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.revealSelectionInExplorer();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.rollback', async () => {
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.rollbackForSelection();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.installKeybindings', async () => {
				const choice = await vscode.window.showWarningMessage(
					'安装本插件快捷键会写入用户 keybindings.json，并可能覆盖已有快捷键（如 Ctrl+K、Ctrl+Shift+K、Ctrl+T、Ctrl+D、F4、Ctrl+Alt+Z）。是否继续？',
					{ modal: true },
					'安装'
				);
				if (choice !== '安装') {
					return;
				}
				const result = await installRecommendedKeybindings(context);
				if (!result.ok) {
					vscode.window.showErrorMessage(result.error);
				}
			})
		);

		gitInitPromise = initializeGit(context);
		log(`Activated v${context.extension.packageJSON.version ?? 'unknown'}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`Activation failed: ${message}`);
		vscode.window.showErrorMessage(`Copy IDEA Git UI 激活失败：${message}`);
		throw err;
	}
}

function log(message: string): void {
	outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

async function initializeGit(context: vscode.ExtensionContext): Promise<void> {
	if (!gitService) {
		gitReady = false;
		gitInitError = 'Git service is not initialized.';
		return;
	}

	try {
		const init = await gitService.init();
		gitReady = init.ok;
		gitInitError = init.ok ? '' : init.error;
		log(gitReady ? 'Git service initialized.' : `Git init failed: ${gitInitError}`);
	} catch (err) {
		gitReady = false;
		gitInitError = err instanceof Error ? err.message : String(err);
		log(`Git init error: ${gitInitError}`);
	}

	if (gitReady) {
		void promptInstallKeybindings(context);
	} else {
		vscode.window.showWarningMessage(
			`Copy IDEA Git UI：${gitInitError || 'Git 未就绪'}。快捷键仍可用，打开面板时会提示详情。`
		);
	}
}

async function ensureGitReady(showError: boolean): Promise<boolean> {
	if (gitInitPromise) {
		await gitInitPromise;
	}
	if (gitReady) {
		return true;
	}
	if (showError) {
		const choice = await vscode.window.showErrorMessage(
			gitInitError || 'Git service is not initialized.',
			'Open Extensions'
		);
		if (choice === 'Open Extensions') {
			await vscode.commands.executeCommand('workbench.extensions.search', '@builtin git');
		}
	}
	return false;
}

export function deactivate(): void {
	gitService = undefined;
	commitViewProvider = undefined;
	gitInitPromise = undefined;
}
