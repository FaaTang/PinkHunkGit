(function () {
  const vscode = acquireVsCodeApi();

  const banner = document.getElementById('banner');
  const panelLoadingOverlay = document.getElementById('panelLoadingOverlay');
  const panelLoadingTitle = document.getElementById('panelLoadingTitle');
  const panelLoadingProgress = document.getElementById('panelLoadingProgress');
  const panelLoadingBar = document.getElementById('panelLoadingBar');
  const panelLoadingBarFill = document.getElementById('panelLoadingBarFill');
  const repoBar = document.getElementById('repoBar');
  const repoSelect = document.getElementById('repoSelect');
  const fileList = document.getElementById('fileList');
  const messageEl = document.getElementById('message');
  const messageResizeEl = document.getElementById('messageResize');
  const messageFieldEl = messageEl ? messageEl.closest('.message-field') : null;
  const generateMsgBtn = document.getElementById('generateMsgBtn');
  const generateMsgSettingsBtn = document.getElementById('generateMsgSettingsBtn');
  const formError = document.getElementById('formError');
  const commitBtn = document.getElementById('commitBtn');
  const commitPushBtn = document.getElementById('commitPushBtn');
  const commitPushSplit = document.getElementById('commitPushSplit');
  const commitPushMenuBtn = document.getElementById('commitPushMenuBtn');
  const commitPushMenu = document.getElementById('commitPushMenu');
  const fastPushBtn = document.getElementById('fastPushBtn');
  const fastPushSettingsBtn = document.getElementById('fastPushSettingsBtn');
  const fastPushSettingsModal = document.getElementById('fastPushSettingsModal');
  const fastPushSettingsCancel = document.getElementById('fastPushSettingsCancel');
  const fastPushSettingsSave = document.getElementById('fastPushSettingsSave');
  const fastPushCommitModal = document.getElementById('fastPushCommitModal');
  const fastPushCommitReason = document.getElementById('fastPushCommitReason');
  const fastPushCommitInput = document.getElementById('fastPushCommitInput');
  const fastPushCommitError = document.getElementById('fastPushCommitError');
  const fastPushCommitCancel = document.getElementById('fastPushCommitCancel');
  const fastPushCommitConfirm = document.getElementById('fastPushCommitConfirm');
  const fastPushConfirmModal = document.getElementById('fastPushConfirmModal');
  const fastPushConfirmSummary = document.getElementById('fastPushConfirmSummary');
  const fastPushConfirmSteps = document.getElementById('fastPushConfirmSteps');
  const fastPushConfirmHint = document.getElementById('fastPushConfirmHint');
  const fastPushConfirmCancel = document.getElementById('fastPushConfirmCancel');
  const fastPushConfirmOk = document.getElementById('fastPushConfirmOk');
  const fpWsGenerate = document.getElementById('fpWsGenerate');
  const fpGlGenerate = document.getElementById('fpGlGenerate');
  const fpWsTag = document.getElementById('fpWsTag');
  const fpGlTag = document.getElementById('fpGlTag');
  const fpWsPush = document.getElementById('fpWsPush');
  const fpGlPush = document.getElementById('fpGlPush');
  const fpGenerateRow = document.getElementById('fpGenerateRow');
  const fpGenerateUnavailable = document.getElementById('fpGenerateUnavailable');
  const commitMsgPrefixModal = document.getElementById('commitMsgPrefixModal');
  const commitMsgPrefixCancel = document.getElementById('commitMsgPrefixCancel');
  const commitMsgPrefixClearGlobal = document.getElementById('commitMsgPrefixClearGlobal');
  const commitMsgPrefixSave = document.getElementById('commitMsgPrefixSave');
  const cmpPrefixInput = document.getElementById('cmpPrefixInput');
  const cmpPromptInput = document.getElementById('cmpPromptInput');
  const cmpWsPromptEnabled = document.getElementById('cmpWsPromptEnabled');
  const cmpGlPromptEnabled = document.getElementById('cmpGlPromptEnabled');
  const cmpWsEnabled = document.getElementById('cmpWsEnabled');
  const cmpGlEnabled = document.getElementById('cmpGlEnabled');
  const stageAllBtn = document.getElementById('stageAll');
  const unstageAllBtn = document.getElementById('unstageAll');
  const refreshBtn = document.getElementById('refreshBtn');
  const locateBtn = document.getElementById('locateBtn');
  const installKeysBtn = document.getElementById('installKeysBtn');
  const expandAllBtn = document.getElementById('expandAllBtn');
  const collapseAllBtn = document.getElementById('collapseAllBtn');
  const viewOptionsBtn = document.getElementById('viewOptionsBtn');
  const viewOptionsMenu = document.getElementById('viewOptionsMenu');
  const groupByDirectoryChk = document.getElementById('groupByDirectoryChk');
  const groupByModuleChk = document.getElementById('groupByModuleChk');
  const showIgnoredFilesChk = document.getElementById('showIgnoredFilesChk');
  const commitForm = document.getElementById('commitForm');
  const commitFormToggle = document.getElementById('commitFormToggle');
  const rollbackModal = document.getElementById('rollbackModal');
  const rollbackTitle = document.getElementById('rollbackTitle');
  const rollbackSummary = document.getElementById('rollbackSummary');
  const rollbackCancelBtn = document.getElementById('rollbackCancel');
  const rollbackConfirmBtn = document.getElementById('rollbackConfirm');
  const expandCollapseAllModal = document.getElementById('expandCollapseAllModal');
  const expandCollapseAllTitle = document.getElementById('expandCollapseAllTitle');
  const expandCollapseAllSummary = document.getElementById('expandCollapseAllSummary');
  const expandCollapseAllCancel = document.getElementById('expandCollapseAllCancel');
  const expandCollapseAllConfirm = document.getElementById('expandCollapseAllConfirm');
  const keysModal = document.getElementById('keysModal');
  const keysCancel = document.getElementById('keysCancel');
  const keysConfirm = document.getElementById('keysConfirm');
  const updateAllModal = document.getElementById('updateAllModal');
  const updateAllSummary = document.getElementById('updateAllSummary');
  const updateAllRepoList = document.getElementById('updateAllRepoList');
  const updateAllHint = document.getElementById('updateAllHint');
  const updateAllCancel = document.getElementById('updateAllCancel');
  const updateAllConfirmBtn = document.getElementById('updateAllConfirm');
  const contextMenu = document.getElementById('contextMenu');
  const commitLogPane = document.getElementById('commitLogPane');
  const commitLogToggle = document.getElementById('commitLogToggle');
  const commitLogRepo = document.getElementById('commitLogRepo');
  const commitLogRefresh = document.getElementById('commitLogRefresh');
  const commitLogList = document.getElementById('commitLogList');
  const commitLogTip = document.getElementById('commitLogTip');
  const commitLogTipBody = document.getElementById('commitLogTipBody');
  const commitLogTipCopy = document.getElementById('commitLogTipCopy');

  const webviewState = vscode.getState() || {};
  let generatingMessage = false;
  let fastPushSettings = {
    workspace: { autoGenerateCommit: true, autoNewTag: false, autoPush: true },
    global: { autoGenerateCommit: true, autoNewTag: false, autoPush: true },
    workspaceConfigured: false,
    effective: { autoGenerateCommit: true, autoNewTag: false, autoPush: true },
    autoGenerateCommitCapability: { available: true },
  };
  let commitMessagePrefixSettings = {
    workspace: { enabled: false, prefix: '', promptEnabled: false, prompt: '' },
    global: { enabled: false, prefix: '', promptEnabled: false, prompt: '' },
    workspaceConfigured: false,
    effective: { enabled: false, prefix: '', promptEnabled: false, prompt: '' },
  };
  let commitLogExpanded = webviewState.commitLogExpanded === true;
  let commitLogRepoRoot = webviewState.commitLogRepoRoot || '';
  let commitLogLoading = false;
  /** Repo root currently being fetched for commit log (dedupe in-flight requests). */
  let commitLogPendingRoot = '';
  /** Full messages keyed by commit hash (dataset cannot reliably hold multiline text). */
  const commitLogMessageByHash = new Map();
  let commitLogTipHideTimer = undefined;
  let commitLogTipMessage = '';
  let commitLogTipHash = '';
  let commitLogTipRepoRoot = '';
  let commitLogTipPinned = false;
  let commitFormExpanded = webviewState.commitFormExpanded === true;
  let groupByDirectory = webviewState.groupByDirectory === true;
  // IDEA-style: show every Git repo header, including empty 0/0 modules.
  let groupByModule = webviewState.groupByModule !== false;
  let showIgnoredFiles = webviewState.showIgnoredFiles !== false;
  let workspace = {
    ok: true,
    repositories: [],
    active: { ok: true, rootPath: '', name: '', staged: [], unstaged: [], unversioned: [] },
    activeRepoRoot: '',
    busy: false,
  };
  const collapsedGroups = new Set(webviewState.collapsedGroups || []);
  /**
   * Repo/folder keys we have already applied a default for.
   * New keys (e.g. after enabling Module / Directory / Ignored) start collapsed.
   */
  const seenStructureKeys = new Set(webviewState.seenStructureKeys || []);
  /** Repo-dimension defaults applied (categories stay expanded). */
  let repoCollapseDefaultsSeeded = webviewState.repoCollapseDefaultsSeeded === true;
  let pendingExpandCollapseAction = null;
  /**
   * IDEA-style repo color palette.
   * Prefer hash → index; collisions among currently visible repos are resolved
   * so each rootPath gets a distinct color in the same workspace snapshot.
   */
  const REPO_COLORS = [
    '#8b4049', // rose
    '#3d6b4f', // forest
    '#4a6082', // slate blue
    '#6b4c8b', // purple
    '#8b6914', // amber
    '#3d6b6b', // teal
    '#6b523d', // brown
    '#4a6b3d', // olive
    '#8b4557', // cranberry
    '#2f6b7a', // cyan-steel
    '#7a5a2f', // bronze
    '#5a4a8b', // indigo
    '#6b3d5a', // plum
    '#3d5a6b', // steel
    '#7a6b2f', // mustard
    '#2f7a4a', // emerald
  ];
  /** rootPath key → assigned hex/hsl; rebuilt on each files render. */
  let repoColorByKey = new Map();
  const checkedUnversioned = new Set(webviewState.checkedUnversioned || []);
  const changeIncludeState = new Map(Object.entries(webviewState.changeIncludeState || {}));
  let lastCommitMessage = webviewState.lastCommitMessage || '';
  let messageDraft = webviewState.messageDraft || '';
  let messageDraftInitialized = false;
  /** Row focus selection (supports multi-select via Shift/Ctrl). */
  let selectedFiles = [];
  /** Anchor for Shift+click range selection within one group. */
  let selectionAnchor = null;
  /** Selected Changes / Unversioned group header (or repo module header). */
  let selectedGroup = null;
  /** Selected directory folder when Group by Directory is on. */
  let selectedDir = null;
  let lastActiveRepoRoot = '';
  let pendingRollback = null;

  const DOUBLE_CLICK_MS = 500;
  let pointerTracker = { key: '', time: 0 };
  let suppressPointerFollowUpUntil = 0;

  /** Second mousedown within DOUBLE_CLICK_MS (earlier than click; works in VS Code webview). */
  function consumePointerDouble(key) {
    const now = performance.now();
    const isDouble = key === pointerTracker.key && now - pointerTracker.time <= DOUBLE_CLICK_MS;
    if (isDouble) {
      pointerTracker = { key: '', time: 0 };
      suppressPointerFollowUpUntil = now + 300;
      return true;
    }
    pointerTracker = { key, time: now };
    return false;
  }

  function shouldSuppressPointerFollowUp() {
    return performance.now() < suppressPointerFollowUpUntil;
  }

  function markPointerFollowUpSuppressed() {
    suppressPointerFollowUpUntil = performance.now() + 300;
  }

  function openFileDiff(entry, groupId, indexInGroup) {
    clearGroupSelection();
    selectedFiles = [entry];
    selectionAnchor = { repoRoot: entry.repoRoot, groupId, index: indexInGroup };
    syncSelectionToHost();
    applyFileListSelectionVisuals();
    post({ type: 'openDiff', repoRoot: entry.repoRoot, path: entry.path, staged: entry.staged });
  }

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

  function totalIncludableCount() {
    return collectCheckedChangesPaths().length + collectCheckedUnversionedPaths().length;
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

  function hashRepoKey(s) {
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function colorForIndex(index) {
    if (index < REPO_COLORS.length) {
      return REPO_COLORS[index];
    }
    // Past the fixed palette: golden-angle hues stay visually distinct.
    const hue = Math.round((index * 137.508) % 360);
    return `hsl(${hue} 48% 45%)`;
  }

  /**
   * Assign a unique color to every currently visible repository.
   * Preferred slot = hash(root) % slotCount; if taken, probe the next free slot.
   * Same repo set → stable colors; colliding paths (e.g. PinkHunkGit / PinkHunkDB)
   * no longer share one swatch.
   */
  function rebuildRepoColors() {
    const keys = [
      ...new Set(
        allRepos()
          .map((r) => repoKey(r && r.rootPath))
          .filter(Boolean)
      ),
    ].sort();
    const slotCount = Math.max(REPO_COLORS.length, keys.length);
    const used = new Set();
    const map = new Map();

    for (const key of keys) {
      const preferred = hashRepoKey(key) % slotCount;
      let assigned = preferred;
      for (let probe = 0; probe < slotCount; probe += 1) {
        const tryIdx = (preferred + probe) % slotCount;
        if (!used.has(tryIdx)) {
          assigned = tryIdx;
          break;
        }
      }
      used.add(assigned);
      map.set(key, colorForIndex(assigned));
    }

    repoColorByKey = map;
  }

  function repoColor(root) {
    const key = repoKey(root);
    if (repoColorByKey.has(key)) {
      return repoColorByKey.get(key);
    }
    return colorForIndex(hashRepoKey(key) % REPO_COLORS.length);
  }

  function categoryCollapseKey(groupId) {
    return 'category:' + groupId;
  }

  function repoCollapseKey(groupId, root) {
    return 'repo:' + groupId + ':' + repoKey(root);
  }

  function dirCollapseKey(groupId, root, dirPath) {
    return 'dir:' + groupId + ':' + repoKey(root) + ':' + dirPath;
  }

  function toggleCategoryCollapsed(groupId) {
    const key = categoryCollapseKey(groupId);
    if (collapsedGroups.has(key)) {
      collapsedGroups.delete(key);
    } else {
      collapsedGroups.add(key);
    }
    saveCollapsedGroups();
    renderFiles();
  }

  function toggleRepoInCategoryCollapsed(groupId, root) {
    const key = repoCollapseKey(groupId, root);
    if (collapsedGroups.has(key)) {
      collapsedGroups.delete(key);
    } else {
      collapsedGroups.add(key);
    }
    saveCollapsedGroups();
    renderFiles();
  }

  function toggleDirCollapsed(groupId, root, dirPath) {
    const key = dirCollapseKey(groupId, root, dirPath);
    if (collapsedGroups.has(key)) {
      collapsedGroups.delete(key);
    } else {
      collapsedGroups.add(key);
    }
    saveCollapsedGroups();
    renderFiles();
  }

  function saveCollapsedGroups() {
    saveWebviewState({
      collapsedGroups: Array.from(collapsedGroups),
      seenStructureKeys: Array.from(seenStructureKeys),
      repoCollapseDefaultsSeeded,
    });
  }

  function categoryGroupIds() {
    return showIgnoredFiles ? ['changes', 'unversioned', 'ignored'] : ['changes', 'unversioned'];
  }

  function itemsForCollapseKey(repo, groupId) {
    if (groupId === 'unversioned') {
      return getUnversioned(repo);
    }
    if (groupId === 'ignored') {
      return getIgnored(repo);
    }
    return getMergedChanges(repo);
  }

  /** Repo + folder keys only (not Changes / Unversioned category headers). */
  function collectRepoDimensionCollapseKeys() {
    const keys = [];
    for (const groupId of categoryGroupIds()) {
      for (const repo of allRepos()) {
        if (groupByModule) {
          keys.push(repoCollapseKey(groupId, repo.rootPath));
        }
        if (!groupByDirectory) {
          continue;
        }
        const items = itemsForCollapseKey(repo, groupId);
        if (!items.length) {
          continue;
        }
        const tree = buildDirTree(items);
        compactDirTree(tree);
        for (const dirPath of walkDirPaths(tree)) {
          keys.push(dirCollapseKey(groupId, repo.rootPath, dirPath));
        }
      }
    }
    return keys;
  }

  /**
   * Default collapse is per repository / folder.
   * Categories stay expanded so module rows remain visible.
   * Newly appeared repo/folder keys (View Options) are collapsed once.
   */
  function syncRepoDimensionCollapseDefaults() {
    if (!allRepos().length) {
      return;
    }
    let changed = false;
    if (!repoCollapseDefaultsSeeded) {
      for (const key of [...collapsedGroups]) {
        if (key.startsWith('category:')) {
          collapsedGroups.delete(key);
          changed = true;
        }
      }
      for (const key of collectRepoDimensionCollapseKeys()) {
        seenStructureKeys.add(key);
        if (!collapsedGroups.has(key)) {
          collapsedGroups.add(key);
          changed = true;
        }
      }
      repoCollapseDefaultsSeeded = true;
      changed = true;
    } else {
      for (const key of collectRepoDimensionCollapseKeys()) {
        if (seenStructureKeys.has(key)) {
          continue;
        }
        seenStructureKeys.add(key);
        if (!collapsedGroups.has(key)) {
          collapsedGroups.add(key);
          changed = true;
        }
      }
    }
    if (changed) {
      saveCollapsedGroups();
    }
  }

  function parentDirPaths(dirPath) {
    const parts = String(dirPath || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
    const out = [];
    for (let i = 1; i < parts.length; i += 1) {
      out.push(parts.slice(0, i).join('/'));
    }
    return out;
  }

  function collectDirCollapseKeys(groupId, repoRoot, rootDirPath) {
    const keys = [];
    const repo = findRepo(repoRoot);
    if (!repo) {
      keys.push(dirCollapseKey(groupId, repoRoot, rootDirPath));
      return keys;
    }
    const items = itemsForCollapseKey(repo, groupId);
    if (!items.length) {
      keys.push(dirCollapseKey(groupId, repoRoot, rootDirPath));
      return keys;
    }
    const tree = buildDirTree(items);
    compactDirTree(tree);
    const prefix = String(rootDirPath || '').replace(/\\/g, '/');
    for (const dirPath of walkDirPaths(tree)) {
      if (dirPath === prefix || dirPath.startsWith(`${prefix}/`)) {
        keys.push(dirCollapseKey(groupId, repoRoot, dirPath));
      }
    }
    if (!keys.length) {
      keys.push(dirCollapseKey(groupId, repoRoot, rootDirPath));
    }
    return keys;
  }

  function collectCollapseKeysForScope(scope) {
    if (!scope || scope.type === 'all') {
      return collectExpandableCollapseKeys();
    }
    if (scope.type === 'category') {
      const keys = [categoryCollapseKey(scope.groupId)];
      for (const repo of allRepos()) {
        if (groupByModule) {
          keys.push(repoCollapseKey(scope.groupId, repo.rootPath));
        }
        if (groupByDirectory) {
          const items = itemsForCollapseKey(repo, scope.groupId);
          if (!items.length) {
            continue;
          }
          const tree = buildDirTree(items);
          compactDirTree(tree);
          for (const dirPath of walkDirPaths(tree)) {
            keys.push(dirCollapseKey(scope.groupId, repo.rootPath, dirPath));
          }
        }
      }
      return keys;
    }
    if (scope.type === 'repo') {
      const keys = [repoCollapseKey(scope.groupId, scope.repoRoot)];
      if (groupByDirectory) {
        const repo = findRepo(scope.repoRoot);
        if (repo) {
          const items = itemsForCollapseKey(repo, scope.groupId);
          if (items.length) {
            const tree = buildDirTree(items);
            compactDirTree(tree);
            for (const dirPath of walkDirPaths(tree)) {
              keys.push(dirCollapseKey(scope.groupId, scope.repoRoot, dirPath));
            }
          }
        }
      }
      return keys;
    }
    if (scope.type === 'dir') {
      return collectDirCollapseKeys(scope.groupId, scope.repoRoot, scope.dirPath);
    }
    return collectExpandableCollapseKeys();
  }

  function expandAncestorKeysForScope(scope) {
    if (!scope || scope.type === 'all' || scope.type === 'category') {
      return;
    }
    if (scope.type === 'repo' || scope.type === 'dir') {
      collapsedGroups.delete(categoryCollapseKey(scope.groupId));
    }
    if (scope.type === 'dir') {
      if (groupByModule) {
        collapsedGroups.delete(repoCollapseKey(scope.groupId, scope.repoRoot));
      }
      for (const parent of parentDirPaths(scope.dirPath)) {
        collapsedGroups.delete(dirCollapseKey(scope.groupId, scope.repoRoot, parent));
      }
    }
  }

  function resolveExpandCollapseScope() {
    if (selectedGroup?.category) {
      return { type: 'category', groupId: selectedGroup.groupId };
    }
    if (selectedGroup && !selectedGroup.category && selectedGroup.repoRoot) {
      return {
        type: 'repo',
        groupId: selectedGroup.groupId,
        repoRoot: selectedGroup.repoRoot,
      };
    }
    if (selectedDir?.repoRoot && selectedDir.dirPath) {
      return {
        type: 'dir',
        groupId: selectedDir.groupId,
        repoRoot: selectedDir.repoRoot,
        dirPath: selectedDir.dirPath,
      };
    }
    return { type: 'all' };
  }

  function applyExpandCollapse(action, scope) {
    const keys = collectCollapseKeysForScope(scope);
    let changed = false;
    if (action === 'expand') {
      expandAncestorKeysForScope(scope);
      for (const key of keys) {
        if (collapsedGroups.has(key)) {
          collapsedGroups.delete(key);
          changed = true;
        }
      }
    } else {
      for (const key of keys) {
        if (!collapsedGroups.has(key)) {
          collapsedGroups.add(key);
          changed = true;
        }
      }
    }
    if (changed) {
      saveCollapsedGroups();
    }
    renderFiles();
  }

  function hideExpandCollapseAllModal() {
    pendingExpandCollapseAction = null;
    expandCollapseAllModal?.classList.add('hidden');
  }

  function showExpandCollapseAllModal(action) {
    pendingExpandCollapseAction = action;
    if (expandCollapseAllTitle) {
      expandCollapseAllTitle.textContent = action === 'expand' ? 'Expand All' : 'Collapse All';
    }
    if (expandCollapseAllSummary) {
      expandCollapseAllSummary.textContent =
        action === 'expand'
          ? 'No group, repository, or folder is selected. Expanding will apply to all files in the Commit panel. Continue?'
          : 'No group, repository, or folder is selected. Collapsing will apply to all files in the Commit panel. Continue?';
    }
    expandCollapseAllModal?.classList.remove('hidden');
  }

  function requestExpandCollapse(action) {
    const scope = resolveExpandCollapseScope();
    if (scope.type === 'all') {
      showExpandCollapseAllModal(action);
      return;
    }
    applyExpandCollapse(action, scope);
  }

  function unversionedCheckKey(repoRoot, path) {
    return `${repoKey(repoRoot)}|${path}`;
  }

  function isUnversionedChecked(repoRoot, path) {
    return checkedUnversioned.has(unversionedCheckKey(repoRoot, path));
  }

  function persistCheckedUnversioned() {
    saveWebviewState({ checkedUnversioned: Array.from(checkedUnversioned) });
  }

  function setUnversionedCheckedQuiet(repoRoot, path, checked) {
    const key = unversionedCheckKey(repoRoot, path);
    if (checked) {
      checkedUnversioned.add(key);
    } else {
      checkedUnversioned.delete(key);
    }
  }

  function toggleUnversionedChecked(repoRoot, path, checked) {
    setUnversionedCheckedQuiet(repoRoot, path, checked);
    persistCheckedUnversioned();
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
      persistCheckedUnversioned();
    }
  }

  /** Changes group: local include-in-commit state (IDEA-style; Git runs on commit). */
  function changeCheckKey(repoRoot, path) {
    return `${repoKey(repoRoot)}|${path}`;
  }

  function isChangeChecked(repoRoot, path) {
    const key = changeCheckKey(repoRoot, path);
    if (changeIncludeState.has(key)) {
      return changeIncludeState.get(key);
    }
    return true;
  }

  function persistChangeIncludeState() {
    saveWebviewState({ changeIncludeState: Object.fromEntries(changeIncludeState) });
  }

  function setChangeCheckedQuiet(repoRoot, path, checked) {
    changeIncludeState.set(changeCheckKey(repoRoot, path), checked);
  }

  function setChangeChecked(repoRoot, path, checked) {
    setChangeCheckedQuiet(repoRoot, path, checked);
    persistChangeIncludeState();
  }

  function pruneChangeIncludeState() {
    const valid = new Set();
    for (const repo of allRepos()) {
      for (const item of getMergedChanges(repo)) {
        valid.add(changeCheckKey(repo.rootPath, item.path));
      }
    }
    let changed = false;
    for (const key of changeIncludeState.keys()) {
      if (!valid.has(key)) {
        changeIncludeState.delete(key);
        changed = true;
      }
    }
    if (changed) {
      persistChangeIncludeState();
    }
  }

  function collectCheckedChangesPaths() {
    const paths = [];
    for (const repo of allRepos()) {
      for (const item of getMergedChanges(repo)) {
        if (isChangeChecked(repo.rootPath, item.path)) {
          paths.push({ repoRoot: repo.rootPath, path: item.path });
        }
      }
    }
    return paths;
  }

  function isSelectedUnversioned(sel) {
    const repo = findRepo(sel.repoRoot);
    if (!repo) {
      return false;
    }
    return getUnversioned(repo).some((i) => i.path === sel.path);
  }

  function isSelectedIgnored(sel) {
    const repo = findRepo(sel.repoRoot);
    if (!repo) {
      return false;
    }
    return getIgnored(repo).some((i) => i.path === sel.path);
  }

  function isAddableUntracked(sel) {
    return isSelectedUnversioned(sel) || isSelectedIgnored(sel);
  }

  function collectCheckedUnversionedPaths() {
    const paths = [];
    for (const repo of allRepos()) {
      for (const item of getUnversioned(repo)) {
        if (isUnversionedChecked(repo.rootPath, item.path)) {
          paths.push({ repoRoot: repo.rootPath, path: item.path });
        }
      }
      for (const item of getIgnored(repo)) {
        if (isUnversionedChecked(repo.rootPath, item.path)) {
          paths.push({ repoRoot: repo.rootPath, path: item.path });
        }
      }
    }
    return paths;
  }

  /** Items under a category/repo group (Changes / Unversioned / Ignored). */
  function itemsForGroupId(repo, groupId) {
    if (groupId === 'unversioned') {
      return getUnversioned(repo);
    }
    if (groupId === 'ignored') {
      return getIgnored(repo);
    }
    return getMergedChanges(repo);
  }

  /**
   * Resolve the current selection into concrete file targets.
   * Parent selection (category / module / directory) expands to all descendants.
   */
  function resolveOperationTargets() {
    if (selectedGroup) {
      if (selectedGroup.category) {
        const targets = [];
        for (const repo of allRepos()) {
          const items = itemsForGroupId(repo, selectedGroup.groupId);
          targets.push(
            ...targetsFromGroup(
              repo.rootPath,
              selectedGroup.groupId,
              items,
              selectedGroup.unversionedGroup
            )
          );
        }
        return targets;
      }
      const repo = findRepo(selectedGroup.repoRoot);
      if (!repo) {
        return [];
      }
      const items = itemsForGroupId(repo, selectedGroup.groupId);
      return targetsFromGroup(
        selectedGroup.repoRoot,
        selectedGroup.groupId,
        items,
        selectedGroup.unversionedGroup
      );
    }
    return selectedFiles.map((entry) => ({
      repoRoot: entry.repoRoot,
      path: entry.path,
      staged: entry.staged ?? false,
      unversionedGroup: isAddableUntracked(entry),
    }));
  }

  function collectAddToGitPaths() {
    const paths = [];
    const seen = new Set();
    const pushPath = (repoRoot, path) => {
      const key = `${repoKey(repoRoot)}|${path}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      paths.push({ repoRoot, path });
    };
    for (const { repoRoot, path } of collectCheckedUnversionedPaths()) {
      pushPath(repoRoot, path);
    }
    for (const entry of resolveOperationTargets()) {
      if (!isAddableUntracked(entry)) {
        continue;
      }
      pushPath(entry.repoRoot, entry.path);
    }
    return paths;
  }

  function selectionEntryKey(entry) {
    return `${repoKey(entry.repoRoot)}|${entry.path}|${entry.staged ? '1' : '0'}`;
  }

  function isSameSelectionEntry(a, b) {
    return (
      a &&
      b &&
      a.repoRoot === b.repoRoot &&
      a.path === b.path &&
      a.staged === b.staged
    );
  }

  function isFileSelected(repoRoot, item, staged) {
    return selectedFiles.some((entry) => isSameSelectionEntry(entry, { repoRoot, path: item.path, staged }));
  }

  function getPrimarySelection() {
    return selectedFiles.length ? selectedFiles[selectedFiles.length - 1] : null;
  }

  function syncSelectionToHost() {
    const primary = getPrimarySelection();
    if (primary) {
      post({
        type: 'updateSelection',
        repoRoot: primary.repoRoot,
        path: primary.path,
        staged: primary.staged,
      });
      focusCommitLogRepo(primary.repoRoot, false);
      return;
    }
    if (selectedGroup) {
      post({
        type: 'updateSelection',
        repoRoot: selectedGroup.repoRoot || activeRepoRoot(),
        path: null,
        staged: false,
        groupSelection: true,
      });
      if (selectedGroup.repoRoot) {
        focusCommitLogRepo(selectedGroup.repoRoot, false);
      }
      return;
    }
    post({ type: 'updateSelection', repoRoot: activeRepoRoot(), path: null, staged: false });
  }

  function focusFileSelectionFromHost(repoRoot, filePath, staged) {
    if (!repoRoot || !filePath) {
      return;
    }
    const repo = findRepo(repoRoot);
    if (!repo) {
      return;
    }

    const tracked = getMergedChanges(repo);
    const trackedItem = tracked.find((item) => item.path === filePath);
    const unversioned = trackedItem ? [] : getUnversioned(repo);
    const unversionedItem = trackedItem ? null : unversioned.find((item) => item.path === filePath);
    if (!trackedItem && !unversionedItem) {
      return;
    }

    const groupId = trackedItem ? 'changes' : 'unversioned';
    const resolvedStaged = trackedItem ? !!staged : false;
    const items = trackedItem ? tracked : unversioned;
    const index = items.findIndex((item) => item.path === filePath);

    clearGroupSelection();
    selectedFiles = [{ repoRoot, path: filePath, staged: resolvedStaged }];
    selectionAnchor = { repoRoot, groupId, index: index >= 0 ? index : 0 };
    applyFileListSelectionVisuals();

    const target = fileList.querySelector(
      `.file-row[data-repo-root="${CSS.escape(repoRoot)}"][data-file-path="${CSS.escape(filePath)}"][data-file-staged="${resolvedStaged ? '1' : '0'}"]`
    );
    target?.scrollIntoView({ block: 'nearest' });
  }

  /** Fingerprint used to detect stale commit-log cache after commit / branch change. */
  function commitLogRepoFingerprint(repoRoot) {
    const repo = findRepo(repoRoot);
    if (!repo) {
      return '';
    }
    return `${repo.branch || ''}|${repo.ahead ?? ''}|${repo.behind ?? ''}`;
  }

  function isCommitLogFresh(repoRoot) {
    if (!commitLogList || !repoRoot) {
      return false;
    }
    if (repoKey(commitLogList.dataset.loadedRoot || '') !== repoKey(repoRoot)) {
      return false;
    }
    if ((commitLogList.dataset.fingerprint || '') !== commitLogRepoFingerprint(repoRoot)) {
      return false;
    }
    return !!commitLogList.querySelector('.commit-log-row, .commit-log-empty');
  }

  function selectCommitLogRow(row) {
    if (!commitLogList || !row) {
      return;
    }
    for (const el of commitLogList.querySelectorAll('.commit-log-row.selected')) {
      el.classList.remove('selected');
    }
    row.classList.add('selected');
  }

  function focusCommitLogRepo(repoRoot, switchActive) {
    if (!repoRoot) {
      return;
    }
    const changed = repoKey(commitLogRepoRoot) !== repoKey(repoRoot);
    if (switchActive && changed) {
      post({ type: 'switchRepo', repoRoot });
    }
    commitLogRepoRoot = repoRoot;
    saveWebviewState({ commitLogRepoRoot });
    populateCommitLogRepoSelect();
    if (commitLogExpanded && !isCommitLogFresh(repoRoot)) {
      requestCommitLog(repoRoot);
    }
  }

  function setCommitLogExpanded(expanded) {
    if (!commitLogPane || !commitLogToggle) {
      return;
    }
    commitLogExpanded = !!expanded;
    commitLogPane.classList.toggle('collapsed', !commitLogExpanded);
    commitLogToggle.textContent = commitLogExpanded ? '▾' : '▸';
    commitLogToggle.setAttribute('aria-expanded', commitLogExpanded ? 'true' : 'false');
    saveWebviewState({ commitLogExpanded });
    if (!commitLogExpanded) {
      hideCommitLogTip(true);
    }
    if (commitLogExpanded) {
      const root = commitLogRepoRoot || activeRepoRoot();
      if (root) {
        commitLogRepoRoot = root;
        populateCommitLogRepoSelect();
        // Reuse cached DOM when the same repo tip is still fresh — avoids git log + re-render lag.
        if (!isCommitLogFresh(root)) {
          requestCommitLog(root);
        }
      }
    }
  }

  function setCommitFormExpanded(expanded) {
    if (!commitForm || !commitFormToggle) {
      return;
    }
    commitFormExpanded = !!expanded;
    commitForm.classList.toggle('collapsed', !commitFormExpanded);
    commitFormToggle.textContent = commitFormExpanded ? '▾' : '▸';
    commitFormToggle.setAttribute('aria-expanded', commitFormExpanded ? 'true' : 'false');
    saveWebviewState({ commitFormExpanded });
  }

  function bindSectionHeaderToggle(headerEl, toggleFn) {
    if (!headerEl) {
      return;
    }
    headerEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, select, input, textarea, a')) {
        return;
      }
      e.preventDefault();
      toggleFn();
    });
  }

  function setGroupByDirectory(enabled) {
    groupByDirectory = !!enabled;
    if (groupByDirectoryChk) {
      groupByDirectoryChk.checked = groupByDirectory;
    }
    saveWebviewState({ groupByDirectory });
    // New folder rows start collapsed (via syncRepoDimensionCollapseDefaults in renderFiles).
    renderFiles();
  }

  function setGroupByModule(enabled) {
    groupByModule = !!enabled;
    if (groupByModuleChk) {
      groupByModuleChk.checked = groupByModule;
    }
    saveWebviewState({ groupByModule });
    // Keep categories expanded so repository headers are visible; repos themselves start collapsed.
    if (groupByModule) {
      let changed = false;
      for (const groupId of categoryGroupIds()) {
        if (collapsedGroups.has(categoryCollapseKey(groupId))) {
          collapsedGroups.delete(categoryCollapseKey(groupId));
          changed = true;
        }
      }
      if (changed) {
        saveCollapsedGroups();
      }
    }
    renderFiles();
  }

  function setShowIgnoredFiles(enabled) {
    showIgnoredFiles = !!enabled;
    if (showIgnoredFilesChk) {
      showIgnoredFilesChk.checked = showIgnoredFiles;
    }
    saveWebviewState({ showIgnoredFiles });
    // Newly visible Ignored category stays expanded; its repos/folders start collapsed.
    if (showIgnoredFiles && collapsedGroups.has(categoryCollapseKey('ignored'))) {
      collapsedGroups.delete(categoryCollapseKey('ignored'));
      saveCollapsedGroups();
    }
    renderFiles();
  }

  function closeViewOptionsMenu() {
    if (!viewOptionsMenu || !viewOptionsBtn) {
      return;
    }
    viewOptionsMenu.classList.add('hidden');
    viewOptionsBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleViewOptionsMenu() {
    if (!viewOptionsMenu || !viewOptionsBtn) {
      return;
    }
    const open = viewOptionsMenu.classList.contains('hidden');
    if (open) {
      viewOptionsMenu.classList.remove('hidden');
      viewOptionsBtn.setAttribute('aria-expanded', 'true');
      if (groupByDirectoryChk) {
        groupByDirectoryChk.checked = groupByDirectory;
      }
      if (groupByModuleChk) {
        groupByModuleChk.checked = groupByModule;
      }
      if (showIgnoredFilesChk) {
        showIgnoredFilesChk.checked = showIgnoredFiles;
      }
    } else {
      closeViewOptionsMenu();
    }
  }

  function walkDirPaths(node, out = []) {
    for (const child of node.dirs.values()) {
      if (child.path) {
        out.push(child.path);
      }
      walkDirPaths(child, out);
    }
    return out;
  }

  function collectExpandableCollapseKeys() {
    const keys = [];
    for (const groupId of categoryGroupIds()) {
      keys.push(categoryCollapseKey(groupId));
      for (const repo of allRepos()) {
        if (groupByModule) {
          keys.push(repoCollapseKey(groupId, repo.rootPath));
        }
        if (!groupByDirectory) {
          continue;
        }
        const items = itemsForCollapseKey(repo, groupId);
        if (!items.length) {
          continue;
        }
        const tree = buildDirTree(items);
        compactDirTree(tree);
        for (const dirPath of walkDirPaths(tree)) {
          keys.push(dirCollapseKey(groupId, repo.rootPath, dirPath));
        }
      }
    }
    return keys;
  }

  function expandAllGroups() {
    applyExpandCollapse('expand', { type: 'all' });
  }

  function collapseAllGroups() {
    applyExpandCollapse('collapse', { type: 'all' });
  }

  /** Include / exclude every tracked change for the next commit (IDEA-style checkboxes). */
  function setAllChangesIncluded(included) {
    const entries = allRepos().map((repo) => ({ repo, items: getMergedChanges(repo) }));
    setAllInEntries(entries, false, !!included);
    syncIncludeCheckboxes();
  }

  function populateCommitLogRepoSelect() {
    if (!commitLogRepo) {
      return;
    }
    const repos = allRepos();
    commitLogRepo.innerHTML = '';
    if (!repos.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No repository';
      commitLogRepo.appendChild(opt);
      return;
    }
    for (const repo of repos) {
      const opt = document.createElement('option');
      opt.value = repo.rootPath;
      opt.textContent = repo.branch ? `${repo.name} (${repo.branch})` : repo.name;
      commitLogRepo.appendChild(opt);
    }
    const preferred = commitLogRepoRoot || activeRepoRoot() || repos[0].rootPath;
    const match = repos.find((r) => repoKey(r.rootPath) === repoKey(preferred));
    commitLogRepo.value = match ? match.rootPath : repos[0].rootPath;
    commitLogRepoRoot = commitLogRepo.value;
  }

  function requestCommitLog(repoRoot, options) {
    const force = !!(options && options.force);
    const root = repoRoot || commitLogRepoRoot || activeRepoRoot();
    if (!root || !commitLogExpanded || !commitLogList) {
      return;
    }
    if (!force && isCommitLogFresh(root)) {
      return;
    }
    // Deduplicate overlapping loads for the same repository.
    if (
      !force &&
      commitLogLoading &&
      repoKey(commitLogPendingRoot) === repoKey(root)
    ) {
      return;
    }
    commitLogPendingRoot = root;
    commitLogLoading = true;
    const hasRows = !!commitLogList.querySelector('.commit-log-row, .commit-log-empty');
    // Keep existing rows visible during background refresh; only flash Loading on empty/forced.
    if (force || !hasRows) {
      commitLogList.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'commit-log-loading';
      loading.textContent = 'Loading commit history…';
      commitLogList.appendChild(loading);
    }
    post({ type: 'loadCommitLog', repoRoot: root });
  }

  function renderCommitLog(payload) {
    if (!commitLogList) {
      return;
    }
    commitLogLoading = false;
    commitLogPendingRoot = '';
    hideCommitLogTip(true);
    commitLogList.innerHTML = '';
    commitLogMessageByHash.clear();
    commitLogList.dataset.loadedRoot = payload.repoRoot || '';
    commitLogList.dataset.fingerprint = commitLogRepoFingerprint(payload.repoRoot || '');
    if (payload.repoRoot) {
      commitLogRepoRoot = payload.repoRoot;
      populateCommitLogRepoSelect();
      if (commitLogRepo) {
        commitLogRepo.value = payload.repoRoot;
      }
    }
    const commits = payload.commits || [];
    if (!commits.length) {
      const empty = document.createElement('div');
      empty.className = 'commit-log-empty';
      empty.textContent = 'No commits yet.';
      commitLogList.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const commit of commits) {
      const row = document.createElement('div');
      row.className = 'commit-log-row';
      row.dataset.hash = commit.hash || '';
      row.dataset.shortHash = commit.shortHash || '';
      row.dataset.subject = commit.subject || '';
      const fullMessage = String(commit.message || commit.subject || '').replace(/\s+$/u, '');
      if (commit.hash && fullMessage) {
        commitLogMessageByHash.set(commit.hash, fullMessage);
      }

      const dot = document.createElement('span');
      dot.className = 'commit-log-dot';

      const main = document.createElement('div');
      main.className = 'commit-log-main';

      const subject = document.createElement('div');
      subject.className = 'commit-log-subject';
      subject.textContent = commit.subject || '(no subject)';

      const meta = document.createElement('div');
      meta.className = 'commit-log-meta';
      const bits = [commit.shortHash, commit.author, commit.date].filter(Boolean);
      meta.textContent = bits.join(' · ');
      if (commit.refs) {
        const refs = document.createElement('span');
        refs.className = 'commit-log-refs';
        refs.textContent = commit.refs;
        meta.appendChild(document.createTextNode(' · '));
        meta.appendChild(refs);
      }

      main.appendChild(subject);
      main.appendChild(meta);
      row.appendChild(dot);
      row.appendChild(main);
      fragment.appendChild(row);
    }
    commitLogList.appendChild(fragment);
  }

  function clearCommitLogTipHideTimer() {
    if (commitLogTipHideTimer) {
      clearTimeout(commitLogTipHideTimer);
      commitLogTipHideTimer = undefined;
    }
  }

  function hideCommitLogTip(immediate) {
    clearCommitLogTipHideTimer();
    const hide = () => {
      if (commitLogTip) {
        commitLogTip.classList.add('hidden');
        commitLogTip.setAttribute('aria-hidden', 'true');
      }
      if (commitLogTipCopy) {
        commitLogTipCopy.classList.add('hidden');
        commitLogTipCopy.textContent = 'Copy';
      }
      commitLogTipPinned = false;
      commitLogTipMessage = '';
      commitLogTipHash = '';
      commitLogTipRepoRoot = '';
    };
    if (immediate) {
      hide();
      return;
    }
    commitLogTipHideTimer = setTimeout(hide, 160);
  }

  function positionCommitLogTip(clientX, clientY, row) {
    const margin = 8;
    const rowRect = row?.getBoundingClientRect?.();

    // Copy sits just above the cursor so it stays over the hovered row (clickable
    // without crossing the pass-through tip into another row).
    if (commitLogTipCopy && !commitLogTipCopy.classList.contains('hidden')) {
      const copyRect = commitLogTipCopy.getBoundingClientRect();
      const copyW = copyRect.width || 48;
      const copyH = copyRect.height || 22;
      let copyLeft = clientX + 10;
      let copyTop = clientY - copyH - 8;
      if (rowRect) {
        // Clamp onto the hovered row so leaving for Copy doesn't fire list mouseleave.
        copyTop = Math.min(Math.max(copyTop, rowRect.top + 2), Math.max(rowRect.top + 2, rowRect.bottom - copyH - 2));
        copyLeft = Math.min(Math.max(copyLeft, rowRect.left + 8), Math.max(rowRect.left + 8, rowRect.right - copyW - 4));
      }
      copyLeft = Math.max(margin, Math.min(copyLeft, window.innerWidth - copyW - margin));
      copyTop = Math.max(margin, Math.min(copyTop, window.innerHeight - copyH - margin));
      commitLogTipCopy.style.left = `${copyLeft}px`;
      commitLogTipCopy.style.top = `${copyTop}px`;
    }

    if (!commitLogTip || commitLogTip.classList.contains('hidden')) {
      return;
    }
    const tipRect = commitLogTip.getBoundingClientRect();
    let left = clientX + 12;
    if (left + tipRect.width > window.innerWidth - margin) {
      left = clientX - tipRect.width - 12;
    }
    // Prefer below the row; tip is pointer-events:none so it won't block hover.
    const anchorBottom = rowRect ? rowRect.bottom : clientY;
    const anchorTop = rowRect ? rowRect.top : clientY;
    let top = anchorBottom + 4;
    if (top + tipRect.height > window.innerHeight - margin) {
      top = anchorTop - tipRect.height - 4;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin));
    commitLogTip.style.left = `${left}px`;
    commitLogTip.style.top = `${top}px`;
  }

  function showCommitLogTip(row, clientX, clientY) {
    if (!commitLogTip || !commitLogTipBody || !row) {
      return;
    }
    const hash = row.dataset.hash || '';
    const subject = row.dataset.subject || '';
    const message = commitLogMessageByHash.get(hash) || subject;
    if (!message) {
      hideCommitLogTip(true);
      return;
    }
    clearCommitLogTipHideTimer();
    commitLogTipPinned = false;
    commitLogTipHash = hash;
    commitLogTipRepoRoot = commitLogRepoRoot || activeRepoRoot() || '';
    commitLogTipMessage = message;
    commitLogTipBody.textContent = message;
    commitLogTip.classList.remove('hidden');
    commitLogTip.setAttribute('aria-hidden', 'false');
    if (commitLogTipCopy) {
      commitLogTipCopy.textContent = 'Copy';
      commitLogTipCopy.classList.remove('hidden');
    }
    positionCommitLogTip(clientX, clientY, row);
  }

  function copyCommitLogTipMessage() {
    if (!commitLogTipMessage) {
      return;
    }
    post({
      type: 'copyCommitMessage',
      repoRoot: commitLogTipRepoRoot || commitLogRepoRoot || activeRepoRoot() || '',
      hash: commitLogTipHash || '',
      text: commitLogTipMessage,
    });
    if (commitLogTipCopy) {
      commitLogTipCopy.textContent = 'Copied';
      setTimeout(() => {
        if (commitLogTipCopy && commitLogTipCopy.textContent === 'Copied') {
          commitLogTipCopy.textContent = 'Copy';
        }
      }, 1200);
    }
  }

  function showCommitLogContextMenu(x, y, commit) {
    if (!commit?.hash || !commit?.repoRoot) {
      return;
    }
    contextMenu.innerHTML = '';

    const openChanges = document.createElement('button');
    openChanges.type = 'button';
    openChanges.textContent = 'Open Changes';
    openChanges.addEventListener('click', () => {
      hideContextMenu();
      post({
        type: 'openCommitChanges',
        repoRoot: commit.repoRoot,
        hash: commit.hash,
      });
    });
    contextMenu.appendChild(openChanges);

    const copyHash = document.createElement('button');
    copyHash.type = 'button';
    copyHash.textContent = 'Copy Commit Hash';
    copyHash.addEventListener('click', () => {
      hideContextMenu();
      post({ type: 'copyCommitHash', hash: commit.hash });
    });
    contextMenu.appendChild(copyHash);

    const copyMessage = document.createElement('button');
    copyMessage.type = 'button';
    copyMessage.textContent = 'Copy Commit Message';
    copyMessage.addEventListener('click', () => {
      hideContextMenu();
      const text = commitLogMessageByHash.get(commit.hash) || commit.subject || '';
      post({
        type: 'copyCommitMessage',
        repoRoot: commit.repoRoot,
        hash: commit.hash,
        text: text || undefined,
      });
    });
    contextMenu.appendChild(copyMessage);

    contextMenu.classList.remove('hidden');
    const rect = contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    contextMenu.style.left = `${Math.min(x, maxX)}px`;
    contextMenu.style.top = `${Math.min(y, maxY)}px`;
  }

  function clearFileSelection() {
    selectedFiles = [];
    selectionAnchor = null;
    selectedDir = null;
  }

  function clearGroupSelection() {
    selectedGroup = null;
    selectedDir = null;
  }

  function selectDir(repoRoot, groupId, dirPath, actionableItems, indexByPath) {
    clearGroupSelection();
    selectedDir = { repoRoot, groupId, dirPath };
    selectedFiles = actionableItems.map((item) => ({
      repoRoot,
      path: item.path,
      staged: item.staged ?? false,
    }));
    if (actionableItems.length) {
      const first = actionableItems[0];
      selectionAnchor = {
        repoRoot,
        groupId,
        index: indexByPath?.get(first.path) ?? 0,
      };
    } else {
      selectionAnchor = null;
    }
    syncSelectionToHost();
  }

  function isDirSelected(repoRoot, groupId, dirPath) {
    return (
      !!selectedDir &&
      selectedDir.groupId === groupId &&
      selectedDir.dirPath === dirPath &&
      repoKey(selectedDir.repoRoot) === repoKey(repoRoot)
    );
  }

  function mergeSelectionEntries(entries) {
    const merged = [...selectedFiles];
    for (const entry of entries) {
      const key = selectionEntryKey(entry);
      if (!merged.some((existing) => selectionEntryKey(existing) === key)) {
        merged.push(entry);
      }
    }
    selectedFiles = merged;
  }

  function toggleSelectionEntry(entry) {
    const key = selectionEntryKey(entry);
    const index = selectedFiles.findIndex((existing) => selectionEntryKey(existing) === key);
    if (index >= 0) {
      selectedFiles = selectedFiles.filter((_, i) => i !== index);
      return;
    }
    selectedFiles = [...selectedFiles, entry];
  }

  function handleFileSelectionClick(e, entry, groupContext, indexInGroup) {
    clearGroupSelection();
    const { repoRoot, groupId } = groupContext;
    const sameGroupAnchor =
      selectionAnchor &&
      selectionAnchor.repoRoot === repoRoot &&
      selectionAnchor.groupId === groupId;

    if (e.shiftKey && sameGroupAnchor) {
      const start = Math.min(selectionAnchor.index, indexInGroup);
      const end = Math.max(selectionAnchor.index, indexInGroup);
      const range = groupContext.items.slice(start, end + 1).map((item) => ({
        repoRoot,
        path: item.path,
        staged: item.staged ?? false,
      }));
      if (e.ctrlKey || e.metaKey) {
        mergeSelectionEntries(range);
      } else {
        selectedFiles = range;
      }
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelectionEntry(entry);
      selectionAnchor = { repoRoot, groupId, index: indexInGroup };
    } else {
      selectedFiles = [entry];
      selectionAnchor = { repoRoot, groupId, index: indexInGroup };
    }
    syncSelectionToHost();
  }

  function isGroupSelected(repoRoot, groupId, category = false) {
    if (!selectedGroup || selectedGroup.groupId !== groupId) {
      return false;
    }
    if (category) {
      return !!selectedGroup.category;
    }
    return !selectedGroup.category && selectedGroup.repoRoot === repoRoot;
  }

  function selectGroup(repoRoot, groupId, unversionedGroup, category = false) {
    clearFileSelection();
    selectedDir = null;
    selectedGroup = { repoRoot, groupId, unversionedGroup, category: !!category };
    syncSelectionToHost();
  }

  /** Update row/group highlight without rebuilding the file list (keeps double-click working). */
  function applyFileListSelectionVisuals() {
    document.querySelectorAll('.group-title.selected, .repo-subgroup-title.selected, .dir-group-title.selected').forEach((el) =>
      el.classList.remove('selected')
    );
    if (selectedGroup) {
      if (selectedGroup.category) {
        document
          .querySelector(`.category-group[data-group-id="${selectedGroup.groupId}"] .group-title`)
          ?.classList.add('selected');
      } else {
        for (const wrap of document.querySelectorAll('.repo-subgroup[data-group-id]')) {
          if (
            wrap.dataset.repoRoot === selectedGroup.repoRoot &&
            wrap.dataset.groupId === selectedGroup.groupId
          ) {
            wrap.querySelector('.repo-subgroup-title')?.classList.add('selected');
            break;
          }
        }
      }
    }
    if (selectedDir) {
      for (const wrap of document.querySelectorAll('.dir-group[data-dir-path]')) {
        if (
          wrap.dataset.dirPath === selectedDir.dirPath &&
          wrap.dataset.groupId === selectedDir.groupId &&
          repoKey(wrap.dataset.repoRoot || '') === repoKey(selectedDir.repoRoot)
        ) {
          wrap.querySelector('.dir-group-title')?.classList.add('selected');
          break;
        }
      }
    }

    for (const row of document.querySelectorAll('.file-row[data-file-path]')) {
      const staged = row.dataset.fileStaged === '1';
      const selected = selectedFiles.some(
        (entry) =>
          entry.repoRoot === row.dataset.repoRoot &&
          entry.path === row.dataset.filePath &&
          entry.staged === staged
      );
      row.classList.toggle('selected', selected);
    }
  }

  function targetsFromGroup(repoRoot, groupId, items, unversionedGroup) {
    return items.map((item) => ({
      repoRoot,
      path: item.path,
      staged: item.staged ?? false,
      unversionedGroup,
    }));
  }

  function targetsForContextMenu(clickedEntry, groupContext, indexInGroup) {
    if (
      selectedFiles.length > 1 &&
      isFileSelected(clickedEntry.repoRoot, { path: clickedEntry.path }, clickedEntry.staged)
    ) {
      return selectedFiles.map((entry) => ({
        ...entry,
        unversionedGroup: groupContext.unversionedGroup,
      }));
    }
    return [
      {
        ...clickedEntry,
        unversionedGroup: groupContext.unversionedGroup,
      },
    ];
  }

  function clearUnversionedChecks(paths) {
    for (const { repoRoot, path } of paths) {
      checkedUnversioned.delete(unversionedCheckKey(repoRoot, path));
    }
    persistCheckedUnversioned();
  }

  function isUnversionedFileRow(row) {
    return row.classList.contains('group-unversioned') || row.classList.contains('group-ignored');
  }

  function isFileRowChecked(row) {
    const repoRoot = row.dataset.repoRoot;
    const path = row.dataset.filePath;
    if (isUnversionedFileRow(row)) {
      return isUnversionedChecked(repoRoot, path);
    }
    return isChangeChecked(repoRoot, path);
  }

  function applyFileCheckboxTitle(checkbox, row, checked) {
    if (row.classList.contains('group-ignored')) {
      checkbox.title = checked ? 'Selected to force-add to Git' : 'Not selected';
    } else if (row.classList.contains('group-unversioned')) {
      checkbox.title = checked ? 'Selected to add to Git' : 'Not selected';
    } else {
      checkbox.title = checked ? 'Included in commit' : 'Excluded from commit';
    }
  }

  function applyGroupSelectAllState(selectAll, selected, total) {
    selectAll.disabled = total === 0;
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
  }

  /** Path lists for group checkboxes; survives collapse (children may be absent from DOM). */
  const groupCheckMeta = new WeakMap();

  function setCheckEntriesMeta(el, entries, unversionedGroup) {
    groupCheckMeta.set(el, {
      kind: 'entries',
      unversioned: !!unversionedGroup,
      entries: entries.flatMap(({ repo, items }) =>
        items.map((item) => ({ repoRoot: repo.rootPath, path: item.path }))
      ),
    });
  }

  function setCheckPathsMeta(el, repoRoot, items, unversionedGroup) {
    groupCheckMeta.set(el, {
      kind: 'paths',
      unversioned: !!unversionedGroup,
      repoRoot,
      paths: items.map((item) => item.path),
    });
  }

  function countCheckedFromGroupMeta(meta) {
    if (!meta) {
      return { selected: 0, total: 0 };
    }
    if (meta.kind === 'entries') {
      let selected = 0;
      for (const entry of meta.entries) {
        if (
          meta.unversioned
            ? isUnversionedChecked(entry.repoRoot, entry.path)
            : isChangeChecked(entry.repoRoot, entry.path)
        ) {
          selected += 1;
        }
      }
      return { selected, total: meta.entries.length };
    }
    let selected = 0;
    for (const path of meta.paths) {
      if (
        meta.unversioned
          ? isUnversionedChecked(meta.repoRoot, path)
          : isChangeChecked(meta.repoRoot, path)
      ) {
        selected += 1;
      }
    }
    return { selected, total: meta.paths.length };
  }

  /**
   * Refresh checkbox / indeterminate visuals without rebuilding the file tree.
   * Full renderFiles() is too expensive when toggling modules or large folders.
   */
  function syncIncludeCheckboxes() {
    if (!fileList) {
      return;
    }

    for (const row of fileList.querySelectorAll('.file-row[data-file-path]')) {
      const checkbox = row.querySelector(':scope > input[type="checkbox"]');
      if (!checkbox) {
        continue;
      }
      const checked = isFileRowChecked(row);
      checkbox.checked = checked;
      applyFileCheckboxTitle(checkbox, row, checked);
    }

    for (const wrap of fileList.querySelectorAll('.dir-group')) {
      const meta = groupCheckMeta.get(wrap);
      if (!meta) {
        continue;
      }
      const title = wrap.querySelector(':scope > .dir-group-title');
      const selectAll = title?.querySelector(':scope > .group-select-all');
      if (!selectAll) {
        continue;
      }
      const { selected, total } = countCheckedFromGroupMeta(meta);
      applyGroupSelectAllState(selectAll, selected, total);
      const countEl = title.querySelector(':scope > .dir-group-count');
      if (countEl) {
        countEl.textContent = formatGroupCount(selected, total);
      }
    }

    for (const wrap of fileList.querySelectorAll('.repo-subgroup')) {
      const meta = groupCheckMeta.get(wrap);
      if (!meta) {
        continue;
      }
      const title = wrap.querySelector(':scope > .repo-subgroup-title');
      const selectAll = title?.querySelector(':scope > .group-select-all');
      if (!selectAll) {
        continue;
      }
      const { selected, total } = countCheckedFromGroupMeta(meta);
      applyGroupSelectAllState(selectAll, selected, total);
      const countEl = title.querySelector('.repo-subgroup-count');
      if (countEl) {
        countEl.textContent = formatGroupCount(selected, total);
      }
    }

    for (const wrap of fileList.querySelectorAll('.category-group')) {
      const meta = groupCheckMeta.get(wrap);
      if (!meta) {
        continue;
      }
      const title = wrap.querySelector(':scope > .group-title');
      const selectAll = title?.querySelector(':scope > .group-select-all');
      if (!selectAll) {
        continue;
      }
      const { selected, total } = countCheckedFromGroupMeta(meta);
      applyGroupSelectAllState(selectAll, selected, total);
      const countEl = title.querySelector(':scope > .group-title-count');
      if (countEl) {
        countEl.textContent = formatGroupCount(selected, total);
      }
    }
  }

  /** After Add to Git, files move into Changes — mark them included for commit. */
  function markAddedPathsForCommit(paths) {
    for (const { repoRoot, path } of paths) {
      setChangeCheckedQuiet(repoRoot, path, true);
    }
    if (paths.length) {
      persistChangeIncludeState();
    }
  }

  function performAddToGit() {
    const paths = collectAddToGitPaths();
    if (!paths.length) {
      showFormError('Select unversioned files to add to Git.');
      return;
    }
    showFormError('');
    markAddedPathsForCommit(paths);
    clearUnversionedChecks(paths);
    post({ type: 'addToGit', paths });
  }

  function targetsAreUnversionedGroup(targets) {
    return (
      targets.length > 0 &&
      targets.every((t) => isSelectedUnversioned(t) || isSelectedIgnored(t))
    );
  }

  function performOpenFiles() {
    const targets = resolveOperationTargets();
    if (!targets.length) {
      showFormError('Select files first.');
      return;
    }
    showFormError('');
    for (const target of targets) {
      post({ type: 'openFile', repoRoot: target.repoRoot, path: target.path });
    }
  }

  function performShowDiffs() {
    const targets = resolveOperationTargets().filter((t) => !isSelectedIgnored(t));
    if (!targets.length) {
      showFormError('Select files first.');
      return;
    }
    showFormError('');
    for (const target of targets) {
      post({
        type: 'openDiff',
        repoRoot: target.repoRoot,
        path: target.path,
        staged: target.staged,
      });
    }
  }

  function performRevealInExplorer() {
    const targets = resolveOperationTargets();
    if (!targets.length) {
      showFormError('Select files first.');
      return;
    }
    showFormError('');
    for (const target of targets) {
      post({ type: 'revealInExplorer', repoRoot: target.repoRoot, path: target.path });
    }
  }

  function performRollback() {
    const targets = resolveOperationTargets().filter((t) => !isSelectedIgnored(t));
    if (!targets.length) {
      showFormError('Select files first.');
      return;
    }
    showFormError('');
    if (targets.length === 1) {
      const target = targets[0];
      post({
        type: 'rollback',
        repoRoot: target.repoRoot,
        path: target.path,
        staged: target.staged,
      });
      return;
    }
    post({
      type: 'rollbackBatch',
      paths: targets.map(({ repoRoot, path, staged }) => ({ repoRoot, path, staged })),
      unversionedGroup: targetsAreUnversionedGroup(targets),
    });
  }

  function formatGroupCount(selected, total) {
    return `${selected}/${total}`;
  }

  function resolveCategoryGroupFromTarget(target) {
    const wrap = target.closest('.category-group[data-group-id]');
    if (!wrap) {
      return null;
    }
    const groupId = wrap.dataset.groupId;
    return {
      repoRoot: null,
      groupId,
      unversionedGroup: groupId === 'unversioned' || groupId === 'ignored',
      ignoredGroup: groupId === 'ignored',
      category: true,
    };
  }

  function resolveRepoSubgroupFromTarget(target) {
    const wrap = target.closest('.repo-subgroup[data-group-id]');
    if (!wrap) {
      return null;
    }
    const groupId = wrap.dataset.groupId;
    return {
      repoRoot: wrap.dataset.repoRoot,
      groupId,
      unversionedGroup: groupId === 'unversioned' || groupId === 'ignored',
      ignoredGroup: groupId === 'ignored',
      category: false,
    };
  }

  function resolveChangeListGroupFromTarget(target) {
    return resolveRepoSubgroupFromTarget(target) || resolveCategoryGroupFromTarget(target);
  }

  /** Expand Changes category and all repo/dir subgroups (used on Ctrl+K auto-check). */
  function expandChangesGroups() {
    let changed = false;
    if (collapsedGroups.has(categoryCollapseKey('changes'))) {
      collapsedGroups.delete(categoryCollapseKey('changes'));
      changed = true;
    }
    for (const repo of allRepos()) {
      const key = repoCollapseKey('changes', repo.rootPath);
      if (collapsedGroups.has(key)) {
        collapsedGroups.delete(key);
        changed = true;
      }
      if (groupByDirectory) {
        const items = getMergedChanges(repo);
        if (items.length) {
          const tree = buildDirTree(items);
          compactDirTree(tree);
          for (const dirPath of walkDirPaths(tree)) {
            const dirKey = dirCollapseKey('changes', repo.rootPath, dirPath);
            if (collapsedGroups.has(dirKey)) {
              collapsedGroups.delete(dirKey);
              changed = true;
            }
          }
        }
      }
    }
    if (changed) {
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

  function setRefreshBusy(busy) {
    refreshBtn.classList.toggle('is-busy', !!busy);
    refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    refreshBtn.title = busy ? 'Refreshing…' : 'Refresh Git status';
  }

  function setBusy(busy, message) {
    workspace.busy = busy;
    document.body.classList.toggle('panel-busy', !!busy);
    if (panelLoadingOverlay) {
      panelLoadingOverlay.classList.toggle('hidden', !busy);
    }
    if (!busy) {
      setRefreshBusy(false);
      clearFastPushProgress();
      if (panelLoadingTitle) {
        panelLoadingTitle.textContent = 'Working…';
      }
    } else if (panelLoadingTitle && message) {
      panelLoadingTitle.textContent = message;
      if (/refresh/i.test(message)) {
        setRefreshBusy(true);
      }
    } else if (panelLoadingTitle && !panelLoadingProgress?.classList.contains('hidden')) {
      // keep progress-driven title
    } else if (panelLoadingTitle) {
      panelLoadingTitle.textContent = 'Working…';
    }
    applyBusyState();
  }

  function clearFastPushProgress() {
    if (panelLoadingProgress) {
      panelLoadingProgress.textContent = '0/0';
      panelLoadingProgress.classList.add('hidden');
    }
    if (panelLoadingBar) {
      panelLoadingBar.classList.add('hidden');
    }
    if (panelLoadingBarFill) {
      panelLoadingBarFill.style.width = '0%';
    }
  }

  function setFastPushProgress(progress) {
    if (!progress) {
      clearFastPushProgress();
      return;
    }
    const current = Math.max(0, Number(progress.current) || 0);
    const total = Math.max(0, Number(progress.total) || 0);
    const label = progress.label || 'Working…';
    if (panelLoadingTitle) {
      panelLoadingTitle.textContent = label;
    }
    if (panelLoadingProgress) {
      panelLoadingProgress.textContent = total > 0 ? `${current}/${total}` : `${current}`;
      panelLoadingProgress.classList.remove('hidden');
    }
    if (panelLoadingBar && panelLoadingBarFill) {
      panelLoadingBar.classList.remove('hidden');
      const ratio = total > 0 ? Math.min(1, current / total) : 0;
      panelLoadingBarFill.style.width = `${Math.round(ratio * 100)}%`;
    }
    if (panelLoadingOverlay) {
      panelLoadingOverlay.classList.remove('hidden');
    }
    document.body.classList.add('panel-busy');
  }

  function setGenerateBusy(busy) {
    generatingMessage = !!busy;
    generateMsgBtn.classList.toggle('is-busy', generatingMessage);
    generateMsgBtn.title = generatingMessage
      ? 'Generating commit message…'
      : 'Generate Commit Message';
    applyBusyState();
  }

  function applyBusyState() {
    const panelBusy = !!workspace.busy || generatingMessage;
    const disabled = panelBusy || !workspace.ok;
    commitBtn.disabled = disabled;
    commitPushBtn.disabled = disabled;
    if (commitPushMenuBtn) {
      commitPushMenuBtn.disabled = disabled;
    }
    if (fastPushBtn) {
      fastPushBtn.disabled = disabled;
    }
    if (fastPushSettingsBtn) {
      fastPushSettingsBtn.disabled = panelBusy;
    }
    if (generateMsgSettingsBtn) {
      generateMsgSettingsBtn.disabled = panelBusy;
    }
    if (disabled) {
      closeCommitPushMenu();
    }
    if (fastPushSettingsSave) {
      fastPushSettingsSave.disabled = panelBusy;
    }
    if (fastPushSettingsCancel) {
      fastPushSettingsCancel.disabled = panelBusy;
    }
    if (commitMsgPrefixSave) {
      commitMsgPrefixSave.disabled = panelBusy;
    }
    if (commitMsgPrefixCancel) {
      commitMsgPrefixCancel.disabled = panelBusy;
    }
    if (commitMsgPrefixClearGlobal) {
      commitMsgPrefixClearGlobal.disabled = panelBusy;
    }
    if (fastPushCommitCancel) {
      fastPushCommitCancel.disabled = false;
    }
    if (fastPushCommitConfirm) {
      fastPushCommitConfirm.disabled = false;
    }
    if (fastPushCommitInput) {
      fastPushCommitInput.disabled = false;
    }
    if (fastPushConfirmCancel) {
      fastPushConfirmCancel.disabled = panelBusy;
    }
    if (fastPushConfirmOk) {
      fastPushConfirmOk.disabled = panelBusy;
    }
    stageAllBtn.disabled = disabled;
    unstageAllBtn.disabled = disabled;
    refreshBtn.disabled = disabled;
    locateBtn.disabled = disabled;
    installKeysBtn.disabled = panelBusy;
    rollbackConfirmBtn.disabled = panelBusy;
    keysConfirm.disabled = panelBusy;
    updateAllConfirmBtn.disabled = panelBusy;
    updateAllCancel.disabled = panelBusy;
    generateMsgBtn.disabled = panelBusy || !workspace.ok;
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

  function showHostError(message) {
    const text = String(message || '').trim();
    if (!text) {
      return;
    }
    showFormError(text);
    showBanner(text, 'error');
  }

  function hideContextMenu() {
    contextMenu.classList.add('hidden');
    contextMenu.innerHTML = '';
  }

  function getMergedChanges(active) {
    const map = new Map();
    // Prefer working-tree entry when both exist (MM): checkbox commit re-adds from disk,
    // so the list must keep representing the on-disk change the user sees as checked.
    for (const item of active.staged) {
      map.set(item.path, { ...item, staged: true });
    }
    for (const item of active.unstaged) {
      if (item.status === '?') {
        continue;
      }
      map.set(item.path, { ...item, staged: false });
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

  function getIgnored(active) {
    return [...(active.ignored ?? [])].sort((a, b) => a.path.localeCompare(b.path));
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

  /** VS Code Seti-style file type badges (letter icons by extension / filename). */
  const FILE_ICON_BY_NAME = {
    dockerfile: { label: 'D', color: '#2496ed' },
    'docker-compose.yml': { label: 'D', color: '#2496ed' },
    'docker-compose.yaml': { label: 'D', color: '#2496ed' },
    makefile: { label: 'M', color: '#427819' },
    gemfile: { label: 'G', color: '#701516' },
    rakefile: { label: 'R', color: '#701516' },
    'package.json': { label: 'npm', color: '#cb3837' },
    'package-lock.json': { label: 'npm', color: '#cb3837' },
    'tsconfig.json': { label: 'TS', color: '#3178c6' },
    'jsconfig.json': { label: 'JS', color: '#f1e05a' },
    '.gitignore': { label: 'GI', color: '#f54d27' },
    '.gitattributes': { label: 'GI', color: '#f54d27' },
    '.env': { label: 'ENV', color: '#ecd53f' },
    'readme.md': { label: 'MD', color: '#083fa1' },
    'readme': { label: 'MD', color: '#083fa1' },
  };

  const FILE_ICON_BY_EXT = {
    java: { label: 'J', color: '#b07219' },
    class: { label: 'J', color: '#b07219' },
    jar: { label: 'J', color: '#b07219' },
    kt: { label: 'K', color: '#A97BFF' },
    kts: { label: 'K', color: '#A97BFF' },
    ts: { label: 'TS', color: '#3178c6' },
    tsx: { label: 'TSX', color: '#3178c6' },
    mts: { label: 'TS', color: '#3178c6' },
    cts: { label: 'TS', color: '#3178c6' },
    js: { label: 'JS', color: '#f1e05a' },
    jsx: { label: 'JSX', color: '#f1e05a' },
    mjs: { label: 'JS', color: '#f1e05a' },
    cjs: { label: 'JS', color: '#f1e05a' },
    vue: { label: 'V', color: '#41b883' },
    css: { label: 'CSS', color: '#563d7c' },
    scss: { label: 'SCSS', color: '#c6538c' },
    sass: { label: 'SASS', color: '#c6538c' },
    less: { label: 'LESS', color: '#1d365d' },
    html: { label: 'HTML', color: '#e34c26' },
    htm: { label: 'HTML', color: '#e34c26' },
    xml: { label: 'XML', color: '#e37933' },
    xhtml: { label: 'XML', color: '#e37933' },
    json: { label: '{}', color: '#cbcb41' },
    jsonc: { label: '{}', color: '#cbcb41' },
    json5: { label: '{}', color: '#cbcb41' },
    yaml: { label: 'YML', color: '#cb171e' },
    yml: { label: 'YML', color: '#cb171e' },
    md: { label: 'MD', color: '#083fa1' },
    markdown: { label: 'MD', color: '#083fa1' },
    py: { label: 'PY', color: '#3572A5' },
    pyw: { label: 'PY', color: '#3572A5' },
    go: { label: 'GO', color: '#00ADD8' },
    rs: { label: 'RS', color: '#dea584' },
    c: { label: 'C', color: '#555555' },
    h: { label: 'H', color: '#555555' },
    cpp: { label: 'C++', color: '#f34b7d' },
    cxx: { label: 'C++', color: '#f34b7d' },
    cc: { label: 'C++', color: '#f34b7d' },
    hpp: { label: 'H', color: '#f34b7d' },
    cs: { label: 'C#', color: '#178600' },
    php: { label: 'PHP', color: '#4F5D95' },
    rb: { label: 'RB', color: '#701516' },
    swift: { label: 'SW', color: '#F05138' },
    sql: { label: 'SQL', color: '#e38c10' },
    sh: { label: 'SH', color: '#89e051' },
    bash: { label: 'SH', color: '#89e051' },
    zsh: { label: 'SH', color: '#89e051' },
    ps1: { label: 'PS', color: '#012456' },
    bat: { label: 'BAT', color: '#C1F12E' },
    cmd: { label: 'CMD', color: '#C1F12E' },
    svelte: { label: 'S', color: '#ff3e00' },
    svg: { label: 'SVG', color: '#ff9900' },
    png: { label: 'IMG', color: '#a074c4' },
    jpg: { label: 'IMG', color: '#a074c4' },
    jpeg: { label: 'IMG', color: '#a074c4' },
    gif: { label: 'IMG', color: '#a074c4' },
    webp: { label: 'IMG', color: '#a074c4' },
    ico: { label: 'IMG', color: '#a074c4' },
    txt: { label: 'TXT', color: '#8a8a8a' },
    log: { label: 'LOG', color: '#8a8a8a' },
    properties: { label: 'P', color: '#8a8a8a' },
    conf: { label: 'CFG', color: '#8a8a8a' },
    cfg: { label: 'CFG', color: '#8a8a8a' },
    ini: { label: 'INI', color: '#8a8a8a' },
    toml: { label: 'TOML', color: '#9c4221' },
    gradle: { label: 'G', color: '#02303a' },
    groovy: { label: 'G', color: '#4298b8' },
    proto: { label: 'P', color: '#3b82f6' },
    graphql: { label: 'GQL', color: '#e10098' },
    gql: { label: 'GQL', color: '#e10098' },
    dart: { label: 'D', color: '#00B4AB' },
    lua: { label: 'LUA', color: '#000080' },
    r: { label: 'R', color: '#198CE7' },
    scala: { label: 'SC', color: '#c22d40' },
    clj: { label: 'CLJ', color: '#db5855' },
    ex: { label: 'EX', color: '#6e4a7e' },
    exs: { label: 'EX', color: '#6e4a7e' },
    elm: { label: 'ELM', color: '#60B5CC' },
    hs: { label: 'HS', color: '#5e5086' },
    erl: { label: 'ERL', color: '#B83998' },
  };

  function resolveFileIconSpec(filePath) {
    const { name } = splitPath(filePath || '');
    const lower = name.toLowerCase();
    if (FILE_ICON_BY_NAME[lower]) {
      return FILE_ICON_BY_NAME[lower];
    }
    const dot = lower.lastIndexOf('.');
    if (dot >= 0) {
      const ext = lower.slice(dot + 1);
      if (FILE_ICON_BY_EXT[ext]) {
        return FILE_ICON_BY_EXT[ext];
      }
      // compound like .d.ts
      if (lower.endsWith('.d.ts')) {
        return FILE_ICON_BY_EXT.ts;
      }
    }
    return { label: 'F', color: '#8a8a8a' };
  }

  function createFolderTypeIcon() {
    const folderIcon = document.createElement('span');
    folderIcon.className = 'file-type-icon folder';
    folderIcon.setAttribute('aria-hidden', 'true');
    const folderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    folderSvg.setAttribute('viewBox', '0 0 16 16');
    folderSvg.setAttribute('width', '14');
    folderSvg.setAttribute('height', '14');
    folderSvg.setAttribute('focusable', 'false');
    const folderPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    folderPath.setAttribute('fill', 'currentColor');
    folderPath.setAttribute(
      'd',
      'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.3 0 .6.1.8.3L8.2 3.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Z'
    );
    folderSvg.appendChild(folderPath);
    folderIcon.appendChild(folderSvg);
    return folderIcon;
  }

  function createFileTypeIcon(filePath, isDirectory) {
    if (isDirectory) {
      return createFolderTypeIcon();
    }
    const spec = resolveFileIconSpec(filePath);
    const el = document.createElement('span');
    const wide = (spec.label || '').length > 2;
    el.className = 'file-type-icon' + (wide ? ' wide' : spec.label.length > 1 ? ' mid' : '');
    el.style.color = spec.color;
    el.textContent = spec.label;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function statusLetterLabel(status) {
    if (status === '?') {
      return 'A';
    }
    return status || '';
  }

  /** Build a directory tree from change items (paths use `/`). */
  function buildDirTree(items) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const item of items) {
      const normalized = (item.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
      const parts = normalized.split('/').filter(Boolean);
      if (!parts.length) {
        continue;
      }
      if (item.directory) {
        let node = root;
        for (let i = 0; i < parts.length; i += 1) {
          const part = parts[i];
          if (!node.dirs.has(part)) {
            const childPath = node.path ? `${node.path}/${part}` : part;
            node.dirs.set(part, { name: part, path: childPath, dirs: new Map(), files: [] });
          }
          node = node.dirs.get(part);
        }
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

  /** Compact chains of single-child dirs (IDEA-style `src/views`). Does not compact the root. */
  function compactDirTree(node) {
    const children = [...node.dirs.values()];
    node.dirs.clear();
    for (const child of children) {
      compactDirTree(child);
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

  function collectTreeLeaves(node, out = []) {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
      collectTreeLeaves(node.dirs.get(name), out);
    }
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    out.push(...files);
    return out;
  }

  function collectTreeFiles(node, out = []) {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
      collectTreeFiles(node.dirs.get(name), out);
    }
    out.push(...node.files);
    return out;
  }

  function isSelectedItem(_active, repoRoot, item, staged) {
    return isFileSelected(repoRoot, item, staged);
  }

  function selectionStillExists() {
    if (selectedGroup) {
      if (selectedGroup.category) {
        for (const repo of allRepos()) {
          const items =
            selectedGroup.groupId === 'unversioned'
              ? getUnversioned(repo)
              : selectedGroup.groupId === 'ignored'
                ? getIgnored(repo)
                : getMergedChanges(repo);
          if (items.length > 0) {
            return true;
          }
        }
        return false;
      }
      const repo = findRepo(selectedGroup.repoRoot);
      if (!repo) {
        return false;
      }
      const items =
        selectedGroup.groupId === 'unversioned'
          ? getUnversioned(repo)
          : selectedGroup.groupId === 'ignored'
            ? getIgnored(repo)
            : getMergedChanges(repo);
      return items.length > 0;
    }
    if (!selectedFiles.length) {
      return true;
    }
    return selectedFiles.every((entry) => {
      const repo = findRepo(entry.repoRoot);
      if (!repo) {
        return false;
      }
      const tracked = getMergedChanges(repo);
      const unversioned = getUnversioned(repo);
      const ignored = getIgnored(repo);
      if (tracked.some((i) => i.path === entry.path)) {
        return true;
      }
      if (unversioned.some((i) => i.path === entry.path)) {
        return true;
      }
      return ignored.some((i) => i.path === entry.path);
    });
  }

  function showContextMenuAt(x, y, targets, unversionedGroup = false, ignoredGroup = false) {
    if (!targets.length) {
      return;
    }
    contextMenu.innerHTML = '';
    const count = targets.length;
    const countLabel = count > 1 ? ` (${count} files)` : '';

    if (unversionedGroup) {
      const addToGit = document.createElement('button');
      addToGit.type = 'button';
      addToGit.textContent = ignoredGroup
        ? `Force Add to Git${countLabel}`
        : `Add to Git (Ctrl+Alt+A)${countLabel}`;
      addToGit.addEventListener('click', () => {
        hideContextMenu();
        const paths = targets.map(({ repoRoot, path }) => ({ repoRoot, path }));
        markAddedPathsForCommit(paths);
        clearUnversionedChecks(paths);
        post({
          type: 'addToGit',
          paths,
        });
      });
      contextMenu.appendChild(addToGit);
    }

    const openFile = document.createElement('button');
    openFile.type = 'button';
    openFile.textContent = `Open File (F4)${countLabel}`;
    openFile.addEventListener('click', () => {
      hideContextMenu();
      for (const target of targets) {
        post({ type: 'openFile', repoRoot: target.repoRoot, path: target.path });
      }
    });
    contextMenu.appendChild(openFile);

    if (!ignoredGroup) {
      const openDiff = document.createElement('button');
      openDiff.type = 'button';
      openDiff.textContent = `Show Diff (Ctrl+D)${countLabel}`;
      openDiff.addEventListener('click', () => {
        hideContextMenu();
        for (const target of targets) {
          post({
            type: 'openDiff',
            repoRoot: target.repoRoot,
            path: target.path,
            staged: target.staged,
          });
        }
      });
      contextMenu.appendChild(openDiff);
    }

    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.textContent = `Reveal in Explorer${countLabel}`;
    reveal.addEventListener('click', () => {
      hideContextMenu();
      for (const target of targets) {
        post({ type: 'revealInExplorer', repoRoot: target.repoRoot, path: target.path });
      }
    });
    contextMenu.appendChild(reveal);

    if (!ignoredGroup) {
      const rollback = document.createElement('button');
      rollback.type = 'button';
      rollback.textContent = `Rollback (Ctrl+Alt+Z)${countLabel}`;
      rollback.addEventListener('click', () => {
        hideContextMenu();
        if (targets.length === 1) {
          const target = targets[0];
          post({
            type: 'rollback',
            repoRoot: target.repoRoot,
            path: target.path,
            staged: target.staged,
          });
          return;
        }
        post({
          type: 'rollbackBatch',
          paths: targets.map(({ repoRoot, path, staged }) => ({ repoRoot, path, staged })),
          unversionedGroup,
        });
      });
      contextMenu.appendChild(rollback);
    }

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
    syncRepoDimensionCollapseDefaults();
    fileList.innerHTML = '';

    if (workspace.loading) {
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = workspace.hint || 'Loading Git...';
      fileList.appendChild(empty);
      return;
    }

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

    rebuildRepoColors();

    const focused = activeRepoRoot();
    const changesEntries = repos.map((repo) => ({ repo, items: getMergedChanges(repo) }));
    const unversionedEntries = repos.map((repo) => ({ repo, items: getUnversioned(repo) }));

    fileList.appendChild(
      renderCategoryGroup('Changes', 'changes', changesEntries, false, focused, false)
    );
    fileList.appendChild(
      renderCategoryGroup('Unversioned Files', 'unversioned', unversionedEntries, true, focused, false)
    );
    if (showIgnoredFiles) {
      const ignoredEntries = repos.map((repo) => ({ repo, items: getIgnored(repo) }));
      const hasIgnored = ignoredEntries.some(({ items }) => items.length > 0);
      if (hasIgnored) {
        fileList.appendChild(
          renderCategoryGroup('Ignored Files', 'ignored', ignoredEntries, true, focused, true)
        );
      }
    }
  }

  function countSelectedInEntries(entries, unversionedGroup) {
    let selected = 0;
    let total = 0;
    for (const { repo, items } of entries) {
      total += items.length;
      for (const item of items) {
        if (unversionedGroup ? isUnversionedChecked(repo.rootPath, item.path) : isChangeChecked(repo.rootPath, item.path)) {
          selected += 1;
        }
      }
    }
    return { selected, total };
  }

  function setAllInEntries(entries, unversionedGroup, checked) {
    for (const { repo, items } of entries) {
      for (const item of items) {
        if (unversionedGroup) {
          setUnversionedCheckedQuiet(repo.rootPath, item.path, checked);
        } else {
          setChangeCheckedQuiet(repo.rootPath, item.path, checked);
        }
      }
    }
    if (unversionedGroup) {
      persistCheckedUnversioned();
    } else {
      persistChangeIncludeState();
    }
  }

  function attachGroupHeaderInteractions(head, groupContext, items, onToggleCollapse) {
    const { repoRoot, groupId, unversionedGroup, category, ignoredGroup } = groupContext;

    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
        return;
      }
      if (e.target.closest('.group-title-chevron') || e.target.closest('.repo-subgroup-chevron') || e.target.closest('.dir-group-chevron')) {
        return;
      }
      const clickKey = category
        ? `category|${groupId}`
        : `repo|${repoKey(repoRoot)}|${groupId}`;
      if (consumePointerDouble(clickKey)) {
        onToggleCollapse();
      }
    });

    head.addEventListener('click', (e) => {
      if (shouldSuppressPointerFollowUp()) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
        return;
      }
      const onChevron =
        e.target.closest('.group-title-chevron') ||
        e.target.closest('.repo-subgroup-chevron') ||
        e.target.closest('.dir-group-chevron');
      if (onChevron) {
        onToggleCollapse();
        return;
      }
      selectGroup(repoRoot, groupId, unversionedGroup, category);
      if (repoRoot) {
        focusCommitLogRepo(repoRoot, true);
      }
      hideContextMenu();
      applyFileListSelectionVisuals();
    });

    head.addEventListener('dblclick', (e) => {
      if (shouldSuppressPointerFollowUp()) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
        return;
      }
      if (e.target.closest('.group-title-chevron') || e.target.closest('.repo-subgroup-chevron') || e.target.closest('.dir-group-chevron')) {
        return;
      }
      e.preventDefault();
      markPointerFollowUpSuppressed();
      onToggleCollapse();
    });

    head.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
        return;
      }
      e.preventDefault();
      selectGroup(repoRoot, groupId, unversionedGroup, category);
      hideContextMenu();
      applyFileListSelectionVisuals();
      if (!items.length) {
        return;
      }
      const targets = category
        ? entriesToTargets(groupContext.entries, unversionedGroup)
        : targetsFromGroup(repoRoot, groupId, items, unversionedGroup);
      showContextMenuAt(e.clientX, e.clientY, targets, unversionedGroup, !!ignoredGroup);
    });
  }

  function entriesToTargets(entries, unversionedGroup) {
    const targets = [];
    for (const { repo, items } of entries) {
      targets.push(...targetsFromGroup(repo.rootPath, unversionedGroup ? 'unversioned' : 'changes', items, unversionedGroup));
    }
    return targets;
  }

  function renderCategoryGroup(title, groupId, entries, unversionedGroup, focusedRoot, ignoredGroup = false) {
    const wrap = document.createElement('div');
    wrap.className = 'category-group' + (ignoredGroup ? ' category-ignored' : '');
    wrap.dataset.groupId = groupId;
    setCheckEntriesMeta(wrap, entries, unversionedGroup);

    const { selected, total } = countSelectedInEntries(entries, unversionedGroup);
    const isCollapsed = collapsedGroups.has(categoryCollapseKey(groupId));

    const head = document.createElement('div');
    head.className = 'group-title collapsible category-group-title';
    if (isGroupSelected(null, groupId, true)) {
      head.classList.add('selected');
    }

    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.className = 'group-select-all';
    selectAll.title = ignoredGroup
      ? 'Select all ignored paths'
      : unversionedGroup
        ? 'Select all'
        : 'Include all in commit';
    selectAll.disabled = total === 0;
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
    selectAll.addEventListener('click', (e) => {
      e.stopPropagation();
      if (total === 0) {
        return;
      }
      setAllInEntries(entries, unversionedGroup, selectAll.checked);
      syncIncludeCheckboxes();
    });

    const chevron = document.createElement('span');
    chevron.className = 'group-title-chevron';
    chevron.textContent = isCollapsed ? '▸' : '▾';

    const name = document.createElement('span');
    name.className = 'group-title-name';
    name.textContent = title;

    const count = document.createElement('span');
    count.className = 'group-title-count';
    count.textContent = formatGroupCount(selected, total);

    head.appendChild(selectAll);
    head.appendChild(chevron);
    head.appendChild(name);
    head.appendChild(count);
    head.title = isCollapsed
      ? 'Double-click to expand; click title to select group'
      : 'Double-click to collapse; click title to select group';

    const groupContext = {
      repoRoot: null,
      groupId,
      items: entries.flatMap(({ items }) => items),
      entries,
      unversionedGroup,
      ignoredGroup,
      category: true,
    };
    attachGroupHeaderInteractions(head, groupContext, groupContext.items, () =>
      toggleCategoryCollapsed(groupId)
    );
    wrap.appendChild(head);

    if (isCollapsed) {
      return wrap;
    }

    // Changes: list every repository, including empty 0/0 modules (IDEA-style).
    // Unversioned / Ignored: only show repositories that have files.
    if (groupByModule) {
      if (!entries.length) {
        return wrap;
      }
      const hideEmptyRepos = groupId === 'unversioned' || groupId === 'ignored';
      for (const { repo, items } of entries) {
        if (hideEmptyRepos && items.length === 0) {
          continue;
        }
        wrap.appendChild(
          renderRepoSubgroup(repo, items, groupId, unversionedGroup, focusedRoot, ignoredGroup)
        );
      }
      return wrap;
    }

    if (!entries.length) {
      return wrap;
    }

    const nonEmpty = entries.filter(({ items }) => items.length > 0);
    if (!nonEmpty.length) {
      return wrap;
    }

    // Directory-only (or flat): no module headers — folders/files hang under the category.
    for (const { repo, items } of nonEmpty) {
      const repoGroupContext = {
        repoRoot: repo.rootPath,
        groupId,
        items,
        unversionedGroup,
        ignoredGroup,
        category: false,
      };
      wrap.appendChild(
        renderFileList(items, repo.rootPath, unversionedGroup, groupId, repoGroupContext, false)
      );
    }
    return wrap;
  }

  /**
   * Ahead/behind Pull / Push after the branch badge — Changes rows only.
   * Unversioned / Ignored keep empty slots so count + branch stay column-aligned.
   */
  function renderRepoSyncControls(repo) {
    const hasUpstream = !!(repo && repo.upstream);
    const behind =
      typeof repo?.behind === 'number' && Number.isFinite(repo.behind) ? Math.max(0, repo.behind) : hasUpstream ? 0 : null;
    const ahead =
      typeof repo?.ahead === 'number' && Number.isFinite(repo.ahead) ? Math.max(0, repo.ahead) : hasUpstream ? 0 : null;
    if (behind === null && ahead === null) {
      return null;
    }

    const wrap = document.createElement('span');
    wrap.className = 'repo-sync';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Pull / Push');

    const pullBtn = document.createElement('button');
    pullBtn.type = 'button';
    pullBtn.className = 'repo-sync-btn repo-sync-pull';
    const behindCount = behind ?? 0;
    pullBtn.textContent = `${behindCount}\u2193`;
    pullBtn.dataset.repoRoot = repo.rootPath;
    if (behindCount > 0) {
      pullBtn.classList.add('has-count');
    }
    if (!hasUpstream) {
      pullBtn.disabled = true;
      pullBtn.title = 'No upstream branch configured';
    } else {
      pullBtn.title =
        behindCount === 1
          ? `Pull 1 commit from ${repo.upstream}`
          : `Pull ${behindCount} commits from ${repo.upstream}`;
      pullBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (workspace.busy || generatingMessage || pullBtn.disabled) {
          return;
        }
        post({ type: 'pullRepo', repoRoot: repo.rootPath });
      });
    }

    const pushBtn = document.createElement('button');
    pushBtn.type = 'button';
    pushBtn.className = 'repo-sync-btn repo-sync-push';
    const aheadCount = ahead ?? 0;
    pushBtn.textContent = `${aheadCount}\u2191`;
    pushBtn.dataset.repoRoot = repo.rootPath;
    if (aheadCount > 0) {
      pushBtn.classList.add('has-count');
    }
    if (!hasUpstream && aheadCount === 0) {
      pushBtn.disabled = true;
      pushBtn.title = 'No upstream branch configured';
    } else {
      pushBtn.title =
        aheadCount === 1
          ? `Push 1 commit${repo.upstream ? ` to ${repo.upstream}` : ''}`
          : `Push ${aheadCount} commits${repo.upstream ? ` to ${repo.upstream}` : ''}`;
      pushBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (workspace.busy || generatingMessage || pushBtn.disabled) {
          return;
        }
        post({ type: 'openPushDialog', repoRoot: repo.rootPath });
      });
    }

    wrap.appendChild(pullBtn);
    wrap.appendChild(pushBtn);
    return wrap;
  }

  function renderRepoSyncSlot(repo, groupId) {
    const slot = document.createElement('span');
    slot.className = 'repo-sync-slot';
    if (groupId !== 'changes') {
      return slot;
    }
    const syncEl = renderRepoSyncControls(repo);
    if (syncEl) {
      slot.appendChild(syncEl);
    }
    return slot;
  }

  function renderRepoSubgroup(repo, items, groupId, unversionedGroup, focusedRoot, ignoredGroup = false) {
    const wrap = document.createElement('div');
    wrap.className = 'repo-subgroup';
    wrap.dataset.repoRoot = repo.rootPath;
    wrap.dataset.groupId = groupId;
    setCheckPathsMeta(wrap, repo.rootPath, items, unversionedGroup);

    if (focusedRoot && repoKey(repo.rootPath) === repoKey(focusedRoot)) {
      wrap.classList.add('focused');
    }

    const repoCollapsed = collapsedGroups.has(repoCollapseKey(groupId, repo.rootPath));
    const selectedCount = unversionedGroup
      ? items.filter((i) => isUnversionedChecked(repo.rootPath, i.path)).length
      : items.filter((i) => isChangeChecked(repo.rootPath, i.path)).length;

    const head = document.createElement('div');
    head.className = 'repo-subgroup-title collapsible';
    if (isGroupSelected(repo.rootPath, groupId, false)) {
      head.classList.add('selected');
    }

    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.className = 'group-select-all';
    selectAll.title = unversionedGroup ? 'Select all in repository' : 'Include all in commit';
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
          setUnversionedCheckedQuiet(repo.rootPath, item.path, checked);
        }
        persistCheckedUnversioned();
      } else {
        for (const item of items) {
          setChangeCheckedQuiet(repo.rootPath, item.path, checked);
        }
        persistChangeIncludeState();
      }
      syncIncludeCheckboxes();
    });

    const chevron = document.createElement('span');
    chevron.className = 'repo-subgroup-chevron';
    chevron.textContent = repoCollapsed ? '▸' : '▾';

    const colorDot = document.createElement('span');
    colorDot.className = 'repo-color-dot';
    colorDot.style.backgroundColor = repoColor(repo.rootPath);
    colorDot.title = repo.name;

    const name = document.createElement('span');
    name.className = 'repo-subgroup-name';
    name.textContent = repo.name;

    const meta = document.createElement('div');
    meta.className = 'repo-subgroup-meta';

    const count = document.createElement('span');
    count.className = 'repo-subgroup-count';
    count.textContent = formatGroupCount(selectedCount, items.length);

    meta.appendChild(name);
    meta.appendChild(count);

    const badge = document.createElement('span');
    badge.className = 'repo-branch-badge';
    if (repo.branch) {
      badge.textContent = repo.branch;
      badge.title = repo.branch;
    } else {
      badge.classList.add('is-empty');
      badge.title = '';
    }
    meta.appendChild(badge);
    meta.appendChild(renderRepoSyncSlot(repo, groupId));

    head.appendChild(selectAll);
    head.appendChild(chevron);
    head.appendChild(colorDot);
    head.appendChild(meta);

    const groupContext = {
      repoRoot: repo.rootPath,
      groupId,
      items,
      unversionedGroup,
      ignoredGroup,
      category: false,
    };
    attachGroupHeaderInteractions(head, groupContext, items, () =>
      toggleRepoInCategoryCollapsed(groupId, repo.rootPath)
    );
    wrap.appendChild(head);

    if (repoCollapsed) {
      wrap.classList.add('collapsed');
      return wrap;
    }

    if (!items.length) {
      return wrap;
    }

    wrap.appendChild(renderFileList(items, repo.rootPath, unversionedGroup, groupId, groupContext, true));
    return wrap;
  }

  function renderFileList(items, repoRoot, unversionedGroup, groupId, groupContext, nested) {
    if (groupByDirectory) {
      return renderFileTree(items, repoRoot, unversionedGroup, groupId, groupContext, nested);
    }
    return renderFlatFileRows(items, repoRoot, unversionedGroup, groupId, groupContext, nested);
  }

  function renderFlatFileRows(items, repoRoot, unversionedGroup, groupId, groupContext, nested) {
    const list = document.createElement('div');
    list.className = nested ? 'file-rows nested' : 'file-rows';
    const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
    groupContext.items = sorted;
    for (let indexInGroup = 0; indexInGroup < sorted.length; indexInGroup += 1) {
      list.appendChild(
        createFileRow(
          sorted[indexInGroup],
          repoRoot,
          unversionedGroup,
          groupId,
          groupContext,
          indexInGroup,
          0,
          true
        )
      );
    }
    return list;
  }

  function renderFileTree(items, repoRoot, unversionedGroup, groupId, groupContext, nested) {
    const list = document.createElement('div');
    list.className = nested ? 'file-tree nested' : 'file-tree';

    const tree = buildDirTree(items);
    compactDirTree(tree);
    const leafOrder = collectTreeLeaves(tree);
    groupContext.items = leafOrder;
    const indexByPath = new Map(leafOrder.map((item, i) => [item.path, i]));

    function appendNode(parentEl, node, depth) {
      const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
      for (const dirName of dirNames) {
        parentEl.appendChild(renderDirGroup(node.dirs.get(dirName), depth));
      }
      const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
      for (const item of files) {
        parentEl.appendChild(
          createFileRow(item, repoRoot, unversionedGroup, groupId, groupContext, indexByPath.get(item.path) ?? 0, depth, false)
        );
      }
    }

    function renderDirGroup(dirNode, depth) {
      const wrap = document.createElement('div');
      wrap.className = 'dir-group';
      wrap.dataset.dirPath = dirNode.path;
      wrap.dataset.repoRoot = repoRoot;
      wrap.dataset.groupId = groupId;

      const descendantFiles = collectTreeFiles(dirNode);
      const selfDirItem =
        groupContext.ignoredGroup
          ? items.find((i) => i.directory && i.path === dirNode.path)
          : undefined;
      const actionableItems =
        descendantFiles.length > 0
          ? descendantFiles
          : selfDirItem
            ? [selfDirItem]
            : [];
      const fileCount = actionableItems.length;
      setCheckPathsMeta(wrap, repoRoot, actionableItems, unversionedGroup);
      const selectedCount = unversionedGroup
        ? actionableItems.filter((i) => isUnversionedChecked(repoRoot, i.path)).length
        : actionableItems.filter((i) => isChangeChecked(repoRoot, i.path)).length;
      const isCollapsed = collapsedGroups.has(dirCollapseKey(groupId, repoRoot, dirNode.path));

      const head = document.createElement('div');
      head.className = 'dir-group-title collapsible';
      head.style.setProperty('--tree-depth', String(depth));
      head.title = dirNode.path;
      if (isDirSelected(repoRoot, groupId, dirNode.path)) {
        head.classList.add('selected');
      }

      const selectAll = document.createElement('input');
      selectAll.type = 'checkbox';
      selectAll.className = 'group-select-all';
      selectAll.title = unversionedGroup ? 'Select all in folder' : 'Include all in folder';
      selectAll.disabled = fileCount === 0;
      selectAll.checked = fileCount > 0 && selectedCount === fileCount;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < fileCount;
      selectAll.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!fileCount) {
          return;
        }
        const checked = selectAll.checked;
        if (unversionedGroup) {
          for (const item of actionableItems) {
            setUnversionedCheckedQuiet(repoRoot, item.path, checked);
          }
          persistCheckedUnversioned();
        } else {
          for (const item of actionableItems) {
            setChangeCheckedQuiet(repoRoot, item.path, checked);
          }
          persistChangeIncludeState();
        }
        syncIncludeCheckboxes();
      });

      const chevron = document.createElement('span');
      chevron.className = 'dir-group-chevron';
      chevron.textContent = isCollapsed ? '▸' : '▾';

      const folderIcon = document.createElement('span');
      folderIcon.className = 'dir-group-icon';
      folderIcon.setAttribute('aria-hidden', 'true');
      const folderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      folderSvg.setAttribute('viewBox', '0 0 16 16');
      folderSvg.setAttribute('width', '14');
      folderSvg.setAttribute('height', '14');
      folderSvg.setAttribute('focusable', 'false');
      const folderPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      folderPath.setAttribute('fill', 'currentColor');
      folderPath.setAttribute(
        'd',
        'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.3 0 .6.1.8.3L8.2 3.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Z'
      );
      folderSvg.appendChild(folderPath);
      folderIcon.appendChild(folderSvg);

      const name = document.createElement('span');
      name.className = 'dir-group-name';
      name.textContent = dirNode.name;

      const count = document.createElement('span');
      count.className = 'dir-group-count';
      count.textContent = formatGroupCount(selectedCount, fileCount);

      head.appendChild(selectAll);
      head.appendChild(chevron);
      head.appendChild(folderIcon);
      head.appendChild(name);
      head.appendChild(count);

      const toggleCollapse = () => toggleDirCollapsed(groupId, repoRoot, dirNode.path);

      head.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('input')) {
          return;
        }
        if (e.target.closest('.dir-group-chevron')) {
          return;
        }
        const clickKey = `dir|${repoKey(repoRoot)}|${groupId}|${dirNode.path}`;
        if (consumePointerDouble(clickKey)) {
          toggleCollapse();
        }
      });

      head.addEventListener('click', (e) => {
        if (shouldSuppressPointerFollowUp()) {
          e.preventDefault();
          return;
        }
        if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
          return;
        }
        if (e.target.closest('.dir-group-chevron')) {
          toggleCollapse();
          return;
        }
        clearGroupSelection();
        selectDir(repoRoot, groupId, dirNode.path, actionableItems, indexByPath);
        hideContextMenu();
        applyFileListSelectionVisuals();
        if (repoRoot) {
          focusCommitLogRepo(repoRoot, true);
        }
      });

      head.addEventListener('dblclick', (e) => {
        if (shouldSuppressPointerFollowUp()) {
          e.preventDefault();
          return;
        }
        if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
          return;
        }
        if (e.target.closest('.dir-group-chevron')) {
          return;
        }
        e.preventDefault();
        markPointerFollowUpSuppressed();
        toggleCollapse();
      });

      head.addEventListener('contextmenu', (e) => {
        if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
          return;
        }
        e.preventDefault();
        selectDir(repoRoot, groupId, dirNode.path, actionableItems, indexByPath);
        applyFileListSelectionVisuals();
        if (!actionableItems.length) {
          return;
        }
        showContextMenuAt(
          e.clientX,
          e.clientY,
          targetsFromGroup(repoRoot, groupId, actionableItems, unversionedGroup),
          unversionedGroup,
          !!groupContext.ignoredGroup
        );
      });

      wrap.appendChild(head);

      if (isCollapsed) {
        wrap.classList.add('collapsed');
        return wrap;
      }

      const children = document.createElement('div');
      children.className = 'dir-group-children';
      appendNode(children, dirNode, depth + 1);
      wrap.appendChild(children);
      return wrap;
    }

    appendNode(list, tree, 0);
    return list;
  }

  function createFileRow(item, repoRoot, unversionedGroup, groupId, groupContext, indexInGroup, depth, showDir) {
    const gitStaged = item.staged;
    const included = unversionedGroup ? false : isChangeChecked(repoRoot, item.path);
    const row = document.createElement('div');
    const ignoredGroup = !!groupContext.ignoredGroup;
    row.className =
      'file-row ' +
      (ignoredGroup ? 'group-ignored' : unversionedGroup ? 'group-unversioned' : 'group-changes');
    row.dataset.repoRoot = repoRoot;
    row.dataset.filePath = item.path;
    row.dataset.fileStaged = gitStaged ? '1' : '0';
    row.style.setProperty('--tree-depth', String(depth));
    if (isSelectedItem(null, repoRoot, item, gitStaged)) {
      row.classList.add('selected');
    }

    const entry = { repoRoot, path: item.path, staged: gitStaged };

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    if (unversionedGroup) {
      const checked = isUnversionedChecked(repoRoot, item.path);
      checkbox.checked = checked;
      checkbox.title = ignoredGroup
        ? checked
          ? 'Selected to force-add to Git'
          : 'Not selected'
        : checked
          ? 'Selected to add to Git'
          : 'Not selected';
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleUnversionedChecked(repoRoot, item.path, checkbox.checked);
        syncIncludeCheckboxes();
      });
    } else {
      checkbox.checked = included;
      checkbox.title = included ? 'Included in commit' : 'Excluded from commit';
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        setChangeChecked(repoRoot, item.path, checkbox.checked);
        syncIncludeCheckboxes();
      });
    }
    row.appendChild(checkbox);

    const typeIcon = createFileTypeIcon(item.path, !!item.directory);
    const gitLetter = statusLetterLabel(item.status);
    if (gitLetter) {
      typeIcon.title = `Git: ${gitLetter}`;
      typeIcon.dataset.gitStatus = gitLetter;
    }

    const pathEl = document.createElement('span');
    pathEl.className = 'path';
    const { name, dir } = splitPath(item.path);

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = item.directory ? `${name}/` : name;
    pathEl.appendChild(nameEl);

    if (showDir) {
      const dirEl = document.createElement('span');
      dirEl.className = 'file-dir';
      if (unversionedGroup || ignoredGroup) {
        dirEl.textContent = item.path;
        pathEl.appendChild(dirEl);
      } else if (dir) {
        dirEl.textContent = dir;
        pathEl.appendChild(dirEl);
      }
    }

    if (item.unsaved) {
      const unsavedEl = document.createElement('span');
      unsavedEl.className = 'file-unsaved';
      unsavedEl.textContent = '(unsaved)';
      pathEl.appendChild(unsavedEl);
    }

    const statusHint = gitLetter ? ` [${gitLetter}]` : '';
    pathEl.title = item.unsaved
      ? `${item.path}${statusHint} — unsaved`
      : ignoredGroup
        ? `${item.path}${statusHint} — ignored by Git; right-click to force-add`
        : unversionedGroup
          ? `${item.path}${statusHint} — checked = add to Git (Ctrl+Alt+A); right-click for more`
          : `${item.path}${statusHint} — checked = commit; right-click for more`;

    row.appendChild(typeIcon);
    row.appendChild(pathEl);
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('input')) {
        return;
      }
      const clickKey = `file|${repoKey(repoRoot)}|${item.path}|${gitStaged ? '1' : '0'}`;
      if (consumePointerDouble(clickKey)) {
        openFileDiff(entry, groupId, indexInGroup);
      }
    });
    row.addEventListener('click', (e) => {
      if (shouldSuppressPointerFollowUp()) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
        return;
      }
      handleFileSelectionClick(e, entry, groupContext, indexInGroup);
      hideContextMenu();
      applyFileListSelectionVisuals();
    });
    row.addEventListener('dblclick', (e) => {
      if (shouldSuppressPointerFollowUp()) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('input') || e.target.closest('.repo-sync-btn')) {
        return;
      }
      e.preventDefault();
      markPointerFollowUpSuppressed();
      openFileDiff(entry, groupId, indexInGroup);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearGroupSelection();
      if (selectedFiles.length <= 1 || !isFileSelected(repoRoot, item, gitStaged)) {
        selectedFiles = [entry];
        selectionAnchor = { repoRoot, groupId, index: indexInGroup };
      }
      syncSelectionToHost();
      applyFileListSelectionVisuals();
      showContextMenuAt(
        e.clientX,
        e.clientY,
        targetsForContextMenu(entry, groupContext, indexInGroup),
        unversionedGroup,
        !!groupContext.ignoredGroup
      );
    });
    return row;
  }

  function validateBeforeCommit() {
    const message = messageEl.value.trim();
    if (!message) {
      setCommitFormExpanded(true);
      showFormError('Commit message cannot be empty.');
      messageEl.focus();
      return null;
    }
    if (!totalIncludableCount()) {
      showFormError('Select files to include in the commit.');
      return null;
    }
    showFormError('');
    return message;
  }

  function hasCommitCandidates() {
    return totalIncludableCount() > 0;
  }

  function closeRollbackModal() {
    rollbackModal.classList.add('hidden');
    pendingRollback = null;
  }

  function openRollbackModal(payload) {
    pendingRollback = payload;
    if (payload.batch) {
      if (payload.allUntracked) {
        rollbackTitle.textContent = 'Delete Files';
        rollbackSummary.textContent = `Will delete ${payload.paths.length} unversioned files. This cannot be undone.`;
      } else if (payload.paths.every((p) => p.staged)) {
        rollbackTitle.textContent = 'Unstage Files';
        rollbackSummary.textContent = `Will unstage ${payload.paths.length} files (one step back). Staged new files return to Unversioned.`;
      } else {
        rollbackTitle.textContent = 'Rollback Files';
        rollbackSummary.textContent = `Will roll back ${payload.paths.length} files one step (unstage if staged, otherwise restore to Git HEAD).`;
      }
    } else if (payload.isUntracked) {
      rollbackTitle.textContent = 'Delete File';
      rollbackSummary.textContent = `Will delete unversioned file "${payload.path}". This cannot be undone.`;
    } else if (payload.staged) {
      rollbackTitle.textContent = 'Unstage File';
      rollbackSummary.textContent = `Will unstage "${payload.path}" (one step back). New files return to Unversioned; the file is not deleted.`;
    } else {
      rollbackTitle.textContent = 'Rollback File';
      rollbackSummary.textContent = `Will restore "${payload.path}" to the version in Git (discarding local changes). This cannot be undone.`;
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

  function runCommit() {
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    const unversionedPaths = collectCheckedUnversionedPaths();
    const checkedChanges = collectCheckedChangesPaths();
    clearUnversionedChecks(unversionedPaths);
    cacheLastCommitMessage(message);
    post({ type: 'commit', message, checkedChanges, unversionedPaths });
  }

  function runCommitAndPush() {
    closeCommitPushMenu();
    if (!hasCommitCandidates()) {
      showFormError('');
      post({ type: 'openPushDialog' });
      return;
    }
    const message = validateBeforeCommit();
    if (!message) {
      return;
    }
    const unversionedPaths = collectCheckedUnversionedPaths();
    const checkedChanges = collectCheckedChangesPaths();
    clearUnversionedChecks(unversionedPaths);
    cacheLastCommitMessage(message);
    post({ type: 'commitAndPush', message, checkedChanges, unversionedPaths });
  }

  commitBtn.addEventListener('click', () => {
    runCommit();
  });

  commitPushBtn.addEventListener('click', () => {
    runCommitAndPush();
  });

  function isCommitPushMenuOpen() {
    return !!(commitPushMenu && !commitPushMenu.classList.contains('hidden'));
  }

  function openCommitPushMenu() {
    if (!commitPushMenu || !commitPushSplit || !commitPushMenuBtn) {
      return;
    }
    commitPushMenu.classList.remove('hidden');
    commitPushSplit.classList.add('is-open');
    commitPushMenuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeCommitPushMenu() {
    if (!commitPushMenu || !commitPushSplit || !commitPushMenuBtn) {
      return;
    }
    commitPushMenu.classList.add('hidden');
    commitPushSplit.classList.remove('is-open');
    commitPushMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleCommitPushMenu() {
    if (isCommitPushMenuOpen()) {
      closeCommitPushMenu();
    } else {
      openCommitPushMenu();
    }
  }

  function updateFastPushTitle() {
    if (!fastPushBtn) {
      return;
    }
    const e = fastPushSettings.effective || {};
    const steps = [
      e.autoGenerateCommit ? 'generate commit message' : 'use Commit Message box',
      'commit',
      e.autoNewTag ? 'auto-bump latest remote v* tag' : 'skip new tag',
      e.autoPush ? 'push (auto-merge on reject; conflicts → manual merge)' : 'open Push dialog',
    ];
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const shortcut = isMac ? 'Cmd+Alt+K' : 'Ctrl+Alt+K';
    fastPushBtn.title =
      `Fast Push (${shortcut}): ${steps.join(' → ')}. Use ⚙ for settings. Workspace overrides Global. ` +
      'Defaults: generate on, tag off, push on.';
  }

  function updateCommitActionTitles() {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    if (commitBtn) {
      commitBtn.title = isMac ? 'Commit (Cmd+Enter)' : 'Commit (Ctrl+Enter)';
    }
    if (commitPushBtn) {
      commitPushBtn.title = isMac
        ? 'Commit and Push (Cmd+Shift+Enter)'
        : 'Commit and Push (Ctrl+Shift+Enter)';
    }
    updateFastPushTitle();
  }

  function fillFastPushSettingsForm(payload) {
    fastPushSettings = payload || fastPushSettings;
    const ws = fastPushSettings.workspace || {};
    const gl = fastPushSettings.global || {};
    const capability = fastPushSettings.autoGenerateCommitCapability || { available: true };
    const generateAvailable = capability.available !== false;

    if (fpWsGenerate) {
      fpWsGenerate.checked = generateAvailable && !!ws.autoGenerateCommit;
      fpWsGenerate.disabled = !generateAvailable;
    }
    if (fpGlGenerate) {
      fpGlGenerate.checked = generateAvailable && !!gl.autoGenerateCommit;
      fpGlGenerate.disabled = !generateAvailable;
    }
    if (fpWsTag) {
      fpWsTag.checked = !!ws.autoNewTag;
    }
    if (fpGlTag) {
      fpGlTag.checked = !!gl.autoNewTag;
    }
    if (fpWsPush) {
      fpWsPush.checked = !!ws.autoPush;
    }
    if (fpGlPush) {
      fpGlPush.checked = !!gl.autoPush;
    }

    if (fpGenerateRow) {
      fpGenerateRow.classList.toggle('is-disabled', !generateAvailable);
    }
    if (fpGenerateUnavailable) {
      if (generateAvailable) {
        fpGenerateUnavailable.textContent = '';
        fpGenerateUnavailable.classList.add('hidden');
      } else {
        fpGenerateUnavailable.textContent =
          capability.reason ||
          'Auto-generate commit requires Cursor (generate commit command) or GitHub Copilot in VS Code.';
        fpGenerateUnavailable.classList.remove('hidden');
      }
    }

    updateCommitActionTitles();
  }

  function readFastPushSettingsForm() {
    const capability = fastPushSettings.autoGenerateCommitCapability || { available: true };
    const generateAvailable = capability.available !== false;
    return {
      workspace: {
        autoGenerateCommit: generateAvailable && !!(fpWsGenerate && fpWsGenerate.checked),
        autoNewTag: !!(fpWsTag && fpWsTag.checked),
        autoPush: !!(fpWsPush && fpWsPush.checked),
      },
      global: {
        autoGenerateCommit: generateAvailable && !!(fpGlGenerate && fpGlGenerate.checked),
        autoNewTag: !!(fpGlTag && fpGlTag.checked),
        autoPush: !!(fpGlPush && fpGlPush.checked),
      },
    };
  }

  function fillCommitMessagePrefixSettingsForm(payload) {
    commitMessagePrefixSettings = payload || commitMessagePrefixSettings;
    const ws = commitMessagePrefixSettings.workspace || {};
    const gl = commitMessagePrefixSettings.global || {};
    const displayPrefix =
      ws.enabled
        ? typeof ws.prefix === 'string'
          ? ws.prefix
          : ''
        : gl.enabled
          ? typeof gl.prefix === 'string'
            ? gl.prefix
            : ''
          : '';
    const displayPrompt =
      ws.promptEnabled
        ? (typeof ws.prompt === 'string' && ws.prompt.trim()
            ? ws.prompt
            : typeof gl.prompt === 'string'
              ? gl.prompt
              : '')
        : gl.promptEnabled
          ? typeof gl.prompt === 'string'
            ? gl.prompt
            : ''
          : '';
    if (cmpPrefixInput) {
      cmpPrefixInput.value = displayPrefix;
    }
    if (cmpPromptInput) {
      cmpPromptInput.value = displayPrompt;
    }
    if (cmpWsEnabled) {
      cmpWsEnabled.checked = !!ws.enabled;
    }
    if (cmpGlEnabled) {
      cmpGlEnabled.checked = !!gl.enabled;
    }
    if (cmpWsPromptEnabled) {
      cmpWsPromptEnabled.checked = !!ws.promptEnabled;
    }
    if (cmpGlPromptEnabled) {
      cmpGlPromptEnabled.checked = !!gl.promptEnabled;
    }
  }

  function readCommitMessagePrefixSettingsForm() {
    const prefix = (cmpPrefixInput?.value || '').trim();
    const prompt = (cmpPromptInput?.value || '').trim();
    const wsEnabled = !!(cmpWsEnabled && cmpWsEnabled.checked);
    const glEnabled = !!(cmpGlEnabled && cmpGlEnabled.checked);
    const wsPromptEnabled = !!(cmpWsPromptEnabled && cmpWsPromptEnabled.checked);
    const glPromptEnabled = !!(cmpGlPromptEnabled && cmpGlPromptEnabled.checked);
    const wsCurrent = commitMessagePrefixSettings.workspace || {};
    const glCurrent = commitMessagePrefixSettings.global || {};
    return {
      workspace: {
        enabled: wsEnabled,
        prefix: wsEnabled ? prefix : (typeof wsCurrent.prefix === 'string' ? wsCurrent.prefix : ''),
        promptEnabled: wsPromptEnabled,
        prompt: wsPromptEnabled
          ? prompt
          : typeof wsCurrent.prompt === 'string'
            ? wsCurrent.prompt
            : '',
      },
      global: {
        enabled: glEnabled,
        prefix: glEnabled ? prefix : (typeof glCurrent.prefix === 'string' ? glCurrent.prefix : ''),
        promptEnabled: glPromptEnabled,
        prompt: glPromptEnabled
          ? prompt
          : typeof glCurrent.prompt === 'string'
            ? glCurrent.prompt
            : '',
      },
    };
  }

  function openCommitMessagePrefixModal() {
    if (!commitMsgPrefixModal) {
      return;
    }
    post({ type: 'getCommitMessagePrefixSettings' });
    commitMsgPrefixModal.classList.remove('hidden');
    cmpPrefixInput?.focus();
  }

  function closeCommitMessagePrefixModal() {
    if (!commitMsgPrefixModal) {
      return;
    }
    commitMsgPrefixModal.classList.add('hidden');
  }

  function openFastPushSettingsModal() {
    if (!fastPushSettingsModal) {
      return;
    }
    closeCommitPushMenu();
    post({ type: 'getFastPushSettings' });
    fastPushSettingsModal.classList.remove('hidden');
  }

  function closeFastPushSettingsModal() {
    if (!fastPushSettingsModal) {
      return;
    }
    fastPushSettingsModal.classList.add('hidden');
  }

  function runFastPush() {
    if (generatingMessage || workspace.busy) {
      return;
    }
    if (!hasCommitCandidates()) {
      showFormError('');
      post({ type: 'openPushDialog' });
      return;
    }
    showFormError('');
    const message = (messageEl.value || '').trim() || undefined;
    if (message) {
      cacheLastCommitMessage(message);
    }
    const unversionedPaths = collectCheckedUnversionedPaths();
    const checkedChanges = collectCheckedChangesPaths();
    clearUnversionedChecks(unversionedPaths);
    post({ type: 'fastPush', message, checkedChanges, unversionedPaths });
  }

  function showFastPushCommitError(text) {
    if (!fastPushCommitError) {
      return;
    }
    if (!text) {
      fastPushCommitError.textContent = '';
      fastPushCommitError.classList.add('hidden');
      return;
    }
    fastPushCommitError.textContent = text;
    fastPushCommitError.classList.remove('hidden');
  }

  function openFastPushConfirmModal(payload) {
    if (!fastPushConfirmModal) {
      return;
    }
    const steps = payload && Array.isArray(payload.steps) ? payload.steps : [];
    const shortcut = (payload && payload.shortcutLabel) || 'Ctrl+Alt+K';
    if (fastPushConfirmSummary) {
      fastPushConfirmSummary.textContent =
        'Fast Push will run the currently enabled steps on the checked files:';
    }
    if (fastPushConfirmSteps) {
      fastPushConfirmSteps.innerHTML = '';
      for (const step of steps) {
        const li = document.createElement('li');
        li.textContent = step;
        fastPushConfirmSteps.appendChild(li);
      }
    }
    if (fastPushConfirmHint) {
      fastPushConfirmHint.textContent = `Press Enter or ${shortcut} again to confirm. Press Esc to cancel. This extra step avoids accidental Fast Push from the shortcut.`;
    }
    fastPushConfirmModal.classList.remove('hidden');
    fastPushConfirmOk?.focus();
  }

  function closeFastPushConfirmModal(confirmed) {
    if (!fastPushConfirmModal) {
      return;
    }
    fastPushConfirmModal.classList.add('hidden');
    if (confirmed) {
      post({ type: 'fastPushConfirmAck' });
      runFastPush();
      return;
    }
    post({ type: 'fastPushConfirmCancel' });
  }

  function openFastPushCommitModal(payload) {
    if (!fastPushCommitModal) {
      return;
    }
    if (fastPushCommitReason) {
      fastPushCommitReason.textContent =
        (payload && payload.reason) ||
        'Auto-generate commit was blocked. Enter a commit message to continue Fast Push.';
    }
    if (fastPushCommitInput) {
      fastPushCommitInput.value = (payload && payload.draft) || messageEl.value || '';
      fastPushCommitInput.focus();
      const end = fastPushCommitInput.value.length;
      fastPushCommitInput.setSelectionRange(end, end);
    }
    showFastPushCommitError('');
    fastPushCommitModal.classList.remove('hidden');
  }

  function closeFastPushCommitModal(confirmed) {
    if (!fastPushCommitModal) {
      return;
    }
    if (!confirmed) {
      fastPushCommitModal.classList.add('hidden');
      showFastPushCommitError('');
      post({ type: 'fastPushCommitCancel' });
      return;
    }
    const message = (fastPushCommitInput?.value || '').trim();
    if (!message) {
      showFastPushCommitError('Commit message cannot be empty.');
      fastPushCommitInput?.focus();
      return;
    }
    fastPushCommitModal.classList.add('hidden');
    showFastPushCommitError('');
    cacheLastCommitMessage(message);
    messageEl.value = message;
    post({ type: 'fastPushCommitConfirm', message });
  }

  if (commitPushMenuBtn) {
    commitPushMenuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (commitPushMenuBtn.disabled) {
        return;
      }
      toggleCommitPushMenu();
    });
  }

  if (fastPushBtn) {
    fastPushBtn.addEventListener('click', () => {
      closeCommitPushMenu();
      runFastPush();
    });
  }

  if (fastPushSettingsBtn) {
    fastPushSettingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (workspace.busy) {
        return;
      }
      openFastPushSettingsModal();
    });
  }
  if (fastPushSettingsCancel) {
    fastPushSettingsCancel.addEventListener('click', closeFastPushSettingsModal);
  }
  if (fastPushSettingsSave) {
    fastPushSettingsSave.addEventListener('click', () => {
      const { workspace: ws, global: gl } = readFastPushSettingsForm();
      post({ type: 'saveFastPushSettings', workspace: ws, global: gl });
      closeFastPushSettingsModal();
    });
  }
  if (fastPushSettingsModal) {
    fastPushSettingsModal.addEventListener('click', (e) => {
      if (e.target === fastPushSettingsModal) {
        closeFastPushSettingsModal();
      }
    });
  }
  if (generateMsgSettingsBtn) {
    generateMsgSettingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (workspace.busy || generatingMessage) {
        return;
      }
      openCommitMessagePrefixModal();
    });
  }
  if (commitMsgPrefixCancel) {
    commitMsgPrefixCancel.addEventListener('click', closeCommitMessagePrefixModal);
  }
  if (commitMsgPrefixClearGlobal) {
    commitMsgPrefixClearGlobal.addEventListener('click', () => {
      if (workspace.busy || generatingMessage) {
        return;
      }
      post({ type: 'clearCommitMessagePrefixGlobal' });
    });
  }
  if (commitMsgPrefixSave) {
    commitMsgPrefixSave.addEventListener('click', () => {
      const { workspace: ws, global: gl } = readCommitMessagePrefixSettingsForm();
      post({ type: 'saveCommitMessagePrefixSettings', workspace: ws, global: gl });
      closeCommitMessagePrefixModal();
    });
  }
  if (commitMsgPrefixModal) {
    commitMsgPrefixModal.addEventListener('click', (e) => {
      if (e.target === commitMsgPrefixModal) {
        closeCommitMessagePrefixModal();
      }
    });
  }
  if (fastPushConfirmCancel) {
    fastPushConfirmCancel.addEventListener('click', () => closeFastPushConfirmModal(false));
  }
  if (fastPushConfirmOk) {
    fastPushConfirmOk.addEventListener('click', () => closeFastPushConfirmModal(true));
  }
  if (fastPushConfirmModal) {
    fastPushConfirmModal.addEventListener('click', (e) => {
      if (e.target === fastPushConfirmModal) {
        closeFastPushConfirmModal(false);
      }
    });
    fastPushConfirmModal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        closeFastPushConfirmModal(true);
      }
    });
  }
  if (fastPushCommitCancel) {
    fastPushCommitCancel.addEventListener('click', () => closeFastPushCommitModal(false));
  }
  if (fastPushCommitConfirm) {
    fastPushCommitConfirm.addEventListener('click', () => closeFastPushCommitModal(true));
  }
  if (fastPushCommitInput) {
    fastPushCommitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        closeFastPushCommitModal(true);
      }
    });
  }
  if (fastPushCommitModal) {
    fastPushCommitModal.addEventListener('click', (e) => {
      if (e.target === fastPushCommitModal) {
        closeFastPushCommitModal(false);
      }
    });
  }

  generateMsgBtn.addEventListener('click', () => {
    if (generatingMessage || workspace.busy) {
      return;
    }
    setCommitFormExpanded(true);
    if (!totalIncludableCount()) {
      showFormError('Select files to include before generating a commit message.');
      return;
    }
    showFormError('');
    const unversionedPaths = collectCheckedUnversionedPaths();
    const checkedChanges = collectCheckedChangesPaths();
    post({ type: 'generateCommitMessage', checkedChanges, unversionedPaths });
  });

  try {
    commitFormToggle?.addEventListener('click', () => {
      setCommitFormExpanded(!commitFormExpanded);
    });
    bindSectionHeaderToggle(commitForm?.querySelector('.commit-form-header'), () => {
      setCommitFormExpanded(!commitFormExpanded);
    });

    expandAllBtn?.addEventListener('click', () => {
      closeViewOptionsMenu();
      requestExpandCollapse('expand');
    });

    collapseAllBtn?.addEventListener('click', () => {
      closeViewOptionsMenu();
      requestExpandCollapse('collapse');
    });

    expandCollapseAllCancel?.addEventListener('click', () => {
      hideExpandCollapseAllModal();
    });

    expandCollapseAllConfirm?.addEventListener('click', () => {
      const action = pendingExpandCollapseAction;
      hideExpandCollapseAllModal();
      if (action === 'expand' || action === 'collapse') {
        applyExpandCollapse(action, { type: 'all' });
      }
    });

    expandCollapseAllModal?.addEventListener('click', (e) => {
      if (e.target === expandCollapseAllModal) {
        hideExpandCollapseAllModal();
      }
    });

    viewOptionsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleViewOptionsMenu();
    });

    groupByDirectoryChk?.addEventListener('change', () => {
      setGroupByDirectory(groupByDirectoryChk.checked);
    });

    groupByModuleChk?.addEventListener('change', () => {
      setGroupByModule(groupByModuleChk.checked);
    });

    showIgnoredFilesChk?.addEventListener('change', () => {
      setShowIgnoredFiles(showIgnoredFilesChk.checked);
    });

    viewOptionsMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    commitLogToggle?.addEventListener('click', () => {
      setCommitLogExpanded(!commitLogExpanded);
    });
    bindSectionHeaderToggle(commitLogPane?.querySelector('.commit-log-header'), () => {
      setCommitLogExpanded(!commitLogExpanded);
    });

    commitLogRepo?.addEventListener('change', () => {
      const repoRoot = commitLogRepo.value;
      if (!repoRoot) {
        return;
      }
      focusCommitLogRepo(repoRoot, true);
    });

    commitLogRefresh?.addEventListener('click', () => {
      requestCommitLog(commitLogRepoRoot || activeRepoRoot(), { force: true });
    });

    // Event delegation: one set of listeners instead of 3×N per render.
    commitLogList?.addEventListener('click', (e) => {
      const row = e.target?.closest?.('.commit-log-row');
      if (!row || !commitLogList.contains(row)) {
        return;
      }
      selectCommitLogRow(row);
    });

    commitLogList?.addEventListener('mouseover', (e) => {
      const row = e.target?.closest?.('.commit-log-row');
      if (!row || !commitLogList.contains(row)) {
        return;
      }
      if (e.relatedTarget && row.contains(e.relatedTarget)) {
        return;
      }
      showCommitLogTip(row, e.clientX, e.clientY);
    });

    commitLogList?.addEventListener('mousemove', (e) => {
      const row = e.target?.closest?.('.commit-log-row');
      if (!row || !commitLogList.contains(row) || commitLogTipPinned) {
        return;
      }
      if (!commitLogTip || commitLogTip.classList.contains('hidden')) {
        showCommitLogTip(row, e.clientX, e.clientY);
        return;
      }
      // Switch tip when entering another row; keep Copy still so it stays clickable.
      if ((row.dataset.hash || '') !== commitLogTipHash) {
        showCommitLogTip(row, e.clientX, e.clientY);
      }
    });

    commitLogList?.addEventListener('mouseleave', (e) => {
      const next = e.relatedTarget;
      if (next && (next === commitLogTipCopy || commitLogTipCopy?.contains(next))) {
        return;
      }
      hideCommitLogTip(false);
    });

    commitLogTipCopy?.addEventListener('mouseenter', () => {
      clearCommitLogTipHideTimer();
      commitLogTipPinned = true;
    });

    commitLogTipCopy?.addEventListener('mouseleave', (e) => {
      const next = e.relatedTarget;
      if (next && commitLogList?.contains(next)) {
        commitLogTipPinned = false;
        return;
      }
      hideCommitLogTip(false);
    });

    commitLogTipCopy?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyCommitLogTipMessage();
    });

    commitLogList?.addEventListener('dblclick', (e) => {
      const row = e.target?.closest?.('.commit-log-row');
      if (!row || !commitLogList.contains(row)) {
        return;
      }
      e.preventDefault();
      const repoRoot = commitLogRepoRoot || activeRepoRoot();
      const hash = row.dataset.hash;
      if (!repoRoot || !hash) {
        return;
      }
      hideCommitLogTip(true);
      post({ type: 'openCommitChanges', repoRoot, hash });
    });

    commitLogList?.addEventListener('contextmenu', (e) => {
      const row = e.target?.closest?.('.commit-log-row');
      if (!row || !commitLogList.contains(row)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      hideCommitLogTip(true);
      selectCommitLogRow(row);
      showCommitLogContextMenu(e.clientX, e.clientY, {
        repoRoot: commitLogRepoRoot || activeRepoRoot(),
        hash: row.dataset.hash,
        shortHash: row.dataset.shortHash,
        subject: row.dataset.subject,
      });
    });

    if (commitLogPane && commitLogToggle && commitLogRepo && commitLogList) {
      setCommitLogExpanded(commitLogExpanded);
    }
    if (commitForm && commitFormToggle) {
      setCommitFormExpanded(commitFormExpanded);
    }
    if (groupByDirectoryChk) {
      groupByDirectoryChk.checked = groupByDirectory;
    }
    if (groupByModuleChk) {
      groupByModuleChk.checked = groupByModule;
    }
    if (showIgnoredFilesChk) {
      showIgnoredFilesChk.checked = showIgnoredFiles;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showBanner(`Commit Log init failed: ${message}`, 'error');
  }

  (function setupMessageResize() {
    if (!messageEl || !messageResizeEl || !messageFieldEl) {
      return;
    }

    const MIN_HEIGHT = 72;
    const MAX_HEIGHT = () => Math.min(Math.floor(window.innerHeight * 0.28), 200);

    function applyHeight(px) {
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT(), Math.round(px)));
      messageEl.style.height = `${next}px`;
      saveWebviewState({ messageHeight: next });
    }

    const savedHeight = Number(webviewState.messageHeight);
    if (Number.isFinite(savedHeight) && savedHeight >= MIN_HEIGHT) {
      applyHeight(savedHeight);
    } else {
      applyHeight(MIN_HEIGHT);
    }

    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    function onPointerMove(e) {
      if (!dragging) {
        return;
      }
      // Handle is on the top edge: drag up => taller, drag down => shorter.
      applyHeight(startHeight + (startY - e.clientY));
    }

    function onPointerUp(e) {
      if (!dragging) {
        return;
      }
      dragging = false;
      messageFieldEl.classList.remove('is-resizing');
      try {
        messageResizeEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }

    messageResizeEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startHeight = messageEl.getBoundingClientRect().height;
      messageFieldEl.classList.add('is-resizing');
      messageResizeEl.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    messageResizeEl.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 24 : 8;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        applyHeight(messageEl.getBoundingClientRect().height + step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        applyHeight(messageEl.getBoundingClientRect().height - step);
      }
    });
  })();

  messageEl.addEventListener('input', () => {
    saveMessageDraft();
  });

  stageAllBtn.addEventListener('click', () => setAllChangesIncluded(true));
  unstageAllBtn.addEventListener('click', () => setAllChangesIncluded(false));
  refreshBtn.addEventListener('click', () => {
    if (workspace.busy || refreshBtn.classList.contains('is-busy') || refreshBtn.disabled) {
      return;
    }
    setRefreshBusy(true);
    setBusy(true, 'Refreshing…');
    post({ type: 'refresh' });
  });
  locateBtn.addEventListener('click', () => {
    performRevealInExplorer();
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
    if (!updateAllModal) {
      return;
    }
    updateAllModal.classList.add('hidden');
    if (!confirmed) {
      post({ type: 'updateAllCancel' });
      return;
    }
    const selections = collectUpdateAllSelections();
    const repoRoots = selections.filter((s) => s.checked).map((s) => s.rootPath);
    post({ type: 'updateAllConfirm', repoRoots, selections });
  }

  function collectUpdateAllSelections() {
    if (!updateAllRepoList) {
      return [];
    }
    return Array.from(updateAllRepoList.querySelectorAll('input[type="checkbox"][data-root]')).map(
      (input) => ({
        rootPath: input.getAttribute('data-root') || '',
        checked: !!input.checked,
      })
    );
  }

  function persistUpdateAllSelections() {
    const selections = collectUpdateAllSelections();
    post({ type: 'updateAllSelectionChanged', selections });
    updateUpdateAllSummary(selections);
  }

  function updateUpdateAllSummary(selections) {
    if (!updateAllSummary) {
      return;
    }
    const total = selections.length;
    const checked = selections.filter((s) => s.checked).length;
    updateAllSummary.textContent =
      total === 0
        ? 'No Git repositories detected.'
        : `Select repositories to pull (${checked} of ${total} selected).`;
  }

  function openUpdateAllModal(payload) {
    const repos = payload && Array.isArray(payload.repos) ? payload.repos : [];
    if (updateAllRepoList) {
      updateAllRepoList.innerHTML = '';
      for (const repo of repos) {
        const label = document.createElement('label');
        label.className = 'update-all-repo-item';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = repo.checked !== false;
        input.setAttribute('data-root', repo.rootPath || '');
        input.addEventListener('change', persistUpdateAllSelections);

        const meta = document.createElement('span');
        meta.className = 'update-all-repo-meta';
        const name = document.createElement('span');
        name.className = 'update-all-repo-name';
        name.textContent = repo.name || repo.rootPath || 'repository';
        const pathEl = document.createElement('span');
        pathEl.className = 'update-all-repo-path';
        pathEl.textContent = repo.rootPath || '';
        meta.appendChild(name);
        if (repo.rootPath && repo.rootPath !== repo.name) {
          meta.appendChild(pathEl);
        }

        label.appendChild(input);
        label.appendChild(meta);
        updateAllRepoList.appendChild(label);
      }
    }

    if (updateAllHint) {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      updateAllHint.textContent = isMac
        ? 'Press Cmd+T again or click Pull to update the selected repositories. Checkmarks are remembered for next time.'
        : 'Press Ctrl+T again or click Pull to update the selected repositories. Checkmarks are remembered for next time.';
    }

    updateUpdateAllSummary(collectUpdateAllSelections());
    updateAllModal.classList.remove('hidden');
    updateAllConfirmBtn?.focus();
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
    if (pendingRollback.batch) {
      const { paths } = pendingRollback;
      closeRollbackModal();
      post({ type: 'rollbackBatchConfirm', paths });
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
    if (
      commitPushSplit &&
      isCommitPushMenuOpen() &&
      !commitPushSplit.contains(e.target)
    ) {
      closeCommitPushMenu();
    }
    if (
      viewOptionsMenu &&
      !viewOptionsMenu.classList.contains('hidden') &&
      viewOptionsBtn &&
      !viewOptionsBtn.contains(e.target) &&
      !viewOptionsMenu.contains(e.target)
    ) {
      closeViewOptionsMenu();
    }
  });
  window.addEventListener('blur', () => {
    hideContextMenu();
    closeCommitPushMenu();
    closeViewOptionsMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expandCollapseAllModal && !expandCollapseAllModal.classList.contains('hidden')) {
      e.preventDefault();
      hideExpandCollapseAllModal();
      return;
    }
    if (e.key === 'Escape' && fastPushConfirmModal && !fastPushConfirmModal.classList.contains('hidden')) {
      e.preventDefault();
      closeFastPushConfirmModal(false);
      return;
    }
    if (e.key === 'Escape' && fastPushCommitModal && !fastPushCommitModal.classList.contains('hidden')) {
      e.preventDefault();
      closeFastPushCommitModal(false);
      return;
    }
    if (e.key === 'Escape' && fastPushSettingsModal && !fastPushSettingsModal.classList.contains('hidden')) {
      e.preventDefault();
      closeFastPushSettingsModal();
      return;
    }
    if (e.key === 'Escape' && commitMsgPrefixModal && !commitMsgPrefixModal.classList.contains('hidden')) {
      e.preventDefault();
      closeCommitMessagePrefixModal();
      return;
    }
    if (e.key === 'Escape' && isCommitPushMenuOpen()) {
      e.preventDefault();
      closeCommitPushMenu();
      return;
    }
    if (e.key === 'Escape' && viewOptionsMenu && !viewOptionsMenu.classList.contains('hidden')) {
      e.preventDefault();
      closeViewOptionsMenu();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'a' && !e.shiftKey) {
      e.preventDefault();
      performAddToGit();
      return;
    }
    if (!resolveOperationTargets().length) {
      return;
    }
    if (e.key === 'F4' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      performOpenFiles();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'd' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      performShowDiffs();
      return;
    }
    if (key === 'z' && e.altKey && !e.shiftKey) {
      e.preventDefault();
      performRollback();
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
        if (workspace.loading) {
          // Global Working overlay covers first paint; skip the thin top banner.
          showBanner('');
        } else if (workspace.error) {
          showBanner(workspace.error, 'error');
        } else if (active.hint) {
          showBanner(active.hint, 'info');
        } else {
          showBanner('');
        }

        setBusy(
          !!workspace.busy || !!workspace.loading,
          workspace.loading ? workspace.hint || 'Loading Git…' : undefined
        );
        renderRepoSelector();
        pruneCheckedUnversioned();
        pruneChangeIncludeState();

        if (!selectionStillExists()) {
          clearFileSelection();
          clearGroupSelection();
          syncSelectionToHost();
        }
        renderFiles();
        populateCommitLogRepoSelect();
        if (!commitLogRepoRoot && activeRepoRoot()) {
          commitLogRepoRoot = activeRepoRoot();
          populateCommitLogRepoSelect();
        }
        // Only reload history when tip changed / not yet loaded (not on every status refresh).
        if (
          commitLogExpanded &&
          (commitLogRepoRoot || activeRepoRoot()) &&
          !isCommitLogFresh(commitLogRepoRoot || activeRepoRoot())
        ) {
          requestCommitLog(commitLogRepoRoot || activeRepoRoot());
        }
        break;
      }
      case 'commitLog':
        renderCommitLog(msg.payload || { commits: [] });
        break;
      case 'busy':
        setBusy(msg.busy, msg.message);
        break;
      case 'error':
        showHostError(msg.message);
        break;
      case 'fastPushProgress':
        setFastPushProgress(msg);
        break;
      case 'generateCommitMessageState':
        setGenerateBusy(msg.busy);
        break;
      case 'fastPushSettings':
        fillFastPushSettingsForm(msg.payload);
        break;
      case 'commitMessagePrefixSettings':
        fillCommitMessagePrefixSettingsForm(msg.payload);
        break;
      case 'showFastPushCommitDialog':
        openFastPushCommitModal(msg.payload);
        break;
      case 'showFastPushConfirmDialog':
        openFastPushConfirmModal(msg.payload);
        break;
      case 'fastPushConfirmSubmit':
        closeFastPushConfirmModal(true);
        break;
      case 'setMessage': {
        messageEl.value = msg.message || '';
        cacheLastCommitMessage(messageEl.value);
        showFormError('');
        messageEl.focus();
        const end = messageEl.value.length;
        messageEl.setSelectionRange(end, end);
        break;
      }
      case 'showRollbackDialog':
        openRollbackModal(msg.payload);
        break;
      case 'showUpdateAllDialog':
        openUpdateAllModal(msg.payload);
        break;
      case 'updateAllSubmit':
        closeUpdateAllModal(true);
        break;
      case 'clearMessage': {
        messageEl.value = lastCommitMessage || '';
        messageDraft = messageEl.value;
        saveWebviewState({ messageDraft, lastCommitMessage });
        showFormError('');
        break;
      }
      case 'focusMessage':
        setCommitFormExpanded(true);
        messageEl.focus();
        const end = messageEl.value.length;
        messageEl.setSelectionRange(end, end);
        break;
      case 'expandChanges':
        expandChangesGroups();
        break;
      case 'selectFile':
        focusFileSelectionFromHost(msg.repoRoot, msg.path, msg.staged);
        break;
      case 'triggerAddToGit':
        performAddToGit();
        break;
      case 'triggerOpenFile':
        performOpenFiles();
        break;
      case 'triggerShowDiff':
        performShowDiffs();
        break;
      case 'triggerRevealInExplorer':
        performRevealInExplorer();
        break;
      case 'triggerRollback':
        performRollback();
        break;
      case 'triggerCommit':
        runCommit();
        break;
      case 'triggerCommitAndPush':
        runCommitAndPush();
        break;
      case 'triggerFastPush':
        runFastPush();
        break;
    }
  });

  updateCommitActionTitles();
  post({ type: 'ready' });
})();
