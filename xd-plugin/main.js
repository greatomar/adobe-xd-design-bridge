/**
 * OpenCode Design Bridge — panel logic.
 *
 * Execution model (documented XD constraint): application.editDocument() may
 * only be called in response to a UI event (click/keydown/mousedown/input/…)
 * with the handler on the call stack. Therefore:
 *   - READ-ONLY operations (inspection, search, validation, PNG renditions)
 *     execute immediately when a request arrives over WebSocket.
 *   - MUTATING operations are QUEUED and executed when the user clicks
 *     "Execute pending (N)", or — when "Auto on interaction" is enabled — on
 *     the next click/keypress inside this panel (also a documented UI event).
 *     All queued operations run inside ONE editDocument batch (single undo step).
 */
(function () {
  "use strict";

  // --- BOOT diagnostics (temporary; remove after load failure is resolved) ---
  console.log("BOOT: main.js evaluating");
  const __missing = [];

  const PORT = 27183;
  const URL = "ws://127.0.0.1:" + PORT;
  const TOKEN_FILE = "bridge-token.txt";

  let ws = null;
  let connected = false;
  let queue = [];          // { id, op, params }
  let executing = false;
  let autoMode = true; // apply queued work on the next panel interaction by default
  let lastResults = [];

  const el = (id) => document.getElementById(id);
  const log = (msg) => {
    const pre = el("log");
    const stamp = new Date().toISOString().slice(11, 19);
    pre.textContent = "[" + stamp + "] " + msg + "\n" + pre.textContent;
  };

  function setStatus(id, cls, text) {
    const node = el(id);
    if (!node) return;
    if (id === "wsStatus") {
      // Compact status pill: the detailed reason stays in the activity log.
      node.className = "pill " + cls;
      node.textContent = cls === "ok" ? "Live" : cls === "warn" ? "Connecting" : "Offline";
      return;
    }
    node.className = "";
    node.textContent = text;
    node.style.color = cls === "err" ? "#ff6b5e" : cls === "warn" ? "#ffb45a" : "";
  }

  function updateQueueUi() {
    const btn = el("execBtn");
    const info = el("queueInfo");
    if (btn) {
      btn.disabled = executing || queue.length === 0;
      btn.textContent = executing ? "Applying…" : queue.length ? "Apply " + queue.length + " change(s)" : "Apply";
    }
    if (info) {
      if (executing) {
        info.className = "busy";
        info.textContent = "Applying…";
      } else if (queue.length) {
        info.className = "armed";
        info.textContent = autoMode
          ? queue.length + " change(s) ready — click anywhere in this panel to apply"
          : queue.length + " change(s) waiting";
      } else {
        info.className = "";
        info.textContent = "Idle — nothing queued";
      }
    }
    const hint = el("logHint");
    if (hint) hint.textContent = executing ? "working" : autoMode ? "auto" : "manual";
  }

  // --- token persistence (plugin data folder; token never in source) --------
  let fs = null;
  try {
    fs = require("uxp").storage.localFileSystem;
    console.log("BOOT: uxp module + localFileSystem ok");
  } catch (e) {
    console.error("BOOT: ERROR requiring uxp:", e && e.stack ? e.stack : String(e));
  }
  async function loadToken() {
    try {
      const folder = await fs.getDataFolder();
      const file = await folder.getEntry(TOKEN_FILE).catch(() => null);
      if (file) return await file.read();
    } catch (e) {
      /* fall through */
    }
    return null;
  }
  async function saveToken(token) {
    try {
      const folder = await fs.getDataFolder();
      const file = await folder.createFile(TOKEN_FILE, { overwrite: true });
      await file.write(token);
    } catch (e) {
      log("could not persist token: " + e);
    }
  }

  // --- document/selection UI -------------------------------------------------
  function refreshInfo() {
    try {
      const application = require("application");
      const scenegraph = require("scenegraph");
      const doc = application.activeDocument;
      if (!doc) {
        setStatus("docStatus", "warn", "Document: none open");
        setStatus("selStatus", "", "Selection: –");
        return;
      }
      // DocumentInfo exposes name + guid only (no .root, .path or .modified);
      // the scenegraph root is the documented scenegraph.root RootNode.
      // RootNode.children is a SceneNodeList (array-like, not an Array): use length + at().
      const root = scenegraph.root;
      const list = root ? root.children : null;
      const count = list && typeof list.length === "number" ? list.length : 0;
      let abs = 0;
      for (let i = 0; i < count; i++) {
        const c = typeof list.at === "function" ? list.at(i) : list[i];
        if (c && c.constructor && c.constructor.name === "Artboard") abs++;
      }
      setStatus("docStatus", list ? "ok" : "warn", "Document: " + doc.name + " · " + abs + " artboard(s)" + (list ? "" : " (scenegraph unavailable)"));
      const sel = scenegraph.selection;
      const names = sel.items.map(function (n) { return n.name || n.constructor.name; }).join(", ");
      setStatus("selStatus", sel.items.length ? "ok" : "", "Selection: " + (sel.items.length ? names.slice(0, 80) : "empty"));
    } catch (e) {
      setStatus("docStatus", "err", "Document: error " + e);
    }
  }

  // --- websocket client -------------------------------------------------------
  async function connect(tokenOverride) {
    let token = tokenOverride || el("token").value.trim();
    if (!token) token = await loadToken();
    if (!token) {
      setStatus("wsStatus", "err", "Bridge: no token — paste it above, then Connect");
      return;
    }
    await saveToken(token);
    try {
      if (ws) { try { ws.close(); } catch (e) {} }
      setStatus("wsStatus", "warn", "Bridge: connecting…");
      console.log("BOOT: creating WebSocket to " + URL);
      ws = new WebSocket(URL);
      console.log("BOOT: WebSocket created, protocol support confirmed");
      ws.onopen = function () {
        ws.send(JSON.stringify({ type: "hello", token: token, version: "1.0.6", capabilities: ["panel", "editDocument", "createRenditions", "scenegraph", "nativeImport", "prototypeInspection"] }));
      };
      ws.onmessage = function (evt) {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (e) { return; }
        if (msg.type === "ready") {
          connected = true;
          setStatus("wsStatus", "ok", "Bridge: connected (127.0.0.1:" + PORT + ")");
          log("authenticated with bridge");
          refreshInfo();
        } else if (msg.type === "request") {
          handleRequest(msg);
        }
      };
      ws.onclose = function (evt) {
        connected = false;
        const reason = evt && evt.reason ? evt.reason : "";
        setStatus("wsStatus", "err", "Bridge: disconnected" + (reason ? " (" + reason + ")" : "") + " — auto-retrying");
        log("closed: code " + (evt && evt.code) + " " + reason);
        setTimeout(function () {
          if (!connected) connect();
        }, 4000);
      };
      ws.onerror = function () {
        setStatus("wsStatus", "err", "Bridge: unreachable — is OpenCode running (or `node bridge\\bin\\bridge.ts`)?");
      };
    } catch (e) {
      setStatus("wsStatus", "err", "Bridge: connect failed " + e);
    }
  }

  function sendEvent(name, data) {
    if (connected && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "event", name: name, data: data }));
    }
  }

  // --- operation handling -------------------------------------------------------
  function respond(id, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type: "response", id: id }, payload)));
  }

  function handleRequest(msg) {
    const handlers = window.__xdBridgeOps.handlers;
    const isReadOnly = window.__xdBridgeOps.nonMutating.has(msg.op);
    const h = handlers[msg.op];
    if (!h) {
      respond(msg.id, { ok: false, error: "unsupported op: " + msg.op, code: "unsupported_op" });
      return;
    }

    if (isReadOnly) {
      // Reads and renditions are legal outside an edit context.
      setStatus("wsStatus", "ok", "Bridge: connected · reading: " + msg.op);
      Promise.resolve()
        .then(function () { return h(msg.params || {}); })
        .then(function (result) {
          respond(msg.id, {
            ok: !!(result && result.ok),
            result: result,
            error: result && result.ok ? undefined : (result.error || result.reason || "operation failed"),
            code: result && result.ok ? undefined : (result.supported === false ? "unsupported" : "plugin_error"),
          });
          log(msg.op + " → " + (result && result.ok ? "ok" : "failed: " + (result.error || result.reason)));
          refreshInfo();
        })
        .catch(function (e) {
          respond(msg.id, { ok: false, error: String(e && e.message ? e.message : e), code: "plugin_exception" });
          log(msg.op + " → exception: " + e);
        });
      return;
    }

    // Mutating: queue, respond immediately, execute on a documented UI event.
    queue.push({ id: msg.id, op: msg.op, params: msg.params || {} });
    updateQueueUi();
    setStatus("wsStatus", "ok", "Bridge: connected · queued: " + queue.length);
    log("queued: " + msg.op + (msg.params && msg.params.name ? " (" + msg.params.name + ")" : ""));
    respond(msg.id, { ok: true, result: { ok: true, queued: true, op: msg.op, pending: queue.length } });
  }

  /** Drain the queue inside ONE editDocument batch (call from a UI event). */
  function executePending() {
    if (executing || queue.length === 0) return;
    executing = true;
    updateQueueUi();
    const application = require("application");
    const batch = queue.splice(0);
    const executor = window.__xdBridgeExecutor;

    if (!executor || typeof executor.runQueuedBatch !== "function") {
      finishBatch(batch, [], new Error("panel executor unavailable (executor.js is not loaded)"));
      return;
    }

    // Completion is reported by executor.js only after the async edit callback
    // has finished, so per-operation results are populated before the event.
    executor.runQueuedBatch({
      application: application,
      editLabel: "OpenCode Design Bridge",
      operations: batch.map(function (q) { return { op: q.op, params: q.params }; }),
      execute: async function (operations) {
        const result = await window.__xdBridgeOps.handlers.execute_batch({ operations: operations });
        return (result && result.results) || [];
      },
      onSettled: function (results, err) {
        finishBatch(batch, results, err);
      },
    });
  }

  function finishBatch(batch, results, err) {
    executing = false;
    lastResults = { batch: batch.map(function (q) { return q.op; }), results: results, error: err ? String(err) : null, at: Date.now() };
    batch.forEach(function (q, i) {
      const r = results[i];
      const ok = r && r.ok;
      respond(q.id, {
        ok: !!ok,
        result: r || null,
        error: ok ? undefined : (r ? (r.error || r.reason || "operation failed") : String(err || "batch failed")),
        code: ok ? undefined : (r && r.supported === false ? "unsupported" : "plugin_error"),
      });
      log(q.op + " → " + (ok ? "ok" : "failed: " + (r ? (r.error || r.reason) : err)));
    });
    sendEvent("batchExecuted", lastResults);
    updateQueueUi();
    setStatus("wsStatus", "ok", "Bridge: connected");
    refreshInfo();
  }

  // --- UI wiring ---------------------------------------------------------------
  ["connectBtn", "refreshBtn", "execBtn", "autoChk", "token", "log", "wsStatus", "docStatus", "selStatus"].forEach(function (id) {
    if (!el(id)) __missing.push(id);
  });
  if (__missing.length) {
    console.error("BOOT: ERROR missing DOM elements:", __missing.join(", "));
  } else {
    console.log("BOOT: all panel DOM elements found");
  }

  el("connectBtn").addEventListener("click", function () { connect(); });
  el("refreshBtn").addEventListener("click", refreshInfo);
  el("execBtn").addEventListener("click", executePending);

  el("autoChk").checked = autoMode;
  el("autoChk").addEventListener("change", function () {
    autoMode = el("autoChk").checked;
    updateQueueUi();
    log("auto-apply: " + (autoMode ? "ON" : "OFF"));
  });

  // Documented-legal UI events that may drain the queue when Auto is enabled.
  ["pointerdown", "mousedown", "pointerup", "click", "keydown", "keyup", "input", "change"].forEach(function (evtName) {
    document.body.addEventListener(evtName, function () {
      if (autoMode && !executing && queue.length > 0) executePending();
    });
  });

  (async function init() {
    console.log("BOOT: async init started");
    try {
      refreshInfo();
      const saved = await loadToken();
      console.log("BOOT: token load complete (" + (saved ? "found" : "none stored") + ")");
      if (saved) {
        el("token").value = saved;
        log("stored token found — auto-connecting…");
        connect(saved);
      }
      updateQueueUi();
      console.log("BOOT: startup complete");
    } catch (e) {
      console.error("BOOT: ERROR in async init:", e && e.stack ? e.stack : String(e));
    }
  })().catch(function (e) {
    console.error("BOOT: ERROR unhandled in init promise:", e && e.stack ? e.stack : String(e));
  });
})();
