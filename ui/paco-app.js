/**
 * ui/paco-app.js
 *
 * Thin wiring layer. All logic lives in paco/ui-state.js (pure, testable).
 * This file only:
 *   1. Owns the single mutable appState object
 *   2. Maps DOM events → state transitions → renders
 *   3. Maps WS pushes → state transitions → renders
 *   4. Drives the boot sequence via nextBootAction / advanceBootPhase
 *
 * Rule: if a function here has a branch that can be tested without a browser,
 * it belongs in ui-state.js instead.
 */

(function () {
  'use strict';

  const S = window.uiState;

  // ─── App state (single mutable object) ───────────────────────────────────────

  let appState = S.makeAppState();

  // Selection is kept as a Set in the UI for O(1) lookup; ui-state uses arrays.
  // We bridge via these helpers.
  const selSets = { left: new Set(), right: new Set() };

  function selArray(side) { return [...selSets[side]]; }

  // ─── DOM refs ─────────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const dom = {
    html:       document.documentElement,
    connDot:    $('conn-dot'),
    busyBar:    $('busy-bar'),
    busyMsg:    $('busy-msg'),
    busyPct:    $('busy-pct'),
    busyFill:   $('busy-progress-fill'),
    busyAbort:  $('busy-abort'),
    btnRefresh: $('btn-refresh'),
    btnConfig:  $('btn-config'),
    overlay:    $('overlay-bg'),
    ovTitle:    $('overlay-title'),
    ovMsg:      $('overlay-msg'),
    ovInput:    $('overlay-input'),
    ovBtns:     $('overlay-btns'),
    fkView:     $('fk-view'),
    fkEdit:     $('fk-edit'),
    fkCopy:     $('fk-copy'),
    fkRename:   $('fk-rename'),
    fkMove:     $('fk-move'),
    fkMkdir:    $('fk-mkdir'),
    fkDelete:   $('fk-delete'),
  };

  function pd(side) {
    return {
      panel:   $(`panel-${side}`),
      tabs:    $(`tabs-${side}`),
      up:      $(`up-${side}`),
      vol:     $(`vol-${side}`),
      bread:   $(`bread-${side}`),
      list:    $(`list-${side}`),
      statCnt: $(`status-${side}-count`),
      statSel: $(`status-${side}-sel`),
    };
  }

  // ─── Navigate ─────────────────────────────────────────────────────────────────

  function navigate(side, targetPath, opts = {}) {
    if (appState.busy) { console.warn('[PACO] navigate blocked — busy'); return; }
    const p        = appState.panels[side];
    const taskPath = targetPath || p.path || '';
    const tabId    = opts.tabId || p.activeTab;
    console.log('[PACO] navigate', side, taskPath, 'tab:', tabId);
    adapter.assign('worker/tasks/navigate.js', {
      panel:       side,
      path:        taskPath,
      tabId,
      // Send current tab structure so the task writes authoritative state to disk
      tabs:        p.tabs,
      activeTab:   tabId,
      pushHistory: opts.pushHistory !== false,
    }).then(r => console.log('[PACO] assign accepted', r))
      .catch(err => { console.error('[PACO] assign failed', err); showError('Navigation failed', err.message); });
  }

  // Drain the watch queue: navigate panels one at a time.
  // Called after a watch batch timer fires, and again from the done handler
  // when _watchQueue still has entries.
  function _drainWatchQueue() {
    const queue = appState._watchQueue;
    if (!queue || queue.length === 0 || appState.busy) return;
    const side = queue[0];
    appState = { ...appState, _watchQueue: queue.slice(1) };
    navigate(side, appState.panels[side].path, { pushHistory: false });
  }

  // ─── WS state handler ─────────────────────────────────────────────────────────

  adapter.onStateChange(function onWsMsg(ws) {
    if (!ws) return;

    const s = ws.state || 'idle';
    console.log('[PACO ws]', s, ws.percent != null ? ws.percent+'%' : '', ws.message || '', ws.result ? '(has result)' : '');
    dom.connDot.className = 'conn-dot ok';

    // ── Busy bar ────────────────────────────────────────────────────────────
    const busy = S.busyStateFrom(ws);
    if (busy) {
      appState = { ...appState, busy: true };
      dom.busyBar.classList.add('visible');
      dom.busyMsg.textContent      = busy.msg;
      dom.busyFill.style.width     = busy.pct + '%';
      dom.busyPct.textContent      = busy.pct + '%';
      dom.connDot.className        = 'conn-dot busy';
      _copyDlgProgress(ws);
    } else if (s !== 'running') {
      appState = { ...appState, busy: false };
      dom.busyBar.classList.remove('visible');
    }

    // ── Task result ─────────────────────────────────────────────────────────
    if (s === 'done' && ws.result) {
      const result = ws.result;

      // Tasks returning both panels embed { left, right } sub-payloads;
      // single-panel tasks return a direct payload. Apply whichever are present.
      const payloads = [];
      if (result.panel)                       payloads.push(result);
      if (result.left  && result.left.panel)  payloads.push(result.left);
      if (result.right && result.right.panel) payloads.push(result.right);

      for (const payload of payloads) {
        const newPanels = S.applyNavigateResult(appState.panels, payload);
        if (newPanels !== appState.panels) {
          appState = { ...appState, panels: newPanels };
          selSets[payload.panel].clear();
          if (payload.config) {
            appState = { ...appState, config: payload.config };
            dom.html.setAttribute('data-theme', payload.config.theme || 'dark');
          }
          if (payload.platform) {
            appState = { ...appState, platform: payload.platform };
          }
          renderPanel(payload.panel);
        }
      }
      if (payloads.length > 0) renderFkeys();

      // Surface per-item errors from move / delete (copy uses its own dialog)
      if (result.errors && result.errors.length > 0 && !result.stats) {
        showError('Some items failed', result.errors.join('\n'));
      }

      // Copy dialog completion
      if (result.stats !== undefined) {
        _copyDlgDone(result);
      }

      // Mkdir dialog completion
      if (mkdirDlg._resultResolve) {
        const resolve = mkdirDlg._resultResolve;
        mkdirDlg._resultResolve = null;
        resolve({ ok: true });
      }

      // Rename dialog completion
      if (renameDlg._resultResolve) {
        const resolve = renameDlg._resultResolve;
        renameDlg._resultResolve = null;
        resolve({ ok: true });
      }

      // F4 "Open with…" completion — unlike mkdir/rename, the result payload
      // itself matters (action: 'open'|'nativeOpen'|'lister'|'none'), so it's
      // forwarded as-is rather than collapsed to a bare { ok: true }.
      if (appState._openWithResolve) {
        const resolve = appState._openWithResolve;
        appState = { ...appState, _openWithResolve: null };
        resolve({ ok: true, result });
      }

      // Continue draining watch queue if more panels need refreshing
      if (appState._watchQueue && appState._watchQueue.length > 0) {
        adapter.reset().then(() => _drainWatchQueue()).catch(() => {});
        return;
      }

      // ── Boot sequencing ────────────────────────────────────────────────
      const bootAction = S.nextBootAction(appState.bootPhase, ws);
      appState = { ...appState, bootPhase: S.advanceBootPhase(appState.bootPhase, bootAction.action) };

      if (bootAction.action === 'navigate-right') {
        // reset then navigate — single reset, early return skips the one below
        adapter.reset().then(() => navigate('right', '')).catch(() => {});
        return;
      }

      adapter.reset().catch(() => {});
    }

    if (s === 'error') {
      appState = { ...appState, busy: false };
      dom.busyBar.classList.remove('visible');
      const errMsg = ws.message || '';
      const isStateMachineViolation = /Cannot \w+ from state/.test(errMsg);
      if (!isStateMachineViolation) {
        // task-shell sends EVT.STATUS_UPDATE then EVT.TASK_ERROR for the same
        // error, producing two identical WS pushes. Only handle the first one.
        if (errMsg && errMsg === appState._lastErrorMsg) {
          // duplicate — ignore, but still reset
          appState = { ...appState, _lastErrorMsg: null };
          adapter.reset().catch(() => {});
        } else {
          appState = { ...appState, _lastErrorMsg: errMsg };
          if (mkdirDlg._resultResolve) {
            const resolve = mkdirDlg._resultResolve;
            mkdirDlg._resultResolve = null;
            resolve({ ok: false, error: errMsg || 'Unknown error' });
          } else if (renameDlg._resultResolve) {
            const resolve = renameDlg._resultResolve;
            renameDlg._resultResolve = null;
            resolve({ ok: false, error: errMsg || 'Unknown error' });
          } else if (appState._openWithResolve) {
            const resolve = appState._openWithResolve;
            appState = { ...appState, _openWithResolve: null };
            resolve({ ok: false, error: errMsg || 'Unknown error' });
          } else {
            showError('Error', errMsg || 'Unknown error');
          }
          adapter.reset().catch(() => {});
        }
      }
    }

    if (s === 'aborted') {
      appState = { ...appState, busy: false };
      dom.busyBar.classList.remove('visible');
      adapter.reset().catch(() => {});
    }

    // ── External change (watcher) ────────────────────────────────────────
    if (s === 'watch' && ws.panel && ws.path) {
      if (appState.bootPhase === 'ready' && !appState.busy) {
        // Collect panels to refresh within a 200ms window, then refresh
        // sequentially (left first, right after done) to handle the common
        // case where both panels show the same directory.
        const pending = appState._watchPending || new Set();
        pending.add(ws.panel);
        clearTimeout(appState._watchTimer);
        const timer = setTimeout(() => {
          if (appState.busy) return;
          // Refresh left first if needed, right will follow via _watchRight flag
          const sides = [...pending].sort(); // 'left' before 'right'
          appState = { ...appState, _watchPending: null, _watchTimer: null, _watchQueue: sides };
          _drainWatchQueue();
        }, 200);
        appState = { ...appState, _watchPending: pending, _watchTimer: timer };
      }
      return;
    }

    // ── Boot trigger on first idle ───────────────────────────────────────
    const bootAction = S.nextBootAction(appState.bootPhase, ws);
    console.log('[PACO boot]', appState.bootPhase, s, '->', bootAction.action);
    if (bootAction.action === 'navigate-left') {
      appState = { ...appState, bootPhase: S.advanceBootPhase(appState.bootPhase, bootAction.action) };
      navigate('left', '');
    }
  });

  // ─── Rendering ────────────────────────────────────────────────────────────────

  function renderPanel(side) {
    const p = appState.panels[side];
    renderTabs(side, p);
    renderBreadcrumb(side, p);
    renderVolumes(side, p);
    renderList(side, p);
    renderStatus(side, p);
  }

  function renderTabs(side, p) {
    const el = pd(side).tabs;
    el.innerHTML = '';

    p.tabs.forEach(tab => {
      const label = tab.label || S.shortenPath(tab.path);
      const t = document.createElement('div');
      t.className = 'tab' + (tab.id === p.activeTab ? ' active' : '');
      t.title = tab.path;

      const lbl = document.createElement('span');
      lbl.textContent = label;
      t.appendChild(lbl);

      if (p.tabs.length > 1) {
        const cls = document.createElement('span');
        cls.className = 'tab-close';
        cls.textContent = '✕';
        cls.addEventListener('click', e => { e.stopPropagation(); onCloseTab(side, tab.id); });
        t.appendChild(cls);
      }

      t.addEventListener('click', () => onSwitchTab(side, tab.id));
      el.appendChild(t);
    });

    const add = document.createElement('div');
    add.className = 'tab-add';
    add.textContent = '+';
    add.title = 'New tab';
    add.addEventListener('click', () => onAddTab(side));
    el.appendChild(add);
  }

  function renderBreadcrumb(side, p) {
    const el = pd(side).bread;
    el.innerHTML = '';
    const isWin  = (p.path || '').includes('\\');
    const sep    = isWin ? '\\' : '/';
    const crumbs = p.breadcrumbs || buildCrumbsFromPath(p.path);

    crumbs.forEach((c, i, arr) => {
      const isLast  = i === arr.length - 1;
      const isRoot  = c.label === '/' || c.label === sep;

      const span = document.createElement('span');
      span.className = isLast ? 'crumb crumb-current' : 'crumb';
      span.title = c.path;

      if (isRoot) {
        // Root crumb: show just "/" — separator role is baked into the label
        span.textContent = sep;
        if (!isLast) span.addEventListener('click', () => navigate(side, c.path));
        el.appendChild(span);
        // No explicit separator after root — the next label follows directly
      } else {
        // Normal segment: "foldername /"  (separator trails the label)
        span.textContent = isLast ? c.label : c.label + ' ' + sep;
        if (!isLast) span.addEventListener('click', () => navigate(side, c.path));
        el.appendChild(span);
      }

      // Add a small gap between segments for readability
      if (!isLast && !isRoot) {
        const gap = document.createElement('span');
        gap.className = 'crumb-gap';
        el.appendChild(gap);
      }
    });
  }

  function buildCrumbsFromPath(dirPath) {
    if (!dirPath) return [];
    const sep   = dirPath.includes('\\') ? '\\' : '/';
    const parts = dirPath.split(sep).filter(Boolean);
    const crumbs = [];
    if (sep === '/') crumbs.push({ label: '/', path: '/' });
    let acc = sep === '/' ? '/' : '';
    parts.forEach(part => {
      acc = acc === '/' ? '/' + part : acc + sep + part;
      crumbs.push({ label: part, path: acc });
    });
    return crumbs;
  }

  function renderVolumes(side, p) {
    const sel = pd(side).vol;
    let vols = p.volumes || [];
    if (vols.length === 0) return;
    // On macOS, '/' is the root of the system volume and is also reachable
    // via /Volumes/Macintosh HD (or similar). Showing bare '/' alongside a
    // named volume is redundant and confusing — filter it out when there are
    // other volumes available.
    if (vols.length > 1) {
      vols = vols.filter(v => v !== '/');
    }
    sel.innerHTML = '';
    vols.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
    // Select the volume that best matches the current path
    const match = vols.find(v => (p.path || '').startsWith(v));
    sel.value = match || vols[0];
  }

  function renderList(side, p) {
    const el = pd(side).list;
    el.innerHTML = '';
    const sel = selSets[side];

    // ".." row — always shown so navigation is never broken, even in empty folders
    const dotdot = document.createElement('div');
    dotdot.className = 'entry';
    dotdot.innerHTML = `<span class="entry-icon">📁</span><span class="entry-name is-dir">..</span><span class="entry-size"></span><span class="entry-mtime"></span>`;
    dotdot.addEventListener('dblclick', () => {
      setActivePanel(side);
      navigate(side, S.parentPath(p.path));
    });
    dotdot.addEventListener('click', () => setActivePanel(side));
    el.appendChild(dotdot);

    if (!p.entries || p.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = p.path ? 'Empty folder' : 'Loading…';
      el.appendChild(empty);
      return;
    }

    p.entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'entry' + (sel.has(entry.path) ? ' selected' : '');
      row.dataset.path = entry.path;

      const isSpinning = appState._spinningPath === entry.path;
      const icon = isSpinning
        ? '<span class="entry-spinner" aria-label="Opening…"></span>'
        : (entry.type === 'dir' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄');
      const nameClass = entry.type === 'dir' ? 'is-dir' : entry.type === 'symlink' ? 'is-link' : '';

      row.innerHTML = `
        <span class="entry-icon">${icon}</span>
        <span class="entry-name ${nameClass}">${S.escHtml(entry.name)}</span>
        <span class="entry-size">${entry.type === 'dir' ? '' : S.fmtSize(entry.size)}</span>
        <span class="entry-mtime">${S.fmtDate(entry.mtime)}</span>
      `;

      row.addEventListener('click', e => {
        setActivePanel(side);
        // Plain click selects this item exclusively and stays selected on
        // a repeat click (standard Explorer/Finder/TC behaviour) — it does
        // NOT toggle off, since a second click of an already-selected item
        // is also the first half of a double-click.
        // Ctrl/Cmd click toggles this item without clearing others.
        // Shift click is reserved for range selection (future).
        if (e.ctrlKey || e.metaKey) {
          const newSel = S.toggleSelection(selArray(side), entry.path);
          selSets[side] = new Set(newSel);
        } else if (!e.shiftKey) {
          selSets[side] = new Set([entry.path]);
        }
        renderList(side, appState.panels[side]);
        renderFkeys();
      });

      row.addEventListener('dblclick', () => {
        setActivePanel(side);
        cmdEnterAction();
      });

      el.appendChild(row);
    });
  }

  function renderNavButtons(side, p) {
    // Disable up when at a filesystem root (parentPath returns same path)
    const atRoot = !!p.path && S.parentPath(p.path) === p.path;
    pd(side).up.disabled = appState.busy || atRoot;
  }

  function renderStatus(side, p) {
    const cnt  = p.entries ? p.entries.length : 0;
    const selN = selSets[side].size;
    pd(side).statCnt.textContent = `${cnt} item${cnt !== 1 ? 's' : ''}`;
    pd(side).statSel.textContent = selN > 0 ? `${selN} selected` : '';
  }

  function renderFkeys() {
    const side    = appState.activePanel;
    const sel     = selArray(side);
    const enabled = S.fkeyEnabledState(sel, appState.busy);
    dom.fkView.disabled   = !enabled.view;
    dom.fkCopy.disabled   = !enabled.copy;
    dom.fkMove.disabled   = !enabled.move;
    dom.fkMkdir.disabled  = !enabled.mkdir;
    dom.fkDelete.disabled = !enabled.delete;
    dom.fkRename.disabled = !S.canRename(sel, appState.panels[side].entries, appState.busy);
    dom.fkEdit.disabled   = !S.canOpenWith(sel, appState.panels[side].entries, appState.busy);
  }

  function setActivePanel(side) {
    if (appState.activePanel === side) return;
    appState = { ...appState, activePanel: side };
    pd('left').panel.classList.toggle('active', side === 'left');
    pd('right').panel.classList.toggle('active', side === 'right');
    renderFkeys();
  }

  // ─── Tab event handlers ───────────────────────────────────────────────────────

  function onAddTab(side) {
    const id   = 'tab-' + Date.now();
    const newP = S.addTab(appState.panels[side], id);
    appState   = { ...appState, panels: { ...appState.panels, [side]: newP } };
    renderTabs(side, newP);
    // navigate() will pick up activeTab (= id) automatically now
    navigate(side, newP.path, { tabId: id, pushHistory: false });
  }

  function onCloseTab(side, tabId) {
    const { panel: newP, navigateTo } = S.closeTab(appState.panels[side], tabId);
    appState = { ...appState, panels: { ...appState.panels, [side]: newP } };
    renderTabs(side, newP);
    // navigate() passes activeTab, which causes the task to write the updated
    // tab list (without the closed tab) to disk.
    navigate(side, navigateTo || newP.path, { pushHistory: false });
  }

  function onSwitchTab(side, tabId) {
    const { panel: newP, navigateTo } = S.switchTab(appState.panels[side], tabId);
    appState = { ...appState, panels: { ...appState.panels, [side]: newP } };
    renderTabs(side, newP);
    if (navigateTo) navigate(side, navigateTo, { tabId, pushHistory: false });
  }

  // ─── Overlay ──────────────────────────────────────────────────────────────────

  function showOverlay(title, msg, buttons, inputDefault) {
    return new Promise(resolve => {
      dom.ovTitle.textContent = title;
      // Support “\n\n” as a paragraph break where the second paragraph
      // renders in a muted secondary style (used for tips/hints).
      dom.ovMsg.innerHTML = '';
      const parts = (msg || '').split('\n\n');
      parts.forEach((part, i) => {
        const p = document.createElement('p');
        p.textContent = part;
        if (i > 0) {
          p.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text3);line-height:1.5;';
        }
        dom.ovMsg.appendChild(p);
      });
      dom.ovInput.style.display         = inputDefault != null ? 'block' : 'none';
      dom.ovInput.value                 = inputDefault || '';
      dom.ovBtns.innerHTML              = '';

      buttons.forEach(btn => {
        const b = document.createElement('button');
        b.className  = 'overlay-btn' + (btn.cls ? ' ' + btn.cls : '');
        b.textContent = btn.label;
        b.addEventListener('click', () => {
          dom.overlay.classList.remove('visible');
          resolve(btn.value !== undefined ? btn.value : (inputDefault != null ? dom.ovInput.value : btn.label));
        });
        dom.ovBtns.appendChild(b);
      });

      dom.overlay.classList.add('visible');
      if (inputDefault != null) { dom.ovInput.focus(); dom.ovInput.select(); }
    });
  }

  function showError(title, msg) {
    return showOverlay(title, msg, [{ label: 'OK', value: null }]);
  }

  // ─── Commands ─────────────────────────────────────────────────────────────────

  function refreshBoth() {
    const lp = appState.panels.left.path;
    const rp = appState.panels.right.path;
    if (lp) navigate('left', lp, { pushHistory: false });
    if (rp && !appState.busy) {
      // Delay right refresh until worker is free again (left nav will reset first)
      const waitRight = () => {
        if (!appState.busy) navigate('right', rp, { pushHistory: false });
        else setTimeout(waitRight, 100);
      };
      setTimeout(waitRight, 200);
    }
  }

  // ─── Mkdir dialog (two phases: configure → error) ──────────────────────────────────

  const mkdirDlg = {
    bg:          document.getElementById('mkdir-dialog-bg'),
    title:       document.getElementById('mkdir-dialog-title'),
    sub:         document.getElementById('mkdir-dialog-sub'),
    input:       document.getElementById('mkdir-input'),
    subdirs:     document.getElementById('mkdir-subdirs'),
    hint:        document.getElementById('mkdir-subdirs-hint'),
    configPhase: document.getElementById('mkdir-configure-phase'),
    errorPhase:  document.getElementById('mkdir-error-phase'),
    errorMsg:    document.getElementById('mkdir-error-msg'),
    cancelBtn:   document.getElementById('mkdir-cancel'),
    createBtn:   document.getElementById('mkdir-create'),
  };

  function _mkdirPhase(phase) {
    const isConfigure = phase === 'configure';
    mkdirDlg.configPhase.classList.toggle('hidden', !isConfigure);
    mkdirDlg.errorPhase.classList.toggle('visible',  !isConfigure);
    if (isConfigure) {
      mkdirDlg.title.textContent      = 'New Folder';
      mkdirDlg.cancelBtn.textContent  = 'Cancel';
      mkdirDlg.createBtn.style.display = '';
    } else {
      mkdirDlg.title.textContent      = 'Error';
      mkdirDlg.cancelBtn.textContent  = 'Close';
      mkdirDlg.createBtn.style.display = 'none';
    }
  }

  mkdirDlg.subdirs.addEventListener('change', () => {
    mkdirDlg.hint.classList.toggle('visible', mkdirDlg.subdirs.checked);
    appState = { ...appState, config: { ...appState.config, mkdirSubDirs: mkdirDlg.subdirs.checked } };
  });

  mkdirDlg.input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); mkdirDlg.createBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); mkdirDlg.cancelBtn.click(); }
  });

  async function cmdMkdir() {
    if (appState.busy) return;
    const side = appState.activePanel;

    // ── Configure phase ──────────────────────────────────────────────────────────────
    mkdirDlg.subdirs.checked = !!appState.config.mkdirSubDirs;
    mkdirDlg.hint.classList.toggle('visible', mkdirDlg.subdirs.checked);
    mkdirDlg.sub.textContent = appState.panels[side].path;
    mkdirDlg.input.value     = '';
    _mkdirPhase('configure');
    mkdirDlg.bg.classList.add('visible');
    setTimeout(() => mkdirDlg.input.focus(), 30);

    const name = await new Promise(resolve => {
      const onCancel = () => { cleanup(); resolve(null); };
      const onCreate = () => { cleanup(); resolve(mkdirDlg.input.value.trim()); };
      function cleanup() {
        mkdirDlg.cancelBtn.removeEventListener('click', onCancel);
        mkdirDlg.createBtn.removeEventListener('click', onCreate);
      }
      mkdirDlg.cancelBtn.addEventListener('click', onCancel);
      mkdirDlg.createBtn.addEventListener('click', onCreate);
    });

    if (!name) { mkdirDlg.bg.classList.remove('visible'); return; }

    // ── Task ───────────────────────────────────────────────────────────────────
    adapter.assign('worker/tasks/mkdir.js', {
      panel: side, name, subDirs: mkdirDlg.subdirs.checked,
    }).catch(err => {
      if (mkdirDlg._resultResolve) {
        const r = mkdirDlg._resultResolve; mkdirDlg._resultResolve = null;
        r({ ok: false, error: err.message });
      }
    });

    const result = await new Promise(resolve => { mkdirDlg._resultResolve = resolve; });

    if (result.ok) { mkdirDlg.bg.classList.remove('visible'); return; }

    // ── Error phase ────────────────────────────────────────────────────────────
    const parts = (result.error || 'Unknown error').split('\n\n');
    mkdirDlg.errorMsg.innerHTML = '';
    parts.forEach((p, i) => {
      const el = document.createElement('p');
      el.textContent = p;
      if (i > 0) el.className = 'msg-tip';
      mkdirDlg.errorMsg.appendChild(el);
    });
    _mkdirPhase('error');

    // Close dismisses — dialog closes cleanly, no re-open
    await new Promise(resolve => {
      const onClose = () => { mkdirDlg.cancelBtn.removeEventListener('click', onClose); resolve(); };
      mkdirDlg.cancelBtn.addEventListener('click', onClose);
    });
    mkdirDlg.bg.classList.remove('visible');
  }

  // ─── Rename dialog (two phases: configure → error) ──────────────────────────

  const renameDlg = {
    bg:          document.getElementById('rename-dialog-bg'),
    title:       document.getElementById('rename-dialog-title'),
    input:       document.getElementById('rename-input'),
    configPhase: document.getElementById('rename-configure-phase'),
    errorPhase:  document.getElementById('rename-error-phase'),
    errorMsg:    document.getElementById('rename-error-msg'),
    cancelBtn:   document.getElementById('rename-cancel'),
    confirmBtn:  document.getElementById('rename-confirm'),
  };

  function _renamePhase(phase) {
    const isConfigure = phase === 'configure';
    renameDlg.configPhase.classList.toggle('hidden', !isConfigure);
    renameDlg.errorPhase.classList.toggle('visible',  !isConfigure);
    if (isConfigure) {
      renameDlg.title.textContent     = 'Rename';
      renameDlg.cancelBtn.textContent = 'Cancel';
      renameDlg.confirmBtn.style.display = '';
    } else {
      renameDlg.title.textContent     = 'Error';
      renameDlg.cancelBtn.textContent = 'Close';
      renameDlg.confirmBtn.style.display = 'none';
    }
  }

  renameDlg.bg.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); renameDlg.cancelBtn.click(); }
  });

  renameDlg.input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); renameDlg.confirmBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); renameDlg.cancelBtn.click(); }
  });

  async function cmdRename() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const sel  = selArray(side);
    if (sel.length !== 1) return;

    const sourcePath = sel[0];
    const currentName = S.shortenPath(sourcePath);
    if (!S.canRename(sel, appState.panels[side].entries, appState.busy)) return;

    // ── Configure phase ──────────────────────────────────────────────────────
    renameDlg.title.textContent = S.renameDialogHeader(currentName);
    renameDlg.input.value = currentName;

    // Pre-select persisted conflict preferences (reuse the move/copy keys'
    // shape but rename has its own independent persisted choices)
    const filesVal   = appState.config.renameConflictFiles   || 'abort';
    const foldersVal = appState.config.renameConflictFolders || 'abort';
    document.querySelectorAll('input[name=renameConflictFiles]').forEach(r => {
      r.checked = r.value === filesVal;
    });
    document.querySelectorAll('input[name=renameConflictFolders]').forEach(r => {
      r.checked = r.value === foldersVal;
    });

    _renamePhase('configure');
    renameDlg.bg.classList.add('visible');
    setTimeout(() => {
      renameDlg.input.focus();
      const selEnd = S.basenameSelectionEnd(currentName);
      renameDlg.input.setSelectionRange(0, selEnd);
    }, 30);

    const newName = await new Promise(resolve => {
      const onCancel  = () => { cleanup(); resolve(null); };
      const onConfirm = () => { cleanup(); resolve(renameDlg.input.value.trim()); };
      function cleanup() {
        renameDlg.cancelBtn.removeEventListener('click', onCancel);
        renameDlg.confirmBtn.removeEventListener('click', onConfirm);
      }
      renameDlg.cancelBtn.addEventListener('click', onCancel);
      renameDlg.confirmBtn.addEventListener('click', onConfirm);
    });

    // Cancelled, empty, or unchanged — close without touching the disk
    if (!newName || newName === currentName) {
      renameDlg.bg.classList.remove('visible');
      return;
    }

    const conflictFiles   = document.querySelector('input[name=renameConflictFiles]:checked')?.value   || 'abort';
    const conflictFolders = document.querySelector('input[name=renameConflictFolders]:checked')?.value || 'abort';

    // Persist preferences
    appState = {
      ...appState,
      config: { ...appState.config, renameConflictFiles: conflictFiles, renameConflictFolders: conflictFolders },
    };

    // ── Task ───────────────────────────────────────────────────────────────────
    adapter.assign('worker/tasks/rename.js', {
      panel: side, source: sourcePath, newName, conflictFiles, conflictFolders,
    }).catch(err => {
      if (renameDlg._resultResolve) {
        const r = renameDlg._resultResolve; renameDlg._resultResolve = null;
        r({ ok: false, error: err.message });
      }
    });

    const result = await new Promise(resolve => { renameDlg._resultResolve = resolve; });

    if (result.ok) { renameDlg.bg.classList.remove('visible'); return; }

    // ── Error phase ────────────────────────────────────────────────────────────
    const parts = (result.error || 'Unknown error').split('\n\n');
    renameDlg.errorMsg.innerHTML = '';
    parts.forEach((p, i) => {
      const el = document.createElement('p');
      el.textContent = p;
      if (i > 0) el.className = 'msg-tip';
      renameDlg.errorMsg.appendChild(el);
    });
    _renamePhase('error');

    await new Promise(resolve => {
      const onClose = () => { renameDlg.cancelBtn.removeEventListener('click', onClose); resolve(); };
      renameDlg.cancelBtn.addEventListener('click', onClose);
    });
    renameDlg.bg.classList.remove('visible');
  }

  // ─── F4: open with… (file-handlers cascade) ──────────────────────────────────

  // F4 has no dialog of its own and no client-side way to predict the
  // outcome (the cascade decision depends on server-side MIME detection),
  // so unlike Enter/double-click it can't optimistically spin an icon
  // before knowing what will happen. It goes through the normal busy-bar
  // and progress-message machinery instead, which already shows exactly
  // what the task is doing at each step.
  //
  // The icon spinner is still shown, same visual as Enter's — but here it
  // is driven by the task's real start/end rather than a fixed timeout,
  // since F4 already has a genuine completion signal (the task settling)
  // to clear it on. That signal still only means "the launch request was
  // handled", same caveat as everywhere else in this file: we cannot know
  // when the target application has actually finished opening.
  async function cmdOpenWith() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const sel  = selArray(side);
    if (!S.canOpenWith(sel, appState.panels[side].entries, appState.busy)) return;

    const targetPath = sel[0];

    appState = { ...appState, _spinningPath: targetPath };
    renderList(side, appState.panels[side]);

    adapter.assign('worker/tasks/open-with.js', { path: targetPath }).catch(err => {
      if (appState._openWithResolve) {
        const resolve = appState._openWithResolve;
        appState = { ...appState, _openWithResolve: null };
        resolve({ ok: false, error: err.message });
      }
    });

    const outcome = await new Promise(resolve => {
      appState = { ...appState, _openWithResolve: resolve };
    });

    // Only clear if this is still the spinner we set — avoids clobbering a
    // newer spin started by a second F4 press in the meantime (same guard
    // used for Enter's spinner).
    if (appState._spinningPath === targetPath) {
      appState = { ...appState, _spinningPath: null };
      renderList(side, appState.panels[side]);
    }

    if (!outcome.ok) {
      showError('Could not open', outcome.error || 'Unknown error');
      return;
    }

    const action = outcome.result && outcome.result.action;
    if (action === 'lister') {
      showError('Coming soon', 'A read-only viewer (F3) is not yet available to fall back to.');
    } else if (action === 'none') {
      // No handler configured for this file, and no executable-safe
      // fallback either — a deliberate, silent no-op, not an error.
    }
    // 'open' and 'nativeOpen' need no further UI action — the OS app
    // appearing on screen is the feedback.
  }

  // ─── Copy dialog (three-phase) ───────────────────────────────────────────────

  const copyDlg = {
    bg:          document.getElementById('copy-dialog-bg'),
    header:      document.getElementById('copy-dialog-header'),
    configWrap:  document.getElementById('copy-configure-wrap'),
    progressWrap:document.getElementById('copy-progress-wrap'),
    reportWrap:  document.getElementById('copy-report-wrap'),
    progressFill:document.getElementById('copy-progress-fill'),
    progressStats:document.getElementById('copy-progress-stats'),
    reportText:  document.getElementById('copy-report-text'),
    reportRow:   document.getElementById('copy-report-row'),
    keepRow:     document.getElementById('copy-keep-row'),
    showReport:  document.getElementById('copy-show-report'),
    keepOnAbort: document.getElementById('copy-keep-on-abort'),
    cancelBtn:   document.getElementById('copy-cancel-btn'),
    okBtn:       document.getElementById('copy-ok-btn'),
  };

  // Escape dismisses the copy/move dialog in any phase
  copyDlg.bg.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); copyDlg.cancelBtn.click(); }
  });

  // Wire cancel/abort/close button
  copyDlg.cancelBtn.addEventListener('click', () => {
    if (copyDlg._phase === 'progress') {
      // User is aborting — the task will finish with aborted:true and
      // _copyDlgDone will handle showing the report. Just signal abort.
      adapter.abort().catch(() => {});
    } else if (copyDlg._phase === 'configure') {
      // Cancel before starting — resolve with null to signal cancellation
      const resolve = copyDlg._resolve;
      copyDlg._resolve = null;
      copyDlg._okHandler && copyDlg.okBtn.removeEventListener('click', copyDlg._okHandler);
      copyDlg.bg.classList.remove('visible');
      resolve && resolve(null);
    } else {
      // Report phase — just close
      _copyDlgClose();
    }
  });

  function _copyDlgPhase(phase) {
    copyDlg._phase = phase;
    copyDlg.configWrap.style.display   = phase === 'configure' ? '' : 'none';
    copyDlg.progressWrap.style.display = phase === 'progress'  ? 'block' : 'none';
    copyDlg.reportWrap.style.display   = phase === 'report'    ? 'block' : 'none';
    copyDlg.reportRow.style.display    = phase === 'configure' ? 'flex' : 'none';
    copyDlg.keepRow.style.display      = phase === 'progress'  ? 'flex' : 'none';
    if (phase === 'configure') {
      copyDlg.cancelBtn.textContent = 'Cancel';
      copyDlg.cancelBtn.className   = 'copy-btn';
      copyDlg.okBtn.style.display   = '';
      // okBtn.textContent is set by cmdCopy/cmdMove before calling this
    } else if (phase === 'progress') {
      copyDlg.cancelBtn.textContent = 'Abort';
      copyDlg.cancelBtn.className   = 'copy-btn danger';
      copyDlg.okBtn.style.display   = 'none';
    } else {
      copyDlg.cancelBtn.textContent = 'Close';
      copyDlg.cancelBtn.className   = 'copy-btn';
      copyDlg.okBtn.style.display   = 'none';
    }
  }

  function _copyDlgClose() {
    copyDlg.bg.classList.remove('visible');
    copyDlg._resolve && copyDlg._resolve();
    copyDlg._resolve = null;
  }

  function _copyDlgPopulate(config) {
    // Set radios from config
    document.querySelectorAll('input[name=conflictFiles]').forEach(r => {
      r.checked = r.value === (config.copyConflictFiles || 'abort');
    });
    document.querySelectorAll('input[name=conflictFolders]').forEach(r => {
      r.checked = r.value === (config.copyConflictFolders || 'abort');
    });
    copyDlg.showReport.checked  = config.copyShowReport !== false;
    copyDlg.keepOnAbort.checked = !!config.copyKeepOnAbort;
  }

  function _copyDlgRead() {
    const filesVal   = document.querySelector('input[name=conflictFiles]:checked')?.value   || 'abort';
    const foldersVal = document.querySelector('input[name=conflictFolders]:checked')?.value || 'abort';
    return {
      conflictFiles:   filesVal,
      conflictFolders: foldersVal,
      showReport:      copyDlg.showReport.checked,
      keepOnAbort:     copyDlg.keepOnAbort.checked,
    };
  }

  async function cmdCopy() {
    if (appState.busy) return;
    const side  = appState.activePanel;
    const other = side === 'left' ? 'right' : 'left';
    const sel   = selArray(side);
    if (sel.length === 0) return;
    const dst = appState.panels[other].path;
    if (!dst) return showError('Copy', 'Target panel has no open directory');

    // Populate from persisted config
    _copyDlgPopulate(appState.config);

    // Set header
    copyDlg.header.textContent = S.copyDialogHeader(sel, dst);
    copyDlg._mode = 'copy';
    copyDlg.okBtn.textContent = 'Copy';

    // Show dialog in configure phase
    _copyDlgPhase('configure');
    copyDlg.bg.classList.add('visible');
    setTimeout(() => copyDlg.bg.focus(), 30);

    // Wait for OK or Cancel
    const prefs = await new Promise(resolve => {
      copyDlg._resolve = resolve;

      const onOk = () => {
        copyDlg.okBtn.removeEventListener('click', onOk);
        copyDlg._okHandler = null;
        copyDlg._resolve = null;
        resolve(_copyDlgRead());
      };
      copyDlg._okHandler = onOk;
      copyDlg.okBtn.addEventListener('click', onOk);
    });

    if (!prefs) return; // cancelled

    // Persist prefs to config
    appState = {
      ...appState,
      config: {
        ...appState.config,
        copyConflictFiles:   prefs.conflictFiles,
        copyConflictFolders: prefs.conflictFolders,
        copyShowReport:      prefs.showReport,
        copyKeepOnAbort:     prefs.keepOnAbort,
      },
    };

    // Store dst for report message
    copyDlg._dst = dst;

    // Switch to progress phase
    _copyDlgPhase('progress');
    copyDlg.header.textContent = 'Copy in progress…';
    copyDlg.progressFill.style.width = '0%';
    copyDlg.progressStats.textContent = '';
    copyDlg.keepOnAbort.checked = prefs.keepOnAbort;

    // Launch task
    adapter.assign('worker/tasks/copy.js', {
      sources:         sel,
      dst,
      panel:           side,
      dstPanel:        other,
      conflictFiles:   prefs.conflictFiles,
      conflictFolders: prefs.conflictFolders,
      showHidden:      appState.config.showHidden,
      keepOnAbort:     prefs.keepOnAbort,
      showReport:      prefs.showReport,
    }).catch(err => {
      _copyDlgPhase('report');
      copyDlg.header.textContent = 'Copy failed';
      copyDlg.reportText.textContent = err.message;
    });
  }

  // Handle progress updates for the copy dialog
  function _copyDlgProgress(ws) {
    if (copyDlg._phase !== 'progress') return;
    const pct   = ws.percent || 0;
    const extra = ws.extra || {};
    copyDlg.progressFill.style.width = pct + '%';

    const parts = [];
    if (extra.itemCount > 0) {
      parts.push(`Item ${(extra.itemIndex || 0) + 1} of ${extra.itemCount}`);
    }
    if (extra.kbTotal > 0) {
      parts.push(`${extra.kbDone || 0} / ${extra.kbTotal} KB`);
    }
    if (extra.speedKbps > 0) {
      parts.push(`${extra.speedKbps} KB/s`);
    }
    if (extra.etaSec != null) {
      parts.push(`ETA ${_fmtEta(extra.etaSec)}`);
    }
    copyDlg.progressStats.textContent = parts.join('  ·  ');
  }

  function _fmtEta(sec) {
    if (sec < 60)  return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  }

  // Handle copy task completion
  function _copyDlgDone(result) {
    if (!result) return;
    const showReport = copyDlg._mode === 'move'
      ? appState.config.moveShowReport !== false
      : appState.config.copyShowReport !== false;
    if (showReport) {
      _copyDlgPhase('report');
      const modeLabel = copyDlg._mode === 'move' ? 'Move' : 'Copy';
      copyDlg.header.textContent = result.aborted ? modeLabel + ' aborted' : modeLabel + ' complete';
      copyDlg.reportText.textContent = S.copyReport(result.stats || {}, copyDlg._dst || '', copyDlg._mode);
      // Also show any non-fatal errors below the report
      if (result.errors && result.errors.length > 0) {
        copyDlg.reportText.textContent += '\n\nErrors:\n' + result.errors.join('\n');
      }
    } else {
      _copyDlgClose();
    }
  }

  async function cmdMove() {
    if (appState.busy) return;
    const side  = appState.activePanel;
    const other = side === 'left' ? 'right' : 'left';
    const sel   = selArray(side);
    if (sel.length === 0) return;
    const dst = appState.panels[other].path;
    if (!dst) return showError('Move', 'Target panel has no open directory');

    // Reuse the copy dialog with move semantics
    _copyDlgPopulate({
      copyConflictFiles:   appState.config.moveConflictFiles   || 'abort',
      copyConflictFolders: appState.config.moveConflictFolders || 'abort',
      copyShowReport:      appState.config.moveShowReport !== false,
      copyKeepOnAbort:     !!appState.config.moveKeepOnAbort,
    });

    copyDlg.header.textContent = S.copyDialogHeader(sel, dst).replace('Copy', 'Move');
    copyDlg._dst  = dst;
    copyDlg._mode = 'move';
    copyDlg.okBtn.textContent = 'Move';

    _copyDlgPhase('configure');
    copyDlg.bg.classList.add('visible');
    setTimeout(() => copyDlg.bg.focus(), 30);

    const prefs = await new Promise(resolve => {
      copyDlg._resolve = resolve;
      const onOk = () => {
        copyDlg.okBtn.removeEventListener('click', onOk);
        copyDlg._okHandler = null;
        copyDlg._resolve = null;
        resolve(_copyDlgRead());
      };
      copyDlg._okHandler = onOk;
      copyDlg.okBtn.addEventListener('click', onOk);
    });

    if (!prefs) return;

    // Persist move prefs
    appState = {
      ...appState,
      config: {
        ...appState.config,
        moveConflictFiles:   prefs.conflictFiles,
        moveConflictFolders: prefs.conflictFolders,
        moveShowReport:      prefs.showReport,
        moveKeepOnAbort:     prefs.keepOnAbort,
      },
    };

    _copyDlgPhase('progress');
    copyDlg.header.textContent = 'Move in progress…';
    copyDlg.progressFill.style.width = '0%';
    copyDlg.progressStats.textContent = '';
    copyDlg.keepOnAbort.checked = prefs.keepOnAbort;

    adapter.assign('worker/tasks/move.js', {
      sources:         sel,
      dst,
      panel:           side,
      dstPanel:        other,
      conflictFiles:   prefs.conflictFiles,
      conflictFolders: prefs.conflictFolders,
      showHidden:      appState.config.showHidden,
      keepOnAbort:     prefs.keepOnAbort,
      showReport:      prefs.showReport,
    }).catch(err => {
      _copyDlgPhase('report');
      copyDlg.header.textContent = 'Move failed';
      copyDlg.reportText.textContent = err.message;
    });
  }

  // ─── Delete dialog ───────────────────────────────────────────────────────────

  const deleteDlg = {
    bg:          document.getElementById('delete-dialog-bg'),
    title:       document.getElementById('delete-dialog-title'),
    msg:         document.getElementById('delete-dialog-msg'),
    trashRow:    document.getElementById('delete-trash-row'),
    toTrash:     document.getElementById('delete-to-trash'),
    cancelBtn:   document.getElementById('delete-cancel'),
    confirmBtn:  document.getElementById('delete-confirm'),
  };

  function _updateDeleteBtn() {
    const trash = deleteDlg.toTrash.checked;
    deleteDlg.title.textContent       = trash ? 'Move to Trash' : 'Delete Permanently';
    deleteDlg.confirmBtn.textContent  = trash ? 'Move to Trash' : 'Delete Permanently';
    deleteDlg.confirmBtn.className    = trash ? 'copy-btn primary' : 'copy-btn danger';
  }

  deleteDlg.toTrash.addEventListener('change', _updateDeleteBtn);

  deleteDlg.bg.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); deleteDlg.cancelBtn.click(); }
    if (e.key === 'Enter')  { e.preventDefault(); deleteDlg.confirmBtn.click(); }
  });

  async function cmdDelete() {
    if (appState.busy) return;
    const side  = appState.activePanel;
    const sel   = selArray(side);
    if (sel.length === 0) return;

    const count = sel.length;
    const noun  = count === 1 ? '1 item' : `${count} items`;

    // Pre-populate from config
    deleteDlg.toTrash.checked = appState.config.deleteToTrash !== false;
    _updateDeleteBtn();
    deleteDlg.msg.textContent = deleteDlg.toTrash.checked
      ? `Move ${noun} to the system trash?`
      : `Permanently delete ${noun}? This cannot be undone.`;

    // Update message when checkbox changes
    const onTrashChange = () => {
      deleteDlg.msg.textContent = deleteDlg.toTrash.checked
        ? `Move ${noun} to the system trash?`
        : `Permanently delete ${noun}? This cannot be undone.`;
    };
    deleteDlg.toTrash.addEventListener('change', onTrashChange);

    deleteDlg.bg.classList.add('visible');
    setTimeout(() => deleteDlg.bg.focus(), 30);

    const confirmed = await new Promise(resolve => {
      const onCancel  = () => { cleanup(); resolve(false); };
      const onConfirm = () => { cleanup(); resolve(true); };
      function cleanup() {
        deleteDlg.cancelBtn.removeEventListener('click', onCancel);
        deleteDlg.confirmBtn.removeEventListener('click', onConfirm);
        deleteDlg.toTrash.removeEventListener('change', onTrashChange);
        deleteDlg.bg.classList.remove('visible');
      }
      deleteDlg.cancelBtn.addEventListener('click', onCancel);
      deleteDlg.confirmBtn.addEventListener('click', onConfirm);
    });

    if (!confirmed) return;

    const useTrash = deleteDlg.toTrash.checked;
    appState = { ...appState, config: { ...appState.config, deleteToTrash: useTrash } };

    adapter.assign('worker/tasks/delete.js', {
      sources: sel,
      panel:   side,
      toTrash: useTrash,
    }).catch(err => showError('Delete failed', err.message));
  }

  // ─── Enter / double-click: open natively, or navigate into a regular folder ───

  // True while any modal dialog is open, so the global Enter handler can
  // stay out of the way of dialogs' own Enter-to-confirm bindings (those
  // listeners don't stopPropagation, so this event still bubbles to us).
  function _anyDialogOpen() {
    return mkdirDlg.bg.classList.contains('visible')
        || renameDlg.bg.classList.contains('visible')
        || copyDlg.bg.classList.contains('visible')
        || deleteDlg.bg.classList.contains('visible')
        || dom.overlay.classList.contains('visible');
  }

  // Duration the icon-spinner shows for, in ms. Purely cosmetic — see
  // worker/tasks/open-native.js for why this is decoupled from the task's
  // actual completion: there is no reliable "the app has opened" signal.
  const OPEN_SPINNER_MS = 2500;

  // Shared by both the Enter key (see the document keydown handler below)
  // and double-click on a row (see renderList) — same decision, same result,
  // intentionally triggered identically by either gesture.
  function cmdEnterAction() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const sel  = selArray(side);
    const entries = appState.panels[side].entries;
    const decision = S.decideEnterAction(sel, entries, appState.platform);

    if (decision.action === 'navigate') {
      navigate(side, decision.path);
    } else if (decision.action === 'open') {
      appState = { ...appState, _spinningPath: decision.path };
      renderList(side, appState.panels[side]);
      setTimeout(() => {
        // Only clear if this is still the spinner we set — avoids clobbering
        // a newer spin started by a second Enter press in the meantime.
        if (appState._spinningPath === decision.path) {
          appState = { ...appState, _spinningPath: null };
          renderList(side, appState.panels[side]);
        }
      }, OPEN_SPINNER_MS);

      adapter.assign('worker/tasks/open-native.js', { path: decision.path })
        .catch(err => showError('Could not open', err.message));
    }
    // action === 'none' → no-op, by design
  }


  // ─── Event wiring ─────────────────────────────────────────────────────────────

  ['left', 'right'].forEach(side => {
    pd(side).panel.addEventListener('mousedown', () => setActivePanel(side));
    pd(side).up.addEventListener('click', () => navigate(side, S.parentPath(appState.panels[side].path)));
    pd(side).vol.addEventListener('change', e => navigate(side, e.target.value));

    document.querySelectorAll(`.col-header[data-panel="${side}"]`).forEach(col => {
      col.addEventListener('click', () => {
        const next = S.nextSortState(appState.config, col.dataset.sort);
        appState = { ...appState, config: { ...appState.config, ...next } };
        navigate(side, appState.panels[side].path, { pushHistory: false });
      });
    });
  });

  document.addEventListener('keydown', e => {
    const side  = appState.activePanel;
    const other = side === 'left' ? 'right' : 'left';
    if (e.key === 'F2')                              { e.preventDefault(); refreshBoth(); }
    else if (e.key === 'F4')                         { e.preventDefault(); cmdOpenWith(); }
    else if (e.key === 'F5')                         { e.preventDefault(); cmdCopy(); }
    else if (e.key === 'F6' && e.shiftKey)           { e.preventDefault(); cmdRename(); }
    else if (e.key === 'F6')                         { e.preventDefault(); cmdMove(); }
    else if (e.key === 'F7')                         { e.preventDefault(); cmdMkdir(); }
    else if (e.key === 'F8' || e.key === 'Delete')   { e.preventDefault(); cmdDelete(); }
    else if (e.key === 'Tab')                        { e.preventDefault(); setActivePanel(other); pd(other).list.focus(); }
    else if (e.key === 'Backspace' && !e.target.matches('input')) { e.preventDefault(); navigate(side, S.parentPath(appState.panels[side].path)); }
    else if (e.key === 'Enter' && !e.target.matches('input') && !_anyDialogOpen()) {
      e.preventDefault();
      cmdEnterAction();
    }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      if (!e.target.matches('input, select')) {
        e.preventDefault();
        selSets[side] = new Set(S.selectAllPaths(appState.panels[side].entries));
        renderList(side, appState.panels[side]);
        renderFkeys();
      }
    }
  });

  dom.fkView.addEventListener('click',   () => showError('Coming soon', 'View not yet implemented'));
  dom.fkEdit.addEventListener('click',   cmdOpenWith);
  dom.fkCopy.addEventListener('click',   cmdCopy);
  dom.fkRename.addEventListener('click', cmdRename);
  dom.fkMove.addEventListener('click',   cmdMove);
  dom.fkMkdir.addEventListener('click',  cmdMkdir);
  dom.fkDelete.addEventListener('click', cmdDelete);
  dom.btnRefresh.addEventListener('click', refreshBoth);
  dom.busyAbort.addEventListener('click', () => adapter.abort().catch(() => {}));
  dom.btnConfig.addEventListener('click', () => {
    const t = appState.config.theme === 'dark' ? 'light' : 'dark';
    appState = { ...appState, config: { ...appState.config, theme: t } };
    dom.html.setAttribute('data-theme', t);
    // TODO: persist via config-update task
  });

  // Patch adapter reconnect indicator
  const _origConnectWS = adapter._connectWS.bind(adapter);
  adapter._connectWS = function () {
    dom.connDot.className = 'conn-dot';
    _origConnectWS();
  };

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  dom.html.setAttribute('data-theme', appState.config.theme);
  adapter.connect();

  // The WS handler will fire onStateChange with {state:'idle'} on connect,
  // which triggers nextBootAction → navigate-left → (on done) navigate-right.
  // No manual sequencing needed here.

})();
