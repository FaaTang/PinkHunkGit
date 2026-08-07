export type CloneDialogPayload = {
	recentUrls: string[];
	defaultDirectory: string;
	currentProxy?: string;
	usingSessionProxy?: boolean;
	busy?: boolean;
};

export type CloneHostToWebview =
	| { type: 'state'; payload: CloneDialogPayload }
	| { type: 'busy'; busy: boolean; message?: string }
	| { type: 'error'; message: string }
	| { type: 'protocolDetected'; protocol?: string }
	| {
			type: 'cloneProgress';
			phase?: 'counting' | 'compressing' | 'receiving' | 'resolving' | 'updating' | 'other';
			percent?: number;
			detail: string;
			downloadedKB?: number;
			totalKB?: number;
			speedKBps?: number;
	  }
	| { type: 'directoryPicked'; directory: string }
	| { type: 'cloneSuccess'; path: string }
	| { type: 'close' };

export type CloneWebviewToHost =
	| { type: 'ready' }
	| { type: 'cancel' }
	| { type: 'cancelClone' }
	| { type: 'setSessionProxy'; proxy?: string }
	| { type: 'clone'; url: string; directory: string }
	| { type: 'pickDirectory'; url?: string }
	| { type: 'urlChanged'; url: string };
