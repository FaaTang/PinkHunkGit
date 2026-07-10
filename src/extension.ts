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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	gitService = new GitService();
	const init = await gitService.init();
	gitReady = init.ok;
	gitInitError = init.ok ? '' : init.error;

	commitViewProvider = new CommitViewProvider(context.extensionUri, gitService, async () => {
		const result = await installRecommendedKeybindings(context);
		if (!result.ok) {
			vscode.window.showErrorMessage(result.error);
		}
	});

	context.subscriptions.push(gitService, commitViewProvider);

	void vscode.commands.executeCommand('setContext', 'copyIdeaGitUi.hasSelection', false);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CommitViewProvider.viewType, commitViewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('copyIdeaGitUi.openCommit', async () => {
			if (!gitService || !commitViewProvider) {
				return;
			}
			if (!gitReady) {
				const choice = await vscode.window.showErrorMessage(gitInitError, 'Open Extensions');
				if (choice === 'Open Extensions') {
					await vscode.commands.executeCommand('workbench.extensions.search', '@builtin git');
				}
			}
			gitService.rememberEditorContext();
			await commitViewProvider.reveal(false, true);
		}),
		vscode.commands.registerCommand('copyIdeaGitUi.openPush', async () => {
			if (!gitService || !commitViewProvider) {
				return;
			}
			if (!gitReady) {
				vscode.window.showErrorMessage(gitInitError);
				return;
			}
			gitService.rememberEditorContext();
			await commitViewProvider.reveal(true);
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
				'安装本插件快捷键会写入用户 keybindings.json，并可能覆盖已有快捷键（如 Ctrl+K、Ctrl+Shift+K、Ctrl+D、F4、Ctrl+Alt+Z）。是否继续？',
				{ modal: true },
				'安装',
				'取消'
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

	// First-run tip only; install is available from the panel toolbar button.
	if (gitReady) {
		void promptInstallKeybindings(context);
	}
}

export function deactivate(): void {
	gitService = undefined;
	commitViewProvider = undefined;
}
