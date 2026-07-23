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
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

const RULE_MARKER_START = '# BEGIN Pink Hunk Git — commit message language (temporary)';
const RULE_MARKER_END = '# END Pink Hunk Git — commit message language (temporary)';

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

	const locale = resolveCommitMessageLocale();
	const prompt = buildPrompt({
		diffs,
		recentCommits,
		projectRules,
		locale,
	});

	let cleaned = await requestCommitMessage(model, prompt);
	if (!cleaned) {
		throw new Error('The language model returned an empty commit message.');
	}

	if (locale.wantsCjk && !CJK_RE.test(cleaned)) {
		const rewritten = await requestCommitMessage(model, buildRewritePrompt(cleaned, locale));
		if (rewritten && CJK_RE.test(rewritten)) {
			cleaned = rewritten;
		}
	}

	return cleaned;
}

/**
 * Cursor does not expose vscode.lm models. Its native generate command DOES read `.cursorrules`.
 * Temporarily inject a strong language rule, generate, then restore the file.
 */
export async function withTemporaryCommitLanguageRule<T>(
	repoRoot: string,
	fn: () => Promise<T>
): Promise<T> {
	const locale = resolveCommitMessageLocale();
	const rulesPath = path.join(repoRoot, '.cursorrules');
	const snippet = [
		RULE_MARKER_START,
		locale.cursorRulesBlock,
		RULE_MARKER_END,
		'',
	].join('\n');

	let original: string | undefined;
	let existed = false;
	try {
		try {
			original = await fs.readFile(rulesPath, 'utf8');
			existed = true;
		} catch {
			original = undefined;
			existed = false;
		}

		const stripped = existed
			? original!.replace(
					new RegExp(`${escapeRegExp(RULE_MARKER_START)}[\\s\\S]*?${escapeRegExp(RULE_MARKER_END)}\\r?\\n?`, 'g'),
					''
				)
			: '';
		await fs.writeFile(rulesPath, `${snippet}${stripped}`, 'utf8');
		// Give Cursor a moment to pick up the on-disk rules before generating.
		await new Promise((resolve) => setTimeout(resolve, 250));
		return await fn();
	} finally {
		try {
			if (!existed) {
				await fs.unlink(rulesPath);
			} else if (original !== undefined) {
				await fs.writeFile(rulesPath, original, 'utf8');
			}
		} catch {
			// best-effort restore
		}
	}
}

export async function rewriteCommitMessageForLocale(message: string): Promise<string | undefined> {
	const locale = resolveCommitMessageLocale();
	if (!locale.wantsCjk || CJK_RE.test(message)) {
		return undefined;
	}
	if (typeof vscode.lm?.selectChatModels !== 'function') {
		return undefined;
	}
	const model = await pickChatModel();
	if (!model) {
		return undefined;
	}
	const rewritten = await requestCommitMessage(model, buildRewritePrompt(message, locale));
	if (rewritten && CJK_RE.test(rewritten)) {
		return rewritten;
	}
	return undefined;
}

/** Last-resort Chinese message from selected paths when AI stays English. */
export function buildLocaleFallbackMessage(
	relativePaths: string[],
	englishMessage?: string
): string | undefined {
	const locale = resolveCommitMessageLocale();
	if (!locale.wantsCjk) {
		return undefined;
	}
	if (englishMessage && CJK_RE.test(englishMessage)) {
		return formatCommitMessageStyle(englishMessage, relativePaths);
	}

	const unique = [...new Set(relativePaths.map((p) => p.replace(/\\/g, '/')))];
	const parsed = parseConventionalCommit(englishMessage || '');
	const subject = inferChineseSubject(unique, englishMessage, parsed);
	const bullets = buildChineseBullets(englishMessage, unique);
	return formatCommitMessageStyle(`${subject}\n\n${bullets.join('\n')}`, relativePaths);
}

/**
 * Normalize AI output:
 * - Keep type(scope) in English ASCII, e.g. feat(commit):
 * - Prefer a short Chinese subject + bullet body (Cursor-native style)
 */
