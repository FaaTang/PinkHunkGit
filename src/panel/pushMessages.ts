import { ChangeItem, SyncMode } from './messages';

export type PushCommitItem = {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	date: string;
};

export type PushTarget = {
	repoRoot: string;
	repoName: string;
	branch?: string;
	upstream?: string;
	remote?: string;
	upstreamBranch?: string;
	ahead?: number;
	behind?: number;
	/** IDEA-style label, e.g. `main → origin : main` */
	label: string;
	commits: PushCommitItem[];
};

export type PushDialogPayload = {
	targets: PushTarget[];
	activeRepoRoot?: string;
	pendingRepoRoots?: string[];
	busy?: boolean;
};

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

export type PushHostToWebview =
	| { type: 'state'; payload: PushDialogPayload }
	| { type: 'busy'; busy: boolean }
	| { type: 'error'; message: string }
	| { type: 'showRejected'; payload: PushRejectedPayload }
	| { type: 'showSyncConflict'; payload: SyncConflictPayload }
	| { type: 'showAskPush'; payload: AskPushPayload }
	| { type: 'close' };

export type PushWebviewToHost =
	| { type: 'ready' }
	| { type: 'cancel' }
	| { type: 'push'; repoRoots: string[]; pushTags?: boolean }
	| { type: 'pushSync'; mode: SyncMode; repoRoot?: string }
	| { type: 'syncAbort'; repoRoot?: string }
	| { type: 'syncContinue'; repoRoot?: string }
	| { type: 'openConflict'; path: string; repoRoot?: string }
	| { type: 'askPushConfirm'; repoRoot?: string; pushTags?: boolean }
	| { type: 'askPushCancel' }
	| { type: 'selectTarget'; repoRoot: string }
	| { type: 'refresh' };
