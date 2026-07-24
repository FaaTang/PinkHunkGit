export type ChangeItem = {
	path: string;
	fsPath: string;
	status: string;
	staged: boolean;
	unsaved?: boolean;
	conflict?: boolean;
};

export type { FastPushFlags, FastPushSettingsPayload } from '../fastPush/settings';

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
	/** Git service is still initializing; show a loading state instead of an error. */
	loading?: boolean;
	hint?: string;
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

export type CommitLogItem = {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	date: string;
	refs?: string;
};

export type CommitLogPayload = {
	repoRoot: string;
	repoName: string;
	branch?: string;
	commits: CommitLogItem[];
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
	batch?: boolean;
	paths?: Array<{ repoRoot: string; path: string; staged: boolean }>;
	allUntracked?: boolean;
};

export type SyncMode = 'merge' | 'rebase';

export type PushRejectedPayload = {
	message: string;
	repoRoot?: string;
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
	repoRoot?: string;
	repoName: string;
	branch?: string;
	upstream?: string;
};

export type AskPushPayload = {
	repoRoot?: string;
	repoName: string;
	branch?: string;
	upstream?: string;
	ahead?: number;
	behind?: number;
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
	| { type: 'showUpdateAllDialog'; payload: { repos: Array<{ rootPath: string; name: string; checked: boolean }> } }
	| { type: 'updateAllSubmit' }
	| {
			type: 'showFastPushCommitDialog';
			payload: { reason: string; draft?: string };
	  }
	| { type: 'clearMessage' }
	| { type: 'focusMessage' }
	| { type: 'setMessage'; message: string }
	| { type: 'generateCommitMessageState'; busy: boolean }
	| { type: 'fastPushSettings'; payload: import('../fastPush/settings').FastPushSettingsPayload }
	| { type: 'commitLog'; payload: CommitLogPayload }
	| { type: 'expandChanges' }
	| { type: 'triggerAddToGit' }
	| { type: 'triggerCommit' }
	| { type: 'triggerCommitAndPush' }
	| { type: 'triggerFastPush' };

export type WebviewToHost =
	| { type: 'ready' }
	| { type: 'switchRepo'; repoRoot: string }
	| { type: 'stageAll'; staged: boolean }
	| { type: 'updateSelection'; repoRoot: string; path: string | null; staged: boolean }
	| { type: 'openDiff'; repoRoot: string; path: string; staged: boolean }
	| { type: 'openFile'; repoRoot: string; path: string }
	| { type: 'revealInExplorer'; repoRoot: string; path: string }
	| { type: 'rollback'; repoRoot: string; path: string; staged: boolean }
	| { type: 'rollbackBatch'; paths: Array<{ repoRoot: string; path: string; staged: boolean }>; unversionedGroup?: boolean }
	| { type: 'rollbackConfirm'; repoRoot: string; path: string; staged: boolean }
	| { type: 'rollbackBatchConfirm'; paths: Array<{ repoRoot: string; path: string; staged: boolean }> }
	| { type: 'rollbackCancel' }
	| { type: 'addToGit'; paths: Array<{ repoRoot: string; path: string }> }
	| {
			type: 'commit';
			message: string;
			checkedChanges?: Array<{ repoRoot: string; path: string }>;
			unversionedPaths?: Array<{ repoRoot: string; path: string }>;
	  }
	| {
			type: 'commitAndPush';
			message: string;
			checkedChanges?: Array<{ repoRoot: string; path: string }>;
			unversionedPaths?: Array<{ repoRoot: string; path: string }>;
	  }
	| {
			type: 'fastPush';
			message?: string;
			checkedChanges?: Array<{ repoRoot: string; path: string }>;
			unversionedPaths?: Array<{ repoRoot: string; path: string }>;
	  }
	| { type: 'fastPushCommitConfirm'; message: string }
	| { type: 'fastPushCommitCancel' }
	| { type: 'getFastPushSettings' }
	| {
			type: 'saveFastPushSettings';
			workspace: import('../fastPush/settings').FastPushFlags;
			global: import('../fastPush/settings').FastPushFlags;
	  }
	| { type: 'push'; repoRoot?: string; pushTags?: boolean }
	| { type: 'pushSync'; mode: SyncMode; repoRoot?: string }
	| { type: 'syncAbort'; repoRoot?: string }
	| { type: 'syncContinue'; repoRoot?: string }
	| { type: 'openConflict'; path: string }
	| { type: 'askPushConfirm'; repoRoot?: string; pushTags?: boolean }
	| { type: 'askPushCancel' }
	| { type: 'pushDialogCancel' }
	| { type: 'updateAllConfirm'; repoRoots: string[]; selections?: Array<{ rootPath: string; checked: boolean }> }
	| { type: 'updateAllCancel' }
	| {
			type: 'updateAllSelectionChanged';
			selections: Array<{ rootPath: string; checked: boolean }>;
	  }
	| { type: 'refresh' }
	| { type: 'installKeybindings' }
	| { type: 'openGitExtension' }
	| {
			type: 'generateCommitMessage';
			checkedChanges?: Array<{ repoRoot: string; path: string }>;
			unversionedPaths?: Array<{ repoRoot: string; path: string }>;
	  }
	| { type: 'loadCommitLog'; repoRoot: string }
	| { type: 'openCommitChanges'; repoRoot: string; hash: string }
	| { type: 'copyCommitHash'; hash: string }
	| { type: 'copyCommitMessage'; repoRoot: string; hash: string };
