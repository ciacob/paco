/**
 * ui/adapter.js
 *
 * UIAdapter: the single communication facade between the UI and the server.
 *
 * ALL REST calls and WebSocket interactions live here.
 * The rendering layer (app.js) calls methods on `window.adapter` and
 * registers a single onStateChange callback — it never touches fetch()
 * or WebSocket directly.
 *
 * Swapping the UI framework means rewriting app.js only.
 * Swapping the transport or API shape means rewriting adapter.js only.
 */

(function () {
  'use strict';

  const BASE_URL = window.location.origin;

  // Verbose diagnostic logging — the wire-level tracing below, plus every
  // similarly-verbose [PACO ...] log in paco-app.js — is OFF by default.
  // It earned its keep during a long debugging session where seeing every
  // outgoing assign() and every incoming WS message, in order, was what
  // actually let a real race condition get found and fixed — but it's
  // pure noise for normal day-to-day use, so it's gated behind a single
  // shared flag rather than always-on. Toggle from the browser console:
  //   pacoDebug(true)   — turn on, persists across reloads
  //   pacoDebug(false)  — turn back off
  // Defined here (adapter.js loads before paco-app.js — see index.html's
  // own script order) so both files can reference the same window-level
  // flag without either needing to redefine it.
  let _debugStored = '0';
  try { _debugStored = localStorage.getItem('paco-debug') || '0'; } catch (_) {}
  window.PACO_DEBUG = _debugStored === '1';
  window.pacoDebug = function (on) {
    window.PACO_DEBUG = !!on;
    try { localStorage.setItem('paco-debug', window.PACO_DEBUG ? '1' : '0'); } catch (_) {}
    console.log('[PACO] verbose logging', window.PACO_DEBUG ? 'ENABLED' : 'disabled');
  };
  function _dlog(...args) { if (window.PACO_DEBUG) console.log(...args); }

  // Printed unconditionally (not gated by PACO_DEBUG itself — nobody
  // would ever see the instructions for turning it ON if they were only
  // shown while already on) so the toggle is discoverable right where
  // anyone debugging PACO is already looking, rather than relying on
  // someone remembering it exists or digging through source comments.
  console.log(
    '%c[PACO]%c verbose diagnostic logging (every assign()/WS message, in order) is available but OFF by default. Run %cpacoDebug(true)%c to enable it — the setting persists across reloads. %cpacoDebug(false)%c to turn it back off.',
    'color:#4a9eff;font-weight:bold', 'color:inherit',
    'color:#4a9eff;font-weight:bold', 'color:inherit',
    'color:#4a9eff;font-weight:bold', 'color:inherit'
  );

  // Comprehensive wire-level tracing — every outgoing assign() and every
  // incoming WS message, logged here unconditionally, since this is the
  // one place both actually pass through regardless of which caller (F3
  // viewer-details, F3 calc-size, F3 extract-preview, navigate, copy,
  // mkdir, everything) triggered them. Added after three rounds of
  // guessing at the exact sequence from partial logs scattered across
  // paco-app.js — this gives the full, ordered picture in one place
  // instead. Sequence numbers let the two sides (outgoing assigns,
  // incoming WS pushes) be correlated by eye even though there's no
  // request/response id actually threaded through the server.
  let _wireSeq = 0;

  class UIAdapter {
    constructor() {
      this._onStateChange = null;
      this._ws            = null;
      this._reconnectDelay = 1500;
    }

    // ─── Setup ───────────────────────────────────────────────────────────────

    /**
     * Register the single state-change handler.
     * The UI calls this once on initialisation.
     * @param {Function} handler  fn(state: WorkerState) => void
     */
    onStateChange(handler) {
      this._onStateChange = handler;
    }

    /**
     * Connect the WebSocket and start receiving live state updates.
     * Also performs an immediate REST status fetch so the UI is not blank.
     */
    connect() {
      this._connectWS();
      this.getStatus().then((state) => {
        if (this._onStateChange) this._onStateChange(state);
      }).catch(() => {});
    }

    _connectWS() {
      const wsUrl = BASE_URL.replace(/^http/, 'ws') + '/ws/status';
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.onmessage = (event) => {
        try {
          const state = JSON.parse(event.data);
          const n = ++_wireSeq;
          _dlog(`[PACO wire] #${n} <- WS`, JSON.stringify(state));
          if (this._onStateChange) this._onStateChange(state);
        } catch (_) {}
      };

      ws.onclose = () => {
        // Auto-reconnect
        setTimeout(() => this._connectWS(), this._reconnectDelay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    // ─── REST helpers ─────────────────────────────────────────────────────────

    async _post(path, body) {
      const hasBody = body !== undefined && body !== null;
      const res = await fetch(`${BASE_URL}${path}`, {
        method:  'POST',
        headers: hasBody ? { 'Content-Type': 'application/json' } : {},
        body:    hasBody ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`POST ${path} failed (${res.status}): ${text}`);
      }
      return res.json();
    }

    async _get(path) {
      const res = await fetch(`${BASE_URL}${path}`);
      return res.json();
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    getConfig() {
      return this._get('/config');
    }

    getRenderers() {
      return this._get('/renderers');
    }

    getStatus() {
      return this._get('/worker/status');
    }

    assign(modulePath, config) {
      const n = ++_wireSeq;
      _dlog(`[PACO wire] #${n} -> assign`, modulePath, JSON.stringify(config || {}));
      return this._post('/worker/assign', { modulePath, config: config || {} }).then((res) => {
        _dlog(`[PACO wire] #${n} <- assign accepted`, modulePath, JSON.stringify(res));
        return res;
      }).catch((err) => {
        _dlog(`[PACO wire] #${n} <- assign REJECTED`, modulePath, err && err.message);
        throw err;
      });
    }

    pause() {
      return this._post('/worker/pause');
    }

    resume() {
      return this._post('/worker/resume');
    }

    abort() {
      return this._post('/worker/abort');
    }

    reset() {
      return this._post('/worker/reset');
    }
  }

  // Expose as a singleton on window
  window.adapter = new UIAdapter();
})();
