import * as vscode from 'vscode';

const SELECTION_KEY = 'updateAll.repoSelection';

function normalizeRoot(root: string): string {
	return root.replace(/\\/g, '/').toLowerCase();
}

/**
 * Remembers which repositories the user checked for Update All / Pull.
 * Missing keys default to checked (true).
 */
export class UpdateAllSelectionStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	private readMap(): Record<string, boolean> {
		const raw = this.context.workspaceState.get<Record<string, boolean>>(SELECTION_KEY);
		if (!raw || typeof raw !== 'object') {
			return {};
		}
		const out: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === 'boolean') {
				out[normalizeRoot(key)] = value;
			}
		}
		return out;
	}

	isChecked(rootPath: string): boolean {
		const map = this.readMap();
		const key = normalizeRoot(rootPath);
		return map[key] !== false;
	}

	async setChecked(rootPath: string, checked: boolean): Promise<void> {
		const map = this.readMap();
		map[normalizeRoot(rootPath)] = checked;
		await this.context.workspaceState.update(SELECTION_KEY, map);
	}

	async setMany(selections: Array<{ rootPath: string; checked: boolean }>): Promise<void> {
		const map = this.readMap();
		for (const item of selections) {
			map[normalizeRoot(item.rootPath)] = item.checked;
		}
		await this.context.workspaceState.update(SELECTION_KEY, map);
	}

	/** Apply remembered preferences to the current repo list (new repos default checked). */
	resolve(repos: Array<{ rootPath: string; name: string }>): Array<{
		rootPath: string;
		name: string;
		checked: boolean;
	}> {
		return repos.map((repo) => ({
			...repo,
			checked: this.isChecked(repo.rootPath),
		}));
	}
}
