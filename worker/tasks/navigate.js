'use strict';

/**
 * worker/tasks/navigate.js
 *
 * PACO command task: navigate a panel to a new directory.
 *
 * Config (passed via adapter.assign):
 *   {string}  panel      — 'left' | 'right'
 *   {string}  path       — absolute path to navigate to
 *   {string}  [tabId]    — which tab to update (defaults to panel's activeTab)
 *   {boolean} [pushHistory=true] — whether to push to nav history
 *
 * Result (passed to done()):
 *   {string}   panel
 *   {string}   path
 *   {FsEntry[]} entries
 *   {object[]} breadcrumbs
 *   {object}   panelState   — full updated panel state slice
 *   {string[]} history      — updated history for this panel
 *   {string[]} volumes      — available volumes (refreshed on every navigate)
 *   {object}   config       — full config (so UI can apply theme/sort/etc.)
 */

const path    = require('path');
const context = require('../../paco/context');
const fs      = require('../../paco/fs-provider');

module.exports = {
  async start(ctx) {
    const { panel, path: targetPath, tabId, pushHistory = true } = ctx.config;

    // ── 1. Bootstrap context ─────────────────────────────────────────────────
    ctx.progress(2, 'Initialising…');
    context.bootstrap();
    const config = context.readConfig();
    const state  = context.readState();

    // ── 2. Resolve & validate target path ────────────────────────────────────
    ctx.progress(5, 'Resolving path…');
    let resolved;
    try {
      resolved = path.resolve(targetPath);
    } catch (err) {
      return ctx.fail(`Invalid path: ${err.message}`);
    }

    // ── 3. List volumes ───────────────────────────────────────────────────────
    ctx.progress(10, 'Listing volumes…');
    let volumes;
    try {
      volumes = await fs.listVolumes();
    } catch (_) {
      volumes = ['/'];
    }

    // ── 4. List directory ─────────────────────────────────────────────────────
    ctx.progress(20, `Reading ${resolved}…`);
    let entries;
    try {
      entries = await fs.list(resolved, {
        showHidden: config.showHidden,
        sortBy:     config.sortBy,
        sortAsc:    config.sortAsc,
      });
    } catch (err) {
      return ctx.fail(`Cannot read directory: ${err.message}`);
    }

    // ── 5. Build breadcrumbs ──────────────────────────────────────────────────
    ctx.progress(70, 'Building breadcrumbs…');
    const crumbs = fs.breadcrumbs(resolved);

    // ── 6. Update context on disk ─────────────────────────────────────────────
    ctx.progress(80, 'Updating state…');
    const panelState = state.panels[panel];
    const activeTab  = tabId || panelState.activeTab;

    // Update the path on the active tab
    const tabs = panelState.tabs.map(t =>
      t.id === activeTab ? { ...t, path: resolved } : t
    );

    context.updatePanel(panel, {
      path:      resolved,
      selection: [],   // clear selection on navigation
      tabs,
      activeTab,
    });

    if (pushHistory) {
      context.pushHistory(panel, resolved);
    }

    // ── 7. Read back updated state ────────────────────────────────────────────
    ctx.progress(90, 'Finalising…');
    const updatedState   = context.readState();
    const updatedHistory = context.readHistory();

    // ── 8. Done ───────────────────────────────────────────────────────────────
    ctx.progress(100, 'Done');
    ctx.done({
      panel,
      path:        resolved,
      entries,
      breadcrumbs: crumbs,
      panelState:  updatedState.panels[panel],
      history:     updatedHistory[panel],
      volumes,
      config,
    });
  },
};
