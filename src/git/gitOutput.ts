import * as path from 'path';
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initGitOutput(output: vscode.OutputChannel): void {
	channel = output;
}

export function logExtension(message: string): void {
	appendLine(`[${timestamp()}] ${message}`);
}

/** Log the start of a git shell command or VS Code Git API call. */
export function logGitStart(repoRoot: string, commandLine: string): void {
	const label = repoLabel(repoRoot);
	appendLine(`[${timestamp()}] ${label}`);
	appendLine(`  $ ${commandLine}`);
	channel?.show(true);
}

export function logGitOk(durationMs: number, output?: string): void {
	appendLine(`  OK (${durationMs}ms)`);
	appendGitOutput(output);
}

export function logGitFail(err: unknown, durationMs: number, output?: string): void {
	const message = err instanceof Error ? err.message : String(err);
	appendLine(`  FAILED (${durationMs}ms): ${message}`);
	appendGitOutput(output);
}

export function formatGitShellCommand(args: string[]): string {
	return `git ${args.map(quoteArg).join(' ')}`;
}

function appendGitOutput(output?: string): void {
	const text = output?.trim();
	if (!text) {
		return;
	}
	for (const line of text.split(/\r?\n/)) {
		appendLine(`  ${line}`);
	}
}

function appendLine(line: string): void {
	channel?.appendLine(line);
}

function repoLabel(repoRoot: string): string {
	const base = path.basename(repoRoot.replace(/[\\/]+$/, '')) || repoRoot;
	return `[${base}]`;
}

function timestamp(): string {
	return new Date().toTimeString().slice(0, 8);
}

function quoteArg(arg: string): string {
	if (!arg || /[\s"'\\]/.test(arg)) {
		return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return arg;
}
