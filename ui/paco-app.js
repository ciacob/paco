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
    topBar:     $('top-bar'),
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
    fkNewFile:  $('fk-newfile'),
    fkEdit:     $('fk-edit'),
    fkCopy:     $('fk-copy'),
    fkRename:   $('fk-rename'),
    fkMove:     $('fk-move'),
    fkMkdir:    $('fk-mkdir'),
    fkDelete:   $('fk-delete'),
    panelsArea:   $('panels-area'),
    panelDivider: $('panel-divider'),
    viewerDivider: $('viewer-divider'),
    viewerPanel:   $('viewer-panel'),
    viewerClose:   $('viewer-close'),
    viewerContent: $('viewer-content'),
    fkeyBar:       $('fkey-bar'),
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

  // ─── Panel divider (drag-to-resize) ───────────────────────────────────────────

  const PANEL_MIN_PX  = 300; // horizontal floor — twin list panels' width
  const DIVIDER_PX    = 3;
  const VIEWER_MIN_PX = 250; // vertical floor — list-panels-region/Viewer height
  const VIEWER_DIVIDER_PX = 3;

  // Tracks the in-progress drag, if any. null when not dragging.
  let _dividerDrag = null;

  /**
   * Compute and apply pixel flex-basis values for both panels from a 0..1
   * fraction (left panel's share of the available width, i.e. the
   * container width minus the divider). Always converts to PIXELS rather
   * than leaving it as a CSS percentage — see the .panel CSS comment for
   * why (percentages are relative to the full container including the
   * divider, which would overflow by the divider's width on every split).
   *
   * The 300px floor is enforced here as a best-effort clamp on the
   * fraction before converting to pixels, purely so the two panels land on
   * sensible round numbers; the actual, unconditional floor is the
   * browser-enforced `min-width: 300px` on .panel, which still applies
   * even if this function were ever skipped or given a bad value.
   *
   * @param {number} [fraction] — left panel's share, 0..1. Defaults to the
   *                              currently-stored config value, or 0.5.
   * @returns {number} the effective, floor-clamped fraction that was
   *                    actually applied — callers should persist THIS,
   *                    not their raw input, so a value recorded mid-drag
   *                    reflects what was visually shown.
   */
  function _applyPanelSplit(fraction) {
    const f = typeof fraction === 'number' && fraction > 0 && fraction < 1
      ? fraction
      : (appState.config.panelSplit || 0.5);

    const totalWidth     = dom.panelsArea.clientWidth;
    const availableWidth = Math.max(0, totalWidth - DIVIDER_PX);

    // Single source of truth for "are we in the narrow-window edge case":
    // toggle our OWN class rather than relying on the browser's native
    // overflow:auto heuristic to decide independently whether a scrollbar
    // is needed. Letting CSS auto-detection and our own width-driven
    // flexBasis math both react to the same boundary, on every resize
    // event, is what caused a visible flicker — this makes it one
    // decision instead of two.
    const needsScroll = availableWidth < PANEL_MIN_PX * 2;
    dom.panelsArea.classList.toggle('overflow-scroll', needsScroll);

    let leftPx = f * availableWidth;

    // Clamp so each side gets at least PANEL_MIN_PX, whenever the window is
    // wide enough to honour both floors simultaneously. Below that
    // threshold (the needsScroll case above), each side gets exactly half
    // of whatever's available instead of an arbitrary unclamped value —
    // the browser's own min-width:300px on .panel is what actually forces
    // the rendered width up to 300px in that case, and #panels-area now
    // scrolls because WE said it should, not because auto guessed it.
    const minSide = needsScroll ? availableWidth / 2 : PANEL_MIN_PX;
    leftPx = Math.max(minSide, Math.min(availableWidth - minSide, leftPx));

    const rightPx = availableWidth - leftPx;

    pd('left').panel.style.flexBasis  = leftPx  + 'px';
    pd('right').panel.style.flexBasis = rightPx + 'px';

    return availableWidth > 0 ? leftPx / availableWidth : f;
  }

  // Synchronous guard, independent of appState.busy (which only flips true
  // after the WS round-trip confirms the worker is running — too slow to
  // prevent two calls fired milliseconds apart, before that round-trip
  // completes). This is purely local bookkeeping for this one function.
  let _panelSplitSaveInFlight = false;

  /**
   * Persist the given fraction to config.json via the lightweight
   * save-config task — no panel refresh needed, this is a pure preference
   * write, same pattern used for every other dialog-remembered setting.
   *
   * Guards against firing a second assign while the previous one is still
   * in flight — see _panelSplitSaveInFlight above. The movement-based drag
   * detection on mouseup (see the divider's mousedown/mousemove/mouseup
   * wiring) is what actually prevents most of this from ever being
   * triggered in the first place; this guard is a second layer in case
   * something still calls this function in rapid succession.
   */
  function _persistPanelSplit(fraction) {
    appState = { ...appState, config: { ...appState.config, panelSplit: fraction } };
    if (_panelSplitSaveInFlight) return;
    _panelSplitSaveInFlight = true;
    adapter.assign('worker/tasks/save-config.js', { panelSplit: fraction })
      .catch(() => {})
      .finally(() => { _panelSplitSaveInFlight = false; });
  }

  dom.panelDivider.addEventListener('mousedown', e => {
    e.preventDefault();
    const totalWidth     = dom.panelsArea.clientWidth;
    const availableWidth = Math.max(1, totalWidth - DIVIDER_PX);
    const areaRect        = dom.panelsArea.getBoundingClientRect();

    // moved=false until mousemove actually reports a meaningful position
    // change — see the comment on mouseup below for why this matters.
    _dividerDrag = { areaLeft: areaRect.left, availableWidth, moved: false };
    dom.panelDivider.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!_dividerDrag) return;
    const { areaLeft, availableWidth } = _dividerDrag;
    const fraction = (e.clientX - areaLeft) / availableWidth;
    // Clamp to [0,1] before applying — _applyPanelSplit further clamps for
    // the 300px floor, but a raw fraction outside 0..1 (dragging past the
    // edges of the panel area) shouldn't even be considered valid input.
    const clamped  = Math.max(0, Math.min(1, fraction));
    const effective = _applyPanelSplit(clamped);
    appState = { ...appState, config: { ...appState.config, panelSplit: effective } };
    _dividerDrag.moved = true;
  });

  document.addEventListener('mouseup', () => {
    if (!_dividerDrag) return;
    // A plain click (mousedown immediately followed by mouseup, with no
    // mousemove in between) is NOT a drag — most notably, the two
    // click-pairs that make up a double-click each land here with zero
    // movement. Without this guard, every double-click on the divider
    // fired two extra, spurious save-config assigns racing the dblclick
    // handler's own persist, occasionally overlapping the worker's
    // still-running previous assign ("Cannot assign task while in
    // state: done/running"). Only persist if a real drag happened.
    const wasRealDrag = _dividerDrag.moved;
    _dividerDrag = null;
    dom.panelDivider.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (wasRealDrag) {
      _persistPanelSplit(appState.config.panelSplit || 0.5);
    }
  });

  dom.panelDivider.addEventListener('dblclick', () => {
    const effective = _applyPanelSplit(0.5);
    _persistPanelSplit(effective);
  });

  // Re-apply the stored fraction (not a frozen pixel value) on window
  // resize, so both panels grow/shrink together proportionally and the
  // 300px floor is re-checked against the new width.
  window.addEventListener('resize', () => {
    _applyPanelSplit(appState.config.panelSplit);
    if (appState.viewerOpen) _applyViewerSplit(appState.config.viewerSplit);
  });

  // ─── Viewer panel (F3) ──────────────────────────────────────────────────────

  // Tracks the in-progress vertical drag, if any. null when not dragging.
  let _viewerDrag = null;

  /**
   * Compute and apply pixel flex-basis values for the twin-list-panels
   * region and the Viewer panel, from a 0..1 fraction (the list panels'
   * share of the available height). Same pixel-not-percentage rationale,
   * same floor-clamp shape, same effective-fraction return contract as
   * _applyPanelSplit — see that function's doc comment for the full
   * reasoning, all of which applies here unchanged, just on the Y axis.
   *
   * Only meaningful (and only ever called) while the Viewer is open —
   * when closed, #panels-area reverts to flex:1 1 0 (fill everything) and
   * neither this nor the Viewer panel's own basis matters.
   *
   * @param {number} [fraction] — list panels' share, 0..1. Defaults to the
   *                              currently-stored config value, or 0.5.
   * @returns {number} the effective, floor-clamped fraction actually applied.
   */
  function _applyViewerSplit(fraction) {
    const f = typeof fraction === 'number' && fraction > 0 && fraction < 1
      ? fraction
      : (appState.config.viewerSplit || 0.5);

    const availableHeight = _measureViewerAvailableHeight();

    const needsScroll = availableHeight < VIEWER_MIN_PX * 2;
    // Mirrors #panels-area's own overflow-scroll toggle, but on the
    // document/body level for the vertical axis — see the CSS comment on
    // body for why this is a class toggle rather than a bare overflow:auto.
    document.body.classList.toggle('viewer-overflow-scroll', needsScroll);

    let topPx = f * availableHeight;
    const minSide = needsScroll ? availableHeight / 2 : VIEWER_MIN_PX;
    topPx = Math.max(minSide, Math.min(availableHeight - minSide, topPx));

    const bottomPx = availableHeight - topPx;

    dom.panelsArea.style.flex      = `0 0 ${topPx}px`;
    dom.viewerPanel.style.flexBasis = bottomPx + 'px';

    // Re-check fit now that the Viewer panel's own height may have just
    // changed (drag, reset, or window resize all land here) — content that
    // fit before a resize might not after, and vice versa.
    _applyViewerFit();

    return availableHeight > 0 ? topPx / availableHeight : f;
  }

  /**
   * Toggle #viewer-columns between height:100% (default, keeps vertical
   * centering) and height:auto (lets it grow past #viewer-content's box,
   * which then scrolls normally) based on whether the tallest column's
   * content actually fits in the available space right now.
   *
   * Centering and scroll-driven overflow don't compose well in flexbox —
   * align-items:center on an overflowing child clips it symmetrically from
   * both edges rather than anchoring to one, which produces a scrollbar
   * that can't actually reach the true top/bottom. Keeping the two modes
   * mutually exclusive, decided by a real measurement rather than assumed,
   * is what avoids that.
   *
   * Safe to call whenever the Viewer's available height OR its rendered
   * content could have changed — called from _applyViewerSplit (drag,
   * reset, window resize, panel-open) and from the end of renderViewer
   * (selection changes, which can make content taller/shorter independent
   * of any divider movement). No-op if the Viewer is closed or has no
   * columns currently rendered (e.g. showing the empty-state message).
   */
  function _applyViewerFit() {
    if (!appState.viewerOpen) return;

    const columns = dom.viewerContent.querySelectorAll('.column-info');
    if (columns.length === 0) return; // empty-state or not yet rendered

    let tallest = 0;
    columns.forEach(el => { tallest = Math.max(tallest, el.scrollHeight); });

    const columnsEl = document.getElementById('viewer-columns');
    if (!columnsEl) return;

    const availableHeight = dom.viewerContent.clientHeight;
    const fits = tallest <= availableHeight;
    columnsEl.style.height = fits ? '100%' : 'auto';
  }

  /**
   * The true total height available to split between #panels-area and
   * #viewer-panel, measured from STABLE references (body's own height
   * minus the other fixed-height chrome) rather than summing the two
   * regions' own current rendered heights.
   *
   * Summing the two regions' own heights would seem simpler, but it's
   * wrong on a window resize: those heights reflect whatever was last
   * applied, not the new total after the window changed size — summing
   * two stale values just reproduces the old (now-incorrect) total,
   * silently failing to adapt. Measuring against body/topBar/busyBar/
   * fkeyBar — none of which we ever resize ourselves — sidesteps that
   * entirely, since those are always correct regardless of how many times
   * #panels-area/#viewer-panel have been resized before this call.
   *
   * @returns {number} available height in pixels, minus the divider.
   */
  function _measureViewerAvailableHeight() {
    const totalHeight = dom.html.clientHeight
      - dom.topBar.offsetHeight
      - dom.busyBar.offsetHeight
      - dom.fkeyBar.offsetHeight;
    return Math.max(1, totalHeight - VIEWER_DIVIDER_PX);
  }

  // Synchronous guard, same rationale as _panelSplitSaveInFlight.
  let _viewerSplitSaveInFlight = false;

  function _persistViewerSplit(fraction) {
    appState = { ...appState, config: { ...appState.config, viewerSplit: fraction } };
    if (_viewerSplitSaveInFlight) return;
    _viewerSplitSaveInFlight = true;
    adapter.assign('worker/tasks/save-config.js', { viewerSplit: fraction })
      .catch(() => {})
      .finally(() => { _viewerSplitSaveInFlight = false; });
  }

  dom.viewerDivider.addEventListener('mousedown', e => {
    e.preventDefault();
    if (!appState.viewerOpen) return;
    _viewerDrag = { startY: e.clientY, moved: false };
    dom.viewerDivider.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!_viewerDrag) return;
    // Re-measure on every move via the same stable measurement
    // _applyViewerSplit itself uses (see _measureViewerAvailableHeight) —
    // not by summing #panels-area/#viewer-panel's own current heights,
    // which would reproduce whatever total was last applied rather than
    // reacting correctly if anything changed it in the meantime.
    const areaRect = dom.panelsArea.getBoundingClientRect();
    const availableHeight = _measureViewerAvailableHeight();
    const fraction = (e.clientY - areaRect.top) / availableHeight;
    const clamped  = Math.max(0, Math.min(1, fraction));
    const effective = _applyViewerSplit(clamped);
    appState = { ...appState, config: { ...appState.config, viewerSplit: effective } };
    _viewerDrag.moved = true;
  });

  document.addEventListener('mouseup', () => {
    if (!_viewerDrag) return;
    // Same plain-click guard as the horizontal divider — see that
    // mouseup handler's comment for the full rationale (a double-click's
    // two click-pairs must not each be treated as a completed drag).
    const wasRealDrag = _viewerDrag.moved;
    _viewerDrag = null;
    dom.viewerDivider.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (wasRealDrag) {
      _persistViewerSplit(appState.config.viewerSplit || 0.5);
    }
  });

  dom.viewerDivider.addEventListener('dblclick', () => {
    if (!appState.viewerOpen) return;
    const effective = _applyViewerSplit(0.5);
    _persistViewerSplit(effective);
  });

  /**
   * Show or hide the Viewer panel. Visibility itself is session-only and
   * never persisted (see the config.js comment on viewerSplit) — only the
   * split position is, for whenever it's reopened. Toggling updates the
   * F3 button's inverted-color "on" state too.
   */
  function toggleViewer(forceState) {
    const next = typeof forceState === 'boolean' ? forceState : !appState.viewerOpen;
    appState = { ...appState, viewerOpen: next };

    dom.fkView.classList.toggle('toggled-on', next);
    dom.panelsArea.classList.toggle('no-viewer', !next);

    if (next) {
      dom.viewerDivider.style.display = 'block';
      dom.viewerPanel.style.display   = 'flex';
      _applyViewerSplit(appState.config.viewerSplit);
      renderViewer();
    } else {
      dom.viewerDivider.style.display = 'none';
      dom.viewerPanel.style.display   = 'none';
      // Hand the full flexible region back to the twin list panels.
      dom.panelsArea.style.flex = '1 1 0';
      document.body.classList.remove('viewer-overflow-scroll');
    }
  }

  dom.fkView.addEventListener('click', () => toggleViewer());
  dom.viewerClose.addEventListener('click', e => {
    e.stopPropagation();
    toggleViewer(false);
  });

  // ─── Viewer panel content rendering ────────────────────────────────────────

  // Per-side cache of the async enrichment (kind label, owner, permissions)
  // fetched by viewer-details.js for the current single-selection item, so
  // a re-render (e.g. triggered by the OTHER panel's selection changing)
  // doesn't need to re-fetch or lose what's already known. Keyed by the
  // item's path — cleared whenever that side's selection no longer matches.
  const _viewerDetailsCache = { left: null, right: null }; // { path, details } | null

  /**
   * Re-render the Viewer panel's content area from both panels' current
   * selection. Safe to call unconditionally (e.g. from every selection
   * mutation site) — it's a no-op render into a hidden panel if the Viewer
   * is currently closed, cheap enough not to bother guarding callers with
   * an appState.viewerOpen check themselves.
   */
  function renderViewer() {
    if (!appState.viewerOpen) return;

    const panels = {
      left:  { selection: selArray('left'),  entries: appState.panels.left.entries  },
      right: { selection: selArray('right'), entries: appState.panels.right.entries },
    };
    const desc = S.describeViewerSelection(panels);

    dom.viewerContent.innerHTML = '';

    if (desc.mode === 'empty') {
      _viewerDetailsCache.left = null;
      _viewerDetailsCache.right = null;
      dom.viewerContent.classList.add('viewer-content-centered');
      const empty = document.createElement('div');
      empty.className = 'viewer-empty';
      empty.textContent = 'Nothing selected in any panel. Select files or folders to see their details here.';
      dom.viewerContent.appendChild(empty);
      return;
    }

    dom.viewerContent.classList.remove('viewer-content-centered');

    const wrap = document.createElement('div');
    wrap.id = 'viewer-columns';

    for (const col of desc.columns) {
      wrap.appendChild(_renderViewerColumn(col));
    }
    dom.viewerContent.appendChild(wrap);

    // Content height can change with every render independent of any
    // divider drag (e.g. a multi-selection table is taller than a
    // single-item one) — re-check fit now that the new content is in
    // the live DOM and its real height can be measured.
    _applyViewerFit();

    // Drop any cached enrichment for a side that no longer has a (matching)
    // single-selection — keeps the cache from ever showing stale details
    // for a different item than what's now actually selected.
    for (const side of ['left', 'right']) {
      const col = desc.columns.find(c => c.side === side);
      const cached = _viewerDetailsCache[side];
      const wantsPath = (col && col.kind === 'single') ? col.entry.path : null;
      if (!wantsPath || (cached && cached.path !== wantsPath)) {
        _viewerDetailsCache[side] = null;
      }
    }

    // Kick off async enrichment for any single-selection column that
    // doesn't already have it cached. Skipped entirely while busy — see
    // the call site for the rationale (avoids competing with whatever
    // else might be using the single shared worker right now).
    for (const col of desc.columns) {
      if (col.kind !== 'single') continue;
      if (_viewerDetailsCache[col.side] && _viewerDetailsCache[col.side].path === col.entry.path) continue;
      _fetchViewerDetails(col.side, col.entry.path);
    }
  }

  async function _fetchViewerDetails(side, targetPath) {
    if (appState.busy) return; // see renderViewer()'s comment — skip, not queue

    adapter.assign('worker/tasks/viewer-details.js', { path: targetPath }).catch(err => {
      if (appState._viewerDetailsResolve) {
        const resolve = appState._viewerDetailsResolve;
        appState = { ...appState, _viewerDetailsResolve: null };
        resolve({ ok: false, error: err.message });
      }
    });

    const outcome = await new Promise(resolve => {
      appState = { ...appState, _viewerDetailsResolve: resolve };
    });

    if (!outcome.ok) return; // silently skip enrichment on failure, per design

    // Only apply if this is still the item that's actually selected on this
    // side — selection may have moved on during the round-trip.
    const sel = selArray(side);
    if (sel.length !== 1 || sel[0] !== targetPath) return;

    _viewerDetailsCache[side] = { path: targetPath, details: outcome.result };
    renderViewer();
  }

  function _renderViewerColumn(col) {
    const column = document.createElement('div');
    column.className = 'viewer-column';

    const info = document.createElement('div');
    info.className = 'column-info';

    const location = document.createElement('div');
    location.className = 'viewer-column-location';
    location.textContent = `${col.side === 'left' ? 'Left' : 'Right'} panel`;
    info.appendChild(location);

    if (col.kind === 'single') {
      info.appendChild(_renderViewerSingle(col));
    } else {
      info.appendChild(_renderViewerMulti(col));
    }

    column.appendChild(info);
    return column;
  }

  function _kv(label, value, rowClass) {
    const tr = document.createElement('tr');
    if (rowClass) tr.className = rowClass;
    const th = document.createElement('th');
    th.textContent = label;
    const td = document.createElement('td');
    if (value instanceof Node) td.appendChild(value);
    else td.textContent = value;
    tr.appendChild(th);
    tr.appendChild(td);
    return tr;
  }

  function _renderViewerSingle(col) {
    const frag = document.createDocumentFragment();
    const e = col.entry;
    const cached = _viewerDetailsCache[col.side];
    const details = (cached && cached.path === e.path) ? cached.details : null;

    const table = document.createElement('table');
    table.className = 'viewer-table';
    const tbody = document.createElement('tbody');

    tbody.appendChild(_kv('Type', e.type === 'dir' ? 'Folder' : 'File'));
    tbody.appendChild(_kv('Name', e.name));

    if (e.type === 'file') {
      tbody.appendChild(_kv('Kind', details ? details.kindLabel : '\u2026'));
    }

    tbody.appendChild(_kv('Created on', S.fmtDate(e.created)));
    tbody.appendChild(_kv('Last modified on', S.fmtDate(e.mtime)));

    if (details && details.owner) {
      tbody.appendChild(_kv('Owner', details.owner));
    }

    if (details) {
      const permLabel = process_platform_is_windows()
        ? 'Attributes'
        : 'Permissions';
      tbody.appendChild(_kv(permLabel, _renderViewerPermissions(details)));
    }

    // Size row: files show their known size directly (no calculation
    // needed); folders get a Calculate button shell (wiring lands in the
    // size-calculation pass). Only the button case needs vertical centering
    // — the button is taller than the label text, which otherwise looks
    // top-aligned/unbalanced next to it.
    if (e.type === 'dir') {
      tbody.appendChild(_kv('Size', _renderViewerSizeRow(col.side, [e.path]), 'viewer-size-kv'));
    } else {
      tbody.appendChild(_kv('Size', S.fmtSize(e.size)));
    }

    table.appendChild(tbody);
    frag.appendChild(table);
    return frag;
  }

  function _renderViewerPermissions(details) {
    if (process_platform_is_windows()) {
      const span = document.createElement('span');
      const bits = [];
      if (details.isReadOnly)   bits.push('Read-only');
      if (details.isExecutable) bits.push('Executable');
      span.textContent = bits.length ? bits.join(', ') : '\u2014';
      return span;
    }

    const grid = details.permissionGrid;
    const wrap = document.createElement('div');
    wrap.className = 'viewer-perm-grid';

    const corner = document.createElement('span');
    wrap.appendChild(corner);
    ['Read', 'Write', 'Execute'].forEach(h => {
      const head = document.createElement('span');
      head.className = 'viewer-perm-head';
      head.textContent = h;
      wrap.appendChild(head);
    });

    [['owner', 'Owner'], ['group', 'Group'], ['other', 'Other']].forEach(([key, label]) => {
      const rowLabel = document.createElement('span');
      rowLabel.className = 'viewer-perm-row-label';
      rowLabel.textContent = label;
      wrap.appendChild(rowLabel);
      ['r', 'w', 'x'].forEach(flag => {
        const cell = document.createElement('span');
        const isSet = grid && grid[key] && grid[key][flag];
        cell.className = 'viewer-perm-cell' + (isSet ? ' is-set' : '');
        cell.textContent = isSet ? '\u2713' : '\u2014';
        wrap.appendChild(cell);
      });
    });

    return wrap;
  }

  function _renderViewerMulti(col) {
    const frag = document.createDocumentFragment();

    const countsTable = document.createElement('table');
    countsTable.className = 'viewer-table';
    const countsBody = document.createElement('tbody');
    countsBody.appendChild(_kv('Files', String(col.counts.files)));
    countsBody.appendChild(_kv('Folders', String(col.counts.folders)));
    countsBody.appendChild(_kv('Total', String(col.counts.total)));
    countsTable.appendChild(countsBody);
    frag.appendChild(countsTable);

    frag.appendChild(_renderViewerRecentTable('Recent additions', 'Creation date', col.recentCreated));
    frag.appendChild(_renderViewerRecentTable('Recent changes', 'Modification date', col.recentModified));

    const sizeTitle = document.createElement('div');
    sizeTitle.className = 'viewer-subtable-title';
    sizeTitle.textContent = 'Total Size';
    frag.appendChild(sizeTitle);
    frag.appendChild(_renderViewerSizeRow(col.side, col.entries.map(e => e.path)));

    return frag;
  }

  function _renderViewerRecentTable(title, dateLabel, rows) {
    const frag = document.createDocumentFragment();
    const heading = document.createElement('div');
    heading.className = 'viewer-subtable-title';
    heading.textContent = title;
    frag.appendChild(heading);

    const table = document.createElement('table');
    table.className = 'viewer-table';
    const tbody = document.createElement('tbody');

    if (rows.length === 0) {
      tbody.appendChild(_kv('\u2014', 'No items'));
    } else {
      rows.forEach(r => {
        const tr = document.createElement('tr');
        const thType = document.createElement('th');
        thType.textContent = r.type === 'dir' ? 'Folder' : 'File';
        const td = document.createElement('td');
        td.textContent = `${r.name} \u2014 ${S.fmtDate(r.when)}`;
        tr.appendChild(thType);
        tr.appendChild(td);
        tbody.appendChild(tr);
      });
    }

    table.appendChild(tbody);
    frag.appendChild(table);
    return frag;
  }

  /**
   * Size row shell — Calculate button + result/spinner slot. The actual
   * calc-size.js task wiring (spawn, cancel-on-selection-change, WS result
   * notification) lands in a later pass; for now this renders the static
   * shell so the layout is in place and confirmed before that work starts.
   */
  function _renderViewerSizeRow(side, paths) {
    const row = document.createElement('div');
    row.className = 'viewer-size-row';
    const btn = document.createElement('button');
    btn.className = 'viewer-calc-btn';
    btn.textContent = 'Calculate';
    btn.disabled = true; // enabled once calc-size.js wiring lands
    btn.title = 'Coming soon';
    row.appendChild(btn);
    return row;
  }

  // The browser doesn't expose process.platform directly — appState.platform
  // (set from the worker's own navigate results, see makeAppState's comment)
  // is the one source of truth for this already used elsewhere in this file.
  function process_platform_is_windows() {
    return appState.platform === 'win32';
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
            _applyPanelSplit(payload.config.panelSplit);
          }
          if (payload.platform) {
            appState = { ...appState, platform: payload.platform };
          }
          renderPanel(payload.panel);
        }
      }
      if (payloads.length > 0) { renderFkeys(); renderViewer(); }

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

      // New File dialog completion
      if (createFileDlg._resultResolve) {
        const resolve = createFileDlg._resultResolve;
        createFileDlg._resultResolve = null;
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

      // F3 Viewer panel — async detail enrichment (kind label, owner,
      // permissions) for a single-selection column. Same forward-the-
      // result-as-is shape as F4's, since the caller needs the payload.
      if (appState._viewerDetailsResolve) {
        const resolve = appState._viewerDetailsResolve;
        appState = { ...appState, _viewerDetailsResolve: null };
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
          } else if (createFileDlg._resultResolve) {
            const resolve = createFileDlg._resultResolve;
            createFileDlg._resultResolve = null;
            resolve({ ok: false, error: errMsg || 'Unknown error' });
          } else if (appState._openWithResolve) {
            const resolve = appState._openWithResolve;
            appState = { ...appState, _openWithResolve: null };
            resolve({ ok: false, error: errMsg || 'Unknown error' });
          } else if (appState._viewerDetailsResolve) {
            const resolve = appState._viewerDetailsResolve;
            appState = { ...appState, _viewerDetailsResolve: null };
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

    // The breadcrumb can now overflow horizontally in a narrow panel (same
    // treatment as .tabs-bar) — default the scroll position to the END, so
    // the current directory (the segment users almost always care about)
    // is what's visible at a glance, rather than the volume root.
    el.scrollLeft = el.scrollWidth;
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
        renderViewer();
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
    // fk-view (F3/Toggle Viewer) is deliberately NOT gated here — it's a
    // pure UI visibility toggle, always enabled regardless of selection,
    // panel writability, or busy state (toggling a panel doesn't touch
    // the filesystem or the worker at all).
    dom.fkCopy.disabled   = !enabled.copy;
    dom.fkMove.disabled   = !enabled.move;
    dom.fkMkdir.disabled  = !enabled.mkdir;
    dom.fkDelete.disabled = !enabled.delete;
    dom.fkRename.disabled = !S.canRename(sel, appState.panels[side].entries, appState.busy);
    dom.fkEdit.disabled   = !S.canOpenWith(sel, appState.panels[side].entries, appState.busy);
    dom.fkNewFile.disabled = !S.canCreateFile(appState.panels[side].directoryWritable, appState.busy);
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
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); mkdirDlg.createBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); mkdirDlg.cancelBtn.click(); }
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

  // ─── New File dialog (Shift+F4, two phases: configure → error) ──────────────

  const createFileDlg = {
    bg:          document.getElementById('createfile-dialog-bg'),
    title:       document.getElementById('createfile-dialog-title'),
    input:       document.getElementById('createfile-input'),
    configPhase: document.getElementById('createfile-configure-phase'),
    errorPhase:  document.getElementById('createfile-error-phase'),
    errorMsg:    document.getElementById('createfile-error-msg'),
    cancelBtn:   document.getElementById('createfile-cancel'),
    confirmBtn:  document.getElementById('createfile-confirm'),
  };

  function _createFilePhase(phase) {
    const isConfigure = phase === 'configure';
    createFileDlg.configPhase.classList.toggle('hidden', !isConfigure);
    createFileDlg.errorPhase.classList.toggle('visible',  !isConfigure);
    if (isConfigure) {
      createFileDlg.title.textContent     = 'New File';
      createFileDlg.cancelBtn.textContent = 'Cancel';
      createFileDlg.confirmBtn.style.display = '';
    } else {
      createFileDlg.title.textContent     = 'Error';
      createFileDlg.cancelBtn.textContent = 'Close';
      createFileDlg.confirmBtn.style.display = 'none';
    }
  }

  createFileDlg.bg.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); createFileDlg.cancelBtn.click(); }
  });

  createFileDlg.input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); createFileDlg.confirmBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); createFileDlg.cancelBtn.click(); }
  });

  async function cmdCreateFile() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const panel = appState.panels[side];
    if (!S.canCreateFile(panel.directoryWritable, appState.busy)) return;

    // ── Configure phase ──────────────────────────────────────────────────────
    // The input is never pre-populated — always starts blank.
    createFileDlg.title.textContent = S.createFileDialogHeader(panel.path);
    createFileDlg.input.value = '';

    _createFilePhase('configure');
    createFileDlg.bg.classList.add('visible');
    setTimeout(() => createFileDlg.input.focus(), 30);

    const fileName = await new Promise(resolve => {
      const onCancel  = () => { cleanup(); resolve(null); };
      const onConfirm = () => { cleanup(); resolve(createFileDlg.input.value.trim()); };
      function cleanup() {
        createFileDlg.cancelBtn.removeEventListener('click', onCancel);
        createFileDlg.confirmBtn.removeEventListener('click', onConfirm);
      }
      createFileDlg.cancelBtn.addEventListener('click', onCancel);
      createFileDlg.confirmBtn.addEventListener('click', onConfirm);
    });

    // Cancelled or left blank — close without touching the disk
    if (!fileName) {
      createFileDlg.bg.classList.remove('visible');
      return;
    }

    // ── Task ───────────────────────────────────────────────────────────────────
    adapter.assign('worker/tasks/create-file.js', {
      panel: side, name: fileName,
    }).catch(err => {
      if (createFileDlg._resultResolve) {
        const r = createFileDlg._resultResolve; createFileDlg._resultResolve = null;
        r({ ok: false, error: err.message });
      }
    });

    const result = await new Promise(resolve => { createFileDlg._resultResolve = resolve; });

    if (result.ok) { createFileDlg.bg.classList.remove('visible'); return; }

    // ── Error phase ────────────────────────────────────────────────────────────
    const parts = (result.error || 'Unknown error').split('\n\n');
    createFileDlg.errorMsg.innerHTML = '';
    parts.forEach((p, i) => {
      const el = document.createElement('p');
      el.textContent = p;
      if (i > 0) el.className = 'msg-tip';
      createFileDlg.errorMsg.appendChild(el);
    });
    _createFilePhase('error');

    await new Promise(resolve => {
      const onClose = () => { createFileDlg.cancelBtn.removeEventListener('click', onClose); resolve(); };
      createFileDlg.cancelBtn.addEventListener('click', onClose);
    });
    createFileDlg.bg.classList.remove('visible');
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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renameDlg.cancelBtn.click(); }
  });

  renameDlg.input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); renameDlg.confirmBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renameDlg.cancelBtn.click(); }
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

  // Minimum time the F4 icon spinner stays visible, regardless of how fast
  // the task itself settles. Without this, a fast MIME-sniff + spawn (the
  // common case) can make the spinner flash for a barely-perceptible
  // instant, which reads as a glitch rather than feedback.
  const OPEN_WITH_SPINNER_MIN_MS = 1000;

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
  // to clear it on, just with a floor under it so a very fast settle never
  // reads as a flash/glitch. That signal still only means "the launch
  // request was handled", same caveat as everywhere else in this file: we
  // cannot know when the target application has actually finished opening.
  async function cmdOpenWith() {
    if (appState.busy) return;
    const side = appState.activePanel;
    const sel  = selArray(side);
    if (!S.canOpenWith(sel, appState.panels[side].entries, appState.busy)) return;

    const targetPath = sel[0];

    appState = { ...appState, _spinningPath: targetPath };
    renderList(side, appState.panels[side]);
    const spinnerStartedAt = Date.now();

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

    // Enforce the minimum visible duration before clearing the spinner.
    const elapsed = Date.now() - spinnerStartedAt;
    if (elapsed < OPEN_WITH_SPINNER_MIN_MS) {
      await new Promise(r => setTimeout(r, OPEN_WITH_SPINNER_MIN_MS - elapsed));
    }

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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); copyDlg.cancelBtn.click(); }
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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); deleteDlg.cancelBtn.click(); }
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); deleteDlg.confirmBtn.click(); }
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

  // Defense-in-depth check, kept even though every dialog's own keydown
  // handler now calls stopPropagation() (so a key consumed by a dialog
  // should never reach this far at all). This guard remains in case a
  // future dialog is added without that call, or a dialog is shown by some
  // path that doesn't go through its own keydown listener.
  function _anyDialogOpen() {
    return mkdirDlg.bg.classList.contains('visible')
        || renameDlg.bg.classList.contains('visible')
        || createFileDlg.bg.classList.contains('visible')
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
    else if (e.key === 'F3')                         { e.preventDefault(); toggleViewer(); }
    else if (e.key === 'F4' && e.shiftKey)           { e.preventDefault(); cmdCreateFile(); }
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
        renderViewer();
      }
    }
  });

  dom.fkNewFile.addEventListener('click', cmdCreateFile);
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
