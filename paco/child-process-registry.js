'use strict';

/**
 * paco/child-process-registry.js
 *
 * Factory for an in-memory registry of in-flight, detached-from-their-
 * original-task child processes, keyed by a caller-generated id. Extracted
 * from what was originally paco/calc-registry.js (the F3 size-calculation
 * registry) once a second, independent caller — the F3 iframe extraction
 * pipeline — needed the exact same shape of thing: a task that forks a
 * child and returns immediately (see e.g. worker/tasks/calc-size.js and
 * worker/tasks/extract-preview.js) needs somewhere to park that child so a
 * LATER, separate cancel task can still find and kill it, since by the
 * time a cancel might arrive, the original spawning task's own invocation
 * has long since completed and exited.
 *
 * This module holds no state itself — it only builds fresh, independent
 * registries. Each caller (paco/calc-registry.js, paco/extract-registry.js)
 * calls createChildProcessRegistry() exactly once at module load and
 * exports that single instance, so Node's require() cache gives every
 * consumer of THAT specific file the same instance — the same mechanism
 * that made the original calc-registry.js work as shared state across
 * separate task invocations within one worker process. Two different
 * registries (calc's and extract's) are deliberately never the same
 * instance — a calc-size calcId and an extraction's jobId share no
 * namespace, so keeping them in separate Maps avoids any possibility of
 * one accidentally colliding with or shadowing the other.
 *
 * There is deliberately no TTL/sweep — same as the original — every code
 * path that creates an entry is expected to also guarantee its own
 * removal (a completion handler, a cancel task, or an 'exit' listener
 * cleaning up after an unexpected crash).
 */

/**
 * @returns {{
 *   register: (id: string, child: import('child_process').ChildProcess) => void,
 *   get:      (id: string) => import('child_process').ChildProcess|undefined,
 *   remove:   (id: string) => void,
 *   size:     () => number,
 * }}
 */
function createChildProcessRegistry() {
  const registry = new Map(); // id -> ChildProcess

  return {
    register(id, child) {
      registry.set(id, child);
    },
    get(id) {
      return registry.get(id);
    },
    remove(id) {
      registry.delete(id);
    },
    size() {
      return registry.size;
    },
  };
}

module.exports = { createChildProcessRegistry };
