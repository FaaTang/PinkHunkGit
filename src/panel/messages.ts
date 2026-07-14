export type ChangeItem = {
	path: string;
	fsPath: string;
	status: string;
	staged: boolean;
	unsaved?: boolean;
	conflict?: boolean;
};

export type RepoSnapshot = {
	ok: boolean;
	error?: string;
	hint?: string;
	rootPath: string;
	name: string;
	branch?: string;
	ahead?: number;
	behind?: number;
	upstream?: string;
	remotes?: string[];
	staged: ChangeItem[];
	unstaged: ChangeItem[];
	unversioned: ChangeItem[];
	conflictFiles?: ChangeItem[];
	syncMode?: SyncMode;
};

export type RepoSummary = {
	rootPath: string;
	name: string;
	branch?: string;
	changeCount: number;
};

export type WorkspaceSnapshot = {
	ok: boolean;
	error?: string;
	/** Focused repository (editor / last selection); used for Push / sync defaults. */
	activeRepoRoot?: string;
	/** Full per-repository snapshots for grouped Changes UI. */
	repositories: RepoSnapshot[];
	/** Focused repository snapshot (compat / push context). */
	active: RepoSnapshot;
	busy?: boolean;
};

export type CommitRepoResult = {
	rootPath: string;
	name: string;
	branch?: string;
};

export type DiffResult = {
	path: string;
	staged: boolean;
	kind: 'text' | 'binary' | 'too-large' | 'missing' | 'empty';
	unified?: string;
	message?: string;
};

export type RollbackDialogPayload = {
	repoRoot: string;
	path: string;
	staged: boolean;
	isUntracked: boolean;
};

export type SyncMode = 'merge' | 'rebase';

export type PushRejectedPayload = {
	message: string;
	repoName: string;
	branch?: string;
	upstream?: string;
	behind?: number;
	ahead?: number;
};

export type SyncConflictPayload = {
	mode: SyncMode;
	message: string;
	conflicts: ChangeItem[];
	repoName: string;
	branch?: string;
	upstream?: string;
};

export type AskPushPayload = {
	repoName: string;
	branch?: string;
	upstream?: string;
	ahead?: number;
	summary: string;
};

export type HostToWebview =
	| { type: 'snapshot'; payload: WorkspaceSnapshot }
	| { type: 'diff'; payload: DiffResult }
	| { type: 'error'; message: string }
	| { type: 'busy'; busy: boolean }
	| { type: 'showPushDialog'; payload: WorkspaceSnapshot }
	| { type: 'showPushRejected'; payload: PushRejectedPayload }
	| { type: 'showSyncConflict'; payload: SyncConflictPayload }
	| { type: 'showAskPush'; payload: AskPushPayload }
	| { type: 'closePushDialog' }
	| { type: 'showRollbackDialog'; payload: RollbackDialogPayload }
	| { type: 'clearMessage' }
	| { type: 'focusMessage' };

export type WebviewToHost =
	| { type: 'ready' }
	| { type: 'switchRepo'; repoRoot: string }
	| { type: 'toggleStage'; repoRoot: string; path: string; staged: boolean; currentlyStaged: boolean }
	| { type: 'stageAll'; staged: boolean }
	| { type: 'updateSelection'; repoRoot: string; path: string | null; staged: boolean }
	| { type: 'openDiff'; repoRoot: string; path: string; staged: boolean }
	| { type: 'openFile'; repoRoot: string; path: string }
	| { type: 'revealInExplorer'; repoRoot: string; path: string }
	| { type: 'rollback'; repoRoot: string; path: string; staged: boolean }
	| { type: 'rollbackConfirm'; repoRoot: string; path: string; staged: boolean }
	| { type: 'rollbackCancel' }
	| { type: 'commit'; message: string }
	| { type: 'commitAndPush'; message: string }
	| { type: 'push' }
	| { type: 'pushSync'; mode: SyncMode }
	| { type: 'syncAbort' }
	| { type: 'syncContinue' }
	| { type: 'openConflict'; path: string }
	| { type: 'askPushConfirm' }
	| { type: 'askPushCancel' }
	| { type: 'pushDialogCancel' }
	| { type: 'refresh' }
	| { type: 'installKeybindings' }
	| { type: 'openGitExtension' };
