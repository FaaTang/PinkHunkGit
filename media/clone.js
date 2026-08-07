(function () {
  const vscode = acquireVsCodeApi();

  const urlInput = document.getElementById('urlInput');
  const urlHistory = document.getElementById('urlHistory');
  const directoryInput = document.getElementById('directoryInput');
  const protocolBadge = document.getElementById('protocolBadge');
  const formError = document.getElementById('formError');
  const browseBtn = document.getElementById('browseBtn');
  const cloneBtn = document.getElementById('cloneBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const closeBtn = document.getElementById('closeBtn');
  const proxyInput = document.getElementById('proxyInput');
  const applyProxyBtn = document.getElementById('applyProxyBtn');
  const clearProxyBtn = document.getElementById('clearProxyBtn');
  const proxyMeta = document.getElementById('proxyMeta');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingMessage = document.getElementById('loadingMessage');
  const stageBadge = document.getElementById('stageBadge');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');

  let defaultParent = '';
  let lastAutoDirectory = '';
  let busy = false;
  let hasAppliedInitialUrlSuggestion = false;
  let lastSizeMeta = { downloadedKB: undefined, totalKB: undefined, speedKBps: undefined };

  function post(message) {
    vscode.postMessage(message);
  }

  function setBusy(isBusy, message) {
    busy = !!isBusy;
    document.body.classList.toggle('busy', busy);
    [cloneBtn, browseBtn, urlInput, directoryInput, proxyInput, applyProxyBtn, clearProxyBtn].forEach((el) => {
      if (el) {
        el.disabled = busy;
      }
    });
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = busy ? 'Force Cancel' : 'Cancel';
    }
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.textContent = busy ? '✕' : '×';
      closeBtn.title = busy ? 'Force Cancel' : 'Close';
    }
    if (loadingOverlay) {
      loadingOverlay.classList.toggle('hidden', !busy);
    }
    if (loadingMessage) {
      if (message) {
        loadingMessage.textContent = message;
      } else if (busy) {
        loadingMessage.textContent = 'Working…';
      }
    }
    if (!busy) {
      updateProgress(undefined, '', undefined, undefined, undefined);
      setStageBadge(undefined, '');
    }
  }

  function inferPhaseByDetail(detail) {
    const text = (detail || '').toLowerCase();
    if (!text) {
      return undefined;
    }
    if (text.includes('enumerating') || text.includes('counting')) {
      return 'counting';
    }
    if (text.includes('compressing')) {
      return 'compressing';
    }
    if (text.includes('receiving')) {
      return 'receiving';
    }
    if (text.includes('resolving')) {
      return 'resolving';
    }
    if (text.includes('updating')) {
      return 'updating';
    }
    if (text.includes('auth') || text.includes('permission denied') || text.includes('passphrase')) {
      return 'authenticating';
    }
    if (text.includes('connect') || text.includes('handshake')) {
      return 'connecting';
    }
    return 'other';
  }

  function setStageBadge(phase, detail) {
    if (!stageBadge) {
      return;
    }
    const inferred = phase || inferPhaseByDetail(detail);
    const labels = {
      connecting: 'Connecting',
      authenticating: 'Authenticating',
      counting: 'Counting',
      compressing: 'Compressing',
      receiving: 'Receiving',
      resolving: 'Resolving',
      updating: 'Updating',
      other: 'Processing',
    };
    const label = inferred ? labels[inferred] || 'Processing' : '';
    if (!label) {
      stageBadge.textContent = '';
      stageBadge.classList.add('hidden');
      return;
    }
    stageBadge.textContent = label;
    stageBadge.classList.remove('hidden');
  }

  function fmtKB(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '';
    }
    return `${Math.max(0, value).toFixed(2)} KB`;
  }

  function updateProgress(percent, detail, downloadedKB, totalKB, speedKBps) {
    if (!progressWrap || !progressBar || !progressText) {
      return;
    }
    if (typeof downloadedKB === 'number') {
      lastSizeMeta.downloadedKB = downloadedKB;
    }
    if (typeof totalKB === 'number') {
      lastSizeMeta.totalKB = totalKB;
    }
    if (typeof speedKBps === 'number') {
      lastSizeMeta.speedKBps = speedKBps;
    }
    const downloadedText = fmtKB(lastSizeMeta.downloadedKB);
    const totalText = fmtKB(lastSizeMeta.totalKB);
    const speedText = fmtKB(lastSizeMeta.speedKBps);
    const sizeParts = [];
    sizeParts.push(`Total ${totalText || 'pending'}`);
    sizeParts.push(`Downloaded ${downloadedText || 'pending'}`);
    if (speedText) {
      sizeParts.push(`Speed ${speedText}/s`);
    }
    const suffix = sizeParts.length ? ` · ${sizeParts.join('，')}` : '';
    if (typeof percent === 'number') {
      const safe = Math.max(0, Math.min(100, percent));
      progressWrap.classList.remove('hidden');
      progressBar.style.width = `${safe}%`;
      progressText.textContent = `${safe}%${detail ? ` · ${detail}` : ''}${suffix}`;
      return;
    }
    if (detail) {
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = `${detail}${suffix}`;
      return;
    }
    progressWrap.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '';
    lastSizeMeta = { downloadedKB: undefined, totalKB: undefined, speedKBps: undefined };
  }

  function showError(message) {
    if (!formError) {
      return;
    }
    if (message) {
      formError.textContent = message;
      formError.classList.remove('hidden');
    } else {
      formError.textContent = '';
      formError.classList.add('hidden');
    }
  }

  function updateProxyMeta(usingSessionProxy, currentProxy) {
    if (!proxyMeta) {
      return;
    }
    if (!currentProxy) {
      proxyMeta.textContent = 'No proxy configured (direct connection).';
      return;
    }
    proxyMeta.textContent = usingSessionProxy
      ? `Current proxy: ${currentProxy} (session only)`
      : `Current proxy: ${currentProxy} (from local Git/env)`;
  }

  function setProtocolBadge(label) {
    if (!protocolBadge) {
      return;
    }
    if (label) {
      protocolBadge.textContent = label;
      protocolBadge.classList.remove('empty');
    } else {
      protocolBadge.textContent = '';
      protocolBadge.classList.add('empty');
    }
  }

  /** Lightweight client-side parse mirroring host cloneUrl helpers. */
  function parseUrlClient(raw) {
    const url = (raw || '').trim();
    if (!url) {
      return { protocol: '', repoName: '' };
    }

    const scp = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(url);
    if (scp) {
      const pathPart = scp[3].replace(/^\/+/, '');
      const parts = pathPart.replace(/\/+$/, '').split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      return {
        protocol: 'SSH',
        repoName: last.replace(/\.git$/i, ''),
      };
    }

    try {
      if (/^(https?|ssh|git):\/\//i.test(url)) {
        const parsed = new URL(url);
        const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
        let protocol = '';
        if (scheme === 'https' || scheme === 'http') {
          protocol = 'HTTPS';
        } else if (scheme === 'ssh') {
          protocol = 'SSH';
        } else if (scheme === 'git') {
          protocol = 'Git';
        }
        const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        const last = parts[parts.length - 1] || '';
        return {
          protocol,
          repoName: decodeURIComponent(last).replace(/\.git$/i, ''),
        };
      }
    } catch {
      // ignore
    }

    return { protocol: '', repoName: '' };
  }

  function joinPath(parent, name) {
    if (!parent) {
      return name || '';
    }
    if (!name) {
      return parent;
    }
    const sep = parent.includes('\\') ? '\\' : '/';
    const trimmed = parent.replace(/[\\/]+$/, '');
    return `${trimmed}${sep}${name}`;
  }

  /** Parent directory of a path; preserves Windows drive roots (e.g. C:\). */
  function parentDir(dir) {
    if (!dir) {
      return '';
    }
    const trimmed = dir.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx < 0) {
      return '';
    }
    if (idx === 0) {
      return trimmed.charAt(0) === '/' ? '/' : '';
    }
    const parent = trimmed.slice(0, idx);
    if (/^[A-Za-z]:$/.test(parent)) {
      return parent + '\\';
    }
    return parent;
  }

  function suggestDirectoryFromUrl() {
    if (!directoryInput) {
      return;
    }
    const { repoName } = parseUrlClient(urlInput ? urlInput.value : '');
    if (!repoName || !defaultParent) {
      return;
    }
    const current = (directoryInput.value || '').trim();
    if (!hasAppliedInitialUrlSuggestion) {
      // First URL input after opening dialog: always append repo name directly.
      const base = current || defaultParent;
      const suggested = joinPath(base, repoName);
      directoryInput.value = suggested;
      lastAutoDirectory = suggested;
      hasAppliedInitialUrlSuggestion = true;
      return;
    }
    const wasAutoFilled =
      !current || current === lastAutoDirectory || current === defaultParent;
    if (!wasAutoFilled) {
      return;
    }
    // Prefer parent of the current auto path so a browse-selected parent is kept
    // when only the repo name from the URL changes (not always defaultParent).
    let parent = defaultParent;
    if (current && current === lastAutoDirectory) {
      parent = parentDir(current) || defaultParent;
    }
    const suggested = joinPath(parent, repoName);
    directoryInput.value = suggested;
    lastAutoDirectory = suggested;
  }

  function onUrlChanged() {
    showError('');
    const parsed = parseUrlClient(urlInput ? urlInput.value : '');
    setProtocolBadge(parsed.protocol || '');
    suggestDirectoryFromUrl();
    post({ type: 'urlChanged', url: urlInput ? urlInput.value : '' });
  }

  function fillRecentUrls(urls) {
    if (!urlHistory) {
      return;
    }
    urlHistory.innerHTML = '';
    (urls || []).forEach((item) => {
      const option = document.createElement('option');
      option.value = item;
      urlHistory.appendChild(option);
    });
  }

  function applyState(payload) {
    if (!payload) {
      return;
    }
    fillRecentUrls(payload.recentUrls || []);
    if (typeof payload.defaultDirectory === 'string' && payload.defaultDirectory) {
      defaultParent = payload.defaultDirectory;
      if (directoryInput && !(directoryInput.value || '').trim()) {
        directoryInput.value = defaultParent;
        lastAutoDirectory = defaultParent;
      }
    }
    if (typeof payload.busy === 'boolean') {
      setBusy(payload.busy, payload.busy ? 'Cloning…' : undefined);
    }
    if (proxyInput && typeof payload.currentProxy === 'string') {
      proxyInput.value = payload.currentProxy;
    } else if (proxyInput && payload.currentProxy == null) {
      proxyInput.value = '';
    }
    updateProxyMeta(!!payload.usingSessionProxy, payload.currentProxy || '');
    suggestDirectoryFromUrl();
  }

  function submitClone() {
    if (busy) {
      return;
    }
    showError('');
    const url = (urlInput ? urlInput.value : '').trim();
    const directory = (directoryInput ? directoryInput.value : '').trim();
    if (!url) {
      showError('URL is required.');
      urlInput && urlInput.focus();
      return;
    }
    if (!directory) {
      showError('Directory is required.');
      directoryInput && directoryInput.focus();
      return;
    }
    post({ type: 'clone', url, directory });
  }

  if (urlInput) {
    urlInput.addEventListener('input', onUrlChanged);
    urlInput.addEventListener('change', onUrlChanged);
  }

  if (directoryInput) {
    directoryInput.addEventListener('input', () => {
      showError('');
    });
  }

  if (browseBtn) {
    browseBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      post({ type: 'pickDirectory', url: urlInput ? urlInput.value : '' });
    });
  }

  if (cloneBtn) {
    cloneBtn.addEventListener('click', submitClone);
  }

  if (applyProxyBtn) {
    applyProxyBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      post({ type: 'setSessionProxy', proxy: proxyInput ? proxyInput.value : '' });
    });
  }

  if (clearProxyBtn) {
    clearProxyBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      if (proxyInput) {
        proxyInput.value = '';
      }
      post({ type: 'setSessionProxy', proxy: '' });
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => post({ type: busy ? 'cancelClone' : 'cancel' }));
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => post({ type: busy ? 'cancelClone' : 'cancel' }));
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      post({ type: busy ? 'cancelClone' : 'cancel' });
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitClone();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) {
      return;
    }
    switch (msg.type) {
      case 'state':
        applyState(msg.payload);
        break;
      case 'busy':
        setBusy(msg.busy, msg.message);
        break;
      case 'cloneProgress':
        updateProgress(
          msg.percent,
          msg.detail || '',
          msg.downloadedKB,
          msg.totalKB,
          msg.speedKBps
        );
        setStageBadge(msg.phase, msg.detail || '');
        if (msg.detail && loadingMessage) {
          loadingMessage.textContent = msg.detail;
        }
        break;
      case 'error':
        setBusy(false);
        showError(msg.message || 'Clone failed.');
        break;
      case 'protocolDetected':
        setProtocolBadge(msg.protocol || '');
        break;
      case 'directoryPicked':
        if (directoryInput && typeof msg.directory === 'string') {
          directoryInput.value = msg.directory;
          lastAutoDirectory = msg.directory;
        }
        showError('');
        break;
      case 'cloneSuccess':
        setBusy(false);
        break;
      case 'close':
        break;
      default:
        break;
    }
  });

  post({ type: 'ready' });
})();
