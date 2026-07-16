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
  const checkedUnversioned = new Set(webviewState.checkedUnversioned || []);
  let lastCommitMessage = webviewState.lastCommitMessage || '';
  let messageDraft = webviewState.messageDraft || '';
  let messageDraftInitialized = false;
  let selected = null;
  let lastActiveRepoRoot = '';
  let pendingRollback = null;

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

  function totalIncludableCount() {
    return totalStagedCount() + collectCheckedUnversionedPaths().length;
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

  function unversionedCheckKey(repoRoot, path) {
    return `${repoKey(repoRoot)}|${path}`;
  }

  function isUnversionedChecked(repoRoot, path) {
    return checkedUnversioned.has(unversionedCheckKey(repoRoot, path));
  }

  function toggleUnversionedChecked(repoRoot, path, checked) {
    const key = unversionedCheckKey(repoRoot, path);
    if (checked) {
      checkedUnversioned.add(key);
    } else {
      checkedUnversioned.delete(key);
    }
    saveWebviewState({ checkedUnversioned: Array.from(checkedUnversioned) });
  }

  function pruneCheckedUnversioned() {
    const valid = new Set();
    for (const repo of allRepos()) {
      for (const item of getUnversioned(repo)) {
        valid.add(unversionedCheckKey(repo.rootPath, item.path));
      }
    }
    let changed = false;
    for (const key of checkedUnversioned) {
      if (!valid.has(key)) {
        checkedUnversioned.delete(key);
        changed = true;
      }
    }
    if (changed) {
      saveWebviewState({ checkedUnversioned: Array.from(checkedUnversioned) });
    }
  }

  function isSelectedUnversioned(sel) {
    const repo = findRepo(sel.repoRoot);
    if (!repo) {
      return false;
    }
    return getUnversioned(repo).some((i) => i.path === sel.path);
  }

  function collectCheckedUnversionedPaths() {
    const paths = [];
    for (const repo of allRepos()) {
      for (const item of getUnversioned(repo)) {
        if (isUnversionedChecked(repo.rootPath, item.path)) {
          paths.push({ repoRoot: repo.rootPath, path: item.path });
        }
      }
    }
    return paths;
  }

  function collectAddToGitPaths() {
    const paths = collectCheckedUnversionedPaths();
    if (selected && isSelectedUnversioned(selected)) {
      const entry = { repoRoot: selected.repoRoot, path: selected.path };
      if (!paths.some((p) => p.repoRoot === entry.repoRoot && p.path === entry.path)) {
        paths.push(entry);
      }
    }
    return paths;
  }

  function clearUnversionedChecks(paths) {
    for (const { repoRoot, path } of paths) {
      checkedUnversioned.delete(unversionedCheckKey(repoRoot, path));
    }
    saveWebviewState({ checkedUnversioned: Array.from(checkedUnversioned) });
  }

  function performAddToGit() {
    const paths = collectAddToGitPaths();
    if (!paths.length) {
      showFormError('Select unversioned files to add to Git.');
      return;
    }
    showFormError('');
    clearUnversionedChecks(paths);
    post({ type: 'addToGit', paths });
  }

  function formatGroupCount(selected, total) {
    return `${selected}/${total}`;
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

  function showContextMenu(x, y, item, repoRoot, unversionedGroup = false) {
    contextMenu.innerHTML = '';
    const staged = item.staged;

    if (unversionedGroup) {
      const addToGit = document.createElement('button');
      addToGit.type = 'button';
      addToGit.textContent = 'Add to Git (Ctrl+Alt+A)';
      addToGit.addEventListener('click', () => {
        hideContextMenu();
        post({
          type: 'toggleStage',
          repoRoot,
          path: item.path,
          staged: true,
          currentlyStaged: false,
        });
      });
      contextMenu.appendChild(addToGit);
    }

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
        const selectedCount =
          tracked.filter((i) => i.staged).length +
          unversioned.filter((i) => isUnversionedChecked(repo.rootPath, i.path)).length;
        const total = tracked.length + unversioned.length;
        title.innerHTML =
          `<span class="repo-group-chevron">${collapsed ? '▸' : '▾'}</span>` +
          `<span class="repo-group-name">${repo.name}${branch}</span><span class="repo-group-count">${formatGroupCount(selectedCount, total)}</span>`;
        title.title = collapsed ? 'Click to expand' : 'Click to collapse';
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
    const selectedCount = unversionedGroup
      ? items.filter((i) => isUnversionedChecked(repoRoot, i.path)).length
      : items.filter((i) => i.staged).length;

    const head = document.createElement('div');
    head.className = 'group-title collapsible';

    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.className = 'group-select-all';
    selectAll.title = unversionedGroup ? 'Select all' : 'Stage all';
    selectAll.disabled = !items.length;
    selectAll.checked = items.length > 0 && selectedCount === items.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < items.length;
    selectAll.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!items.length) {
        return;
      }
      const checked = selectAll.checked;
      if (unversionedGroup) {
        for (const item of items) {
          toggleUnversionedChecked(repoRoot, item.path, checked);
        }
        renderFiles();
        return;
      }
      const toToggle = items.filter((item) => item.staged !== checked).map((item) => item.path);
      if (toToggle.length) {
        post({ type: 'setGroupStaged', repoRoot, paths: toToggle, staged: checked });
      }
    });

    const chevron = document.createElement('span');
    chevron.className = 'group-title-chevron';
    chevron.textContent = collapsed ? '▸' : '▾';

    const name = document.createElement('span');
    name.className = 'group-title-name';
    name.textContent = title;

    const count = document.createElement('span');
    count.className = 'group-title-count';
    count.textContent = formatGroupCount(selectedCount, items.length);

    head.appendChild(selectAll);
    head.appendChild(chevron);
    head.appendChild(name);
    head.appendChild(count);

    if (groupId) {
      head.title = collapsed ? 'Click to expand' : 'Click to collapse';
      head.addEventListener('click', (e) => {
        if (e.target === selectAll) {
          return;
        }
        toggleGroupCollapsed(repoRoot, groupId);
      });
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
      if (unversionedGroup) {
        const checked = isUnversionedChecked(repoRoot, item.path);
        checkbox.checked = checked;
        checkbox.title = checked ? 'Selected to add to Git' : 'Not selected';
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleUnversionedChecked(repoRoot, item.path, checkbox.checked);
          renderFiles();
        });
      } else {
        checkbox.checked = staged;
        checkbox.title = staged ? 'Included in commit' : 'Not included in commit';
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
      }
      row.appendChild(checkbox);

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

      const dirEl = document.createElement('span');
      dirEl.className = 'file-dir';
      if (unversionedGroup) {
        dirEl.textContent = item.path;
        pathEl.appendChild(dirEl);
      } else if (dir) {
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
          ? `${item.path} — checked = add to Git (Ctrl+Alt+A); right-click for more`
          : `${item.path} — checked = commit; right-click for more`;

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
        showContextMenu(e.clientX, e.clientY, item, repoRoot, unversionedGroup);
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
    if (!totalIncludableCount()) {
      showFormError('Select files to include in the commit.');
      return null;
    }
    showFormError('');
    return message;
  }

  function closeRollbackModal() {
    rollbackModal.classList.add('hidden');
    pendingRollback = null;
  }

  function openRollbackModal(payload) {
    pendingRollback = payload;
    if (payload.isUntracked) {
      rollbackTitle.textContent = 'Delete Untracked File';
      rollbackSummary.textContent = `Will delete "${payload.path}". This cannot be undone.`;
    } else {
      rollbackTitle.textContent = 'Rollback File';
      rollbackSummary.textContent = `Will restore "${payload.path}" to the version in Git (discarding all local changes). This cannot be undone.`;
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
    const unversionedPaths = collectCheckedUnversionedPaths();
    clearUnversionedChecks(unversionedPaths);
    cacheLastCommitMessage(message);
    post({ type: 'commit', message, unversionedPaths });
  });

  commitPushBtn.addEventListener('click', () => {
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    const unversionedPaths = collectCheckedUnversionedPaths();
    clearUnversionedChecks(unversionedPaths);
    cacheLastCommitMessage(message);
    post({ type: 'commitAndPush', message, unversionedPaths });
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
    updateAllSummary.textContent = `Will pull and update ${count} Git repositories in the workspace. Continue?`;
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
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'a' && !e.shiftKey) {
      e.preventDefault();
      performAddToGit();
      return;
    }
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
        pruneCheckedUnversioned();

        if (selected && !selectionStillExists(selected)) {
          selected = null;
          post({ type: 'updateSelection', repoRoot: activeRepoRoot(), path: null, staged: false });
        }
        renderFiles();
        break;
      }
      case 'error':
        showFormError(msg.message);
        break;
      case 'busy':
        setBusy(msg.busy);
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
      case 'triggerAddToGit':
        performAddToGit();
        break;
    }
  });

  post({ type: 'ready' });
})();
