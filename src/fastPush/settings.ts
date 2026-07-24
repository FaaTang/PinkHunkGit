import * as vscode from 'vscode';

export type FastPushFlags = {
	autoGenerateCommit: boolean;
	autoNewTag: boolean;
	autoPush: boolean;
};

export type FastPushGenerateCapability = {
	available: boolean;
	reason?: string;
};

export type FastPushSettingsPayload = {
	workspace: FastPushFlags;
	global: FastPushFlags;
	/** True when this workspace has saved its own Fast Push overrides. */
	workspaceConfigured: boolean;
	effective: FastPushFlags;
	autoGenerateCommitCapability: FastPushGenerateCapability;
};

const GLOBAL_KEY = 'fastPush.settings';
const WORKSPACE_KEY = 'fastPush.settings';

export const FAST_PUSH_DEFAULTS: FastPushFlags = {
	autoGenerateCommit: true,
	autoNewTag: false,
	autoPush: true,
};

function normalizeFlags(value: unknown, fallback: FastPushFlags): FastPushFlags {
	if (!value || typeof value !== 'object') {
		return { ...fallback };
	}
	const raw = value as Partial<FastPushFlags>;
	return {
		autoGenerateCommit:
			typeof raw.autoGenerateCommit === 'boolean'
				? raw.autoGenerateCommit
				: fallback.autoGenerateCommit,
		autoNewTag: typeof raw.autoNewTag === 'boolean' ? raw.autoNewTag : fallback.autoNewTag,
		autoPush: typeof raw.autoPush === 'boolean' ? raw.autoPush : fallback.autoPush,
	};
}

export class FastPushSettingsStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	getGlobal(): FastPushFlags {
		return normalizeFlags(this.context.globalState.get(GLOBAL_KEY), FAST_PUSH_DEFAULTS);
	}

	getWorkspace(): FastPushFlags | undefined {
		const raw = this.context.workspaceState.get(WORKSPACE_KEY);
		if (raw == null) {
			return undefined;
		}
		return normalizeFlags(raw, FAST_PUSH_DEFAULTS);
	}

	getEffective(capability?: FastPushGenerateCapability): FastPushFlags {
		const global = this.getGlobal();
		const workspace = this.getWorkspace();
		// Workspace overrides Global when this folder has saved Fast Push settings.
		const base = workspace ?? global;
		if (capability && !capability.available) {
			return { ...base, autoGenerateCommit: false };
		}
		return base;
	}

	getPayload(capability: FastPushGenerateCapability): FastPushSettingsPayload {
		const global = this.getGlobal();
		const workspaceStored = this.getWorkspace();
		const workspaceConfigured = workspaceStored != null;
		const workspace = workspaceStored ?? { ...global };
		return {
			global: capability.available ? global : { ...global, autoGenerateCommit: false },
			workspace: capability.available ? workspace : { ...workspace, autoGenerateCommit: false },
			workspaceConfigured,
			effective: this.getEffective(capability),
			autoGenerateCommitCapability: capability,
		};
	}

	async save(
		workspace: FastPushFlags,
		global: FastPushFlags,
		capability: FastPushGenerateCapability
	): Promise<FastPushSettingsPayload> {
		const nextWorkspace = normalizeFlags(workspace, FAST_PUSH_DEFAULTS);
		const nextGlobal = normalizeFlags(global, FAST_PUSH_DEFAULTS);
		if (!capability.available) {
			nextWorkspace.autoGenerateCommit = false;
			nextGlobal.autoGenerateCommit = false;
		}
		await this.context.globalState.update(GLOBAL_KEY, nextGlobal);
		await this.context.workspaceState.update(WORKSPACE_KEY, nextWorkspace);
		return this.getPayload(capability);
	}
}
