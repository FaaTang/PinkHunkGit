# Design: VS Code 插件 — 仿 IDEA Git 提交 UI

**日期：** 2026-07-10  
**仓库：** CopyIDEAGitUI  
**状态：** 已确认（brainstorming）

## 目标

在 VS Code 中提供接近 IntelliJ IDEA Commit 工具窗口的提交交互：独立面板内完成查看变更、勾选暂存、预览 Diff、填写提交信息并 Commit / Commit & Push。

## 范围（MVP）

**包含**

- 独立 Webview 提交面板（三栏：左文件列表、右 Diff、底提交区）
- 变更列表分组：Staged / Changes；勾选即 stage / unstage
- 面板内文本 Diff 预览
- Commit、Commit and Push
- Push 确认弹窗（精简）
- 默认快捷键仿 IDEA：`Ctrl+K` / `Ctrl+Shift+K`（可改绑）
- 通过 VS Code 内置 Git 扩展 API（`vscode.git`）操作仓库
- 布局仿 IDEA，配色跟随 VS Code 主题（`--vscode-*`）

**不包含（明确延后）**

- Changelist
- 行级 / hunk 暂存
- Amend、Author、Before Commit 勾选
- 完整 IDEA Push 对话框（force、多远端细项等）
- 多 Git 仓库切换
- Monaco DiffEditor
- 自动化 UI E2E

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ activation   │  │ GitService   │  │ CommitPanel   │  │
│  │ + commands   │──│ (vscode.git) │──│ (WebviewPanel)│  │
│  └──────────────┘  └──────────────┘  └───────┬───────┘  │
└──────────────────────────────────────────────┼──────────┘
                                               │ postMessage
┌──────────────────────────────────────────────┼──────────┐
│  Webview                                     ▼          │
│  ┌────────────┬──────────────────┬───────────────────┐  │
│  │ FileList   │ DiffViewer       │ CommitForm        │  │
│  │ (左栏)     │ (右上)           │ (底部)            │  │
│  └────────────┴──────────────────┴───────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 组件职责

| 单元 | 职责 | 依赖 |
|------|------|------|
| `activation` / commands | 注册命令与快捷键；打开面板 / Push 弹窗 | CommitPanel, GitService |
| `GitService` | 唯一接触 `vscode.git`：status、stage、unstage、commit、push、diff | VS Code Git 扩展 API |
| `CommitPanel` | 创建/销毁 WebviewPanel；消息桥；把仓库快照推给 UI | GitService |
| Webview UI | 纯展示与交互；不直接调 Git | postMessage 协议 |

### 技术选型

- **扩展宿主：** TypeScript VS Code Extension
- **UI：** 单页 Webview，MVP 使用纯 HTML/CSS/JS（无前端框架）；仅当 UI 复杂度明显上升时再引入轻量框架
- **Git：** `vscode.git` API（方案 A）；不自管 `git` 子进程（除非后续 API 不足再局部补充）
- **Diff：** 轻量文本 diff 渲染；不引入 Monaco（MVP）

### 仓库范围

- MVP 仅使用当前工作区中**第一个**可用的 Git 仓库
- 多根工作区：其余仓库忽略，并在面板做轻提示

### 打开方式

- 命令：`CopyIDEAGitUI: Open Commit`
- 面板类型：`WebviewPanel`（可拖到编辑器区域，接近 IDEA 工具窗口）
- 可选：Activity Bar 入口（实现阶段按需加入，非阻塞）

## 界面与交互

### 布局

1. **左栏 — 文件列表**
   - 分组：`Staged`、`Changes`（未暂存）
   - 每项：勾选框、状态图标（M/A/D/R/U）、相对路径
   - 勾选 ↔ stage / unstage
   - 单击选中并刷新右侧 Diff
   - 支持全选 / 全不选

2. **右上 — Diff**
   - 在 Webview 内渲染选中文件的文本 Diff
   - 二进制或超过大小上限的文件：占位提示，不渲染全文

3. **底部 — 提交区**
   - 多行提交信息
   - 主操作：`Commit`、`Commit and Push…`

### 快捷键

| 默认快捷键 | macOS | 行为 |
|------------|-------|------|
| `Ctrl+K` | `Cmd+K` | 打开 / 聚焦 Commit 面板 |
| `Ctrl+Shift+K` | `Cmd+Shift+K` | 打开 Push 弹窗 |

**冲突策略（已选 B）：**

- `package.json` 默认注册上述键位，尽量开箱即用像 IDEA
- README 明确说明与 VS Code `Ctrl+K` 和弦前缀的冲突
- 用户可通过 Keyboard Shortcuts（及文档指引）改绑；插件不运行时扫描全部冲突

