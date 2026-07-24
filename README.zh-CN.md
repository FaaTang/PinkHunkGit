# Pink Hunk Git

[English](README.md)

仿 IntelliJ IDEA 的 VS Code / Cursor **Commit** 面板：文件列表勾选暂存、Diff、Commit / Push、回滚等。

## 安装（从 GitHub Release 手动安装）

1. 打开 [Releases](https://github.com/FaaTang/PinkHunkGit/releases) 下载最新的 `.vsix`
2. VS Code / Cursor 命令面板运行：`Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 安装，必要时重载窗口

## 发布（维护者）

推送符合 `v*` 的 tag 会触发 GitHub Actions：打包 `.vsix` 并创建 Release。

```bash
# 确保代码已推到 main
git push origin main

# 打 tag 并推送（示例）
git tag v0.1.0
git push origin v0.1.0
```

可选：仓库 Settings → Variables → Actions 设置 `RELEASE_BRANCH`（默认 `main`）。仅当 tag 指向的提交在该分支历史上时才会发布。

## 本地开发

```bash
npm install
npm run compile
# F5 启动 Extension Development Host
```

本地打包：

```bash
npm run package
# 生成 pink-hunk-git-x.y.z.vsix
```

## 功能

- 左侧独立 Commit 面板（Activity Bar）
- Changes / Unversioned Files 分组（仿 IDEA）
- 勾选纳入提交；右键 Diff / 回滚 / 打开文件 / 定位资源管理器
- Commit / Commit and Push；多仓库切换
- Fast Push（Commit and Push ▾ 下拉）：可选 AI 生成说明 → 提交 → 可选自动 `v*` tag 递增 → 可选推送并自动合并
- 一次拉取并更新当前工作区内的所有 Git 仓库
- 快捷键安装按钮（写入用户 `keybindings.json`）

### Fast Push

**Fast Push** 位于 **Commit and Push** 下拉菜单（▾）。按 ⚙ 设置中启用的步骤执行：

1. **Auto-generate commit**（默认开）— 需要 Cursor 生成提交命令，或 GitHub Copilot / VS Code Language Model
2. **Auto new tag**（默认关）— 将远程最新 `v*` tag 末尾数字 +1（如 `v1.0.3` → `v1.0.4`）；无法递增时打开 Push + New Tag
3. **Auto push**（默认开）— 有新建 tag 时带 tags 推送；被拒则自动 merge，合并不了走手动冲突界面

每项均有 **Workspace** / **Global** 勾选框；当前文件夹以 Workspace 为准。

快捷键：`Ctrl+Alt+K`（macOS：`Cmd+Alt+K`）。请先勾选要纳入提交的文件。

### 更新所有仓库

运行 **Pink Hunk Git: Update All Git Repositories**（`Ctrl+T` / `Cmd+T`，或 Commit 面板标题栏同步按钮）可选择要拉取的 Git 仓库：

1. 第一次按下弹出仓库列表（默认全选；勾选状态按工作区记住）
2. 再按一次 `Ctrl+T` / `Cmd+T`，或点击 **Pull**，即可拉取当前勾选的仓库

更新过程中会显示当前仓库和总体进度。某个仓库更新失败时，插件会继续更新其余仓库，
最后汇总成功数量以及失败原因。仓库需要已配置上游分支；本地改动、合并冲突、认证失败等
情况仍按 Git 的规则处理，不会自动丢弃或覆盖本地修改。

### 快捷键（安装后）

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+K` | 打开 / 聚焦 Commit 面板 |
| `Ctrl+Shift+K` | Push 弹窗 |
| `Ctrl+Enter` | Commit（Commit 面板聚焦时） |
| `Ctrl+Shift+Enter` | Commit and Push（Commit 面板聚焦时） |
| `Ctrl+Alt+K` | Fast Push |
| `Ctrl+T` | 拉取并更新工作区内的所有 Git 仓库 |
| `Ctrl+D` | Show Diff（需选中文件） |
| `F4` | 打开选中文件 |
| `Ctrl+Alt+Z` | 回滚选中文件 |
| `Ctrl+Alt+A` | Add to Git（Unversioned 勾选，Commit 面板） |

面板顶部 **⌨** 可一键安装上述快捷键（会提示可能覆盖现有绑定）。
`Ctrl+T` / `Cmd+T` 与编辑器原有快捷键可能冲突；如需保留原绑定，可在 Keyboard
Shortcuts 中删除或修改 **Pink Hunk Git: Update All Git Repositories** 的快捷键，手动入口仍可使用。

## 要求

- VS Code / Cursor 1.85+
- 内置 **Git** 扩展已启用（`vscode.git`）
