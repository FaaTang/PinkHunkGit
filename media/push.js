(function () {
  const vscode = acquireVsCodeApi();
  const webviewState = vscode.getState() || {};

  const dialogTitle = document.getElementById('dialogTitle');
  const mainView = document.getElementById('mainView');
  const altView = document.getElementById('altView');
  const statusBanner = document.getElementById('statusBanner');
  const targetList = document.getElementById('targetList');
  const commitsPane = document.getElementById('commitsPane');
  const commitResize = document.getElementById('commitResize');
  const commitPane = document.getElementById('commitPane');
  const branchMapping = document.getElementById('branchMapping');
  const commitList = document.getElementById('commitList');
  const noCommitSelected = document.getElementById('noCommitSelected');
  const fileTree = document.getElementById('fileTree');
  const noFileSelected = document.getElementById('noFileSelected');
  const commitDetailMessage = document.getElementById('commitDetailMessage');
  const commitDetailMeta = document.getElementById('commitDetailMeta');
  const expandFilesBtn = document.getElementById('expandFilesBtn');
  const collapseFilesBtn = document.getElementById('collapseFilesBtn');
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
  const newTagRepoList = document.getElementById('newTagRepoList');
  const newTagError = document.getElementById('newTagError');
  const newTagCancelBtn = document.getElementById('newTagCancelBtn');
  const newTagConfirmBtn = document.getElementById('newTagConfirmBtn');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingMessage = document.getElementById('loadingMessage');

  let payload = { targets: [], activeRepoRoot: '', pendingRepoRoots: [] };
  let modalState = 'confirm';
  let newTagOpen = false;
  let pendingTagRoots = [];
  let previousTagRequestId = 0;
  /** @type {Map<string, { previousTag?: string; error?: string; loading: boolean }>} */
  let tagRowState = new Map();
  let selectedTargetRoot = null;
  let selectedCommitHash = null;
  let selectedFilePath = null;
  let commitDetails = null;
  let pendingDetailsKey = null;
  let collapsedFileDirs = new Set();
  let checkedRoots = new Set();
  let targetSelectionInitialized = false;
  let pushRepoRoot = null;
  let syncMode = 'merge';
  let syncPreviewPayload = null;
  let rejectedPayload = null;
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
    if (newTagRepoList) {
      for (const input of newTagRepoList.querySelectorAll('input[type="text"]')) {
        input.disabled = !!busy;
      }
      for (const btn of newTagRepoList.querySelectorAll('button')) {
        btn.disabled = !!busy;
      }
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
      } else if (!busy && modalState === 'rejected' && rejectedPayload) {
        statusBanner.classList.remove('hidden');
        statusBanner.textContent = formatRejectedBanner(rejectedPayload);
        statusBanner.classList.add('error');
      } else if (!busy && modalState === 'syncPreview' && syncPreviewPayload) {
        statusBanner.classList.remove('hidden');
        statusBanner.textContent = syncPreviewPayload.mode === 'rebase' ? 'Review commits to rebase onto.' : 'Review commits to merge.';
        statusBanner.classList.remove('error');
      }
    }
  }

  function formatRejectedBanner(p) {
    const context = `${p.repoName || 'repository'} · ${p.branch || '(detached)'} → ${p.upstream || 'remote'}`;
    const reason = (p.message || '').trim();
    return reason ? `${context}\n${reason}` : context;
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

  function saveWebviewState(patch) {
    const state = { ...(vscode.getState() || {}), ...patch };
    vscode.setState(state);
  }

  const DEFAULT_COMMIT_PANE_HEIGHT = 140;
  const MIN_COMMIT_PANE_HEIGHT = 96;

  function maxCommitPaneHeight() {
    if (!commitsPane) {
      return 420;
    }
    const paneH = commitsPane.getBoundingClientRect().height;
    if (paneH < 1) {
      return 420;
    }
    const resizeH = commitResize ? commitResize.getBoundingClientRect().height : 8;
    // Leave room for at least a few target rows.
    return Math.max(MIN_COMMIT_PANE_HEIGHT, Math.floor(paneH - resizeH - 72));
  }

  function applyCommitPaneHeight(px) {
    if (!commitPane || !commitsPane?.classList.contains('has-targets')) {
      return;
    }
    const next = Math.max(MIN_COMMIT_PANE_HEIGHT, Math.min(maxCommitPaneHeight(), Math.round(px)));
    commitPane.style.height = `${next}px`;
    webviewState.commitPaneHeight = next;
    saveWebviewState({ commitPaneHeight: next });
  }

  function restoreCommitPaneHeight() {
    const preferred = Number(webviewState.commitPaneHeight) || DEFAULT_COMMIT_PANE_HEIGHT;
    applyCommitPaneHeight(preferred);
    requestAnimationFrame(() => applyCommitPaneHeight(preferred));
  }

  function setCommitsPaneHasTargets(hasTargets) {
    if (!commitsPane) {
      return;
    }
    commitsPane.classList.toggle('has-targets', !!hasTargets);
    if (commitResize) {
      commitResize.classList.toggle('hidden', !hasTargets);
    }
    if (!hasTargets && commitPane) {
      commitPane.style.height = '';
    } else if (hasTargets) {
      restoreCommitPaneHeight();
    }
  }

  (function initCommitPaneResize() {
    if (!commitResize || !commitPane || !commitsPane) {
      return;
    }
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    function onPointerMove(e) {
      if (!dragging) {
        return;
      }
      // Sash sits between target list (top) and commit pane (bottom):
      // drag sash up => commit taller; drag sash down => commit shorter.
      applyCommitPaneHeight(startHeight + (startY - e.clientY));
    }

    function onPointerUp(e) {
      if (!dragging) {
        return;
      }
      dragging = false;
      commitsPane.classList.remove('is-resizing');
      document.body.classList.remove('is-commit-split-resizing');
      try {
        commitResize.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      commitResize.removeEventListener('pointermove', onPointerMove);
      commitResize.removeEventListener('pointerup', onPointerUp);
      commitResize.removeEventListener('pointercancel', onPointerUp);
    }

    commitResize.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !commitsPane.classList.contains('has-targets')) {
        return;
      }
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startHeight = commitPane.getBoundingClientRect().height;
      commitsPane.classList.add('is-resizing');
      document.body.classList.add('is-commit-split-resizing');
      commitResize.setPointerCapture(e.pointerId);
      commitResize.addEventListener('pointermove', onPointerMove);
      commitResize.addEventListener('pointerup', onPointerUp);
      commitResize.addEventListener('pointercancel', onPointerUp);
    });

    commitResize.addEventListener('keydown', (e) => {
      if (!commitsPane.classList.contains('has-targets')) {
        return;
      }
      const step = e.shiftKey ? 24 : 8;
      // ArrowUp moves sash up => commit taller; ArrowDown => commit shorter.
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        applyCommitPaneHeight(commitPane.getBoundingClientRect().height + step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        applyCommitPaneHeight(commitPane.getBoundingClientRect().height - step);
      }
    });
  })();

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

  /** If tag ends with digits, bump the trailing number by 1; otherwise return as-is. */
  function bumpTrailingNumber(tagName) {
    const name = (tagName || '').trim();
    if (!name) {
      return '';
    }
    const match = /^(.*)(\d+)$/.exec(name);
    if (!match) {
      return name;
    }
    return `${match[1]}${Number(match[2]) + 1}`;
  }

  function getTagRowInput(repoRoot) {
    if (!newTagRepoList) {
      return null;
    }
    const key = normalizeRepoRoot(repoRoot);
    return newTagRepoList.querySelector(`input.new-tag-input[data-repo-root-key="${CSS.escape(key)}"]`);
  }

  function renderNewTagRows(roots) {
    if (!newTagRepoList) {
      return;
    }
    newTagRepoList.innerHTML = '';
    tagRowState = new Map();

    for (const root of roots) {
      const key = normalizeRepoRoot(root);
      const target = findTarget(root);
      const repoName = target?.repoName || root;
      const branch = target?.branch || '(detached)';
      tagRowState.set(key, { loading: true });

      const row = document.createElement('div');
      row.className = 'new-tag-repo-row';
      row.dataset.repoRoot = root;
      row.dataset.repoRootKey = key;

      const head = document.createElement('div');
      head.className = 'new-tag-repo-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'new-tag-repo-name';
      nameEl.textContent = repoName;
      const branchEl = document.createElement('span');
      branchEl.className = 'new-tag-repo-branch';
      branchEl.textContent = branch;
      head.appendChild(nameEl);
      head.appendChild(branchEl);

      const previous = document.createElement('div');
      previous.className = 'new-tag-previous is-loading';
      previous.dataset.role = 'previous';

      const prevLabel = document.createElement('span');
      prevLabel.className = 'new-tag-previous-label';
      prevLabel.textContent = 'Previous remote tag:';

      const spinner = document.createElement('span');
      spinner.className = 'new-tag-previous-spinner';
      spinner.setAttribute('aria-hidden', 'true');

      const prevValue = document.createElement('span');
      prevValue.className = 'new-tag-previous-value hidden';
      prevValue.dataset.role = 'previous-value';

      const overwriteBtn = document.createElement('button');
      overwriteBtn.type = 'button';
      overwriteBtn.className = 'new-tag-overwrite hidden';
      overwriteBtn.dataset.role = 'overwrite';
      overwriteBtn.textContent = 'Overwrite';
      overwriteBtn.title = 'Fill input with previous remote tag (bump trailing number by +1 when present)';
      overwriteBtn.addEventListener('click', () => {
        const state = tagRowState.get(key);
        const previousTag = (state?.previousTag || '').trim();
        if (!previousTag) {
          return;
        }
        const input = getTagRowInput(root);
        if (!input) {
          return;
        }
        input.value = bumpTrailingNumber(previousTag);
        input.focus();
        input.select();
        showNewTagError('');
      });

      previous.appendChild(prevLabel);
      previous.appendChild(spinner);
      previous.appendChild(prevValue);
      previous.appendChild(overwriteBtn);

      const label = document.createElement('label');
      label.className = 'field-label';
      label.textContent = 'Tag name';
      const inputId = `newTagInput_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      label.setAttribute('for', inputId);

      const input = document.createElement('input');
      input.id = inputId;
      input.className = 'field-input new-tag-input';
      input.type = 'text';
      input.placeholder = 'v1.0.3';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.repoRoot = root;
      input.dataset.repoRootKey = key;
      input.addEventListener('input', () => showNewTagError(''));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitNewTag();
        }
      });

      row.appendChild(head);
      row.appendChild(previous);
      row.appendChild(label);
      row.appendChild(input);
      newTagRepoList.appendChild(row);
    }
  }

  function applyPreviousRemoteTagsToRows(items) {
    if (!newTagRepoList) {
      return;
    }
    const byKey = new Map();
    for (const item of items || []) {
      byKey.set(normalizeRepoRoot(item.repoRoot), item);
    }

    for (const root of pendingTagRoots) {
      const key = normalizeRepoRoot(root);
      const row = newTagRepoList.querySelector(`.new-tag-repo-row[data-repo-root-key="${CSS.escape(key)}"]`);
      if (!row) {
        continue;
      }
      const previous = row.querySelector('[data-role="previous"]');
      const prevValue = row.querySelector('[data-role="previous-value"]');
      const overwriteBtn = row.querySelector('[data-role="overwrite"]');
      const item = byKey.get(key);
      let previousTag = '';
      let error = '';
      let display = '(none)';

      if (!item) {
        display = '(none)';
      } else if (item.error) {
        error = item.error;
        display = '(unavailable)';
      } else if (item.tagName) {
        previousTag = String(item.tagName).trim();
        display = previousTag || '(none)';
      }

      tagRowState.set(key, { previousTag, error, loading: false });
      if (previous) {
        previous.classList.remove('is-loading');
      }
      if (prevValue) {
        prevValue.textContent = display;
        prevValue.classList.remove('hidden');
        prevValue.title = error || display;
      }
      if (overwriteBtn) {
        overwriteBtn.classList.toggle('hidden', !previousTag);
      }
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
        newTagSummary.textContent = `Create a tag for each selected repository (at that repo HEAD). Each row has its own previous remote tag and Overwrite (+1).`;
      }
    }
    renderNewTagRows(roots);
    showNewTagError('');
    const firstInput = newTagRepoList?.querySelector('input.new-tag-input');
    firstInput?.focus();
    const requestId = ++previousTagRequestId;
    post({ type: 'getPreviousRemoteTags', repoRoots: roots, requestId });
  }

  function closeNewTagModal() {
    newTagOpen = false;
    pendingTagRoots = [];
    previousTagRequestId += 1;
    tagRowState = new Map();
    if (newTagModal) {
      newTagModal.classList.add('hidden');
    }
    showNewTagError('');
    if (newTagRepoList) {
      newTagRepoList.innerHTML = '';
    }
  }

  function collectTagAssignmentsFromRows() {
    if (!pendingTagRoots.length) {
      return { ok: false, error: 'Select at least one branch to tag.' };
    }
    const items = [];
    for (const root of pendingTagRoots) {
      const input = getTagRowInput(root);
      const tagName = (input?.value || '').trim();
      const target = findTarget(root);
      const label = target?.repoName || root;
      if (!tagName) {
        return { ok: false, error: `Tag name cannot be empty for ${label}.` };
      }
      if (!isValidTagName(tagName)) {
        return { ok: false, error: `Invalid tag name for ${label}: ${tagName}` };
      }
      items.push({ repoRoot: root, tagName });
    }
    return { ok: true, items };
  }

  function submitNewTag() {
    const tags = collectTagAssignmentsFromRows();
    if (!tags.ok) {
      showNewTagError(tags.error || 'Invalid tag input.');
      return;
    }
    showNewTagError('');
    post({ type: 'createTag', tags: tags.items });
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
      selectedFilePath = null;
      commitDetails = null;
      pendingDetailsKey = null;
      collapsedFileDirs = new Set();
    }
    pushRepoRoot = findTargetByKey(key)?.repoRoot || pushRepoRoot;
    renderTargets();
    renderBranchMapping();
    renderCommits();
    renderCommitDetails();
    updateTitle();
    autoSelectFirstCommit();
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

  function formatBranchMapping(target) {
    if (!target) {
      return '';
    }
    const local = target.branch || '(detached)';
    if (target.remote && target.upstreamBranch) {
      return `${local} → ${target.remote} : ${target.upstreamBranch}`;
    }
    if (target.upstream) {
      return `${local} → ${target.upstream}`;
    }
    return local;
  }

  function renderBranchMapping() {
    if (!branchMapping) {
      return;
    }
    const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
    branchMapping.textContent = formatBranchMapping(target);
    branchMapping.title = branchMapping.textContent;
  }

  function renderTargets() {
    if (!targetList) {
      return;
    }
    targetList.innerHTML = '';
    // IDEA focuses one repo; only show checkbox list when multiple repos.
    if (payload.targets.length <= 1) {
      setCommitsPaneHasTargets(false);
      return;
    }
    setCommitsPaneHasTargets(true);
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
      clearCommitDetails();
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
      li.appendChild(subject);
      li.addEventListener('click', () => {
        selectCommit(commit.hash);
      });
      commitList.appendChild(li);
    });
  }

  function autoSelectFirstCommit() {
    const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
    const commits = target?.commits || [];
    if (!commits.length) {
      clearCommitDetails();
      return;
    }
    if (selectedCommitHash && commits.some((c) => sameCommitHash(c.hash, selectedCommitHash))) {
      // Keep existing details on state refresh; only fetch when missing/stale.
      requestCommitDetails(selectedCommitHash, { quiet: true });
      return;
    }
    selectCommit(commits[0].hash);
  }

  function selectCommit(hash) {
    selectedCommitHash = hash;
    selectedFilePath = null;
    renderCommits();
    requestCommitDetails(hash);
  }

  function sameCommitHash(a, b) {
    if (!a || !b) {
      return false;
    }
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    return x === y || x.startsWith(y) || y.startsWith(x);
  }

  function detailsKey(repoRoot, hash) {
    return `${normalizeRepoRoot(repoRoot)}::${String(hash).toLowerCase()}`;
  }

  function requestCommitDetails(hash, options = {}) {
    const quiet = !!options.quiet;
    const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
    if (!target || !hash) {
      clearCommitDetails();
      return;
    }
    const key = detailsKey(target.repoRoot, hash);

    // Already showing this commit — avoid clearing the right pane (prevents flicker on state refresh).
    if (
      commitDetails &&
      sameCommitHash(commitDetails.hash, hash) &&
      normalizeRepoRoot(commitDetails.repoRoot) === normalizeRepoRoot(target.repoRoot)
    ) {
      pendingDetailsKey = null;
      renderCommitDetails();
      return;
    }

    // Same request already in flight.
    if (pendingDetailsKey === key) {
      return;
    }

    pendingDetailsKey = key;
    const keepUi = quiet && commitDetails;
    if (!keepUi) {
      commitDetails = null;
      if (fileTree) {
        fileTree.innerHTML = '';
      }
      if (noFileSelected) {
        noFileSelected.textContent = 'Loading…';
        noFileSelected.classList.remove('hidden');
      }
      if (commitDetailMessage) {
        commitDetailMessage.innerHTML = '';
        commitDetailMessage.dataset.loading = '1';
      }
      if (commitDetailMeta) {
        commitDetailMeta.textContent = '';
      }
    }
    post({ type: 'getCommitDetails', repoRoot: target.repoRoot, hash });
  }

  function clearCommitDetails() {
    commitDetails = null;
    pendingDetailsKey = null;
    selectedFilePath = null;
    if (fileTree) {
      fileTree.innerHTML = '';
    }
    if (noFileSelected) {
      noFileSelected.textContent = 'Select a commit to view changed files';
      noFileSelected.classList.remove('hidden');
    }
    if (commitDetailMessage) {
      commitDetailMessage.innerHTML = '';
      delete commitDetailMessage.dataset.loading;
    }
    if (commitDetailMeta) {
      commitDetailMeta.textContent = '';
    }
  }

  function applyCommitDetails(details) {
    pendingDetailsKey = null;
    if (commitDetailMessage) {
      delete commitDetailMessage.dataset.loading;
    }
    commitDetails = details;
    collapsedFileDirs = new Set();
    renderCommitDetails();
  }

  function renderCommitDetails() {
    if (!commitDetails) {
      return;
    }
    if (commitDetailMessage) {
      commitDetailMessage.innerHTML = '';
      const raw = (commitDetails.message || commitDetails.subject || '').replace(/\r\n/g, '\n');
      const lines = raw.split('\n');
      const subjectLine = lines[0] || '';
      const body = lines.slice(1).join('\n').replace(/^\n+/, '');
      const subjectEl = document.createElement('div');
      subjectEl.className = 'commit-detail-subject';
      subjectEl.textContent = subjectLine;
      commitDetailMessage.appendChild(subjectEl);
      if (body.trim()) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'commit-detail-body';
        bodyEl.textContent = body;
        commitDetailMessage.appendChild(bodyEl);
      }
    }
    if (commitDetailMeta) {
      const email = commitDetails.email ? `<${commitDetails.email}>` : '';
      const date = commitDetails.date ? `on ${commitDetails.date}` : '';
      commitDetailMeta.textContent = [commitDetails.shortHash, commitDetails.author, email, date]
        .filter(Boolean)
        .join('  ');
      commitDetailMeta.title = commitDetailMeta.textContent;
    }
    renderFileTree();
  }

  function splitPushPath(fullPath) {
    const normalized = (fullPath || '').replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx < 0) {
      return { name: normalized, dir: '' };
    }
    return { name: normalized.slice(idx + 1), dir: normalized.slice(0, idx) };
  }

  const PUSH_FILE_ICON_BY_EXT = {
    java: { label: 'J', color: '#b07219' },
    ts: { label: 'TS', color: '#3178c6' },
    tsx: { label: 'TSX', color: '#3178c6' },
    js: { label: 'JS', color: '#f1e05a' },
    jsx: { label: 'JSX', color: '#f1e05a' },
    vue: { label: 'V', color: '#41b883' },
    css: { label: 'CSS', color: '#563d7c' },
    scss: { label: 'SCSS', color: '#c6538c' },
    html: { label: 'HTML', color: '#e34c26' },
    json: { label: '{}', color: '#cbcb41' },
    md: { label: 'MD', color: '#083fa1' },
    py: { label: 'PY', color: '#3572A5' },
    go: { label: 'GO', color: '#00ADD8' },
    xml: { label: 'XML', color: '#e37933' },
    yml: { label: 'YML', color: '#cb171e' },
    yaml: { label: 'YML', color: '#cb171e' },
    sql: { label: 'SQL', color: '#e38c10' },
  };

  function resolvePushFileIcon(filePath) {
    const { name } = splitPushPath(filePath);
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot >= 0) {
      const ext = lower.slice(dot + 1);
      if (PUSH_FILE_ICON_BY_EXT[ext]) {
        return PUSH_FILE_ICON_BY_EXT[ext];
      }
    }
    return { label: 'F', color: '#8a8a8a' };
  }

  function buildPushDirTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const item of files) {
      const normalized = (item.path || '').replace(/\\/g, '/');
      const parts = normalized.split('/').filter(Boolean);
      if (!parts.length) {
        continue;
      }
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        if (!node.dirs.has(part)) {
          const childPath = node.path ? `${node.path}/${part}` : part;
          node.dirs.set(part, { name: part, path: childPath, dirs: new Map(), files: [] });
        }
        node = node.dirs.get(part);
      }
      node.files.push(item);
    }
    return root;
  }

  function compactPushDirTree(node) {
    const children = [...node.dirs.values()];
    node.dirs.clear();
    for (const child of children) {
      compactPushDirTree(child);
      while (child.dirs.size === 1 && child.files.length === 0) {
        const only = child.dirs.values().next().value;
        child.name = `${child.name}/${only.name}`;
        child.path = only.path;
        child.dirs = only.dirs;
        child.files = only.files;
      }
      node.dirs.set(child.name, child);
    }
  }

  function countPushTreeFiles(node) {
    let total = node.files.length;
    for (const child of node.dirs.values()) {
      total += countPushTreeFiles(child);
    }
    return total;
  }

  function walkPushDirPaths(node, out = []) {
    for (const child of node.dirs.values()) {
      if (child.path) {
        out.push(child.path);
      }
      walkPushDirPaths(child, out);
    }
    return out;
  }

  function createPushFolderIcon() {
    const el = document.createElement('span');
    el.className = 'push-dir-icon';
    el.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('fill', 'currentColor');
    pathEl.setAttribute(
      'd',
      'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.3 0 .6.1.8.3L8.2 3.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Z'
    );
    svg.appendChild(pathEl);
    el.appendChild(svg);
    return el;
  }

  function renderFileTree() {
    if (!fileTree || !noFileSelected) {
      return;
    }
    fileTree.innerHTML = '';
    const files = commitDetails?.files || [];
    if (!files.length) {
      noFileSelected.textContent = 'No changed files in this commit';
      noFileSelected.classList.remove('hidden');
      return;
    }
    noFileSelected.classList.add('hidden');

    const tree = buildPushDirTree(files);
    compactPushDirTree(tree);
    const repoName = commitDetails.repoName || 'repository';
    const total = files.length;

    // Root module-like header (IDEA shows project root + count).
    const rootHead = document.createElement('div');
    rootHead.className = 'push-dir-group-title';
    rootHead.style.setProperty('--tree-depth', '0');
    rootHead.appendChild(createPushFolderIcon());
    const rootName = document.createElement('span');
    rootName.className = 'push-dir-name';
    rootName.textContent = repoName;
    const rootCount = document.createElement('span');
    rootCount.className = 'push-dir-count';
    rootCount.textContent = `${total} ${total === 1 ? 'file' : 'files'}`;
    rootHead.appendChild(rootName);
    rootHead.appendChild(rootCount);
    fileTree.appendChild(rootHead);

    function appendNode(parentEl, node, depth) {
      const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
      for (const dirName of dirNames) {
        parentEl.appendChild(renderDir(node.dirs.get(dirName), depth));
      }
      const fileItems = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
      for (const item of fileItems) {
        parentEl.appendChild(renderFile(item, depth));
      }
    }

    function renderDir(dirNode, depth) {
      const wrap = document.createElement('div');
      wrap.className = 'push-dir-group';
      const collapsed = collapsedFileDirs.has(dirNode.path);
      const fileCount = countPushTreeFiles(dirNode);

      const head = document.createElement('div');
      head.className = 'push-dir-group-title';
      head.style.setProperty('--tree-depth', String(depth));

      const chevron = document.createElement('span');
      chevron.className = 'push-dir-chevron';
      chevron.textContent = collapsed ? '▸' : '▾';

      const name = document.createElement('span');
      name.className = 'push-dir-name';
      name.textContent = dirNode.name;

      const count = document.createElement('span');
      count.className = 'push-dir-count';
      count.textContent = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;

      head.appendChild(chevron);
      head.appendChild(createPushFolderIcon());
      head.appendChild(name);
      head.appendChild(count);
      head.addEventListener('click', () => {
        if (collapsedFileDirs.has(dirNode.path)) {
          collapsedFileDirs.delete(dirNode.path);
        } else {
          collapsedFileDirs.add(dirNode.path);
        }
        renderFileTree();
      });
      wrap.appendChild(head);

      if (!collapsed) {
        const children = document.createElement('div');
        appendNode(children, dirNode, depth + 1);
        wrap.appendChild(children);
      }
      return wrap;
    }

    function renderFile(item, depth) {
      const row = document.createElement('div');
      row.className = 'push-file-row' + (selectedFilePath === item.path ? ' selected' : '');
      row.style.setProperty('--tree-depth', String(depth));
      const statusLetter = item.status || 'M';
      row.title = `${item.path} (${statusLetter})`;

      const iconSpec = resolvePushFileIcon(item.path);
      const icon = document.createElement('span');
      icon.className = 'push-file-type-icon' + (iconSpec.label.length > 2 ? ' wide' : iconSpec.label.length > 1 ? ' mid' : '');
      icon.style.color = iconSpec.color;
      icon.textContent = iconSpec.label;

      const name = document.createElement('span');
      name.className = 'push-file-name';
      name.textContent = splitPushPath(item.path).name;

      row.appendChild(icon);
      row.appendChild(name);
      row.addEventListener('click', () => {
        selectedFilePath = item.path;
        renderFileTree();
      });
      row.addEventListener('dblclick', () => {
        selectedFilePath = item.path;
        renderFileTree();
        if (commitDetails?.hash && commitDetails?.repoRoot) {
          post({
            type: 'openCommitFileDiff',
            repoRoot: commitDetails.repoRoot,
            hash: commitDetails.hash,
            path: item.path,
          });
        }
      });
      return row;
    }

    appendNode(fileTree, tree, 1);
  }

  function expandAllFileDirs() {
    collapsedFileDirs = new Set();
    renderFileTree();
  }

  function collapseAllFileDirs() {
    if (!commitDetails?.files?.length) {
      return;
    }
    const tree = buildPushDirTree(commitDetails.files);
    compactPushDirTree(tree);
    collapsedFileDirs = new Set(walkPushDirPaths(tree));
    renderFileTree();
  }

  function findTargetByKey(key) {
    if (!key) {
      return null;
    }
    return payload.targets.find((t) => t.repoRoot.replace(/\\/g, '/').toLowerCase() === key);
  }

  function updateTitle() {
    if (modalState === 'confirm') {
      const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
      dialogTitle.textContent = target?.repoName
        ? `Push Commits to ${target.repoName}`
        : 'Push Commits';
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
    const prevCommit = selectedCommitHash;
    payload = data;
    const targetKeys = new Set(data.targets.map((target) => normalizeRepoRoot(target.repoRoot)));
    if (!targetSelectionInitialized || data.pendingRepoRoots?.length) {
      checkedRoots = defaultCheckedRoots();
      targetSelectionInitialized = true;
    } else {
      checkedRoots = new Set([...checkedRoots].filter((key) => targetKeys.has(key)));
    }
    const activeKey = normalizeRepoRoot(data.activeRepoRoot || data.targets[0]?.repoRoot || '');
    if (prevSelected && targetKeys.has(prevSelected) && checkedRoots.has(prevSelected)) {
      selectedTargetRoot = prevSelected;
    } else {
      selectedTargetRoot = checkedRoots.has(activeKey)
        ? activeKey
        : [...checkedRoots][0] || activeKey || null;
    }
    if (prevSelected !== selectedTargetRoot) {
      selectedCommitHash = null;
      commitDetails = null;
      pendingDetailsKey = null;
    } else {
      selectedCommitHash = prevCommit;
    }
    pushRepoRoot = findTargetByKey(selectedTargetRoot)?.repoRoot || data.targets[0]?.repoRoot || null;
    conflictItems = [];
    selectedConflictPath = null;
    rejectedPayload = null;
    syncPreviewPayload = null;

    mainView.classList.remove('hidden');
    altView.classList.add('hidden');
    statusBanner.classList.add('hidden');
    statusBanner.textContent = '';
    if (altSplitPane) {
      altSplitPane.classList.add('hidden');
    }

    updateTitle();
    renderTargets();
    renderBranchMapping();
    renderCommits();
    autoSelectFirstCommit();
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
  if (expandFilesBtn) {
    expandFilesBtn.addEventListener('click', expandAllFileDirs);
  }
  if (collapseFilesBtn) {
    collapseFilesBtn.addEventListener('click', collapseAllFileDirs);
  }
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
    if (modalState === 'askPush') {
      post({ type: 'askPushConfirm', repoRoot: pushRepoRoot || undefined, pushTags: isPushTagsChecked() });
      return;
    }
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
      case 'openNewTag': {
        const roots =
          msg.repoRoots?.length
            ? msg.repoRoots
            : getCheckedRepoRoots().length
              ? getCheckedRepoRoots()
              : payload.targets.map((t) => t.repoRoot);
        if (!roots.length) {
          showFooterError('Select at least one branch to tag.');
          break;
        }
        // Ensure targets for these roots are checked so Create applies to them.
        targetSelectionInitialized = true;
        checkedRoots = new Set(roots.map(normalizeRepoRoot));
        renderTargets();
        if (pushTagsCheckbox) {
          pushTagsCheckbox.checked = true;
          savePushTagsPreference();
        }
        openNewTagModal(roots);
        break;
      }
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
      case 'previousRemoteTags':
        if (!newTagOpen || msg.requestId !== previousTagRequestId) {
          break;
        }
        applyPreviousRemoteTagsToRows(msg.items || []);
        break;
      case 'showRejected': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        syncPreviewPayload = null;
        rejectedPayload = p;
        if (mergeBtn) {
          mergeBtn.textContent = 'Merge';
          mergeBtn.classList.add('primary');
          mergeBtn.disabled = false;
        }
        showSplitAltView(
          'Push Rejected',
          formatRejectedBanner(p),
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
        rejectedPayload = null;
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
        rejectedPayload = null;
        syncPreviewPayload = null;
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
        rejectedPayload = null;
        syncPreviewPayload = null;
        const behindLine = typeof p.behind === 'number' ? `\nBehind: ${p.behind}` : '';
        showBannerAltView(
          'Push?',
          `${p.summary}\n\nRepository: ${p.repoName}\nBranch: ${p.branch || '(detached)'}\nUpstream: ${p.upstream || '(none)'}\nAhead: ${typeof p.ahead === 'number' ? p.ahead : '?'}${behindLine}`,
          'askPush',
          ['laterBtn', 'pushBtn'],
          true,
          false
        );
        break;
      }
      case 'commitDetails': {
        const details = msg.payload;
        if (!details?.hash || !selectedCommitHash) {
          break;
        }
        if (!sameCommitHash(details.hash, selectedCommitHash) && !sameCommitHash(details.shortHash, selectedCommitHash)) {
          break;
        }
        applyCommitDetails(details);
        break;
      }
      default:
        break;
    }
  });

  post({ type: 'ready' });
})();
