import * as path from 'path';
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
let userGitLogging = false;

export function initGitOutput(output: vscode.OutputChannel): void {
	channel = output;
}

export function setUserGitLogging(enabled: boolean): void {
	userGitLogging = enabled;
}

export function logExtension(message: string): void {
	appendLine(`[${timestamp()}] ${message}`);
}

/** Log the start of a git shell command or VS Code Git API call. */
export function logGitStart(repoRoot: string, commandLine: string): void {
	if (!userGitLogging) {
		return;
	}
	const label = repoLabel(repoRoot);
	appendLine(`[${timestamp()}] ${label}`);
	appendLine(`  $ ${commandLine}`);
}

export function logGitOk(durationMs: number, output?: string): void {
	if (!userGitLogging) {
		return;
	}
	appendLine(`  OK (${durationMs}ms)`);
	appendGitOutput(output);
}

export function logGitFail(err: unknown, durationMs: number, output?: string): void {
	const message = formatGitError(err);
	if (userGitLogging) {
		appendLine(`  FAILED (${durationMs}ms):`);
		for (const line of message.split(/\r?\n/)) {
			appendLine(`  ${line}`);
		}
		appendGitOutput(output);
		return;
	}
	// Still record unexpected failures so "Show Output" has context.
	appendLine(`[${timestamp()}] FAILED (${durationMs}ms):`);
	for (const line of message.split(/\r?\n/)) {
		appendLine(`  ${line}`);
	}
	appendGitOutput(output);
}

/**
 * Prefer git stderr/stdout over VS Code's generic "Failed to execute git" wrapper.
 */
export function formatGitError(err: unknown): string {
	const seen = new Set<unknown>();
	const chunks: string[] = [];

	const visit = (value: unknown, depth: number): void => {
		if (value == null || depth > 4 || seen.has(value)) {
			return;
		}
		if (typeof value !== 'object') {
			const text = String(value).trim();
			if (text) {
				chunks.push(text);
			}
			return;
		}
		seen.add(value);

		const e = value as {
			message?: unknown;
			stderr?: string | Buffer;
			stdout?: string | Buffer;
			gitErrorCode?: string;
			gitCommand?: string;
			gitArgs?: string[];
			exitCode?: number;
			error?: unknown;
			cause?: unknown;
		};

		const stderr = bufferToString(e.stderr).trim();
		const stdout = bufferToString(e.stdout).trim();
		if (stderr) {
			chunks.push(stderr);
		}
		if (stdout && stdout !== stderr) {
			chunks.push(stdout);
		}

		const message = typeof e.message === 'string' ? e.message.trim() : '';
		const generic =
			!message || /^Failed to execute git/i.test(message) || /^Git error$/i.test(message);
		if (message && !generic) {
			chunks.push(message);
		} else if (message && generic && !stderr && !stdout) {
			chunks.push(message);
		}

		if (e.gitCommand) {
			const args = Array.isArray(e.gitArgs) ? e.gitArgs.map(String).join(' ') : '';
			chunks.unshift(`git ${e.gitCommand}${args ? ` ${args}` : ''} failed`);
		} else if (typeof e.exitCode === 'number') {
			chunks.push(`exit code ${e.exitCode}`);
		}
		if (e.gitErrorCode) {
			chunks.push(`code: ${e.gitErrorCode}`);
		}

		visit(e.error, depth + 1);
		visit(e.cause, depth + 1);
	};

	visit(err, 0);

	let text = uniqueLines(chunks).join('\n').trim();
	if (!text) {
		text = String(err);
	}

	if (isIndexLockError(text)) {
		text +=
			"\n\nIf no other Git process is running, delete this repository's .git/index.lock and retry.";
	}
	return text;
}

/** Show a notification (with detail when needed) and return the formatted message. */
export async function notifyGitError(err: unknown): Promise<string> {
	const full = formatGitError(err);
	logExtension(`ERROR\n${full}`);

	const lines = full.split(/\r?\n/).map((line) => line.trimEnd());
	const summary = lines.find((line) => line.trim()) || 'Git operation failed.';
	const shortSummary = summary.length > 140 ? `${summary.slice(0, 137)}...` : summary;
	const hasDetail = lines.filter((line) => line.trim()).length > 1 || full.length > 140;

	const choice = hasDetail
		? await vscode.window.showErrorMessage(shortSummary, { modal: true, detail: full }, 'Show Output')
		: await vscode.window.showErrorMessage(full, 'Show Output');
	if (choice === 'Show Output') {
		channel?.show(true);
	}
	return full;
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

function bufferToString(value: string | Buffer | undefined): string {
	if (!value) {
		return '';
	}
	return typeof value === 'string' ? value : value.toString('utf8');
}

function uniqueLines(chunks: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const chunk of chunks) {
		for (const line of chunk.split(/\r?\n/)) {
			const trimmed = line.trimEnd();
			if (!trimmed) {
				continue;
			}
			const key = trimmed.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push(trimmed);
		}
	}
	return out;
}

function isIndexLockError(message: string): boolean {
	return /index\.lock/i.test(message) || /Another git process seems to be running/i.test(message);
}
