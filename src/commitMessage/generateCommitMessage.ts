import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { Repository } from '../git/git';

const execFile = promisify(execFileCb);

const MAX_DIFF_CHARS = 40_000;
const MAX_RULES_CHARS = 12_000;
const MAX_RECENT_COMMITS = 8;

export async function generateCommitMessageWithLanguageModel(
	repo: Repository,
	relativePaths: string[]
): Promise<string | undefined> {
	if (typeof vscode.lm?.selectChatModels !== 'function') {
		return undefined;
	}

	const model = await pickChatModel();
	if (!model) {
		return undefined;
	}

	const root = repo.rootUri.fsPath;
	const [diffs, recentCommits, projectRules] = await Promise.all([
		collectStagedDiffs(repo, relativePaths),
		collectRecentCommitMessages(root),
		loadProjectRules(root),
	]);

	if (!diffs.trim()) {
		throw new Error('No diffs found for the selected files.');
	}

	const locale = vscode.env.language || 'en';
	const languageInstruction = languageInstructionForLocale(locale);
	const prompt = buildPrompt({
		diffs,
		recentCommits,
		projectRules,
		languageInstruction,
		locale,
	});

	const messages = [vscode.LanguageModelChatMessage.User(prompt)];
	const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

	let text = '';
	for await (const chunk of response.text) {
		text += chunk;
	}

	const cleaned = sanitizeGeneratedMessage(text);
	if (!cleaned) {
		throw new Error('The language model returned an empty commit message.');
	}
	return cleaned;
}

async function pickChatModel(): Promise<vscode.LanguageModelChat | undefined> {
	try {
		// Prefer Cursor / Copilot-style vendors when present; otherwise any available model.
		const preferredVendors = ['cursor', 'copilot', 'anysphere'];
		for (const vendor of preferredVendors) {
			const models = await vscode.lm.selectChatModels({ vendor });
			if (models.length) {
				return models[0];
			}
		}
		const all = await vscode.lm.selectChatModels();
		return all[0];
	} catch {
		return undefined;
	}
}

function languageInstructionForLocale(locale: string): string {
	const lang = locale.toLowerCase();
	if (lang.startsWith('zh')) {
		return [
			'Write the entire commit message in Simplified Chinese (简体中文).',
			'Prefer the repository’s existing commit style when project rules or recent commits suggest one.',
			'Otherwise use a concise subject line, optionally followed by a short body.',
		].join(' ');
	}
	if (lang.startsWith('ja')) {
		return 'Write the entire commit message in Japanese.';
	}
	if (lang.startsWith('ko')) {
		return 'Write the entire commit message in Korean.';
	}
	if (lang.startsWith('en')) {
		return 'Write the entire commit message in English.';
	}
	return `Write the entire commit message in the language matching the user locale "${locale}".`;
}

function buildPrompt(input: {
	diffs: string;
	recentCommits: string[];
	projectRules: string;
	languageInstruction: string;
	locale: string;
}): string {
	const recent =
		input.recentCommits.length > 0
			? input.recentCommits.map((m) => `- ${m.replace(/\s+/g, ' ').trim()}`).join('\n')
			: '(none)';
	const rules = input.projectRules.trim() || '(none found)';

	return [
		'You are generating a Git commit message for the staged changes below.',
		'Return ONLY the commit message text. No markdown fences, no quotes, no preamble.',
		input.languageInstruction,
		`Editor locale: ${input.locale}`,
		'',
		'Follow project rules related to commits, language, and style when present:',
		rules,
		'',
		'Recent commit messages (for style reference):',
		recent,
		'',
		'Staged diffs:',
		input.diffs,
	].join('\n');
}

function sanitizeGeneratedMessage(text: string): string {
	let message = text.trim();
	if (message.startsWith('```')) {
		message = message.replace(/^```(?:\w+)?\s*/u, '').replace(/\s*```$/u, '').trim();
	}
	if (
		(message.startsWith('"') && message.endsWith('"')) ||
		(message.startsWith("'") && message.endsWith("'"))
	) {
		message = message.slice(1, -1).trim();
	}
	return message;
}

async function collectStagedDiffs(repo: Repository, relativePaths: string[]): Promise<string> {
	const chunks: string[] = [];
	let total = 0;
	const paths = relativePaths.length
		? relativePaths
		: (await listStagedPaths(repo.rootUri.fsPath));

	for (const relativePath of paths) {
		let unified = '';
		try {
			unified = await repo.diffIndexWithHEAD(relativePath);
		} catch {
			unified = '';
		}
		if (!unified?.trim()) {
			continue;
		}
		const block = `--- ${relativePath} ---\n${unified.trim()}\n`;
		if (total + block.length > MAX_DIFF_CHARS) {
			chunks.push(`\n... (diff truncated after ${chunks.length} files)`);
			break;
		}
		chunks.push(block);
		total += block.length;
	}
	return chunks.join('\n');
}

async function listStagedPaths(repoRoot: string): Promise<string[]> {
	try {
		const { stdout } = await execFile('git', ['diff', '--cached', '--name-only', '-z'], {
			cwd: repoRoot,
			maxBuffer: 5 * 1024 * 1024,
		});
		return stdout
			.split('\0')
			.map((p) => p.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function collectRecentCommitMessages(repoRoot: string): Promise<string[]> {
	try {
		const { stdout } = await execFile(
			'git',
			['log', '-n', String(MAX_RECENT_COMMITS), '--pretty=format:%s'],
			{ cwd: repoRoot, maxBuffer: 1024 * 1024 }
		);
		return stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function loadProjectRules(repoRoot: string): Promise<string> {
	const parts: string[] = [];
	let total = 0;

	const append = async (label: string, filePath: string) => {
		try {
			const text = (await fs.readFile(filePath, 'utf8')).trim();
			if (!text) {
				return;
			}
			const block = `### ${label}\n${text}\n`;
			if (total + block.length > MAX_RULES_CHARS) {
				parts.push(`### ${label}\n${text.slice(0, Math.max(0, MAX_RULES_CHARS - total - 40))}\n... (truncated)\n`);
				total = MAX_RULES_CHARS;
				return;
			}
			parts.push(block);
			total += block.length;
		} catch {
			// ignore missing files
		}
	};

	await append('.cursorrules', path.join(repoRoot, '.cursorrules'));
	await append('AGENTS.md', path.join(repoRoot, 'AGENTS.md'));

	const rulesDir = path.join(repoRoot, '.cursor', 'rules');
	try {
		const entries = await fs.readdir(rulesDir, { withFileTypes: true });
		const ruleFiles = entries
			.filter((e) => e.isFile() && /\.(mdc|md)$/i.test(e.name))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));
		for (const name of ruleFiles) {
			if (total >= MAX_RULES_CHARS) {
				break;
			}
			await append(`.cursor/rules/${name}`, path.join(rulesDir, name));
		}
	} catch {
		// no rules dir
	}

	return parts.join('\n').slice(0, MAX_RULES_CHARS);
}
