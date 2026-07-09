'use strict';

/**
 * paco/calc-registry.js
 *
 * The F3 size-calculation registry — one singleton instance of the shared
 * child-process registry factory (paco/child-process-registry.js), created
 * once at module load. Node's require() cache means every file that
 * requires THIS module gets the exact same instance across the worker
 * process's lifetime, which is what lets worker/tasks/calc-size.js (which
 * registers an entry and returns immediately, without waiting for its
 * spawned child) and worker/tasks/cancel-calc.js (a later, separate task
 * invocation that needs to find that same child) share state.
 *
 * See child-process-registry.js for the actual implementation and the
 * three ways an entry gets removed (cancel-calc.js, the child's own
 * completion handler in calc-size.js, or an unexpected-exit cleanup) —
 * none of that changed when this file was reduced to a thin wrapper around
 * the shared factory; only the Map itself moved, not the semantics.
 */

const { createChildProcessRegistry } = require('./child-process-registry');

module.exports = createChildProcessRegistry();
