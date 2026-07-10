import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const MARKER = 'copyIdeaGitUi.keybindings';

const SHOW_DIFF_WHEN = 'view == copyIdeaGitUi.commitView && copyIdeaGitUi.hasSelection';

const RECOMMENDED_BINDINGS: KeybindingEntry[] = [
	{ key: 'ctrl+k', command: 'copyIdeaGitUi.openCommit', mac: 'cmd+k' },
	{ key: 'ctrl+shift+k', command: 'copyIdeaGitUi.openPush', mac: 'cmd+shift+k' },
	{ key: 'ctrl+shift+k', command: '-editor.action.deleteLines' },
	{ key: 'ctrl+d', command: 'copyIdeaGitUi.showDiff', mac: 'cmd+d', when: SHOW_DIFF_WHEN },
	{ key: 'f4', command: 'copyIdeaGitUi.openFile', when: 'copyIdeaGitUi.hasSelection' },
	{ key: 'ctrl+alt+z', command: 'copyIdeaGitUi.rollback', mac: 'cmd+alt+z', when: SHOW_DIFF_WHEN },
];

export async function promptInstallKeybindings(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(MARKER)) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'Copy IDEA Git UI：Ctrl+K / Ctrl+Shift+K 会被 VS Code 内置快捷键占用。是否写入用户快捷键配置以仿 IDEA？',
		'安装',
		'稍后'
	);

	if (choice === '安装') {
		await installRecommendedKeybindings(context);
	}
}

export async function installRecommendedKeybindings(
	context: vscode.ExtensionContext
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const keybindingsPath = getUserKeybindingsPath();
		await fs.mkdir(path.dirname(keybindingsPath), { recursive: true });

		let existing: KeybindingEntry[] = [];
		let existingRaw = '';
		try {
			existingRaw = await fs.readFile(keybindingsPath, 'utf8');
			existing = parseKeybindingsJson(existingRaw);
		} catch {
			existing = [];
			existingRaw = '';
		}

		const toAdd: KeybindingEntry[] = [];
		for (const binding of RECOMMENDED_BINDINGS) {
			const macKey = binding.mac ?? binding.key;
			const key = process.platform === 'darwin' ? macKey : binding.key;
			if (!hasBinding(existing, key, binding.command, binding.when)) {
				toAdd.push({ key, command: binding.command, when: binding.when });
			}
		}

		if (!toAdd.length) {
			await context.globalState.update(MARKER, true);
			vscode.window.showInformationMessage('IDEA 快捷键已存在，无需重复安装。');
			return { ok: true };
		}

		const content = existingRaw
			? appendKeybindings(existingRaw, toAdd)
			: `[\n// ${MARKER}\n${toAdd.map((b) => JSON.stringify(b)).join(',\n')}\n]\n`;

		await fs.writeFile(keybindingsPath, content, 'utf8');
		await context.globalState.update(MARKER, true);
		vscode.window.showInformationMessage(
			'已写入用户快捷键。若仍无效，请重载窗口（Developer: Reload Window）。',
			'重载窗口'
		).then((action) => {
			if (action === '重载窗口') {
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

type KeybindingEntry = { key: string; command: string; mac?: string; when?: string };

function getUserKeybindingsPath(): string {
	const appData = process.env.APPDATA || path.join(process.env.HOME || '', 'Library', 'Application Support');
	const folder = vscode.env.appName.toLowerCase().includes('cursor') ? 'Cursor' : 'Code';
	return path.join(appData, folder, 'User', 'keybindings.json');
}

function parseKeybindingsJson(raw: string): KeybindingEntry[] {
	const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	return JSON.parse(withoutComments) as KeybindingEntry[];
}

function hasBinding(entries: KeybindingEntry[], key: string, command: string, when?: string): boolean {
	return entries.some((e) => e.key === key && e.command === command && (e.when ?? '') === (when ?? ''));
}

function appendKeybindings(existingRaw: string, toAdd: KeybindingEntry[]): string {
	const comment = `// ${MARKER}`;
	const block = toAdd.map((b) => JSON.stringify(b)).join(',\n');
	const addition = `${comment},\n${block}`;

	const trimmed = existingRaw.trim();
	if (!trimmed) {
		return `[\n${addition}\n]\n`;
	}
	if (trimmed.endsWith(']')) {
		const body = trimmed.slice(0, -1).trimEnd();
		const separator = body.endsWith('[') ? '\n' : ',\n';
		return `${body}${separator}${addition}\n]\n`;
	}
	return `${trimmed},\n${addition}\n`;
}
