# Pink Hunk Git
 
[中文](README.zh-CN.md)

An IntelliJ IDEA–style **Commit** panel for VS Code / Cursor: stage files from a checklist, diff, commit / push, rollback, and more.

## Install (manual from GitHub Release)

1. Open [Releases](https://github.com/FaaTang/PinkHunkGit/releases) and download the latest `.vsix`
2. In VS Code / Cursor, run from the Command Palette: `Extensions: Install from VSIX...`
3. Select the downloaded `.vsix` and reload the window if prompted

## Release (maintainers)

Pushing a `v*` tag triggers GitHub Actions to package a `.vsix` and create a Release.

```bash
# Ensure code is pushed to main
git push origin main

# Tag and push (example)
git tag v2.0.20
git push origin v2.0.20
```

Optional: set `RELEASE_BRANCH` under Settings → Variables → Actions (default `main`). A release runs only when the tagged commit is on that branch history.

## Local development

```bash
npm install
npm run compile
# F5 to launch Extension Development Host
```

Package locally:

```bash
npm run package
# Produces pink-hunk-git-x.y.z.vsix
```

## Features

- Dedicated Commit panel in the Activity Bar
- Changes / Unversioned Files groups (IDEA-style); repositories collapsed by default (categories stay open); Expand All / Collapse All apply to the selected group, repository, or folder — with a confirm dialog when none is selected
- Check files to include in commit; right-click for Diff / Rollback / Open File / Reveal in Explorer
- Commit / Commit and Push; multi-repo switching
- Fast Push (from Commit and Push ▾): optional AI commit message → commit → optional auto `v*` tag bump → optional push with auto-merge
- AI commit messages: force **Simplified Chinese** subject + bullets from system/prompt; optional prefix and mandatory generation prompt (Workspace / Global, with Clear Global). Forced prompts are injected into generation and enforced afterwards in code; `yyyyMMdd` / `YYYYMMDD` expand to today's local date (e.g. `vyyyyMMdd#000` → `v20260812#000`). Vague “updated N files” subjects are rejected; fallbacks summarize staged diffs instead
- Soft exclusive Git (default on): disables built-in `git.autofetch` / `git.autorefresh` in the workspace to reduce `index.lock` races, while keeping `vscode.git` enabled for this extension’s API. Toggle via setting **Pink Hunk Git: Soft Exclusive Git** or command **Toggle Soft Exclusive Git**. The Commit panel refreshes on file changes via its own watchers, and while the panel is visible it periodically status-refreshes the active repository so new untracked files are not missed
- Clone Repository dialog (IDEA-style): paste HTTPS/SSH URL, pick directory, `git clone`
- Pull and update all Git repositories in the workspace at once
- Keybindings install button (writes to user `keybindings.json`)

### Clone Repository

Run **Pink Hunk Git: Clone Repository** from the Command Palette, or use the clone icon in the Commit panel title bar.

1. Enter a Git repository URL (HTTPS or SSH — protocol is detected automatically)
2. Confirm the target Directory (auto-suggested from the repo name; use **…** to browse)
3. Click **Clone**. On success you can **Open** or **Open in New Window**

Recent URLs are remembered. Authentication uses your existing Git / SSH credential helpers.

### Fast Push

**Fast Push** is under the **Commit and Push** dropdown (▾). It runs the steps enabled in Fast Push settings (⚙ next to the menu item):

1. **Auto-generate commit** (default on) — needs Cursor generate-commit or GitHub Copilot / VS Code Language Model
2. **Auto new tag** (default off) — bumps the latest remote `v*` tag trailing number (e.g. `v1.0.3` → `v1.0.4`); if bump fails, opens Push + New Tag
3. **Auto push** (default on) — push with tags when a tag was created; on rejection auto-merge, unresolved conflicts use the manual merge UI

Each setting has **Workspace** and **Global** checkboxes; Workspace overrides Global for the current folder.

Shortcut: `Ctrl+Alt+K` (macOS: `Cmd+Alt+K`). Check the files to include first.

### Update All Repositories

Run **Pink Hunk Git: Update All Git Repositories** (`Ctrl+T` / `Cmd+T`, or the sync button in the Commit panel title bar) to choose which Git repositories to pull:

1. First press opens a dialog listing repositories (all checked by default; previous checkmarks are remembered per workspace)
2. Press `Ctrl+T` / `Cmd+T` again, or click **Pull**, to pull the selected repositories

Progress shows the current repository and overall status. If one repository fails, the extension continues with the rest and summarizes successes and failures. Repositories need an upstream branch configured; local changes, merge conflicts, auth failures, etc. follow normal Git rules and are not discarded automatically.

### Keybindings (after install)

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open / focus Commit panel |
| `Ctrl+Shift+K` | Open Push dialog |
| `Ctrl+Enter` | Commit (Commit panel focused) |
| `Ctrl+Shift+Enter` | Commit and Push (Commit panel focused) |
| `Ctrl+Alt+K` | Fast Push |
| `Ctrl+T` | Pull and update all Git repositories in the workspace |
| `Ctrl+D` | Show Diff (requires selected file) |
| `F4` | Open selected file |
| `F6` | Diff: Previous Change / Previous File |
| `F7` | Diff: Next Change / Next File |
| `Ctrl+Alt+Z` | Rollback selected file |
| `Ctrl+Alt+A` | Add to Git (Unversioned checks, Commit panel) |

Click **⌨** at the top of the panel to install these keybindings (you will be warned about possible conflicts).
`Ctrl+T` / `Cmd+T` may conflict with built-in editor shortcuts; remove or change **Pink Hunk Git: Update All Git Repositories** in Keyboard Shortcuts if you want to keep the original binding. Manual entry points still work.

### Diff navigation (F6 / F7)

When a diff editor is focused:
- `F6` jumps to the previous change within the current file.
- If you are already at the first change in the current file, press `F6` again to jump to the last change of the previous file.
- `F7` jumps to the next change within the current file.
- If you are already at the last change in the current file, press `F7` again to jump to the first change of the next file.
- `changes` and `unversioned` are treated as one continuous file list for this navigation.

## Requirements

- VS Code / Cursor 1.85+
- Built-in **Git** extension enabled (`vscode.git`)
