# Copy IDEA Git UI

[中文](README.zh-CN.md)

An IntelliJ IDEA–style **Commit** panel for VS Code / Cursor: stage files from a checklist, diff, commit / push, rollback, and more.

## Install (manual from GitHub Release)

1. Open [Releases](https://github.com/FaaTang/CopyIDEAGitUI/releases) and download the latest `.vsix`
2. In VS Code / Cursor, run from the Command Palette: `Extensions: Install from VSIX...`
3. Select the downloaded `.vsix` and reload the window if prompted

## Release (maintainers)

Pushing a `v*` tag triggers GitHub Actions to package a `.vsix` and create a Release.

```bash
# Ensure code is pushed to main
git push origin main

# Tag and push (example)
git tag v0.1.0
git push origin v0.1.0
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
# Produces copy-idea-git-ui-x.y.z.vsix
```

## Features

- Dedicated Commit panel in the Activity Bar
- Changes / Unversioned Files groups (IDEA-style)
- Check files to include in commit; right-click for Diff / Rollback / Open File / Reveal in Explorer
- Commit / Commit and Push; multi-repo switching
- Pull and update all Git repositories in the workspace at once
- Keybindings install button (writes to user `keybindings.json`)

### Update All Repositories

Run **Copy IDEA Git UI: Update All Git Repositories** to `git pull` each Git repository VS Code / Cursor has detected. You can trigger it via:

- `Ctrl+T` (macOS: `Cmd+T`)
- The sync button in the Commit panel title bar
- Command Palette: **Copy IDEA Git UI: Update All Git Repositories**

Progress shows the current repository and overall status. If one repository fails, the extension continues with the rest and summarizes successes and failures. Repositories need an upstream branch configured; local changes, merge conflicts, auth failures, etc. follow normal Git rules and are not discarded automatically.

### Keybindings (after install)

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open / focus Commit panel |
| `Ctrl+Shift+K` | Open Push dialog |
| `Ctrl+T` | Pull and update all Git repositories in the workspace |
| `Ctrl+D` | Show Diff (requires selected file) |
| `F4` | Open selected file |
| `Ctrl+Alt+Z` | Rollback selected file |

Click **⌨** at the top of the panel to install these keybindings (you will be warned about possible conflicts).
`Ctrl+T` / `Cmd+T` may conflict with built-in editor shortcuts; remove or change **Copy IDEA Git UI: Update All Git Repositories** in Keyboard Shortcuts if you want to keep the original binding. Manual entry points still work.

## Requirements

- VS Code / Cursor 1.85+
- Built-in **Git** extension enabled (`vscode.git`)
