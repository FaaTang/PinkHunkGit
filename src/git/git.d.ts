/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, Event, Disposable, ProviderResult, Command, CancellationToken } from 'vscode';
export { ProviderResult } from 'vscode';

export interface Git {
	readonly path: string;
}

export interface InputBox {
	value: string;
}

export const enum ForcePushMode {
	Force = 0,
	ForceWithLease = 1,
	ForceWithLeaseIfIncludes = 2,
}

export const enum RefType {
	Head = 0,
	RemoteHead = 1,
	Tag = 2,
}

export interface Ref {
	readonly type: RefType;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

export interface UpstreamRef {
	readonly remote: string;
	readonly name: string;
	readonly commit?: string;
}

export interface Branch extends Ref {
	readonly upstream?: UpstreamRef;
	readonly ahead?: number;
	readonly behind?: number;
}

export interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
	readonly authorDate?: Date;
	readonly authorName?: string;
	readonly authorEmail?: string;
	readonly commitDate?: Date;
}

export interface Remote {
	readonly name: string;
	readonly fetchUrl?: string;
	readonly pushUrl?: string;
	readonly isReadOnly: boolean;
}

export const enum Status {
	INDEX_MODIFIED = 0,
	INDEX_ADDED = 1,
	INDEX_DELETED = 2,
	INDEX_RENAMED = 3,
	INDEX_COPIED = 4,

	MODIFIED = 5,
	DELETED = 6,
	UNTRACKED = 7,
	IGNORED = 8,
	INTENT_TO_ADD = 9,
	INTENT_TO_RENAME = 10,
	TYPE_CHANGED = 11,

	ADDED_BY_US = 12,
	ADDED_BY_THEM = 13,
	DELETED_BY_US = 14,
	DELETED_BY_THEM = 15,
	BOTH_ADDED = 16,
	BOTH_DELETED = 17,
	BOTH_MODIFIED = 18,
}

export interface Change {
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: Status;
}

export type RepositoryKind = 'repository' | 'submodule' | 'worktree';

export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly refs: Ref[];
	readonly remotes: Remote[];
	readonly rebaseCommit: Commit | undefined;
	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	readonly untrackedChanges?: Change[];
	readonly onDidChange: Event<void>;
}

export interface RepositoryUIState {
	readonly selected: boolean;
	readonly onDidChange: Event<void>;
}

export interface CommitOptions {
	all?: boolean | 'tracked';
	amend?: boolean;
	signoff?: boolean;
	signCommit?: boolean;
	empty?: boolean;
	noVerify?: boolean;
	requireUserConfig?: boolean;
	postCommitCommand?: string | null;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: InputBox;
	readonly state: RepositoryState;
	readonly ui: RepositoryUIState;
	readonly kind: RepositoryKind;
	readonly onDidCommit?: Event<void>;

	show(ref: string, path: string): Promise<string>;
	add(paths: string[]): Promise<void>;
	revert(paths: string[]): Promise<void>;
	restore(paths: string[], options?: { staged?: boolean; ref?: string }): Promise<void>;
	clean(paths: string[]): Promise<void>;
	diffIndexWithHEAD(path: string): Promise<string>;
	diffWithHEAD(path: string): Promise<string>;
	status(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;
	commit(message: string, opts?: CommitOptions): Promise<void>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
	readonly state: APIState;
	readonly onDidChangeState: Event<APIState>;
	readonly git: Git;
	readonly repositories: Repository[];
	readonly onDidOpenRepository: Event<Repository>;
	readonly onDidCloseRepository: Event<Repository>;
	getRepository(uri: Uri): Repository | null;
	toGitUri(uri: Uri, ref: string): Uri;
}

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}

export const enum GitErrorCodes {
	AuthenticationFailed = 'AuthenticationFailed',
	NoUpstreamBranch = 'NoUpstreamBranch',
	NotAGitRepository = 'NotAGitRepository',
}
