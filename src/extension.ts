import * as vscode from 'vscode';
import { GitService } from './git/GitService';
import {
	installRecommendedKeybindings,
	promptInstallKeybindings,
} from './keybindings/installRecommendedKeybindings';
import { CommitViewProvider } from './panel/CommitViewProvider';
import { PushDialogProvider } from './panel/PushDialogProvider';
import { initGitOutput, logExtension } from './git/gitOutput';

let gitService: GitService | undefined;
let commitViewProvider: CommitViewProvider | undefined;
let pushDialogProvider: PushDialogProvider | undefined;
let gitReady = false;
let gitInitError = 'Git service is not initialized.';
let gitInitPromise: Promise<void> | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('Pink Hunk Git');
	context.subscriptions.push(outputChannel);
	initGitOutput(outputChannel);

	try {
		gitService = new GitService();
		gitInitPromise = initializeGit(context);
		pushDialogProvider = new PushDialogProvider(context.extensionUri, gitService);
		commitViewProvider = new CommitViewProvider(
			context.extensionUri,
			gitService,
			pushDialogProvider,
			async () => {
			const result = await installRecommendedKeybindings(context);
			if (!result.ok) {
				vscode.window.showErrorMessage(result.error);
			}
		},
			() => gitInitPromise ?? Promise.resolve(),
			context
		);

		context.subscriptions.push(gitService, pushDialogProvider, commitViewProvider);

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
					await gitService.runWithUserLogging(() => gitService!.stageTrackedChanges());
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					vscode.window.showWarningMessage(`Failed to auto-stage Changes: ${message}`);
				}
				await commitViewProvider.reveal(true, true);
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.openPush', async () => {
				if (!(await ensureGitReady(true))) {
					return;
				}
				if (!gitService || !pushDialogProvider) {
					return;
				}
				gitService.rememberEditorContext();
				await pushDialogProvider.show();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.updateAllRepositories', async () => {
				if (!(await ensureGitReady(true)) || !gitService || !commitViewProvider) {
					return;
				}

				if (commitViewProvider.isUpdateAllDialogOpen()) {
					commitViewProvider.submitUpdateAllDialog();
					return;
				}

				const repos = gitService.getRepositoryList();
				if (!repos.length) {
					vscode.window.showWarningMessage('No Git repositories detected in the current workspace.');
					return;
				}

				const selectedRoots = await commitViewProvider.confirmUpdateAll(repos);
				if (!selectedRoots) {
					return;
				}
				if (!selectedRoots.length) {
					vscode.window.showWarningMessage('Select at least one repository to pull.');
					return;
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Updating Git repositories',
						cancellable: false,
					},
					async (progress) =>
						gitService!.runWithUserLogging(() =>
							gitService!.pullAllRepositories((repository, index, total) => {
								progress.report({ message: `${repository} (${index}/${total})` });
							}, selectedRoots)
						)
				);

				if (!result.failed.length) {
					vscode.window.showInformationMessage(
						`Updated ${result.succeeded.length} Git repositories.`
					);
					return;
				}

				const details = result.failed
					.map(({ repository, error }) => `${repository}: ${error}`)
					.join('\n');
				vscode.window.showWarningMessage(
					`Repository update finished: ${result.succeeded.length} succeeded, ${result.failed.length} failed.\n${details}`,
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
			vscode.commands.registerCommand('copyIdeaGitUi.addToGit', async () => {
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.addToGit();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.commit', async () => {
				if (!(await ensureGitReady(true))) {
					return;
				}
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.triggerCommit();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.commitAndPush', async () => {
				if (!(await ensureGitReady(true))) {
					return;
				}
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.triggerCommitAndPush();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.fastPush', async () => {
				if (!(await ensureGitReady(true))) {
					return;
				}
				if (!commitViewProvider) {
					return;
				}
				await commitViewProvider.triggerFastPush();
			}),
			vscode.commands.registerCommand('copyIdeaGitUi.installKeybindings', async () => {
				const choice = await vscode.window.showWarningMessage(
					'Installing extension keybindings will write to your user keybindings.json and may override existing bindings (Ctrl+K, Ctrl+Shift+K, Ctrl+T, Ctrl+D, F4, Ctrl+Alt+Z, Ctrl+Alt+K). Continue?',
					{ modal: true },
					'Install'
				);
				if (choice !== 'Install') {
					return;
				}
				const result = await installRecommendedKeybindings(context);
				if (!result.ok) {
					vscode.window.showErrorMessage(result.error);
				}
			})
		);

		logExtension(`Activated v${context.extension.packageJSON.version ?? 'unknown'}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logExtension(`Activation failed: ${message}`);
		vscode.window.showErrorMessage(`Pink Hunk Git activation failed: ${message}`);
		throw err;
	}
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
		logExtension(gitReady ? 'Git service initialized.' : `Git init failed: ${gitInitError}`);
	} catch (err) {
		gitReady = false;
		gitInitError = err instanceof Error ? err.message : String(err);
		gitService.markInitFailed(gitInitError);
		logExtension(`Git init error: ${gitInitError}`);
	}

	if (gitReady) {
		void promptInstallKeybindings(context);
	} else {
		vscode.window.showWarningMessage(
			`Pink Hunk Git: ${gitInitError || 'Git not ready'}. Keybindings remain available; details will be shown when opening the panel.`
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
	pushDialogProvider = undefined;
	gitInitPromise = undefined;
}
