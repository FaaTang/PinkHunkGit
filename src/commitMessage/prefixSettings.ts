import * as vscode from 'vscode';
import { enrichCommitMessagePrompt } from './prefixTemplate';

export type CommitMessagePrefixFlags = {
	enabled: boolean;
	prefix: string;
	/** Whether to apply the custom generation prompt from this scope. */
	promptEnabled: boolean;
	/** Extra instruction forced into AI commit-message generation. */
	prompt: string;
};

export type CommitMessagePrefixSettingsPayload = {
	workspace: CommitMessagePrefixFlags;
	global: CommitMessagePrefixFlags;
	workspaceConfigured: boolean;
	effective: CommitMessagePrefixFlags;
};

const GLOBAL_KEY = 'commitMessage.prefixSettings';
const WORKSPACE_KEY = 'commitMessage.prefixSettings';

const GLOBAL_DEFAULTS: CommitMessagePrefixFlags = {
	enabled: false,
	prefix: '',
	promptEnabled: false,
	prompt: '',
};

const WORKSPACE_DEFAULTS: CommitMessagePrefixFlags = {
	enabled: true,
	prefix: '',
	promptEnabled: false,
	prompt: '',
};

function normalizeFlags(value: unknown, fallback: CommitMessagePrefixFlags): CommitMessagePrefixFlags {
	if (!value || typeof value !== 'object') {
		return { ...fallback };
	}
	const raw = value as Partial<CommitMessagePrefixFlags>;
	return {
		enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
		prefix: typeof raw.prefix === 'string' ? raw.prefix : fallback.prefix,
		promptEnabled:
			typeof raw.promptEnabled === 'boolean' ? raw.promptEnabled : fallback.promptEnabled,
		prompt: typeof raw.prompt === 'string' ? raw.prompt : fallback.prompt,
	};
}

export class CommitMessagePrefixSettingsStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	getGlobal(): CommitMessagePrefixFlags {
		return normalizeFlags(this.context.globalState.get(GLOBAL_KEY), GLOBAL_DEFAULTS);
	}

	getWorkspace(): CommitMessagePrefixFlags | undefined {
		const raw = this.context.workspaceState.get(WORKSPACE_KEY);
		if (raw == null) {
			return undefined;
		}
		return normalizeFlags(raw, WORKSPACE_DEFAULTS);
	}

	/**
	 * Effective prefix: Workspace wins only when its Apply Prefix is checked; otherwise Global.
	 * For prompt text: Workspace Force checked uses workspace prompt, but falls back to Global
	 * prompt when workspace prompt is blank (so an empty WS field cannot wipe Global text).
	 */
	getEffective(): CommitMessagePrefixFlags {
		const ws = this.getWorkspace();
		const gl = this.getGlobal();
		const prefixFromWs = !!(ws && ws.enabled);
		const promptFromWs = !!(ws && ws.promptEnabled);
		const wsPrompt = ((ws && ws.prompt) || '').trim();
		const glPrompt = (gl.prompt || '').trim();
		return {
			enabled: prefixFromWs ? true : gl.enabled,
			prefix: prefixFromWs ? ws!.prefix : gl.prefix,
			promptEnabled: promptFromWs ? true : gl.promptEnabled,
			prompt: promptFromWs ? wsPrompt || glPrompt : gl.prompt,
		};
	}

	/**
	 * Effective custom generation prompt text, or empty when disabled / blank.
	 * Expands yyyyMMdd-style tokens and appends an explicit today-date context
	 * so the model cannot invent a stale calendar date.
	 */
	getEffectivePrompt(): string {
		const effective = this.getEffective();
		if (!effective.promptEnabled) {
			return '';
		}
		return enrichCommitMessagePrompt((effective.prompt || '').trim());
	}

	getPayload(): CommitMessagePrefixSettingsPayload {
		const global = this.getGlobal();
		const workspaceStored = this.getWorkspace();
		return {
			global,
			workspace: workspaceStored ?? { ...WORKSPACE_DEFAULTS },
			workspaceConfigured: workspaceStored != null,
			effective: this.getEffective(),
		};
	}

	async save(
		workspace: CommitMessagePrefixFlags,
		global: CommitMessagePrefixFlags
	): Promise<CommitMessagePrefixSettingsPayload> {
		const nextWorkspace = normalizeFlags(workspace, WORKSPACE_DEFAULTS);
		const nextGlobal = normalizeFlags(global, GLOBAL_DEFAULTS);
		await this.context.globalState.update(GLOBAL_KEY, nextGlobal);
		await this.context.workspaceState.update(WORKSPACE_KEY, nextWorkspace);
		return this.getPayload();
	}

	async clearGlobal(): Promise<CommitMessagePrefixSettingsPayload> {
		await this.context.globalState.update(GLOBAL_KEY, { ...GLOBAL_DEFAULTS });
		return this.getPayload();
	}
}
