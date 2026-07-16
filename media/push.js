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
  const conflictList = document.getElementById('conflictList');
  const pushTagsCheckbox = document.getElementById('pushTagsCheckbox');
  const pushTagsOption = document.getElementById('pushTagsOption');
  const cancelBtn = document.getElementById('cancelBtn');
  const pushBtn = document.getElementById('pushBtn');
  const mergeBtn = document.getElementById('mergeBtn');
  const rebaseBtn = document.getElementById('rebaseBtn');
  const abortBtn = document.getElementById('abortBtn');
  const continueBtn = document.getElementById('continueBtn');
  const laterBtn = document.getElementById('laterBtn');
  const closeBtn = document.getElementById('closeBtn');

  let payload = { targets: [], activeRepoRoot: '', pendingRepoRoots: [] };
  let modalState = 'confirm';
  let selectedTargetRoot = null;
  let selectedCommitHash = null;
  let checkedRoots = new Set();
  let pushRepoRoot = null;

  function post(message) {
    vscode.postMessage(message);
  }

  function setBusy(busy) {
    document.body.classList.toggle('busy', !!busy);
    [cancelBtn, pushBtn, mergeBtn, rebaseBtn, abortBtn, continueBtn, laterBtn].forEach((btn) => {
      if (btn) {
        btn.disabled = !!busy;
      }
    });
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
    if (pushTagsOption) {
      pushTagsOption.classList.toggle('hidden', !visible);
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

  function findTarget(repoRoot) {
    return payload.targets.find(
      (t) => String(t.repoRoot).replace(/\\/g, '/').toLowerCase() === String(repoRoot || '').replace(/\\/g, '/').toLowerCase()
    );
  }

  function defaultCheckedRoots() {
    if (payload.pendingRepoRoots?.length) {
      return new Set(payload.pendingRepoRoots.map((r) => r.replace(/\\/g, '/').toLowerCase()));
    }
    const active = payload.activeRepoRoot || payload.targets[0]?.repoRoot;
    if (active) {
      return new Set([String(active).replace(/\\/g, '/').toLowerCase()]);
    }
    return new Set(payload.targets.map((t) => t.repoRoot.replace(/\\/g, '/').toLowerCase()));
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
      const key = target.repoRoot.replace(/\\/g, '/').toLowerCase();
      const row = document.createElement('div');
      row.className = 'target-item' + (selectedTargetRoot === key ? ' selected' : '');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checkedRoots.has(key);
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          checkedRoots.add(key);
        } else {
          checkedRoots.delete(key);
        }
      });

      const label = document.createElement('span');
      label.className = 'target-label';
      label.textContent = target.label;
      label.title = target.label;

      row.appendChild(checkbox);
      row.appendChild(label);
      row.addEventListener('click', () => {
        selectedTargetRoot = key;
        selectedCommitHash = null;
        post({ type: 'selectTarget', repoRoot: target.repoRoot });
        renderTargets();
        renderCommits();
      });
      targetList.appendChild(row);
    });
  }

  function renderCommits() {
    commitList.innerHTML = '';
    const target = findTargetByKey(selectedTargetRoot) || payload.targets[0];
    const commits = target?.commits || [];

    if (!target || !commits.length) {
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
    } else if (modalState === 'conflict') {
      dialogTitle.textContent = 'Merge / Rebase Conflicts';
    } else if (modalState === 'askPush') {
      dialogTitle.textContent = 'Push?';
    }
  }

  function showConfirmView(data) {
    modalState = 'confirm';
    payload = data;
    checkedRoots = defaultCheckedRoots();
    const activeKey = (data.activeRepoRoot || data.targets[0]?.repoRoot || '').replace(/\\/g, '/').toLowerCase();
    selectedTargetRoot = checkedRoots.has(activeKey) ? activeKey : [...checkedRoots][0] || activeKey || null;
    selectedCommitHash = null;
    pushRepoRoot = findTargetByKey(selectedTargetRoot)?.repoRoot || data.targets[0]?.repoRoot || null;

    mainView.classList.remove('hidden');
    altView.classList.add('hidden');
    statusBanner.classList.add('hidden');
    statusBanner.textContent = '';

    updateTitle();
    renderTargets();
    renderCommits();
    applyPushTagsPreference();
    setTagsVisible(true);
    setFooterActions(['cancelBtn', 'pushBtn']);
  }

  function showAltView(title, message, conflicts, state, footerIds, showTags) {
    modalState = state;
    dialogTitle.textContent = title;
    mainView.classList.add('hidden');
    altView.classList.remove('hidden');
    statusBanner.classList.remove('hidden');
    statusBanner.textContent = message;
    statusBanner.classList.toggle('error', state === 'rejected');
    renderConflictList(conflicts || []);
    setTagsVisible(!!showTags);
    setFooterActions(footerIds);
  }

  function renderConflictList(conflicts) {
    conflictList.innerHTML = '';
    if (!conflicts.length) {
      conflictList.classList.add('hidden');
      return;
    }
    conflictList.classList.remove('hidden');
    conflicts.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'conflict-item';
      li.title = 'Open in VS Code merge editor';
      const status = document.createElement('span');
      status.className = 'conflict-status';
      status.textContent = item.status || 'C';
      const name = document.createElement('span');
      name.className = 'conflict-path';
      name.textContent = item.path;
      li.appendChild(status);
      li.appendChild(name);
      li.addEventListener('click', () =>
        post({ type: 'openConflict', path: item.path, repoRoot: pushRepoRoot || undefined })
      );
      conflictList.appendChild(li);
    });
  }

  function getCheckedRepoRoots() {
    return payload.targets
      .filter((t) => checkedRoots.has(t.repoRoot.replace(/\\/g, '/').toLowerCase()))
      .map((t) => t.repoRoot);
  }

  cancelBtn.addEventListener('click', () => post({ type: 'cancel' }));
  closeBtn.addEventListener('click', () => post({ type: 'cancel' }));
  pushBtn.addEventListener('click', () => {
    const roots = getCheckedRepoRoots();
    if (!roots.length) {
      statusBanner.classList.remove('hidden');
      statusBanner.textContent = 'Select at least one branch to push.';
      statusBanner.classList.add('error');
      return;
    }
    post({ type: 'push', repoRoots: roots, pushTags: isPushTagsChecked() });
  });
  mergeBtn.addEventListener('click', () => post({ type: 'pushSync', mode: 'merge', repoRoot: pushRepoRoot || undefined }));
  rebaseBtn.addEventListener('click', () => post({ type: 'pushSync', mode: 'rebase', repoRoot: pushRepoRoot || undefined }));
  abortBtn.addEventListener('click', () => post({ type: 'syncAbort', repoRoot: pushRepoRoot || undefined }));
  continueBtn.addEventListener('click', () => post({ type: 'syncContinue', repoRoot: pushRepoRoot || undefined }));
  laterBtn.addEventListener('click', () => {
    post({ type: 'askPushCancel' });
    post({ type: 'cancel' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
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
        setBusy(msg.busy);
        break;
      case 'error':
        statusBanner.classList.remove('hidden');
        statusBanner.textContent = msg.message;
        statusBanner.classList.add('error');
        break;
      case 'showRejected': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        const behind =
          typeof p.behind === 'number'
            ? `Behind remote: ${p.behind}`
            : 'Remote has commits you do not have locally.';
        showAltView(
          'Push Rejected',
          `${p.message}\n\nRepository: ${p.repoName}\nBranch: ${p.branch || '(detached)'}\nUpstream: ${p.upstream || '(none)'}\n${behind}\n\nChoose Merge or Rebase to sync with remote, then Push.`,
          [],
          'rejected',
          ['cancelBtn', 'mergeBtn', 'rebaseBtn'],
          false
        );
        break;
      }
      case 'showSyncConflict': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        showAltView(
          `${p.mode === 'rebase' ? 'Rebase' : 'Merge'} Conflicts`,
          `${p.message}\n\nClick conflict files below to resolve in VS Code merge editor. When all are resolved, click Continue; or Abort to cancel.`,
          p.conflicts || [],
          'conflict',
          ['abortBtn', 'continueBtn'],
          false
        );
        break;
      }
      case 'showAskPush': {
        const p = msg.payload;
        pushRepoRoot = p.repoRoot || pushRepoRoot;
        const behindLine = typeof p.behind === 'number' ? `\nBehind: ${p.behind}` : '';
        showAltView(
          'Push?',
          `${p.summary}\n\nRepository: ${p.repoName}\nBranch: ${p.branch || '(detached)'}\nUpstream: ${p.upstream || '(none)'}\nAhead: ${typeof p.ahead === 'number' ? p.ahead : '?'}${behindLine}`,
          [],
          'askPush',
          ['laterBtn', 'pushBtn'],
          true
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
