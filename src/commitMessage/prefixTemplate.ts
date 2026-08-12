/**
 * Date / template helpers for commit-message prefix and mandatory generation prompts.
 * Models often invent stale dates; expand tokens in code with the local calendar date.
 */

/** Local calendar yyyyMMdd (e.g. 20260812). */
export function formatLocalYyyyMmDd(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, '0');
	const d = String(now.getDate()).padStart(2, '0');
	return `${y}${m}${d}`;
}

/** Local calendar yyyy-MM-dd. */
export function formatLocalYyyyMmDdDash(now: Date = new Date()): string {
	const compact = formatLocalYyyyMmDd(now);
	return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * Expand common date placeholders in a prefix or prompt string.
 * Longer tokens first so `yyyyMMdd` is not partially replaced as `yyyy`.
 */
export function expandPrefixTemplate(template: string, now: Date = new Date()): string {
	const text = String(template || '');
	if (!text) {
		return text;
	}
	const ymd = formatLocalYyyyMmDd(now);
	const ymdDash = formatLocalYyyyMmDdDash(now);
	return text
		.replace(/yyyyMMdd/g, ymd)
		.replace(/YYYYMMDD/g, ymd)
		.replace(/yyyy-MM-dd/g, ymdDash)
		.replace(/YYYY-MM-DD/g, ymdDash);
}

/**
 * Enrich a mandatory generation prompt so the model sees a concrete today date
 * and any yyyyMMdd tokens already resolved.
 */
export function enrichCommitMessagePrompt(prompt: string, now: Date = new Date()): string {
	const raw = (prompt || '').trim();
	if (!raw) {
		return '';
	}
	const ymd = formatLocalYyyyMmDd(now);
	const ymdDash = formatLocalYyyyMmDdDash(now);
	const expanded = expandPrefixTemplate(raw, now);
	const requiredPrefix = extractPromptRequiredVersionPrefix(raw, now);
	const dateBlock = [
		`[System date context] Today's local calendar date is ${ymdDash} (yyyyMMdd=${ymd}).`,
		'If the instruction mentions a date prefix or the token yyyyMMdd / YYYYMMDD, use this exact date — never invent another date (e.g. do not use 20231005).',
		'Any yyyyMMdd placeholders in the instruction above have already been expanded to the real today.',
		requiredPrefix
			? `The commit message MUST start with exactly "${requiredPrefix}" (space then subject). Do not omit it and do not use any other vYYYYMMDD#N value.`
			: '',
	]
		.filter(Boolean)
		.join(' ');
	return `${expanded}\n\n${dateBlock}`;
}

/** Leading auto-style prefix like `v20260812#000 `. */
const LEADING_V_DATE_PREFIX_RE = /^(v\d{8}#\d+)(?:\s+|$)([\s\S]*)$/u;

/**
 * Remove a leading `vYYYYMMDD#N` prefix so a configured (expanded) prefix can be applied cleanly.
 */
export function stripLeadingVersionDatePrefix(message: string): string {
	const peeled = peelLeadingVersionDatePrefix(message);
	return peeled.body;
}

/** Peel a leading `vYYYYMMDD#N` so style formatting can run on the conventional subject. */
export function peelLeadingVersionDatePrefix(message: string): { prefix: string; body: string } {
	const text = String(message || '').trim();
	if (!text) {
		return { prefix: '', body: '' };
	}
	const match = text.match(LEADING_V_DATE_PREFIX_RE);
	if (!match) {
		return { prefix: '', body: text };
	}
	return { prefix: match[1], body: (match[2] || '').trim() };
}

/**
 * From a mandatory prompt, resolve the exact version-date prefix the message must start with.
 * Examples in prompt: `vyyyyMMdd#000`, `v20260812#000`, 「加上前缀 vyyyyMMdd#000」.
 */
export function extractPromptRequiredVersionPrefix(
	prompt: string,
	now: Date = new Date()
): string | undefined {
	const raw = (prompt || '').trim();
	if (!raw) {
		return undefined;
	}
	const expanded = expandPrefixTemplate(raw, now);
	const explicit = expanded.match(/\bv(\d{8})#(\d+)\b/);
	if (explicit) {
		return `v${explicit[1]}#${explicit[2]}`;
	}
	// "加上前缀…yyyyMMdd…" without a full v…#… token yet
	if (/yyyyMMdd|YYYYMMDD/u.test(raw) && /前缀|prefix/i.test(raw)) {
		return `v${formatLocalYyyyMmDd(now)}#000`;
	}
	return undefined;
}

/**
 * Code-level enforcement: if the mandatory prompt requires a vYYYYMMDD#N prefix,
 * force it onto the message (correct wrong dates / add when the model omitted it).
 */
export function enforcePromptRequiredPrefix(
	message: string,
	prompt: string,
	now: Date = new Date()
): string {
	const required = extractPromptRequiredVersionPrefix(prompt, now);
	let text = expandPrefixTemplate(String(message || '').trim(), now);
	if (!text) {
		return text;
	}
	if (!required) {
		return text;
	}
	text = stripLeadingVersionDatePrefix(text).trim();
	if (!text) {
		return required;
	}
	if (text.startsWith(`${required} `) || text === required) {
		return text;
	}
	return `${required} ${text}`;
}
