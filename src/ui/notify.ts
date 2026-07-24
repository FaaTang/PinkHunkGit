import * as vscode from 'vscode';

/** Default auto-dismiss delay for non-interactive success toasts. */
export const INFO_MESSAGE_TIMEOUT_MS = 5000;

/**
 * Show a toast that closes automatically after `timeoutMs`.
 * VS Code has no dismiss API for `showInformationMessage`; progress notifications
 * close when the task promise settles.
 */
export function showTimedInfoMessage(
	message: string,
	timeoutMs = INFO_MESSAGE_TIMEOUT_MS
): void {
	void vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: message,
			cancellable: false,
		},
		async () => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, timeoutMs);
			});
		}
	);
}