export function formatCommitMessageStyle(message: string, relativePaths: string[] = []): string {
	let text = message.replace(/\r\n/g, '\n').trim();
	if (!text) {
		return text;
	}

	text = normalizeEnglishScope(text);

	const lines = text.split('\n');
	const subjectLine = lines[0].trim();
	const bodyLines = lines.slice(1).map((l) => l.trimEnd());
	const existingBullets = bodyLines
		.map((l) => l.trim())
		.filter((l) => l.startsWith('- ') || l.startsWith('* '));

	if (existingBullets.length >= 2) {
		const rest = bodyLines.filter((l) => {
			const t = l.trim();
			return t && !t.startsWith('- ') && !t.startsWith('* ');
		});
		const bullets = existingBullets.map((l) => l.replace(/^\*\s+/, '- '));
		return [subjectLine, '', ...bullets, ...rest].join('\n').trim();
	}

	// Single-line / no bullets: split Chinese enumeration into subject + details.
	const parsed = parseConventionalCommit(subjectLine);
	if (parsed) {
		const parts = splitChineseClauses(parsed.description);
		if (parts.length >= 2) {
			const subject = `${parsed.type}(${parsed.scope || 'commit'}): ${parts[0]}`;
			const bullets = parts.slice(1).map((p) => `- ${p}`);
			return [normalizeEnglishScope(subject), '', ...bullets].join('\n').trim();
		}
	}

	if (existingBullets.length === 1) {
		return [subjectLine, '', existingBullets[0].replace(/^\*\s+/, '- ')].join('\n').trim();
	}

	// Still no details: synthesize bullets from paths so the body is not empty.
	if (relativePaths.length > 0 && existingBullets.length === 0) {
		const bullets = relativePaths.slice(0, 10).map((p) => `- 更新 ${p.replace(/\\/g, '/')}`);
		return [subjectLine, '', ...bullets].join('\n').trim();
	}

	return text;
}

function parseConventionalCommit(subjectLine: string): {
	type: string;
	scope: string;
	description: string;
} | null {
	const match = subjectLine.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?\s*:\s*(.+)$/);
	if (!match) {
		return null;
	}
	return {
		type: match[1].toLowerCase(),
		scope: (match[2] || '').trim(),
		description: match[3].trim(),
	};
}

function normalizeEnglishScope(message: string): string {
	return message.replace(
		/^([a-zA-Z]+)(?:\(([^)]*)\))?\s*:\s*/u,
		(_full, type: string, scope: string | undefined) => {
			const t = type.toLowerCase();
			const rawScope = (scope || '').trim();
			if (!rawScope) {
				return `${t}: `;
			}
			if (!CJK_RE.test(rawScope) && /^[a-zA-Z0-9_./-]+$/.test(rawScope)) {
				return `${t}(${rawScope}): `;
			}
			return `${t}(${mapScopeToEnglish(rawScope)}): `;
		}
	);
}

