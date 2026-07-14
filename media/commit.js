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
  const contextMenu = document.getElementById('contextMenu');

  let workspace = {
    ok: true,
    repositories: [],
    active: { ok: true, rootPath: '', name: '', staged: [], unstaged: [], unversioned: [] },
    activeRepoRoot: '',
    busy: false,
  };
  const commitMessages = {};
  let selected = null;
  let lastActiveRepoRoot = '';
  let pendingRollback = null;
  /** @type {'confirm' | 'rejected' | 'conflict' | 'askPush' | null} */
  let pushModalState = null;

  function activeRepoRoot() {
    return workspace.activeRepoRoot || workspace.active.rootPath;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function saveMessageDraft() {
    const root = lastActiveRepoRoot || activeRepoRoot();
    if (root) {
      commitMessages[root] = messageEl.value;
    }
  }

  function loadMessageDraft() {
    const root = activeRepoRoot();
    messageEl.value = commitMessages[root] || '';
    lastActiveRepoRoot = root;
  }

  function setBusy(busy) {
    workspace.busy = busy;
    const active = workspace.active;
    const disabled = !!busy || !workspace.ok || !active.ok;
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

  function selectionStillExists(active, selectedRef) {
    if (!selectedRef) {
      return false;
    }
    const tracked = getMergedChanges(active);
    const unversioned = getUnversioned(active);
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
    const repos = workspace.repositories || [];
    if (repos.length <= 1) {
      repoBar.classList.add('hidden');
      return;
    }
    repoBar.classList.remove('hidden');
    const current = activeRepoRoot();
    repoSelect.innerHTML = '';
    for (const repo of repos) {
      const opt = document.createElement('option');
      opt.value = repo.rootPath;
      const branch = repo.branch ? ` · ${repo.branch}` : '';
      opt.textContent = `${repo.name}${branch}`;
      opt.selected = repo.rootPath === current;
      repoSelect.appendChild(opt);
    }
  }

  function renderFiles() {
    fileList.innerHTML = '';
    const active = workspace.active;

    if (!workspace.ok) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = workspace.error || 'Repository unavailable';
      fileList.appendChild(empty);
      return;
    }

    if (!active.ok) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = active.error || 'Repository unavailable';
      fileList.appendChild(empty);
      return;
    }

    const repoRoot = active.rootPath;
    const tracked = getMergedChanges(active);
    const unversioned = getUnversioned(active);
    fileList.appendChild(renderChangeList('Changes', tracked, repoRoot));
    fileList.appendChild(renderChangeList('Unversioned Files', unversioned, repoRoot, true));
  }

  function renderChangeList(title, items, repoRoot, unversionedGroup = false) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'group-title';
    head.innerHTML = `<span>${title}</span><span>${items.length}</span>`;
    wrap.appendChild(head);

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
    const active = workspace.active;
    if (!message) {
      showFormError('Commit message cannot be empty.');
      return null;
    }
    if (!active.staged.length) {
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
    pushModal.classList.add('hidden');
    pushConflictList.classList.add('hidden');
    pushConflictList.innerHTML = '';
  }

  function openPushModal() {
    const active = workspace.active;
    const branch = active.branch || '(detached)';
    const upstream = active.upstream || '(no upstream)';
    const remotes = (active.remotes || []).join(', ') || '(none)';
    const ahead = typeof active.ahead === 'number' ? active.ahead : '?';
    const behind = typeof active.behind === 'number' ? active.behind : '?';
    let note = `Repository: ${active.name}\nBranch: ${branch}\nUpstream: ${upstream}\nRemotes: ${remotes}\nAhead: ${ahead}\nBehind: ${behind}`;
    if (typeof active.ahead === 'number' && active.ahead === 0) {
      note += '\n\nNo local commits to push (ahead = 0). You can still try Push.';
    }
    if (typeof active.behind === 'number' && active.behind > 0) {
      note += `\n\nRemote is ahead by ${active.behind} commit(s). Push may be rejected — Merge or Rebase first.`;
    }
    pushModalState = 'confirm';
    pushTitle.textContent = 'Push';
    pushSummary.textContent = note;
    renderConflictList([]);
    setPushActionVisibility(['pushCancel', 'pushConfirm']);
    pushModal.classList.remove('hidden');
  }

  function openPushRejectedModal(payload) {
    pushModalState = 'rejected';
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
    pushTitle.textContent = 'Push？';
    pushSummary.textContent =
      `${payload.summary}\n\n` +
      `Repository: ${payload.repoName}\n` +
      `Branch: ${payload.branch || '(detached)'}\n` +
      `Upstream: ${payload.upstream || '(none)'}\n` +
      `Ahead: ${typeof payload.ahead === 'number' ? payload.ahead : '?'}`;
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
    saveMessageDraft();
    const repoRoot = repoSelect.value;
    post({ type: 'switchRepo', repoRoot });
  });

  commitBtn.addEventListener('click', () => {
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    post({ type: 'commit', message });
  });

  commitPushBtn.addEventListener('click', () => {
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    post({ type: 'commitAndPush', message });
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
  pushCancel.addEventListener('click', () => {
    closePushModal();
    post({ type: 'pushDialogCancel' });
  });
  pushConfirm.addEventListener('click', () => {
    post({ type: 'push' });
  });
  pushMerge.addEventListener('click', () => post({ type: 'pushSync', mode: 'merge' }));
  pushRebase.addEventListener('click', () => post({ type: 'pushSync', mode: 'rebase' }));
  pushAbort.addEventListener('click', () => post({ type: 'syncAbort' }));
  pushContinue.addEventListener('click', () => post({ type: 'syncContinue' }));
  pushAskNo.addEventListener('click', () => {
    closePushModal();
    post({ type: 'askPushCancel' });
  });
  pushAskYes.addEventListener('click', () => post({ type: 'askPushConfirm' }));
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
        const prevRoot = activeRepoRoot();
        workspace = msg.payload;
        const nextRoot = activeRepoRoot();
        if (prevRoot && prevRoot !== nextRoot) {
          saveMessageDraft();
        }
        if (nextRoot !== lastActiveRepoRoot) {
          loadMessageDraft();
        }

        const active = workspace.active;
        if (workspace.error) {
          showBanner(workspace.error, 'error');
        } else if (active.hint) {
          showBanner(active.hint, 'info');
        } else {
          showBanner('');
        }

        setBusy(!!workspace.busy);
        renderRepoSelector();

        if (selected) {
          if (selected.repoRoot !== nextRoot || !selectionStillExists(active, selected)) {
            selected = null;
            post({ type: 'updateSelection', repoRoot: nextRoot, path: null, staged: false });
          }
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
      case 'clearMessage': {
        const root = activeRepoRoot();
        commitMessages[root] = '';
        messageEl.value = '';
        showFormError('');
        break;
      }
      case 'focusMessage':
        messageEl.focus();
        const end = messageEl.value.length;
        messageEl.setSelectionRange(end, end);
        break;
    }
  });

  post({ type: 'ready' });
})();
