(function () {
  const vscode = acquireVsCodeApi();
  const webviewState = vscode.getState() || {};

  const dialogTitle = document.getElementById('dialogTitle');
  const mainView = document.getElementById('mainView');
  const altView = document.getElementById('altView');
  const statusBanner = document.getElementById('statusBanner');
  const targetList = document.getElementById('targetList');
  const commitList = document.getElementById('commitList');
  const noCommitSelected = document.getElementById('noCommitSelected');
  const altSplitPane = document.getElementById('altSplitPane');
  const altLeftPane = document.getElementById('altLeftPane');
  const altRightPane = document.getElementById('altRightPane');
  const pushTagsCheckbox = document.getElementById('pushTagsCheckbox');
  const pushTagsOption = document.getElementById('pushTagsOption');
  const footerLeft = document.getElementById('footerLeft');
  const newTagBtn = document.getElementById('newTagBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const pushBtn = document.getElementById('pushBtn');
  const mergeBtn = document.getElementById('mergeBtn');
  const rebaseBtn = document.getElementById('rebaseBtn');
  const abortBtn = document.getElementById('abortBtn');
  const continueBtn = document.getElementById('continueBtn');
  const laterBtn = document.getElementById('laterBtn');
  const closeBtn = document.getElementById('closeBtn');
  const newTagModal = document.getElementById('newTagModal');
  const newTagSummary = document.getElementById('newTagSummary');
  const newTagInput = document.getElementById('newTagInput');
  const newTagError = document.getElementById('newTagError');
  const newTagCancelBtn = document.getElementById('newTagCancelBtn');
  const newTagConfirmBtn = document.getElementById('newTagConfirmBtn');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingMessage = document.getElementById('loadingMessage');

  let payload = { targets: [], activeRepoRoot: '', pendingRepoRoots: [] };
  let modalState = 'confirm';
  let newTagOpen = false;
  let pendingTagRoots = [];
  let selectedTargetRoot = null;
  let selectedCommitHash = null;
  let checkedRoots = new Set();
  let targetSelectionInitialized = false;
  let pushRepoRoot = null;
  let syncMode = 'merge';
  let syncPreviewPayload = null;
  let conflictItems = [];
  let selectedConflictPath = null;

  function post(message) {
    vscode.postMessage(message);
  }

  function setBusy(busy, message) {
    document.body.classList.toggle('busy', !!busy);
    [cancelBtn, pushBtn, mergeBtn, rebaseBtn, abortBtn, continueBtn, laterBtn, newTagBtn, newTagCancelBtn, newTagConfirmBtn, closeBtn].forEach((btn) => {
      if (btn) {
        btn.disabled = !!busy;
      }
    });
    if (newTagInput) {
      newTagInput.disabled = !!busy;
    }
    if (pushTagsCheckbox) {
      pushTagsCheckbox.disabled = !!busy;
    }
    if (loadingOverlay) {
      loadingOverlay.classList.toggle('hidden', !busy);
    }
    if (loadingMessage && message) {
      loadingMessage.textContent = message;
    } else if (loadingMessage && busy) {
      loadingMessage.textContent = 'Working…';
    }
    if (statusBanner && modalState !== 'confirm') {
      if (busy && message) {
        statusBanner.classList.remove('hidden');
        statusBanner.textContent = message;
        statusBanner.classList.remove('error');
      } else if (!busy && modalState === 'syncPreview' && syncPreviewPayload) {
        statusBanner.classList.remove('hidden');
        statusBanner.textContent = syncPreviewPayload.mode === 'rebase' ? 'Review commits to rebase onto.' : 'Review commits to merge.';
        statusBanner.classList.remove('error');
      }
    }
  }

  function setFooterActions(visibleIds) {
    const buttons = {
      cancelBtn,
      pushBtn,
      mergeBtn,
      rebaseBtn,
      abortBtn,
      continueBtn,
      laterBtn,
    };
    Object.entries(buttons).forEach(([id, el]) => {
      if (el) {
        el.classList.toggle('hidden', !visibleIds.includes(id));
      }
    });
  }

  function setTagsVisible(visible) {
    if (footerLeft) {
      footerLeft.classList.toggle('hidden', !visible);
    }
  }

  function isPushTagsChecked() {
    return !!(pushTagsCheckbox && pushTagsCheckbox.checked);
  }

  function applyPushTagsPreference() {
    if (!pushTagsCheckbox) {
      return;
    }
    const state = vscode.getState() || {};
    pushTagsCheckbox.checked = state.pushTags !== false;
  }

  function savePushTagsPreference() {
    if (!pushTagsCheckbox) {
      return;
    }
    const state = vscode.getState() || {};
    vscode.setState({ ...state, pushTags: pushTagsCheckbox.checked });
  }

  if (pushTagsCheckbox) {
    pushTagsCheckbox.addEventListener('change', savePushTagsPreference);
  }

  function isValidTagName(name) {
    if (!name || name.includes('..') || name.startsWith('-') || name.endsWith('.')) {
      return false;
    }
    return /^[^\s~^:?*[\]\\]+$/.test(name);
  }

  function showNewTagError(message) {
    if (!newTagError) {
      return;
    }
    if (message) {
      newTagError.textContent = message;
      newTagError.classList.remove('hidden');
    } else {
      newTagError.textContent = '';
      newTagError.classList.add('hidden');
    }
  }

  function openNewTagModal(roots) {
    pendingTagRoots = roots;
    newTagOpen = true;
    if (newTagModal) {
      newTagModal.classList.remove('hidden');
    }
    if (newTagSummary) {
      if (roots.length === 1) {
        const target = findTarget(roots[0]);
        const branch = target?.branch || '(detached)';
        newTagSummary.textContent = `Create tag at HEAD on ${target?.repoName || 'repository'} (${branch}).`;
      } else {
        newTagSummary.textContent = `Create tag on ${roots.length} selected repositories (at each HEAD).`;
      }
    }
    if (newTagInput) {
      newTagInput.value = '';
      newTagInput.focus();
    }
    showNewTagError('');
  }

  function closeNewTagModal() {
    newTagOpen = false;
    pendingTagRoots = [];
    if (newTagModal) {
      newTagModal.classList.add('hidden');
    }
    showNewTagError('');
    if (newTagInput) {
      newTagInput.value = '';
    }
  }

  function submitNewTag() {
    const trimmed = (newTagInput?.value || '').trim();
    if (!trimmed) {
      showNewTagError('Tag name cannot be empty.');
      return;
    }
    if (!isValidTagName(trimmed)) {
      showNewTagError('Invalid tag name.');
      return;
    }
    showNewTagError('');
    post({ type: 'createTag', repoRoots: pendingTagRoots, tagName: trimmed });
  }

  function findTarget(repoRoot) {
    return payload.targets.find(
      (t) => String(t.repoRoot).replace(/\\/g, '/').toLowerCase() === String(repoRoot || '').replace(/\\/g, '/').toLowerCase()
    );
  }

  function normalizeRepoRoot(repoRoot) {
    return String(repoRoot || '').replace(/\\/g, '/').toLowerCase();
  }

  function defaultCheckedRoots() {
    if (payload.pendingRepoRoots?.length) {
      return new Set(payload.pendingRepoRoots.map(normalizeRepoRoot));
    }
    const active = payload.activeRepoRoot || payload.targets[0]?.repoRoot;
    if (active) {
      return new Set([normalizeRepoRoot(active)]);
    }
    return new Set(payload.targets.map((t) => normalizeRepoRoot(t.repoRoot)));
  }

  function selectTarget(key) {
    const changed = selectedTargetRoot !== key;
    selectedTargetRoot = key;
    if (changed) {
      selectedCommitHash = null;
    }
    pushRepoRoot = findTargetByKey(key)?.repoRoot || pushRepoRoot;
    renderTargets();
    renderCommits();
    updateTitle();
  }

  function toggleTargetChecked(key, checked) {
    targetSelectionInitialized = true;
    if (checked) {
      checkedRoots.add(key);
    } else {
      checkedRoots.delete(key);
    }
    renderTargets();
  }

  function renderTargets() {
    targetList.innerHTML = '';
    if (!payload.targets.length) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = 'No repositories to push.';
      targetList.appendChild(empty);
      return;
    }

    payload.targets.forEach((target) => {
      const key = normalizeRepoRoot(target.repoRoot);
      const row = document.createElement('div');
      row.className = 'target-item' + (selectedTargetRoot === key ? ' selected' : '');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checkedRoots.has(key);
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        toggleTargetChecked(key, checkbox.checked);
      });

      const label = document.createElement('span');
      label.className = 'target-label';
      label.textContent = target.label;
      label.title = target.label;

      row.appendChild(checkbox);
      row.appendChild(label);
      row.addEventListener('click', (e) => {
        if (e.target.closest('input[type="checkbox"]')) {
          return;
        }
        selectTarget(key);
      });
      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('input[type="checkbox"]')) {
          return;
        }
        e.preventDefault();
        targetSelectionInitialized = true;
        if (checkedRoots.has(key)) {
          checkedRoots.delete(key);
        } else {
          checkedRoots.add(key);
        }
        selectTarget(key);
      });
      targetList.appendChild(row);
    });
  }

  function renderCommits() {
    commitList.innerHTML = '';
    const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
    const commits = target?.commits || [];

    if (!target) {
      noCommitSelected.textContent = 'No commits selected';
      noCommitSelected.classList.remove('hidden');
      commitList.classList.add('hidden');
      return;
    }

    if (!commits.length) {
      noCommitSelected.textContent = 'No commits to push';
      noCommitSelected.classList.remove('hidden');
      commitList.classList.add('hidden');
      return;
    }

    noCommitSelected.classList.add('hidden');
    commitList.classList.remove('hidden');

    commits.forEach((commit) => {
      const li = document.createElement('li');
      li.className = 'commit-item' + (selectedCommitHash === commit.hash ? ' selected' : '');
      const subject = document.createElement('div');
      subject.className = 'commit-subject';
      subject.textContent = commit.subject;
      subject.title = commit.subject;
      const meta = document.createElement('div');
      meta.className = 'commit-meta';
      meta.textContent = `${commit.shortHash} · ${commit.author} · ${commit.date}`;
      li.appendChild(subject);
      li.appendChild(meta);
      li.addEventListener('click', () => {
        selectedCommitHash = commit.hash;
        renderCommits();
      });
      commitList.appendChild(li);
    });
  }

  function findTargetByKey(key) {
    if (!key) {
      return null;
    }
    return payload.targets.find((t) => t.repoRoot.replace(/\\/g, '/').toLowerCase() === key);
  }

  function updateTitle() {
    const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
    const name = target?.repoName || 'repository';
    if (modalState === 'confirm') {
      dialogTitle.textContent = `Push Commits to ${name}`;
    } else if (modalState === 'rejected') {
      dialogTitle.textContent = 'Push Rejected';
    } else if (modalState === 'syncPreview') {
      const branch = syncPreviewPayload?.branch || '(detached)';
      const upstream = syncPreviewPayload?.upstream || 'remote';
      if (syncPreviewPayload?.mode === 'rebase') {
        dialogTitle.textContent = `Rebase ${branch} onto ${upstream}`;
      } else {
        dialogTitle.textContent = `Merge Revisions from ${upstream} into ${branch}`;
      }
    } else if (modalState === 'conflict') {
      dialogTitle.textContent = 'Merge / Rebase Conflicts';
    } else if (modalState === 'askPush') {
      dialogTitle.textContent = 'Push?';
    }
  }

  function showConfirmView(data) {
    modalState = 'confirm';
    const prevSelected = selectedTargetRoot;
    payload = data;
    const targetKeys = new Set(data.targets.map((target) => normalizeRepoRoot(target.repoRoot)));
    if (!targetSelectionInitialized) {
      checkedRoots = defaultCheckedRoots();
      targetSelectionInitialized = true;
    } else {
      checkedRoots = new Set([...checkedRoots].filter((key) => targetKeys.has(key)));
    }
    const activeKey = normalizeRepoRoot(data.activeRepoRoot || data.targets[0]?.repoRoot || '');
    if (prevSelected && targetKeys.has(prevSelected)) {
      selectedTargetRoot = prevSelected;
    } else {
      selectedTargetRoot = checkedRoots.has(activeKey)
        ? activeKey
        : [...checkedRoots][0] || activeKey || null;
    }
    if (prevSelected !== selectedTargetRoot) {
      selectedCommitHash = null;
    }
    pushRepoRoot = findTargetByKey(selectedTargetRoot)?.repoRoot || data.targets[0]?.repoRoot || null;
    conflictItems = [];
    selectedConflictPath = null;

    mainView.classList.remove('hidden');
    altView.classList.add('hidden');
    statusBanner.classList.add('hidden');
    statusBanner.textContent = '';
    if (altSplitPane) {
      altSplitPane.classList.add('hidden');
    }

    updateTitle();
    renderTargets();
    renderCommits();
    applyPushTagsPreference();
    setTagsVisible(true);
    setFooterActions(['cancelBtn', 'pushBtn']);
  }

  function showBannerAltView(title, message, state, footerIds, showTags, isError) {
    modalState = state;
    dialogTitle.textContent = title;
    mainView.classList.add('hidden');
    altView.classList.remove('hidden');
    statusBanner.classList.remove('hidden');
    statusBanner.textContent = message;
    statusBanner.classList.toggle('error', !!isError);
    if (altSplitPane) {
      altSplitPane.classList.add('hidden');
    }
    setTagsVisible(!!showTags);
    setFooterActions(footerIds);
  }

  function showSplitAltView(title, bannerMessage, state, footerIds, showTags, isError) {
    modalState = state;
    dialogTitle.textContent = title;
    mainView.classList.add('hidden');
    altView.classList.remove('hidden');
    statusBanner.classList.remove('hidden');
    statusBanner.textContent = bannerMessage;
    statusBanner.classList.toggle('error', !!isError);
    if (altSplitPane) {
      altSplitPane.classList.remove('hidden');
    }
    setTagsVisible(!!showTags);
    setFooterActions(footerIds);
  }

  function renderIncomingCommits(commits, emptyText) {
    if (!commits.length) {
      const empty = document.createElement('div');
      empty.className = 'placeholder compact';
      empty.textContent = emptyText;
      return empty;
    }

    const list = document.createElement('ul');
    list.className = 'commit-list incoming-commit-list';
    commits.forEach((commit) => {
      const li = document.createElement('li');
      li.className = 'commit-item';
      const subject = document.createElement('div');
      subject.className = 'commit-subject';
      subject.textContent = commit.subject;
      subject.title = commit.subject;
      const meta = document.createElement('div');
      meta.className = 'commit-meta';
      meta.textContent = `${commit.shortHash} · ${commit.author} · ${commit.date}`;
      li.appendChild(subject);
      li.appendChild(meta);
      list.appendChild(li);
    });
    return list;
  }

  function renderSyncPreviewSplit(p) {
    if (!altLeftPane || !altRightPane) {
      return;
    }
    syncPreviewPayload = p;
    syncMode = p.mode || 'merge';
    altLeftPane.innerHTML = '';
    altRightPane.innerHTML = '';

    const leftTitle = document.createElement('div');
    leftTitle.className = 'alt-pane-title';
    leftTitle.textContent = 'Repository';
    altLeftPane.appendChild(leftTitle);

    const repoItem = document.createElement('div');
    repoItem.className = 'alt-info-item selected';
    repoItem.innerHTML =
      `<div class="alt-info-name">${escapeHtml(p.repoName || 'repository')}</div>` +
      `<div class="alt-info-meta">Branch: ${escapeHtml(p.branch || '(detached)')}</div>` +
      `<div class="alt-info-meta">Upstream: ${escapeHtml(p.upstream || '(none)')}</div>`;
    altLeftPane.appendChild(repoItem);

    const rightTitle = document.createElement('div');
    rightTitle.className = 'alt-pane-title';
    rightTitle.textContent =
      p.mode === 'rebase'
        ? `Incoming commits (${p.commits?.length || 0})`
        : `Commits to merge (${p.commits?.length || 0})`;
    altRightPane.appendChild(rightTitle);

    if (p.blockers?.length) {
      const warning = document.createElement('div');
      warning.className = 'alt-detail-hint error';
      warning.textContent =
        `Local changes to the following file(s) would be overwritten: ${p.blockers.join(', ')}. Commit or stash them before merging.`;
      altRightPane.appendChild(warning);
    }

    altRightPane.appendChild(
      renderIncomingCommits(
        p.commits || [],
        p.mode === 'rebase' ? 'No incoming commits found on upstream.' : 'No incoming commits found to merge.'
      )
    );

    const hint = document.createElement('div');
    hint.className = 'alt-detail-hint';
    hint.textContent =
      p.mode === 'rebase'
        ? 'Your local commits will be replayed on top of the upstream branch.'
        : 'Remote commits will be merged into your current branch.';
    altRightPane.appendChild(hint);

    if (mergeBtn) {
      mergeBtn.textContent = p.mode === 'rebase' ? 'Rebase' : 'Merge';
      mergeBtn.disabled = !!(p.blockers && p.blockers.length);
      mergeBtn.classList.toggle('primary', true);
    }
  }

  function renderRejectedSplit(p) {
    if (!altLeftPane || !altRightPane) {
      return;
    }
    altLeftPane.innerHTML = '';
    altRightPane.innerHTML = '';

    const leftTitle = document.createElement('div');
    leftTitle.className = 'alt-pane-title';
    leftTitle.textContent = 'Repository';
    altLeftPane.appendChild(leftTitle);

    const repoItem = document.createElement('div');
    repoItem.className = 'alt-info-item selected';
    repoItem.innerHTML =
      `<div class="alt-info-name">${escapeHtml(p.repoName || 'repository')}</div>` +
      `<div class="alt-info-meta">Branch: ${escapeHtml(p.branch || '(detached)')}</div>` +
      `<div class="alt-info-meta">Upstream: ${escapeHtml(p.upstream || '(none)')}</div>` +
      (typeof p.behind === 'number' ? `<div class="alt-info-meta">Behind: ${p.behind}</div>` : '') +
      (typeof p.ahead === 'number' ? `<div class="alt-info-meta">Ahead: ${p.ahead}</div>` : '');
    altLeftPane.appendChild(repoItem);

    const rightTitle = document.createElement('div');
    rightTitle.className = 'alt-pane-title';
    rightTitle.textContent = 'Push rejected';
    altRightPane.appendChild(rightTitle);

    const msg = document.createElement('div');
    msg.className = 'alt-detail-message';
    msg.textContent = p.message;
    altRightPane.appendChild(msg);

    const hint = document.createElement('div');
    hint.className = 'alt-detail-hint';
    hint.textContent = 'Remote has commits you do not have locally. Choose Merge to integrate remote changes, or Rebase to replay your commits on top.';
    altRightPane.appendChild(hint);
  }

  function renderConflictSplit(p) {
    if (!altLeftPane || !altRightPane) {
      return;
    }
    syncMode = p.mode || 'merge';
    conflictItems = p.conflicts || [];
    if (selectedConflictPath && !conflictItems.some((c) => c.path === selectedConflictPath)) {
      selectedConflictPath = conflictItems[0]?.path || null;
    } else if (!selectedConflictPath && conflictItems.length) {
      selectedConflictPath = conflictItems[0].path;
    }

    altLeftPane.innerHTML = '';
    altRightPane.innerHTML = '';

    const leftTitle = document.createElement('div');
    leftTitle.className = 'alt-pane-title';
    leftTitle.textContent = `Conflicts (${conflictItems.length})`;
    altLeftPane.appendChild(leftTitle);

    if (!conflictItems.length) {
      const empty = document.createElement('div');
      empty.className = 'placeholder compact';
      empty.textContent = 'No unresolved conflicts';
      altLeftPane.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'conflict-list';
      conflictItems.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'conflict-item' + (selectedConflictPath === item.path ? ' selected' : '');
        const status = document.createElement('span');
        status.className = 'conflict-status';
        status.textContent = item.status || 'C';
        const name = document.createElement('span');
        name.className = 'conflict-path';
        name.textContent = item.path;
        name.title = item.path;
        li.appendChild(status);
        li.appendChild(name);
        li.addEventListener('click', () => {
          selectedConflictPath = item.path;
          renderConflictSplit(p);
        });
        list.appendChild(li);
      });
      altLeftPane.appendChild(list);
    }

    renderConflictDetail(p);
  }

  function renderConflictDetail(p) {
    if (!altRightPane) {
      return;
    }

    const rightTitle = document.createElement('div');
    rightTitle.className = 'alt-pane-title';
    rightTitle.textContent = 'Resolve conflict';
    altRightPane.appendChild(rightTitle);

    if (!conflictItems.length) {
      const done = document.createElement('div');
      done.className = 'alt-detail-hint success';
      done.textContent = 'All conflicts resolved. Click Continue to finish the merge/rebase.';
      altRightPane.appendChild(done);
      return;
    }

    if (!selectedConflictPath) {
      const pick = document.createElement('div');
      pick.className = 'placeholder compact';
      pick.textContent = 'Select a conflicted file on the left.';
      altRightPane.appendChild(pick);
      return;
    }

    const fileTitle = document.createElement('div');
    fileTitle.className = 'alt-file-path';
    fileTitle.textContent = selectedConflictPath;
    fileTitle.title = selectedConflictPath;
    altRightPane.appendChild(fileTitle);

    const yoursLabel = syncMode === 'rebase' ? 'Accept Yours (Local commit)' : 'Accept Yours (Local)';
    const theirsLabel = syncMode === 'rebase' ? 'Accept Theirs (Upstream)' : 'Accept Theirs (Remote)';

    const actions = document.createElement('div');
    actions.className = 'resolve-actions';

    const yoursBtn = document.createElement('button');
    yoursBtn.type = 'button';
    yoursBtn.className = 'resolve-btn';
    yoursBtn.textContent = yoursLabel;
    yoursBtn.addEventListener('click', () => {
      post({
        type: 'resolveConflict',
        path: selectedConflictPath,
        side: 'yours',
        mode: syncMode,
        repoRoot: pushRepoRoot || undefined,
      });
    });

    const theirsBtn = document.createElement('button');
    theirsBtn.type = 'button';
    theirsBtn.className = 'resolve-btn';
    theirsBtn.textContent = theirsLabel;
    theirsBtn.addEventListener('click', () => {
      post({
        type: 'resolveConflict',
        path: selectedConflictPath,
        side: 'theirs',
        mode: syncMode,
        repoRoot: pushRepoRoot || undefined,
      });
    });

    const mergeBtnLocal = document.createElement('button');
    mergeBtnLocal.type = 'button';
    mergeBtnLocal.className = 'resolve-btn primary';
    mergeBtnLocal.textContent = 'Merge in Editor…';
    mergeBtnLocal.addEventListener('click', () => {
      post({ type: 'openConflict', path: selectedConflictPath, repoRoot: pushRepoRoot || undefined });
    });

    actions.appendChild(yoursBtn);
    actions.appendChild(theirsBtn);
    actions.appendChild(mergeBtnLocal);
    altRightPane.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'alt-detail-hint';
    hint.textContent =
      syncMode === 'rebase'
        ? 'Pick one side to auto-resolve, or open the merge editor to combine changes manually.'
        : 'Accept local or remote version, or open the merge editor to combine changes manually.';
    altRightPane.appendChild(hint);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getCheckedRepoRoots() {
    return payload.targets
      .filter((t) => checkedRoots.has(t.repoRoot.replace(/\\/g, '/').toLowerCase()))
      .map((t) => t.repoRoot);
  }

  function selectionHasCommits(roots) {
    return roots.some((root) => (findTarget(root)?.commits?.length ?? 0) > 0);
  }

  function canPushSelection() {
    const roots = getCheckedRepoRoots();
    if (!roots.length) {
      return false;
    }
    if (isPushTagsChecked()) {
      return true;
    }
    return selectionHasCommits(roots);
  }

  function showFooterError(message) {
    statusBanner.classList.remove('hidden');
    statusBanner.textContent = message;
    statusBanner.classList.add('error');
  }

  cancelBtn.addEventListener('click', () => post({ type: 'cancel' }));
  closeBtn.addEventListener('click', () => post({ type: 'cancel' }));
  if (newTagBtn) {
    newTagBtn.addEventListener('click', () => {
      const roots = getCheckedRepoRoots();
      if (!roots.length) {
        showFooterError('Select at least one branch to tag.');
        return;
      }
      openNewTagModal(roots);
    });
  }
  if (newTagCancelBtn) {
    newTagCancelBtn.addEventListener('click', closeNewTagModal);
  }
  if (newTagConfirmBtn) {
    newTagConfirmBtn.addEventListener('click', submitNewTag);
  }
  if (newTagInput) {
    newTagInput.addEventListener('input', () => showNewTagError(''));
    newTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitNewTag();
      }
    });
  }
  if (newTagModal) {
    newTagModal.addEventListener('click', (e) => {
      if (document.body.classList.contains('busy')) {
        return;
      }
      if (e.target === newTagModal) {
        closeNewTagModal();
      }
    });
  }
  pushBtn.addEventListener('click', () => {
    const roots = getCheckedRepoRoots();
    if (!roots.length) {
      showFooterError('Select at least one branch to push.');
      return;
    }
    if (!canPushSelection()) {
      showFooterError('No commits to push. Check Push tags to push tags only.');
      return;
    }
    post({ type: 'push', repoRoots: roots, pushTags: isPushTagsChecked() });
  });
  mergeBtn.addEventListener('click', () => {
    if (modalState === 'rejected') {
      post({ type: 'pushSyncPreview', mode: 'merge', repoRoot: pushRepoRoot || undefined });
      return;
    }
    if (modalState === 'syncPreview') {
      post({ type: 'pushSyncConfirm', mode: syncMode, repoRoot: pushRepoRoot || undefined });
    }
  });
  rebaseBtn.addEventListener('click', () =>
    post({ type: 'pushSyncPreview', mode: 'rebase', repoRoot: pushRepoRoot || undefined })
  );
  abortBtn.addEventListener('click', () => post({ type: 'syncAbort', repoRoot: pushRepoRoot || undefined }));
  continueBtn.addEventListener('click', () => post({ type: 'syncContinue', repoRoot: pushRepoRoot || undefined }));
  laterBtn.addEventListener('click', () => {
    post({ type: 'askPushCancel' });
    post({ type: 'cancel' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.body.classList.contains('busy')) {
        return;
      }
      e.preventDefault();
      if (newTagOpen) {
        closeNewTagModal();
        return;
      }
      post({ type: 'cancel' });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        showConfirmView(msg.payload);
        break;
      case 'busy':
        setBusy(msg.busy, msg.message);
        break;
      case 'error':
        statusBanner.classList.remove('hidden');
        statusBanner.textContent = msg.message;
        statusBanner.classList.add('error');
        break;
      case 'tagResult':
        if (msg.success) {
          closeNewTagModal();
        } else if (newTagOpen) {
          showNewTagError(msg.message);
        } else {
          showFooterError(msg.message);
        }
        break;
      case 'showRejected': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        syncPreviewPayload = null;
        if (mergeBtn) {
          mergeBtn.textContent = 'Merge';
          mergeBtn.classList.add('primary');
          mergeBtn.disabled = false;
        }
        showSplitAltView(
          'Push Rejected',
          `${p.repoName} · ${p.branch || '(detached)'} → ${p.upstream || 'remote'}`,
          'rejected',
          ['cancelBtn', 'mergeBtn', 'rebaseBtn'],
          false,
          true
        );
        renderRejectedSplit(p);
        break;
      }
      case 'showSyncPreview': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        syncPreviewPayload = p;
        syncMode = p.mode || 'merge';
        const titleBranch = p.branch || '(detached)';
        const titleUpstream = p.upstream || 'remote';
        const title =
          p.mode === 'rebase'
            ? `Rebase ${titleBranch} onto ${titleUpstream}`
            : `Merge Revisions from ${titleUpstream} into ${titleBranch}`;
        showSplitAltView(
          title,
          p.mode === 'rebase' ? 'Review commits to rebase onto.' : 'Review commits to merge.',
          'syncPreview',
          ['cancelBtn', 'mergeBtn'],
          false,
          false
        );
        renderSyncPreviewSplit(p);
        updateTitle();
        break;
      }
      case 'showSyncConflict': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        showSplitAltView(
          `${p.mode === 'rebase' ? 'Rebase' : 'Merge'} Conflicts`,
          p.message,
          'conflict',
          ['abortBtn', 'continueBtn'],
          false,
          false
        );
        renderConflictSplit(p);
        break;
      }
      case 'showAskPush': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        const behindLine = typeof p.behind === 'number' ? `\nBehind: ${p.behind}` : '';
        showBannerAltView(
          'Push?',
          `${p.summary}\n\nRepository: ${p.repoName}\nBranch: ${p.branch || '(detached)'}\nUpstream: ${p.upstream || '(none)'}\nAhead: ${typeof p.ahead === 'number' ? p.ahead : '?'}${behindLine}`,
          'askPush',
          ['laterBtn', 'pushBtn'],
          true,
          false
        );
        pushBtn.onclick = () =>
          post({ type: 'askPushConfirm', repoRoot: pushRepoRoot || undefined, pushTags: isPushTagsChecked() });
        break;
      }
      default:
        break;
    }
  });

  post({ type: 'ready' });
})();