function mapScopeToEnglish(scope: string): string {
	const s = scope.toLowerCase();
	if (s.includes('提交') || s.includes('commit')) {
		return 'commit';
	}
	if (s.includes('面板') || s.includes('panel') || s.includes('ui') || s.includes('界面')) {
		return 'ui';
	}
	if (s.includes('生成') || s.includes('generate')) {
		return 'commit';
	}
	if (s.includes('样式') || s.includes('css') || s.includes('style')) {
		return 'style';
	}
	if (s.includes('任务') || s.includes('task')) {
		return 'build';
	}
	// Fallback: ascii slug from letters/digits only, else "commit"
	const ascii = scope
		.replace(CJK_RE, '')
		.replace(/[^a-zA-Z0-9_./-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
	return ascii || 'commit';
}

function splitChineseClauses(description: string): string[] {
	return description
		.split(/[，；;]+/u)
		.map((part) => part.trim().replace(/[。．.]+$/u, ''))
		.filter((part) => part.length >= 2);
}

function buildChineseBullets(englishMessage: string | undefined, paths: string[]): string[] {
	const fromEnglish = extractEnglishBullets(englishMessage)
		.map((line) => `- ${localizeBullet(line)}`)
		.filter(Boolean);
	if (fromEnglish.length > 0) {
		return fromEnglish.slice(0, 12);
	}
	return paths.slice(0, 10).map((p) => `- 更新 ${p}`);
}

function extractEnglishBullets(englishMessage?: string): string[] {
	if (!englishMessage) {
		return [];
	}
	return englishMessage
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith('-') || line.startsWith('*'))
		.map((line) => line.replace(/^[-*]\s*/, '').trim())
		.filter(Boolean);
}

/** Always return Chinese text for a bullet. */
function localizeBullet(line: string): string {
	const lower = line.toLowerCase();
	if (lower.includes('generate') && lower.includes('commit')) {
		return '新增/完善 AI 生成提交信息能力';
	}
	if (lower.includes('resize') || lower.includes('drag')) {
		return '调整提交输入框拖动手柄位置与交互';
	}
	if (lower.includes('button') || lower.includes('sparkle') || lower.includes('icon')) {
		return '调整生成按钮位置与样式';
	}
	if (lower.includes('task') || lower.includes('vscode')) {
		return '优化 VS Code / Cursor 任务与调试配置';
	}
	if (lower.includes('css') || lower.includes('ui') || lower.includes('layout')) {
		return '优化提交面板界面布局';
	}
	if (lower.includes('language') || lower.includes('locale') || lower.includes('chinese')) {
		return '按系统语言生成中文提交说明';
	}
	if (lower.includes('package') && lower.includes('version')) {
		return '更新扩展版本号与依赖信息';
	}
	if (lower.includes('error handling') || lower.includes('backend') || lower.includes('logic')) {
		return '完善生成提交信息的后端逻辑与错误处理';
	}
	if (lower.includes('added') || lower.includes('introduce')) {
		return `新增：${stripLeadingVerb(line)}`;
	}
	if (lower.includes('updated') || lower.includes('update')) {
		return `更新：${stripLeadingVerb(line)}`;
	}
	if (lower.includes('enhanced') || lower.includes('improve')) {
		return `优化：${stripLeadingVerb(line)}`;
	}
	if (lower.includes('implemented') || lower.includes('implement')) {
		return `实现：${stripLeadingVerb(line)}`;
	}
	return `调整：${line}`;
}

function stripLeadingVerb(line: string): string {
	return line.replace(
		/^(Added|Add|Updated|Update|Enhanced|Improve|Improved|Implemented|Implement|Introduced|Introduce)\s+/i,
		''
	);
}

export function resolveCommitMessageLocale(): {
	id: string;
	label: string;
	wantsCjk: boolean;
	instruction: string;
	cursorRulesBlock: string;
} {
	const editor = (vscode.env.language || '').trim();
	const system = detectSystemLocale();
	const id = pickPreferredLocale(editor, system);
	const lower = id.toLowerCase();

	if (lower.startsWith('zh')) {
		const instruction = [
			'【硬性要求】提交说明的标题描述与正文细项必须使用简体中文。',
			'Conventional Commit 的 type 与 scope 必须用英文 ASCII，例如 feat(commit): / fix(ui):，括号内禁止中文。',
			'格式必须类似 Cursor 原生：第一行短标题，空一行，然后多条以 "- " 开头的细项（至少 2 条，覆盖主要改动）。',
			'不要把所有内容挤在一行；不要省略 bullet 细项。',
		].join('');
		return {
			id,
			label: '简体中文',
			wantsCjk: true,
			instruction,
			cursorRulesBlock: [
				'## Git commit messages',
				'When generating a Git commit message for this repository:',
				'- Use Conventional Commits with ENGLISH type and ENGLISH scope only, e.g. feat(commit): or fix(ui):',
				'- NEVER put Chinese inside the parentheses scope. Wrong: feat(提交信息生成):  ... Right: feat(commit): ...',
				'- Write the subject description and ALL body bullets in Simplified Chinese.',
				'- Match Cursor native style: short subject line, blank line, then multiple "- " bullet details (2+ bullets).',
				'- Do not collapse everything into one long sentence without bullets.',
				'- Example:',
				'  feat(commit): 增加 AI 生成提交信息功能',
				'',
				'  - 为提交面板增加 AI 生成按钮',
				'  - 优化输入框拖动手柄与样式',
				'  - 按系统语言生成简体中文说明',
			].join('\n'),
		};
	}
	if (lower.startsWith('ja')) {
		return {
			id,
			label: '日本語',
			wantsCjk: true,
			instruction: 'Commit message 全体を日本語で書いてください。',
			cursorRulesBlock:
				'When generating Git commit messages, ALWAYS write them in Japanese, even if recent commits are in English.',
		};
	}
	if (lower.startsWith('ko')) {
		return {
			id,
			label: '한국어',
			wantsCjk: true,
			instruction: '커밋 메시지 전체를 한국어로 작성하세요.',
			cursorRulesBlock:
				'When generating Git commit messages, ALWAYS write them in Korean, even if recent commits are in English.',
		};
	}
	if (lower.startsWith('en')) {
		return {
			id,
			label: 'English',
			wantsCjk: false,
			instruction: 'Write the entire commit message in English.',
			cursorRulesBlock: 'When generating Git commit messages, write them in English.',
		};
	}
	return {
		id,
		label: id,
		wantsCjk: false,
		instruction: `Write the entire commit message in the language for locale "${id}".`,
		cursorRulesBlock: `When generating Git commit messages, write them in the language for locale "${id}".`,
	};
}

function inferChineseSubject(
	paths: string[],
	englishMessage?: string,
	parsed?: { type: string; scope: string; description: string } | null
): string {
	const joined = paths.join(' ').toLowerCase();
	const eng = (englishMessage || '').toLowerCase();
	const type = parsed?.type || (eng.includes('fix') ? 'fix' : 'feat');
	const scope =
		parsed?.scope && !CJK_RE.test(parsed.scope)
			? parsed.scope
			: joined.includes('commit') || eng.includes('commit')
				? 'commit'
				: joined.includes('.css') || eng.includes('ui')
					? 'ui'
					: 'commit';
	if (joined.includes('commit') || eng.includes('commit message')) {
		return `${type}(${scope}): 改进提交信息生成与面板交互`;
	}
	if (joined.includes('.css') || joined.includes('ui') || eng.includes('ui')) {
		return `${type}(${scope}): 优化界面布局与交互`;
	}
	if (paths.length === 1) {
		return `chore: 更新 ${paths[0]}`;
	}
	return `chore: 更新 ${paths.length} 个文件`;
}

function pickPreferredLocale(editor: string, system: string): string {
	const e = editor.toLowerCase();
	const s = system.toLowerCase();
	if (e.startsWith('zh')) {
		return editor || 'zh-cn';
	}
	if (s.startsWith('zh')) {
		return system || 'zh-CN';
	}
	return editor || system || 'en';
}

function detectSystemLocale(): string {
	try {
		const intl = Intl.DateTimeFormat().resolvedOptions().locale;
		if (intl) {
			return intl;
		}
	} catch {
		// ignore
	}
	const env =
		process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || '';
	if (env) {
		return env.split('.')[0].replace(/_/g, '-');
	}
	return '';
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pickChatModel(): Promise<vscode.LanguageModelChat | undefined> {
	try {
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

async function requestCommitMessage(
	model: vscode.LanguageModelChat,
	prompt: string
): Promise<string> {
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];
	const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
	let text = '';
	for await (const chunk of response.text) {
		text += chunk;
	}
	return sanitizeGeneratedMessage(text);
}

function buildPrompt(input: {
	diffs: string;
	recentCommits: string[];
	projectRules: string;
	locale: ReturnType<typeof resolveCommitMessageLocale>;
}): string {
	const recent =
		input.recentCommits.length > 0
			? input.recentCommits.map((m) => `- ${m.replace(/\s+/g, ' ').trim()}`).join('\n')
			: '(none)';
	const rules = input.projectRules.trim() || '(none found)';

	return [
		'You are generating a Git commit message for the staged changes below.',
		'Return ONLY the commit message text. No markdown fences, no quotes, no preamble.',
		'',
		`Target language: ${input.locale.label} (locale=${input.locale.id})`,
		input.locale.instruction,
		'',
		'Follow project rules related to commits and style when present:',
		rules,
		'',
		'Recent commit messages (structure/style reference ONLY; do NOT copy their language if it conflicts with Target language):',
		recent,
		'',
		'Staged diffs:',
		input.diffs,
	].join('\n');
}

function buildRewritePrompt(
	englishMessage: string,
	locale: ReturnType<typeof resolveCommitMessageLocale>
): string {
	return [
		'Rewrite the following Git commit message into the required target language and format.',
		'Keep the same meaning and keep a Cursor-native structure: short subject, blank line, then multiple "- " bullet details.',
		'type(scope) must use English ASCII only, e.g. feat(commit): — never Chinese inside parentheses.',
		'Return ONLY the rewritten commit message. No markdown fences, no quotes, no preamble.',
		'',
		`Target language: ${locale.label} (locale=${locale.id})`,
		locale.instruction,
		'',
		'Original message:',
		englishMessage,
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
		: await listStagedPaths(repo.rootUri.fsPath);

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
				parts.push(
					`### ${label}\n${text.slice(0, Math.max(0, MAX_RULES_CHARS - total - 40))}\n... (truncated)\n`
				);
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
