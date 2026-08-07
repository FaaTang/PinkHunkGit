export type CloneProtocol = 'ssh' | 'https' | 'git' | 'unknown';

export type ParsedCloneUrl = {
	url: string;
	protocol: CloneProtocol;
	repoName?: string;
	host?: string;
};

/** Human-readable protocol badge for the clone dialog. */
export function protocolLabel(protocol: CloneProtocol): string | undefined {
	switch (protocol) {
		case 'ssh':
			return 'SSH';
		case 'https':
			return 'HTTPS';
		case 'git':
			return 'Git';
		default:
			return undefined;
	}
}

/**
 * Heuristic: looks like something `git clone` could accept.
 * Keeps false positives low for empty / partial typing.
 */
export function isLikelyCloneUrl(raw: string): boolean {
	const url = raw.trim();
	if (!url || /\s/.test(url)) {
		return false;
	}
	if (/^https?:\/\//i.test(url)) {
		return /https?:\/\/[^/\s]+\/.+/.test(url);
	}
	if (/^ssh:\/\//i.test(url)) {
		return /ssh:\/\/[^/\s]+\/.+/.test(url);
	}
	if (/^git:\/\//i.test(url)) {
		return /git:\/\/[^/\s]+\/.+/.test(url);
	}
	// git@host:path/to/repo(.git)
	if (/^[\w.-]+@[\w.-]+:.+/.test(url)) {
		return true;
	}
	return false;
}

function stripGitSuffix(name: string): string {
	return name.replace(/\.git$/i, '');
}

function lastPathSegment(pathname: string): string | undefined {
	const cleaned = pathname.replace(/\/+$/, '');
	const parts = cleaned.split('/').filter(Boolean);
	const last = parts[parts.length - 1];
	if (!last) {
		return undefined;
	}
	return stripGitSuffix(decodeURIComponent(last));
}

/**
 * Parse a clone URL for protocol detection and suggested directory name.
 * Returns protocol `unknown` when the string is not yet a full clone URL.
 */
export function parseCloneUrl(raw: string): ParsedCloneUrl {
	const url = raw.trim();
	if (!url) {
		return { url: '', protocol: 'unknown' };
	}

	// SCP-like SSH: git@github.com:org/repo.git
	const scp = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(url);
	if (scp) {
		const pathPart = scp[3].replace(/^\/+/, '');
		return {
			url,
			protocol: 'ssh',
			host: scp[2],
			repoName: lastPathSegment(pathPart),
		};
	}

	try {
		if (/^(https?|ssh|git):\/\//i.test(url)) {
			const parsed = new URL(url);
			const protocolName = parsed.protocol.replace(/:$/, '').toLowerCase();
			let protocol: CloneProtocol = 'unknown';
			if (protocolName === 'https' || protocolName === 'http') {
				protocol = 'https';
			} else if (protocolName === 'ssh') {
				protocol = 'ssh';
			} else if (protocolName === 'git') {
				protocol = 'git';
			}
			const repoName = lastPathSegment(parsed.pathname);
			return {
				url,
				protocol,
				host: parsed.hostname || undefined,
				repoName,
			};
		}
	} catch {
		// fall through
	}

	return { url, protocol: 'unknown' };
}
