'use strict';

/**
 * worker/tasks/navigate.js
 *
 * PACO command task: navigate a panel to a new directory.
 *
 * Config:
 *   {string}  panel              — 'left' | 'right'
 *   {string}  path               — absolute path to navigate to ('' = home dir)
 *   {string}  [tabId]            — tab to update (defaults to panel's activeTab)
 *   {boolean} [pushHistory=true]
 *
 * Result: navigate-compatible panel payload (see paco/task-helpers.refreshPanel)
 */

const nodePath = require('path');
const os       = require('os');
const context  = require('../../paco/context');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

module.exports = {
  async start(ctx) {
    const { panel, path: rawPath, tabId, pushHistory = true } = ctx.config;

    // ── 1. Bootstrap ─────────────────────────────────────────────────────────
    ctx.progress(5, 'Initialising…');
    const { config, state } = helpers.boot();

    // ── 2. Resolve target path ────────────────────────────────────────────────
    ctx.progress(10, 'Resolving path…');
    let resolved;
    try {
      resolved = rawPath ? nodePath.resolve(rawPath) : os.homedir();
    } catch (err) {
      return ctx.fail(`Invalid path: ${err.message}`);
    }

    // ── 3. List directory ─────────────────────────────────────────────────────
    ctx.progress(20, `Reading ${resolved}…`);
    let entries;
    try {
      entries = await provider.list(resolved, {
        showHidden: config.showHidden,
        sortBy:     config.sortBy,
        sortAsc:    config.sortAsc,
      });
    } catch (err) {
      return ctx.fail(`Cannot read directory: ${err.message}`);
    }

    // ── 4. Update context on disk ─────────────────────────────────────────────
    ctx.progress(80, 'Updating state…');
    const panelState = state.panels[panel];
    const activeTab  = tabId || panelState.activeTab;
    const tabs       = panelState.tabs.map(t =>
      t.id === activeTab ? { ...t, path: resolved } : t
    );

    context.updatePanel(panel, { path: resolved, selection: [], tabs, activeTab });
    if (pushHistory) context.pushHistory(panel, resolved);

    // ── 5. Build full result via shared helper ────────────────────────────────
    ctx.progress(90, 'Finalising…');
    const result = await helpers.refreshPanel(panel, resolved);

    ctx.progress(100, 'Done');
    ctx.done(result);
  },
};
