'use strict';

/**
 * worker/tasks/save-config.js
 *
 * Lightweight task: merge one or more config key/value pairs into
 * ~/.paco/config.json. Used by the UI to persist dialog preferences
 * without triggering a full navigate round-trip.
 *
 * Config: any flat key/value pairs to merge into stored config.
 * Result: { saved: true }
 */

const helpers = require('../../paco/task-helpers');
const context = require('../../paco/context');

module.exports = {
  async start(ctx) {
    ctx.progress(10, 'Saving…', {});
    helpers.boot();

    // Everything in ctx.config is treated as a config update.
    // Strip internal task-routing fields that don't belong in config.
    const { panel, dstPanel, sources, dst, tabs, activeTab, tabId,
            pushHistory, path, ...updates } = ctx.config;

    if (Object.keys(updates).length > 0) {
      context.updateConfig(updates);
    }

    ctx.progress(100, 'Saved', {});
    ctx.done({ saved: true });
  },
};
