import * as vscode from 'vscode';

export type CommitMessagePrefixFlags = {
	enabled: boolean;
	prefix: string;
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
};

const WORKSPACE_DEFAULTS: CommitMessagePrefixFlags = {
	enabled: true,
	prefix: '',
};

function normalizeFlags(value: unknown, fallback: CommitMessagePrefixFlags): CommitMessagePrefixFlags {
	if (!value || typeof value !== 'object') {
		return { ...fallback };
	}
	const raw = value as Partial<CommitMessagePrefixFlags>;
	return {
		enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
		prefix: typeof raw.prefix === 'string' ? raw.prefix : fallback.prefix,
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

	getEffective(): CommitMessagePrefixFlags {
		const ws = this.getWorkspace();
		// Workspace 优先级：只有当 Workspace 已启用时才生效；未勾选时回退 Global。
		if (ws && ws.enabled) {
			return ws;
		}
		return this.getGlobal();
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
