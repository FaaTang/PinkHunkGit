(function () {
  const vscode = acquireVsCodeApi();

  const banner = document.getElementById('banner');
  const repoBar = document.getElementById('repoBar');
  const repoSelect = document.getElementById('repoSelect');
  const fileList = document.getElementById('fileList');
  const messageEl = document.getElementById('message');
  const formError = document.getElementById('formError');
  const commitBtn = document.getElementById('commitBtn');
  const commitPushBtn = document.getElementById('commitPushBtn');
  const stageAllBtn = document.getElementById('stageAll');
  const unstageAllBtn = document.getElementById('unstageAll');
  const refreshBtn = document.getElementById('refreshBtn');
  const locateBtn = document.getElementById('locateBtn');
  const installKeysBtn = document.getElementById('installKeysBtn');
  const pushModal = document.getElementById('pushModal');
  const pushTitle = document.getElementById('pushTitle');
  const pushSummary = document.getElementById('pushSummary');
  const pushConflictList = document.getElementById('pushConflictList');
  const pushCancel = document.getElementById('pushCancel');
  const pushConfirm = document.getElementById('pushConfirm');
  const pushMerge = document.getElementById('pushMerge');
  const pushRebase = document.getElementById('pushRebase');
  const pushAbort = document.getElementById('pushAbort');
  const pushContinue = document.getElementById('pushContinue');
  const pushAskNo = document.getElementById('pushAskNo');
  const pushAskYes = document.getElementById('pushAskYes');
  const rollbackModal = document.getElementById('rollbackModal');
  const rollbackTitle = document.getElementById('rollbackTitle');
  const rollbackSummary = document.getElementById('rollbackSummary');
  const rollbackCancelBtn = document.getElementById('rollbackCancel');
  const rollbackConfirmBtn = document.getElementById('rollbackConfirm');
  const keysModal = document.getElementById('keysModal');
  const keysCancel = document.getElementById('keysCancel');
  const keysConfirm = document.getElementById('keysConfirm');
  const updateAllModal = document.getElementById('updateAllModal');
  const updateAllSummary = document.getElementById('updateAllSummary');
  const updateAllCancel = document.getElementById('updateAllCancel');
  const updateAllConfirmBtn = document.getElementById('updateAllConfirm');
  const contextMenu = document.getElementById('contextMenu');

  let workspace = {
    ok: true,
    repositories: [],
    active: { ok: true, rootPath: '', name: '', staged: [], unstaged: [], unversioned: [] },
    activeRepoRoot: '',
    busy: false,
  };
  const webviewState = vscode.getState() || {};
  const collapsedRepos = new Set(webviewState.collapsedRepos || []);
  const collapsedGroups = new Set(webviewState.collapsedGroups || []);
  let lastCommitMessage = webviewState.lastCommitMessage || '';
  let messageDraft = webviewState.messageDraft || '';
  let messageDraftInitialized = false;
  let selected = null;
  let lastActiveRepoRoot = '';
  let pendingRollback = null;
  /** @type {'confirm' | 'rejected' | 'conflict' | 'askPush' | null} */
  let pushModalState = null;
  /** Repo root for the in-progress Push / Merge / Rebase dialog. */
  let pushRepoRoot = null;

  function activeRepoRoot() {
    return workspace.activeRepoRoot || workspace.active?.rootPath || '';
  }

  function allRepos() {
    const repos = workspace.repositories || [];
    if (repos.length && repos[0] && Array.isArray(repos[0].staged)) {
      return repos.filter((r) => r && r.ok !== false);
    }
    // Legacy fallback: only active snapshot
    return workspace.active?.ok ? [workspace.active] : [];
  }

  function totalStagedCount() {
    return allRepos().reduce((n, r) => n + (r.staged?.length || 0), 0);
  }

  function repoKey(root) {
    return String(root || '').replace(/\\/g, '/').toLowerCase();
  }

  function findRepo(root) {
    if (!root) {
      return undefined;
    }
    const key = repoKey(root);
    return allRepos().find((r) => repoKey(r.rootPath) === key);
  }

  function saveWebviewState(patch) {
    const state = { ...vscode.getState(), ...patch };
    vscode.setState(state);
  }

  function saveCollapsedRepos() {
    saveWebviewState({ collapsedRepos: Array.from(collapsedRepos) });
  }

  function toggleRepoCollapsed(root) {
    const key = repoKey(root);
    if (collapsedRepos.has(key)) {
      collapsedRepos.delete(key);
    } else {
      collapsedRepos.add(key);
    }
    saveCollapsedRepos();
    renderFiles();
  }

  function groupKey(root, group) {
    return repoKey(root) + '::' + group;
  }

  function saveCollapsedGroups() {
    saveWebviewState({ collapsedGroups: Array.from(collapsedGroups) });
  }

  function toggleGroupCollapsed(root, group) {
    const key = groupKey(root, group);
    if (collapsedGroups.has(key)) {
      collapsedGroups.delete(key);
    } else {
      collapsedGroups.add(key);
    }
    saveCollapsedGroups();
    renderFiles();
  }

  /** Expand all repo groups and their Changes groups (used on Ctrl+K auto-check). */
  function expandChangesGroups() {
    let changed = false;
    for (const repo of allRepos()) {
      const rKey = repoKey(repo.rootPath);
      if (collapsedRepos.has(rKey)) {
        collapsedRepos.delete(rKey);
        changed = true;
      }
      const gKey = groupKey(repo.rootPath, 'changes');
      if (collapsedGroups.has(gKey)) {
        collapsedGroups.delete(gKey);
        changed = true;
      }
    }
    if (changed) {
      saveCollapsedRepos();
      saveCollapsedGroups();
      renderFiles();
    }
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function saveMessageDraft() {
    messageDraft = messageEl.value;
    saveWebviewState({ messageDraft, lastCommitMessage });
  }

  function loadMessageDraft() {
    messageEl.value = messageDraft || lastCommitMessage || '';
  }

  function cacheLastCommitMessage(message) {
    lastCommitMessage = message;
    messageDraft = message;
    saveWebviewState({ lastCommitMessage, messageDraft });
  }

  function setBusy(busy) {
    workspace.busy = busy;
    const disabled = !!busy || !workspace.ok;
    commitBtn.disabled = disabled;
    commitPushBtn.disabled = disabled;
    stageAllBtn.disabled = disabled;
    unstageAllBtn.disabled = disabled;
    refreshBtn.disabled = disabled;
    locateBtn.disabled = disabled;
    installKeysBtn.disabled = !!busy;
    pushConfirm.disabled = busy;
    pushMerge.disabled = busy;
    pushRebase.disabled = busy;
    pushAbort.disabled = busy;
    pushContinue.disabled = busy;
    pushAskYes.disabled = busy;
    pushAskNo.disabled = busy;
    pushCancel.disabled = busy;
    rollbackConfirmBtn.disabled = busy;
    keysConfirm.disabled = busy;
  }

  function showBanner(text, kind) {
    if (!text) {
      banner.classList.add('hidden');
      banner.textContent = '';
      return;
    }
    banner.textContent = text;
    banner.classList.remove('hidden', 'info');
    if (kind === 'info') {
      banner.classList.add('info');
    }
  }

  function showFormError(text) {
    if (!text) {
      formError.classList.add('hidden');
      formError.textContent = '';
      return;
    }
    formError.textContent = text;
    formError.classList.remove('hidden');
  }

  function hideContextMenu() {
    contextMenu.classList.add('hidden');
    contextMenu.innerHTML = '';
  }

  function getMergedChanges(active) {
    const map = new Map();
    for (const item of active.unstaged) {
      if (item.status === '?') {
        continue;
      }
      map.set(item.path, { ...item, staged: false });
    }
    for (const item of active.staged) {
      map.set(item.path, { ...item, staged: true });
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  function getUnversioned(active) {
    const fromField = active.unversioned ?? [];
    const fromUnstaged = (active.unstaged ?? []).filter((item) => item.status === '?');
    const map = new Map();
    for (const item of [...fromField, ...fromUnstaged]) {
      map.set(item.path, item);
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  function splitPath(fullPath) {
    const normalized = (fullPath || '').replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx < 0) {
      return { name: normalized, dir: '' };
    }
    return {
      name: normalized.slice(idx + 1),
      dir: normalized.slice(0, idx),
    };
  }

  function isSelectedItem(_active, repoRoot, item, staged) {
    return (
      selected &&
      selected.repoRoot === repoRoot &&
      selected.path === item.path &&
      selected.staged === staged
    );
  }

  function selectionStillExists(selectedRef) {
    if (!selectedRef) {
      return false;
    }
    const repo = findRepo(selectedRef.repoRoot);
    if (!repo) {
      return false;
    }
    const tracked = getMergedChanges(repo);
    const unversioned = getUnversioned(repo);
    if (tracked.some((i) => i.path === selectedRef.path && i.staged === selectedRef.staged)) {
      return true;
    }
    return unversioned.some((i) => i.path === selectedRef.path);
  }

  function showContextMenu(x, y, item, repoRoot) {
    contextMenu.innerHTML = '';
    const staged = item.staged;

    const openFile = document.createElement('button');
    openFile.type = 'button';
    openFile.textContent = 'Open File (F4)';
    openFile.addEventListener('click', () => {
      hideContextMenu();
      post({ type: 'openFile', repoRoot, path: item.path });
    });
    contextMenu.appendChild(openFile);

    const openDiff = document.createElement('button');
    openDiff.type = 'button';
    openDiff.textContent = 'Show Diff (Ctrl+D)';
    openDiff.addEventListener('click', () => {
      hideContextMenu();
      post({ type: 'openDiff', repoRoot, path: item.path, staged });
    });
    contextMenu.appendChild(openDiff);

    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.textContent = 'Reveal in Explorer';
    reveal.addEventListener('click', () => {
      hideContextMenu();
      post({ type: 'revealInExplorer', repoRoot, path: item.path });
    });
    contextMenu.appendChild(reveal);

    const rollback = document.createElement('button');
    rollback.type = 'button';
    rollback.textContent = 'Rollback (Ctrl+Alt+Z)';
    rollback.addEventListener('click', () => {
      hideContextMenu();
      post({ type: 'rollback', repoRoot, path: item.path, staged });
    });
    contextMenu.appendChild(rollback);

    contextMenu.classList.remove('hidden');
    const rect = contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    contextMenu.style.left = `${Math.min(x, maxX)}px`;
    contextMenu.style.top = `${Math.min(y, maxY)}px`;
  }

  function renderRepoSelector() {
    // Multi-repo Changes are shown grouped below; no top-level switcher.
    repoBar.classList.add('hidden');
  }

  function renderFiles() {
    fileList.innerHTML = '';

    if (!workspace.ok) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = workspace.error || 'Repository unavailable';
      fileList.appendChild(empty);
      return;
    }

    const repos = allRepos();
    if (!repos.length) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = workspace.active?.error || 'Repository unavailable';
      fileList.appendChild(empty);
      return;
    }

    const multi = repos.length > 1;
    const focused = activeRepoRoot();
    let rendered = 0;

    for (const repo of repos) {
      const tracked = getMergedChanges(repo);
      const unversioned = getUnversioned(repo);
      // Always list every Git repository in multi-root workspaces, including
      // clean ones (no local changes). Skipping them made it look like the
      // panel was missing repos (e.g. 3 folders open, only 2 shown).

      rendered += 1;
      const group = document.createElement('div');
      group.className = 'repo-group';
      if (multi && focused && repoKey(repo.rootPath) === repoKey(focused)) {
        group.classList.add('focused');
      }

      const collapsed = multi && collapsedRepos.has(repoKey(repo.rootPath));

      if (multi) {
        const title = document.createElement('div');
        title.className = 'repo-group-title collapsible';
        const branch = repo.branch ? ` · ${repo.branch}` : '';
        const count = tracked.length + unversioned.length;
        title.innerHTML =
          `<span class="repo-group-chevron">${collapsed ? '▸' : '▾'}</span>` +
          `<span class="repo-group-name">${repo.name}${branch}</span><span class="repo-group-count">${count}</span>`;
        title.title = collapsed ? '点击展开' : '点击折叠';
        title.addEventListener('click', () => toggleRepoCollapsed(repo.rootPath));
        group.appendChild(title);
      }

      if (!collapsed) {
        group.appendChild(renderChangeList('Changes', tracked, repo.rootPath, false, 'changes'));
        group.appendChild(
          renderChangeList('Unversioned Files', unversioned, repo.rootPath, true, 'unversioned')
        );
      } else {
        group.classList.add('collapsed');
      }
      fileList.appendChild(group);
    }

    if (!rendered) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = 'No local changes';
      fileList.appendChild(empty);
    }
  }

  function renderChangeList(title, items, repoRoot, unversionedGroup = false, groupId = '') {
    const wrap = document.createElement('div');
    const collapsed = groupId ? collapsedGroups.has(groupKey(repoRoot, groupId)) : false;
    const head = document.createElement('div');
    head.className = 'group-title collapsible';
    head.innerHTML =
      `<span class="group-title-chevron">${collapsed ? '▸' : '▾'}</span>` +
      `<span class="group-title-name">${title}</span><span class="group-title-count">${items.length}</span>`;
    if (groupId) {
      head.title = collapsed ? '点击展开' : '点击折叠';
      head.addEventListener('click', () => toggleGroupCollapsed(repoRoot, groupId));
    }
    wrap.appendChild(head);

    if (collapsed) {
      return wrap;
    }

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-group';
      empty.textContent = 'None';
      wrap.appendChild(empty);
      return wrap;
    }

    for (const item of items) {
      const staged = unversionedGroup ? false : item.staged;
      const row = document.createElement('div');
      row.className = 'file-row';
      if (isSelectedItem(null, repoRoot, item, staged)) {
        row.classList.add('selected');
      }

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = staged;
      checkbox.title = unversionedGroup
        ? 'Add to Git (include in commit)'
        : staged
          ? 'Included in commit'
          : 'Not included in commit';
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        post({
          type: 'toggleStage',
          repoRoot,
          path: item.path,
          staged: !staged,
          currentlyStaged: staged,
        });
      });

      const status = document.createElement('span');
      status.className = 'status ' + (item.status === '?' ? 'A' : item.status);
      status.textContent = item.status;

      const pathEl = document.createElement('span');
      pathEl.className = 'path';
      const { name, dir } = splitPath(item.path);

      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = name;

      pathEl.appendChild(nameEl);
      if (dir) {
        const dirEl = document.createElement('span');
        dirEl.className = 'file-dir';
        dirEl.textContent = dir;
        pathEl.appendChild(dirEl);
      }
      if (item.unsaved) {
        const unsavedEl = document.createElement('span');
        unsavedEl.className = 'file-unsaved';
        unsavedEl.textContent = '(unsaved)';
        pathEl.appendChild(unsavedEl);
      }

      pathEl.title = item.unsaved
        ? `${item.path} — unsaved`
        : unversionedGroup
          ? `${item.path} — check to add; right-click for more`
          : `${item.path} — checked = commit; right-click for more`;

      row.appendChild(checkbox);
      row.appendChild(status);
      row.appendChild(pathEl);
      row.addEventListener('click', () => {
        selected = { repoRoot, path: item.path, staged };
        hideContextMenu();
        renderFiles();
        post({ type: 'updateSelection', repoRoot, path: item.path, staged });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selected = { repoRoot, path: item.path, staged };
        renderFiles();
        post({ type: 'updateSelection', repoRoot, path: item.path, staged });
        showContextMenu(e.clientX, e.clientY, item, repoRoot);
      });
      wrap.appendChild(row);
    }
    return wrap;
  }

  function validateBeforeCommit() {
    const message = messageEl.value.trim();
    if (!message) {
      showFormError('Commit message cannot be empty.');
      return null;
    }
    if (!totalStagedCount()) {
      showFormError('请勾选要提交的文件。');
      return null;
    }
    showFormError('');
    return message;
  }

  function setPushActionVisibility(visibleIds) {
    const buttons = {
      pushCancel,
      pushConfirm,
      pushMerge,
      pushRebase,
      pushAbort,
      pushContinue,
      pushAskNo,
      pushAskYes,
    };
    Object.entries(buttons).forEach(([id, el]) => {
      if (!el) {
        return;
      }
      el.classList.toggle('hidden', !visibleIds.includes(id));
    });
  }

  function renderConflictList(conflicts) {
    pushConflictList.innerHTML = '';
    if (!conflicts || !conflicts.length) {
      pushConflictList.classList.add('hidden');
      return;
    }
    pushConflictList.classList.remove('hidden');
    conflicts.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'conflict-item';
      li.title = '在 VS Code 合并编辑器中打开';
      const status = document.createElement('span');
      status.className = 'conflict-status';
      status.textContent = item.status || 'C';
      const name = document.createElement('span');
      name.className = 'conflict-path';
      name.textContent = item.path;
      li.appendChild(status);
      li.appendChild(name);
      li.addEventListener('click', () => post({ type: 'openConflict', path: item.path }));
      pushConflictList.appendChild(li);
    });
  }

  function closePushModal() {
    pushModalState = null;
    pushRepoRoot = null;
    pushModal.classList.add('hidden');
    pushConflictList.classList.add('hidden');
    pushConflictList.innerHTML = '';
  }

  function openPushModal() {
    const repos = allRepos();
    const active = findRepo(activeRepoRoot()) || workspace.active || repos[0] || {};
    pushRepoRoot = active.rootPath || null;
    const lines = [];
    if (repos.length > 1) {
      lines.push('将 Push 当前聚焦仓库（高亮分组）。其它仓库概况：');
      for (const repo of repos) {
        const ahead = typeof repo.ahead === 'number' ? repo.ahead : '?';
        const behind = typeof repo.behind === 'number' ? repo.behind : '?';
        const mark =
          String(repo.rootPath).replace(/\\/g, '/').toLowerCase() ===
          String(active.rootPath || '').replace(/\\/g, '/').toLowerCase()
            ? '→ '
            : '  ';
        lines.push(
          `${mark}${repo.name}${repo.branch ? ` (${repo.branch})` : ''}  ahead ${ahead} / behind ${behind}`
        );
      }
      lines.push('');
    }
    const branch = active.branch || '(detached)';
    const upstream = active.upstream || '(no upstream)';
    const remotes = (active.remotes || []).join(', ') || '(none)';
    const ahead = typeof active.ahead === 'number' ? active.ahead : '?';
    const behind = typeof active.behind === 'number' ? active.behind : '?';
    lines.push(
      `Repository: ${active.name || '(unknown)'}`,
      `Branch: ${branch}`,
      `Upstream: ${upstream}`,
      `Remotes: ${remotes}`,
      `Ahead: ${ahead}`,
      `Behind: ${behind}`
    );
    if (typeof active.ahead === 'number' && active.ahead === 0) {
      lines.push('', 'No local commits to push (ahead = 0). You can still try Push.');
    }
    if (typeof active.behind === 'number' && active.behind > 0) {
      lines.push(
        '',
        `Remote is ahead by ${active.behind} commit(s). Push may be rejected — Merge or Rebase first.`
      );
    }
    pushModalState = 'confirm';
    pushTitle.textContent = 'Push';
    pushSummary.textContent = lines.join('\n');
    renderConflictList([]);
    setPushActionVisibility(['pushCancel', 'pushConfirm']);
    pushModal.classList.remove('hidden');
  }

  function openPushRejectedModal(payload) {
    pushModalState = 'rejected';
    pushRepoRoot = payload.repoRoot || pushRepoRoot || activeRepoRoot() || null;
    pushTitle.textContent = 'Push Rejected';
    const behind =
      typeof payload.behind === 'number' ? `Behind remote: ${payload.behind}` : 'Remote has commits you do not have locally.';
    pushSummary.textContent =
      `${payload.message}\n\n` +
      `Repository: ${payload.repoName}\n` +
      `Branch: ${payload.branch || '(detached)'}\n` +
      `Upstream: ${payload.upstream || '(none)'}\n` +
      `${behind}\n\n` +
      `选择 Merge 或 Rebase 同步远程后再 Push。`;
    renderConflictList([]);
    setPushActionVisibility(['pushCancel', 'pushMerge', 'pushRebase']);
    pushModal.classList.remove('hidden');
  }

  function openSyncConflictModal(payload) {
    pushModalState = 'conflict';
    pushRepoRoot = payload.repoRoot || pushRepoRoot || activeRepoRoot() || null;
    const modeLabel = payload.mode === 'rebase' ? 'Rebase' : 'Merge';
    pushTitle.textContent = `${modeLabel} Conflicts`;
    pushSummary.textContent =
      `${payload.message}\n\n` +
      `点击下方冲突文件，在 VS Code 合并编辑器中解决。全部解决后点 Continue；或 Abort 中止。`;
    renderConflictList(payload.conflicts || []);
    setPushActionVisibility(['pushAbort', 'pushContinue']);
    pushModal.classList.remove('hidden');
  }

  function openAskPushModal(payload) {
    pushModalState = 'askPush';
    pushRepoRoot = payload.repoRoot || pushRepoRoot || activeRepoRoot() || null;
    pushTitle.textContent = 'Push？';
    const behindLine =
      typeof payload.behind === 'number' ? `\nBehind: ${payload.behind}` : '';
    pushSummary.textContent =
      `${payload.summary}\n\n` +
      `Repository: ${payload.repoName}\n` +
      `Branch: ${payload.branch || '(detached)'}\n` +
      `Upstream: ${payload.upstream || '(none)'}\n` +
      `Ahead: ${typeof payload.ahead === 'number' ? payload.ahead : '?'}` +
      behindLine;
    renderConflictList([]);
    setPushActionVisibility(['pushAskNo', 'pushAskYes']);
    pushModal.classList.remove('hidden');
  }

  function syncConflictListFromSnapshot() {
    if (pushModalState !== 'conflict') {
      return;
    }
    const conflicts = workspace.active.conflictFiles || [];
    renderConflictList(conflicts);
    if (!conflicts.length && workspace.active.syncMode) {
      pushSummary.textContent =
        '冲突文件已全部解决。点击 Continue 完成 Merge / Rebase；或 Abort 中止。';
    }
  }

  function closeRollbackModal() {
    rollbackModal.classList.add('hidden');
    pendingRollback = null;
  }

  function openRollbackModal(payload) {
    pendingRollback = payload;
    if (payload.isUntracked) {
      rollbackTitle.textContent = '删除未跟踪文件';
      rollbackSummary.textContent = `将删除 "${payload.path}"。此操作不可撤销。`;
    } else {
      rollbackTitle.textContent = '回滚文件';
      rollbackSummary.textContent = `将 "${payload.path}" 恢复到 Git 中的版本（撤销所有本地修改）。此操作不可撤销。`;
    }
    rollbackModal.classList.remove('hidden');
    rollbackConfirmBtn.focus();
  }

  repoSelect.addEventListener('change', () => {
    // Kept for compatibility; selector is hidden in grouped multi-repo mode.
    const repoRoot = repoSelect.value;
    if (repoRoot) {
      post({ type: 'switchRepo', repoRoot });
    }
  });

  commitBtn.addEventListener('click', () => {
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    cacheLastCommitMessage(message);
    post({ type: 'commit', message });
  });

  commitPushBtn.addEventListener('click', () => {
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    cacheLastCommitMessage(message);
    post({ type: 'commitAndPush', message });
  });

  messageEl.addEventListener('input', () => {
    saveMessageDraft();
  });

  stageAllBtn.addEventListener('click', () => post({ type: 'stageAll', staged: true }));
  unstageAllBtn.addEventListener('click', () => post({ type: 'stageAll', staged: false }));
  refreshBtn.addEventListener('click', () => post({ type: 'refresh' }));
  locateBtn.addEventListener('click', () => {
    if (!selected) {
      return;
    }
    post({
      type: 'revealInExplorer',
      repoRoot: selected.repoRoot,
      path: selected.path,
    });
  });
  installKeysBtn.addEventListener('click', () => {
    keysModal.classList.remove('hidden');
    keysConfirm.focus();
  });
  keysCancel.addEventListener('click', () => keysModal.classList.add('hidden'));
  keysConfirm.addEventListener('click', () => {
    keysModal.classList.add('hidden');
    post({ type: 'installKeybindings' });
  });
  function closeUpdateAllModal(confirmed) {
    updateAllModal.classList.add('hidden');
    post({ type: confirmed ? 'updateAllConfirm' : 'updateAllCancel' });
  }
  function openUpdateAllModal(payload) {
    const count = payload && payload.repoCount != null ? payload.repoCount : 0;
    updateAllSummary.textContent = `将对工作区内 ${count} 个 Git 仓库执行 pull 更新。是否继续？`;
    updateAllModal.classList.remove('hidden');
    updateAllConfirmBtn.focus();
  }
  updateAllCancel.addEventListener('click', () => closeUpdateAllModal(false));
  updateAllConfirmBtn.addEventListener('click', () => closeUpdateAllModal(true));
  updateAllModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeUpdateAllModal(false);
    }
  });
  pushCancel.addEventListener('click', () => {
    closePushModal();
    post({ type: 'pushDialogCancel' });
  });
  pushConfirm.addEventListener('click', () => {
    post({ type: 'push', repoRoot: pushRepoRoot || undefined });
  });
  pushMerge.addEventListener('click', () =>
    post({ type: 'pushSync', mode: 'merge', repoRoot: pushRepoRoot || undefined })
  );
  pushRebase.addEventListener('click', () =>
    post({ type: 'pushSync', mode: 'rebase', repoRoot: pushRepoRoot || undefined })
  );
  pushAbort.addEventListener('click', () =>
    post({ type: 'syncAbort', repoRoot: pushRepoRoot || undefined })
  );
  pushContinue.addEventListener('click', () =>
    post({ type: 'syncContinue', repoRoot: pushRepoRoot || undefined })
  );
  pushAskNo.addEventListener('click', () => {
    closePushModal();
    post({ type: 'askPushCancel' });
  });
  pushAskYes.addEventListener('click', () =>
    post({ type: 'askPushConfirm', repoRoot: pushRepoRoot || undefined })
  );
  rollbackCancelBtn.addEventListener('click', () => {
    closeRollbackModal();
    post({ type: 'rollbackCancel' });
  });
  rollbackConfirmBtn.addEventListener('click', () => {
    if (!pendingRollback) {
      return;
    }
    const { repoRoot, path, staged } = pendingRollback;
    closeRollbackModal();
    post({ type: 'rollbackConfirm', repoRoot, path, staged });
  });

  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });
  window.addEventListener('blur', hideContextMenu);

  document.addEventListener('keydown', (e) => {
    if (!selected) {
      return;
    }
    if (e.key === 'F4' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      post({
        type: 'openFile',
        repoRoot: selected.repoRoot,
        path: selected.path,
      });
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'd' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      post({
        type: 'openDiff',
        repoRoot: selected.repoRoot,
        path: selected.path,
        staged: selected.staged,
      });
      return;
    }
    if (key === 'z' && e.altKey && !e.shiftKey) {
      e.preventDefault();
      post({
        type: 'rollback',
        repoRoot: selected.repoRoot,
        path: selected.path,
        staged: selected.staged,
      });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'snapshot': {
        workspace = msg.payload;
        if (!messageDraftInitialized) {
          loadMessageDraft();
          messageDraftInitialized = true;
        }

        const active = workspace.active || {};
        if (workspace.error) {
          showBanner(workspace.error, 'error');
        } else if (active.hint) {
          showBanner(active.hint, 'info');
        } else {
          showBanner('');
        }

        setBusy(!!workspace.busy);
        renderRepoSelector();

        if (selected && !selectionStillExists(selected)) {
          selected = null;
          post({ type: 'updateSelection', repoRoot: activeRepoRoot(), path: null, staged: false });
        }
        renderFiles();
        syncConflictListFromSnapshot();
        break;
      }
      case 'error':
        showFormError(msg.message);
        if (pushModalState && !pushModal.classList.contains('hidden')) {
          pushSummary.textContent = msg.message;
        }
        break;
      case 'busy':
        setBusy(msg.busy);
        break;
      case 'showPushDialog':
        workspace = msg.payload;
        renderRepoSelector();
        renderFiles();
        openPushModal();
        break;
      case 'showPushRejected':
        openPushRejectedModal(msg.payload);
        break;
      case 'showSyncConflict':
        openSyncConflictModal(msg.payload);
        break;
      case 'showAskPush':
        openAskPushModal(msg.payload);
        break;
      case 'closePushDialog':
        closePushModal();
        break;
      case 'showRollbackDialog':
        openRollbackModal(msg.payload);
        break;
      case 'showUpdateAllDialog':
        openUpdateAllModal(msg.payload);
        break;
      case 'clearMessage': {
        messageEl.value = lastCommitMessage || '';
        messageDraft = messageEl.value;
        saveWebviewState({ messageDraft, lastCommitMessage });
        showFormError('');
        break;
      }
      case 'focusMessage':
        messageEl.focus();
        const end = messageEl.value.length;
        messageEl.setSelectionRange(end, end);
        break;
      case 'expandChanges':
        expandChangesGroups();
        break;
    }
  });

  post({ type: 'ready' });
})();