### Push 弹窗（MVP 精简）

- 触发：`Ctrl+Shift+K`，或 Commit and Push 流程
- 展示：当前分支、可解析的远端信息、确认 Push / 取消
- 不做 force、多远端高级选项

### 主题

- 结构仿 IDEA；颜色使用 `--vscode-*` CSS 变量，跟随当前主题

## 数据流

### 权威状态

- Extension Host 为权威；Webview 不长期持有独立真相
- 订阅 Git 扩展状态变更（如 `onDidChangeState`、repository status 事件），变更后推送快照

### 快照形状（概念）

```text
{
  staged: ChangeItem[],
  unstaged: ChangeItem[],
  selectedPath?: string,
  branch?: string,
  remotes?: string[]
}
```

### Webview → 扩展消息

| 消息 | 扩展动作 |
|------|----------|
| `ready` | 回推当前快照 |
| `toggleStage` | stage / unstage，再推快照 |
| `selectFile` | 计算 Diff，回 `diff` |
| `commit` | 校验后 `repo.commit`，成功提示并刷新 |
| `commitAndPush` | commit 成功后进入 Push 确认 / 推送流程 |
| `push` | `repo.push()`，结果用通知反馈 |

### Diff 规则

- 未暂存文件：working tree vs index
- 已暂存文件：index vs HEAD
- 文本超限（建议默认约 1MB）或二进制 → 占位，不渲染全文

### 一致性

- 提交 / 推送进行中禁用相关按钮，防止重复提交
- 外部（终端、内置 SCM）修改仓库后，面板自动刷新

## 错误处理与边界

| 场景 | 行为 |
|------|------|
| 内置 Git 扩展未启用 | 面板提示并引导启用 |
| 非 Git 工作区 | 提示当前文件夹不是 Git 仓库 |
| 多根工作区 | 使用第一个 Git 仓库；轻提示其余忽略 |
| 空提交信息 | 底部内联错误，不调用 Git |
| 无已暂存文件 | 提示先勾选变更 |
| commit 失败（钩子、锁等） | `showErrorMessage` 展示原文；面板保持可编辑 |
| 无上游分支 | 提示失败原因；MVP 不自动 `push -u`（除非 API 轻易支持） |
| 认证 / 网络失败 | 错误通知；不静默重试 |
| Push 时无新提交 | 允许打开弹窗；文案说明或由 Git 回报 |
| 文件消失 / 重命名 | 清空 Diff；列表以最新 status 为准 |
| 快捷键冲突 | 文档说明；不自动检测全部冲突 |

## 测试与验收

### 测试

- **单元测试：** `GitService` 对 `vscode.git` 的封装（mock API）
- **协议测试：** Webview ↔ 扩展消息 payload 形状（纯函数校验）
- **手工验收：** Extension Development Host 走主路径；自动化 E2E 不进 MVP

### MVP 验收清单

1. `Ctrl+K` 打开 Commit 面板；`Ctrl+Shift+K` 打开 Push 弹窗（可改绑）
2. 左栏 Staged / Changes；勾选可 stage / unstage
3. 单击文件在右栏看到文本 Diff；二进制 / 过大文件有占位
4. 填写 message 后 Commit 成功并刷新；空 message / 无暂存有明确提示
5. Commit and Push / Push 弹窗能对当前分支 push；失败有错误通知
6. 配色跟随 VS Code 主题；布局为左列表 + 右 Diff + 底提交区
7. 外部改动仓库状态后面板会刷新

## 实现顺序（供后续 plan 参考）

1. 脚手架：VS Code 扩展项目、激活、空 WebviewPanel
2. `GitService` + 状态快照推送
3. 左栏文件列表与 stage/unstage
4. 面板内 Diff
5. Commit 表单与校验
6. Push 弹窗与 Commit and Push
7. 默认快捷键、README 冲突说明、主题样式打磨
8. 单元 / 协议测试与手工验收

## 决策记录

| 决策点 | 选择 |
|--------|------|
| 功能范围 | A — 核心提交面板 |
| UI 载体 | A — 独立 Webview 面板 |
| Git 接入 | A — `vscode.git` API |
| Diff 位置 | A — 全在 Webview 内 |
| 外观 | A — 布局仿 IDEA，主题跟 VS Code |
| 实现路线 | 方案 1 — Extension Host + 单页 Webview |
| 快捷键冲突 | B — 默认 Ctrl+K / Ctrl+Shift+K，文档说明并可改绑 |
