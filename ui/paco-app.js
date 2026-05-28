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
    fkMove:     $('fk-move'),
    fkMkdir:    $('fk-mkdir'),
    fkDelete:   $('fk-delete'),
  };

  function pd(side) {
    return {
      panel:   $(`panel-${side}`),
      tabs:    $(`tabs-${side}`),
      back:    $(`back-${side}`),
      fwd:     $(`fwd-${side}`),
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
    if (appState.busy) return;
    adapter.assign('worker/tasks/navigate.js', {
      panel:       side,
      path:        targetPath || appState.panels[side].path || '',
      pushHistory: opts.pushHistory !== false,
    }).catch(err => showError('Navigation failed', err.message));
  }

  // ─── WS state handler ─────────────────────────────────────────────────────────

  adapter.onStateChange(function onWsMsg(ws) {
    if (!ws) return;

    const s = ws.state || 'idle';
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
          renderPanel(payload.panel);
        }
      }
      if (payloads.length > 0) renderFkeys();

      // Surface per-item errors from copy / move / delete
      if (result.errors && result.errors.length > 0) {
        showError('Some items failed', result.errors.join('\n'));
      }

      // ── Boot sequencing ────────────────────────────────────────────────
      const bootAction = S.nextBootAction(appState.bootPhase, ws);
      appState = { ...appState, bootPhase: S.advanceBootPhase(appState.bootPhase, bootAction.action) };

      if (bootAction.action === 'navigate-right') {
        adapter.reset().then(() => navigate('right', '')).catch(() => {});
        return;
      }

      adapter.reset().catch(() => {});
    }

    if (s === 'error') {
      appState = { ...appState, busy: false };
      dom.busyBar.classList.remove('visible');
      showError('Task error', ws.message || 'Unknown error');
      adapter.reset().catch(() => {});
    }

    if (s === 'aborted') {
      appState = { ...appState, busy: false };
      dom.busyBar.classList.remove('visible');
      adapter.reset().catch(() => {});
    }

    // ── Boot trigger on first idle ───────────────────────────────────────
    const bootAction = S.nextBootAction(appState.bootPhase, ws);
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
    renderNavButtons(side, p);
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
    const sep = (p.path || '').includes('\\') ? '\\' : '/';
    (p.breadcrumbs || buildCrumbsFromPath(p.path)).forEach((c, i, arr) => {
      const span = document.createElement('span');
      span.className = 'crumb';
      span.textContent = c.label;
      span.title = c.path;
      span.addEventListener('click', () => navigate(side, c.path));
      el.appendChild(span);
      if (i < arr.length - 1) {
        const s = document.createElement('span');
        s.className = 'crumb-sep';
        s.textContent = sep;
        el.appendChild(s);
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
    const vols = p.volumes || [];
    if (vols.length === 0) return;
    sel.innerHTML = '';
    vols.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
    const match = vols.find(v => (p.path || '').startsWith(v));
    sel.value = match || vols[0];
  }

  function renderList(side, p) {
    const el = pd(side).list;
    el.innerHTML = '';
    const sel = selSets[side];

    if (!p.entries || p.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = p.path ? 'Empty folder' : 'Loading…';
      el.appendChild(empty);
      return;
    }

    // ".." row
    const dotdot = document.createElement('div');
    dotdot.className = 'entry';
    dotdot.innerHTML = `<span class="entry-icon">📁</span><span class="entry-name is-dir">..</span><span class="entry-size"></span><span class="entry-mtime"></span>`;
    dotdot.addEventListener('dblclick', () => {
      setActivePanel(side);
      navigate(side, S.parentPath(p.path));
    });
    dotdot.addEventListener('click', () => setActivePanel(side));
    el.appendChild(dotdot);

    p.entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'entry' + (sel.has(entry.path) ? ' selected' : '');
      row.dataset.path = entry.path;

      const icon      = entry.type === 'dir' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄';
      const nameClass = entry.type === 'dir' ? 'is-dir' : entry.type === 'symlink' ? 'is-link' : '';

      row.innerHTML = `
        <span class="entry-icon">${icon}</span>
        <span class="entry-name ${nameClass}">${S.escHtml(entry.name)}</span>
        <span class="entry-size">${entry.type === 'dir' ? '' : S.fmtSize(entry.size)}</span>
        <span class="entry-mtime">${S.fmtDate(entry.mtime)}</span>
      `;

      row.addEventListener('click', e => {
        setActivePanel(side);
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const newSel = S.toggleSelection(selArray(side), entry.path);
          selSets[side] = new Set(newSel);
          renderList(side, appState.panels[side]);
          renderFkeys();
        }
      });

      row.addEventListener('dblclick', () => {
        setActivePanel(side);
        if (entry.type === 'dir') navigate(side, entry.path);
        // file open handled in future tasks
      });

      el.appendChild(row);
    });
  }

  function renderNavButtons(side, p) {
    const d = pd(side);
    d.back.disabled = appState.busy || !S.canGoBack(p);
    d.fwd.disabled  = appState.busy || !S.canGoFwd(p);
    d.up.disabled   = appState.busy;
  }

  function renderStatus(side, p) {
    const cnt  = p.entries ? p.entries.length : 0;
    const selN = selSets[side].size;
    pd(side).statCnt.textContent = `${cnt} item${cnt !== 1 ? 's' : ''}`;
    pd(side).statSel.textContent = selN > 0 ? `${selN} selected` : '';
  }

  function renderFkeys() {
    const side    = appState.activePanel;
    const enabled = S.fkeyEnabledState(selArray(side), appState.busy);
    dom.fkView.disabled   = !enabled.view;
    dom.fkEdit.disabled   = !enabled.edit;
    dom.fkCopy.disabled   = !enabled.copy;
    dom.fkMove.disabled   = !enabled.move;
    dom.fkMkdir.disabled  = !enabled.mkdir;
    dom.fkDelete.disabled = !enabled.delete;
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
    const id     = 'tab-' + Date.now();
    const newP   = S.addTab(appState.panels[side], id);
    appState     = { ...appState, panels: { ...appState.panels, [side]: newP } };
    renderTabs(side, newP);
    navigate(side, newP.path);
  }

  function onCloseTab(side, tabId) {
    const { panel: newP, navigateTo } = S.closeTab(appState.panels[side], tabId);
    appState = { ...appState, panels: { ...appState.panels, [side]: newP } };
    renderTabs(side, newP);
    if (navigateTo) navigate(side, navigateTo);
  }

  function onSwitchTab(side, tabId) {
    const { panel: newP, navigateTo } = S.switchTab(appState.panels[side], tabId);
    appState = { ...appState, panels: { ...appState.panels, [side]: newP } };
    renderTabs(side, newP);
    if (navigateTo) navigate(side, navigateTo);
  }

  // ─── Overlay ──────────────────────────────────────────────────────────────────

  function showOverlay(title, msg, buttons, inputDefault) {
    return new Promise(resolve => {
      dom.ovTitle.textContent           = title;
      dom.ovMsg.textContent             = msg || '';
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

  async function cmdMkdir() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const name = await showOverlay(
      'New Folder',
      `Create folder in:\n${appState.panels[side].path}`,
      [{ label: 'Cancel', value: null }, { label: 'Create', cls: 'primary' }],
      'New Folder'
    );
    // null = Cancel button; 'Cancel' = button label fallback; empty string = blank input
    if (!name || name === 'Cancel') return;
    adapter.assign('worker/tasks/mkdir.js', { panel: side, name })
      .catch(err => showError('New Folder failed', err.message));
  }

  async function cmdCopy() {
    if (appState.busy) return;
    const side  = appState.activePanel;
    const other = side === 'left' ? 'right' : 'left';
    const sel   = selArray(side);
    if (sel.length === 0) return;
    const dst = appState.panels[other].path;
    if (!dst) return showError('Copy failed', 'Target panel has no open directory');
    const confirmed = await showOverlay(
      'Copy',
      S.opConfirmMessage('copy', sel.length, dst),
      [{ label: 'Cancel', value: false }, { label: 'Copy', cls: 'primary', value: true }]
    );
    if (!confirmed) return;
    adapter.assign('worker/tasks/copy.js', {
      sources:  sel,
      dst,
      panel:    side,
      dstPanel: other,
    }).catch(err => showError('Copy failed', err.message));
  }

  async function cmdMove() {
    if (appState.busy) return;
    const side  = appState.activePanel;
    const other = side === 'left' ? 'right' : 'left';
    const sel   = selArray(side);
    if (sel.length === 0) return;
    const dst = appState.panels[other].path;
    if (!dst) return showError('Move failed', 'Target panel has no open directory');
    const confirmed = await showOverlay(
      'Move',
      S.opConfirmMessage('move', sel.length, dst),
      [{ label: 'Cancel', value: false }, { label: 'Move', cls: 'primary', value: true }]
    );
    if (!confirmed) return;
    adapter.assign('worker/tasks/move.js', {
      sources:  sel,
      dst,
      panel:    side,
      dstPanel: other,
    }).catch(err => showError('Move failed', err.message));
  }

  async function cmdDelete() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const sel  = selArray(side);
    if (sel.length === 0) return;
    const confirmed = await showOverlay(
      'Delete',
      `Permanently delete ${sel.length} item${sel.length > 1 ? 's' : ''}?`,
      [{ label: 'Cancel', value: false }, { label: 'Delete', cls: 'danger', value: true }]
    );
    if (!confirmed) return;
    adapter.assign('worker/tasks/delete.js', {
      sources: sel,
      panel:   side,
    }).catch(err => showError('Delete failed', err.message));
  }

  // ─── Event wiring ─────────────────────────────────────────────────────────────

  ['left', 'right'].forEach(side => {
    pd(side).panel.addEventListener('mousedown', () => setActivePanel(side));
    pd(side).back.addEventListener('click',  () => {
      const target = S.backPath(appState.panels[side]);
      if (target) navigate(side, target, { pushHistory: false });
    });
    pd(side).fwd.addEventListener('click', () => {
      const target = S.fwdPath(appState.panels[side]);
      if (target) navigate(side, target, { pushHistory: false });
    });
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
    else if (e.key === 'F5')                         { e.preventDefault(); cmdCopy(); }
    else if (e.key === 'F6')                         { e.preventDefault(); cmdMove(); }
    else if (e.key === 'F7')                         { e.preventDefault(); cmdMkdir(); }
    else if (e.key === 'F8' || e.key === 'Delete')   { e.preventDefault(); cmdDelete(); }
    else if (e.key === 'Tab')                        { e.preventDefault(); setActivePanel(other); pd(other).list.focus(); }
    else if (e.key === 'Backspace' && !e.target.matches('input')) { e.preventDefault(); navigate(side, S.parentPath(appState.panels[side].path)); }
    else if (e.key === 'ArrowLeft'  && e.altKey)     { e.preventDefault(); pd(side).back.click(); }
    else if (e.key === 'ArrowRight' && e.altKey)     { e.preventDefault(); pd(side).fwd.click(); }
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
  dom.fkEdit.addEventListener('click',   () => showError('Coming soon', 'Edit not yet implemented'));
  dom.fkCopy.addEventListener('click',   cmdCopy);
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
