import * as vscode from 'vscode';
import { showTimedInfoMessage } from '../ui/notify';

export const SOFT_EXCLUSIVE_SETTING = 'copyIdeaGitUi.softExclusiveGit';

const PREVIOUS_GIT_KEY = 'softExclusive.previousGitSettings';
const APPLIED_KEY = 'softExclusive.applied';
const NOTIFIED_KEY = 'softExclusive.notified';

type PreviousGitSettings = {
	/** Workspace-level value before we overwrote it; `undefined` means no workspace override. */
	autofetch: boolean | string | undefined;
	autorefresh: boolean | undefined;
};

/**
 * Soft-exclusive mode: keep `vscode.git` enabled (API still works) but stop its
 * background autofetch / autorefresh so Pink Hunk Git is less likely to race on index.lock.
 */
export function isSoftExclusiveEnabled(): boolean {
	return vscode.workspace.getConfiguration().get<boolean>(SOFT_EXCLUSIVE_SETTING, true);
}

export async function syncSoftExclusiveGit(
	context: vscode.ExtensionContext,
	options?: { announce?: boolean }
): Promise<void> {
	const enabled = isSoftExclusiveEnabled();
	if (enabled) {
		await applySoftExclusive(context, options?.announce !== false);
	} else {
		await restoreSoftExclusive(context, options?.announce !== false);
	}
}

export function registerSoftExclusiveGit(
	context: vscode.ExtensionContext
): vscode.Disposable {
	void syncSoftExclusiveGit(context, { announce: true });

	const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!e.affectsConfiguration(SOFT_EXCLUSIVE_SETTING)) {
			return;
		}
		void syncSoftExclusiveGit(context, { announce: true });
	});

	const toggleCmd = vscode.commands.registerCommand(
		'copyIdeaGitUi.toggleSoftExclusiveGit',
		async () => {
			const next = !isSoftExclusiveEnabled();
			await vscode.workspace
				.getConfiguration()
				.update(SOFT_EXCLUSIVE_SETTING, next, vscode.ConfigurationTarget.Global);
			// syncSoftExclusiveGit runs via onDidChangeConfiguration and announces.
		}
	);

	return vscode.Disposable.from(configSub, toggleCmd);
}

async function applySoftExclusive(
	context: vscode.ExtensionContext,
	announce: boolean
): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		return;
	}

	const git = vscode.workspace.getConfiguration('git');
	const alreadyApplied = context.workspaceState.get<boolean>(APPLIED_KEY) === true;
	if (!alreadyApplied) {
		const prev: PreviousGitSettings = {
			autofetch: git.inspect<boolean | string>('autofetch')?.workspaceValue,
			autorefresh: git.inspect<boolean>('autorefresh')?.workspaceValue,
		};
		await context.workspaceState.update(PREVIOUS_GIT_KEY, prev);
	}

	const autofetchWs = git.inspect<boolean | string>('autofetch')?.workspaceValue;
	const autorefreshWs = git.inspect<boolean>('autorefresh')?.workspaceValue;
	if (autofetchWs !== false) {
		await git.update('autofetch', false, vscode.ConfigurationTarget.Workspace);
	}
	if (autorefreshWs !== false) {
		await git.update('autorefresh', false, vscode.ConfigurationTarget.Workspace);
	}

	await context.workspaceState.update(APPLIED_KEY, true);

	if (announce && context.workspaceState.get<boolean>(NOTIFIED_KEY) !== true) {
		await context.workspaceState.update(NOTIFIED_KEY, true);
		showTimedInfoMessage(
			'Pink Hunk Git soft exclusive: disabled built-in Git autofetch/autorefresh. Commit panel refreshes on file changes and polls the active repo while visible. Toggle via setting “Soft Exclusive Git”.'
		);
	}
}

async function restoreSoftExclusive(
	context: vscode.ExtensionContext,
	announce: boolean
): Promise<void> {
	if (context.workspaceState.get<boolean>(APPLIED_KEY) !== true) {
		return;
	}

	const git = vscode.workspace.getConfiguration('git');
	const prev = context.workspaceState.get<PreviousGitSettings>(PREVIOUS_GIT_KEY);
	await git.update(
		'autofetch',
		prev?.autofetch === undefined ? undefined : prev.autofetch,
		vscode.ConfigurationTarget.Workspace
	);
	await git.update(
		'autorefresh',
		prev?.autorefresh === undefined ? undefined : prev.autorefresh,
		vscode.ConfigurationTarget.Workspace
	);

	await context.workspaceState.update(PREVIOUS_GIT_KEY, undefined);
	await context.workspaceState.update(APPLIED_KEY, false);
	await context.workspaceState.update(NOTIFIED_KEY, false);

	if (announce) {
		showTimedInfoMessage(
			'Pink Hunk Git soft exclusive off: restored previous built-in Git autofetch/autorefresh settings.'
		);
	}
}
