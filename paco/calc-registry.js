'use strict';

/**
 * paco/calc-registry.js
 *
 * In-memory registry of in-flight size-calculation child processes, keyed
 * by a generated calcId. Lives in the worker process (the same long-lived
 * process every worker/tasks/*.js task runs in) — NOT in main.js or
 * server-process.js, since only the worker process actually spawns these
 * children.
 *
 * Why a registry at all, rather than each task keeping its own local
 * variable: calc-size.js spawns the child and returns immediately (it does
 * NOT wait for the child to finish — see that file's header for why), so
 * by the time a user might want to cancel, calc-size.js's own invocation
 * has long since completed and exited. A LATER, separate cancel-calc.js
 * invocation needs some way to find the still-running child — this module
 * is that shared, persistent home. Node's require() cache means both task
 * files get the exact same module instance across multiple task
 * invocations within the worker process's lifetime, which is what makes a
 * plain module-level Map work correctly here.
 *
 * Entries are removed in three ways, all already covered:
 *   - cancel-calc.js removes it after killing the child
 *   - calc-size-child.js's own completion message handler (in
 *     worker/tasks/calc-size.js) removes it once a result has been reported
 *   - if the child exits/errors for any other reason, the same 'exit'
 *     listener cleans it up
 * There is deliberately no TTL/sweep — every code path that creates an
 * entry also guarantees its own removal.
 */

const registry = new Map(); // calcId -> ChildProcess

/**
 * @param {string} calcId
 * @param {import('child_process').ChildProcess} child
 */
function register(calcId, child) {
  registry.set(calcId, child);
}

/**
 * @param {string} calcId
 * @returns {import('child_process').ChildProcess|undefined}
 */
function get(calcId) {
  return registry.get(calcId);
}

/**
 * @param {string} calcId
 */
function remove(calcId) {
  registry.delete(calcId);
}

/**
 * @returns {number} count of currently-tracked in-flight calculations —
 *   exposed for tests; not used by production code.
 */
function size() {
  return registry.size;
}

module.exports = { register, get, remove, size };
