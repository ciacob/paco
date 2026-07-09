'use strict';

/**
 * paco/extract-registry.js
 *
 * The F3 iframe-extraction registry — one singleton instance of the shared
 * child-process registry factory (paco/child-process-registry.js), created
 * once at module load. Same shape and same reasoning as paco/calc-registry.js
 * (its older sibling, reduced to a thin wrapper around the same factory
 * when this module was added): worker/tasks/extract-preview.js forks a
 * child to run the matched extractor and returns immediately without
 * waiting for it, registering the child here under a generated jobId; a
 * later, separate worker/tasks/cancel-extract.js invocation (fired when
 * the user switches tabs or changes selection mid-extraction) looks that
 * jobId up here to find and kill the still-running child.
 *
 * Deliberately a separate instance from calc-registry.js, not a shared
 * one — a calc-size calcId and an extraction jobId are different
 * namespaces with no reason to ever collide or shadow one another.
 */

const { createChildProcessRegistry } = require('./child-process-registry');

module.exports = createChildProcessRegistry();
