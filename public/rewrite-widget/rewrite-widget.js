/* rewrite-widget.js (shared status poller edition)
   UI widget for HK Rewrite Bridge (OIDC-protected API)
   Creates a card with: status dot + status text + textarea + Undo + Rewrite + toast.

   Key improvement:
   - A SINGLE shared status poller per apiBase (and per STATUS_URL).
   - Widgets subscribe to shared model state updates.
   - No duplicated network requests for model-status.

   Public API:
     const w = await RewriteWidget.mount({...})
     w.rewrite()
     w.undo()
     w.pollStatusOnce()   // forces immediate shared poll
     w.destroy()
*/

(function (global) {
  "use strict";

  // -----------------------
  // Helpers
  // -----------------------
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal, credentials: "include" });
    } finally {
      clearTimeout(id);
    }
  }

  async function safeJson(res) {
    try { return await res.json(); } catch { return null; }
  }

  function isLikelyAuthRedirect(res, requestUrl) {
    if (!res) return false;

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    // Auth/login pages usually end up as followed redirects to HTML.
    // Avoid treating generic upstream HTML error pages (e.g., 502/503) as auth redirects.
    if (res.ok && ct.includes("text/html") && res.redirected) return true;

    // If we expected one endpoint but ended up at a different URL, it's likely a login bounce.
    if (requestUrl && res.redirected && res.url) {
      try {
        const requested = new URL(requestUrl, window.location.href);
        const finalUrl = new URL(res.url, window.location.href);
        if (requested.origin !== finalUrl.origin || requested.pathname !== finalUrl.pathname) {
          return true;
        }
      } catch {
        // If URL parsing fails, ignore and continue with heuristic checks below.
      }
    }

    if (res.url && /accounts\.google\.com|oauth2|openid|oidc/i.test(res.url)) return true;
    return false;
  }

  // -----------------------
  // Shared Model Status Poller (Singleton per STATUS_URL)
  // -----------------------
  const SharedStatus = (() => {
    // Map<statusUrl, poller>
    const pollers = new Map();

    function makePoller(statusUrl) {
      let timer = null;
      let inFlight = false;
      let intervalMs = 5000;

      // Shared state
      let state = {
        phase: "unknown",
        status: "unknown",
        serviceState: "unknown",
        statusText: "Checking model…",
        modelReady: false,
        reachable: true,
        lastError: "",
        lastUpdatedMs: 0
      };

      // Canonical model-state normalization used by all subscribers.
      //
      // Precedence (highest -> lowest):
      // 1) unreachable/down
      // 2) degraded
      // 3) ready (either field)
      // 4) starting/warming/loading (either field)
      // 5) unknown
      //
      // Sample mapping table:
      // | status      | serviceState | reachable | phase    | modelReady |
      // |------------ |------------- |---------- |--------- |----------- |
      // | ready       | starting     | true      | ready    | true       |
      // | warming     | unknown      | true      | starting | false      |
      // | loading     | unknown      | true      | starting | false      |
      // | unknown     | degraded     | true      | degraded | false      |
      // | ready       | ready        | false     | down     | false      |
      function normalizeModelState(data = {}, opts = {}) {
        const status = String(data?.status || "unknown").toLowerCase();
        const serviceState = String(data?.serviceState || "unknown").toLowerCase();
        const reachable = opts.reachable !== undefined ? !!opts.reachable : true;
        const lastError = opts.lastError || "";

        const isDown = !reachable || status === "down" || serviceState === "down" || status === "unreachable" || serviceState === "unreachable";
        const isDegraded = status === "degraded" || serviceState === "degraded";
        const isReady = status === "ready" || serviceState === "ready";
        const isStarting = status === "starting" || serviceState === "starting" || status === "warming" || serviceState === "warming" || status === "loading" || serviceState === "loading";

        let phase = "unknown";
        if (isDown) phase = "down";
        else if (isDegraded) phase = "degraded";
        else if (isReady) phase = "ready";
        else if (isStarting) phase = "starting";

        const statusText = phase === "down"
          ? "API unreachable"
          : phase === "degraded"
            ? "Model degraded"
            : phase === "ready"
              ? "Model ready"
              : phase === "starting"
                ? "Model loading…"
                : "Checking model…";

        return {
          phase,
          status,
          serviceState,
          statusText,
          modelReady: phase === "ready",
          reachable,
          lastError
        };
      }

      // Subscribers: Map<id, callback(state)>
      const subs = new Map();
      let nextId = 1;

      function notify() {
        for (const cb of subs.values()) {
          try { cb({ ...state }); } catch { /* ignore */ }
        }
      }

      function setState(patch) {
        state = { ...state, ...patch, lastUpdatedMs: Date.now() };
        notify();
      }

      async function pollOnce() {
        if (inFlight) return { ...state };
        inFlight = true;

        try {
          // Poll response is normalized into canonical `phase/modelReady/statusText`
          // from API `status` + `serviceState`, so widget instances do not drift
          // with ad-hoc per-widget checks.
          const res = await fetchWithTimeout(statusUrl, { method: "GET" }, 8000);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json();
          setState(normalizeModelState(data, { reachable: true, lastError: "" }));
        } catch (e) {
          setState(normalizeModelState(
            { status: "down", serviceState: "down" },
            { reachable: false, lastError: e?.message || "Model status error" }
          ));
        } finally {
          inFlight = false;
        }
        return { ...state };
      }

      function start() {
        if (timer) return;
        timer = setInterval(pollOnce, intervalMs);
        // immediate first tick
        pollOnce();
      }

      function stopIfNoSubs() {
        if (subs.size > 0) return;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }

      function subscribe(cb) {
        const id = nextId++;
        subs.set(id, cb);
        // push current state immediately
        try { cb({ ...state }); } catch { /* ignore */ }
        // ensure polling running
        start();
        return () => {
          subs.delete(id);
          stopIfNoSubs();
        };
      }

      return {
        subscribe,
        pollOnce,
        setIntervalMs(ms) {
          const n = Number(ms);
          if (Number.isFinite(n) && n >= 1000) {
            intervalMs = n;
            if (timer) {
              clearInterval(timer);
              timer = setInterval(pollOnce, intervalMs);
            }
          }
        },
        getState: () => ({ ...state })
      };
    }

    return {
      get(statusUrl) {
        if (!pollers.has(statusUrl)) pollers.set(statusUrl, makePoller(statusUrl));
        return pollers.get(statusUrl);
      }
    };
  })();

  // -----------------------
  // UI (same as before)
  // -----------------------
  function cssText() {
    return `
:root { --bg:#0b0f17; --card:#121a26; --muted:#93a4b8; --text:#e8eef6; --accent:#5aa9ff; --danger:#ff5a7a; }
.rw-root * { box-sizing:border-box; font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; }
.rw-card{
  width:min(780px,calc(100vw - 32px));
  background: color-mix(in srgb, #121a26 92%, #000 8%);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:20px;
  padding:18px;
  box-shadow:0 10px 30px rgba(0,0,0,0.35);
  color:var(--text);
}
.rw-title{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
.rw-title h1{ font-size:16px; margin:0; font-weight:650; letter-spacing:.2px; }
.rw-status{ font-size:12px; color:var(--muted); display:flex; align-items:center; gap:8px; user-select:none; }
.rw-dot{ width:10px; height:10px; border-radius:999px; background:#6b7b91; box-shadow:0 0 0 3px rgba(107,123,145,0.18); }
.rw-dot.ready{ background:#39d98a; box-shadow:0 0 0 3px rgba(57,217,138,0.18); }
.rw-dot.busy { background:#ffd166; box-shadow:0 0 0 3px rgba(255,209,102,0.18); }
.rw-dot.down { background:var(--danger); box-shadow:0 0 0 3px rgba(255,90,122,0.18); }

.rw-area{ position:relative; }
.rw-textarea{
  width:100%; min-height:180px; resize:vertical;
  border-radius:16px; padding:14px 14px 44px 14px;
  border:1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.04);
  color:var(--text); outline:none; font-size:16px; line-height:1.5;
}
.rw-textarea:focus{ border-color: rgba(90,169,255,0.6); box-shadow: 0 0 0 4px rgba(90,169,255,0.15); }
.rw-textarea[disabled]{ opacity:.7; }

.rw-footer{
  position:absolute; left:0; right:0; bottom:10px;
  display:flex; align-items:center; justify-content:space-between;
  padding:0 12px; pointer-events:none;
}
.rw-counter,.rw-hint{ font-size:12px; color:var(--muted); pointer-events:none; transition:color .15s ease, font-weight .15s ease; }
.rw-counter.over-limit,.rw-hint.over-limit{ color:#ffb3c2; font-weight:600; }
.rw-actions{ margin-top:12px; display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
.rw-stream-toggle{ margin-top:10px; display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; user-select:none; }
.rw-stream-toggle input{ width:16px; height:16px; accent-color:var(--accent); }
.rw-btn{
  border:1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color:var(--text);
  padding:10px 14px; border-radius:14px;
  cursor:pointer; font-weight:600;
  transition: transform .05s ease, opacity .15s ease, border-color .15s ease, background .15s ease;
}
.rw-btn:hover{ border-color: rgba(90,169,255,0.65); background: rgba(90,169,255,0.12); }
.rw-btn:active{ transform: translateY(1px); }
.rw-btn[disabled]{ opacity:.45; cursor:not-allowed; }
.rw-primary{ background: rgba(90,169,255,0.18); border-color: rgba(90,169,255,0.35); }
.rw-primary:hover{ background: rgba(90,169,255,0.25); border-color: rgba(90,169,255,0.7); }
.rw-toast{ margin-top:10px; font-size:13px; color:var(--muted); min-height:20px; white-space:pre-wrap; }
.rw-toast.error{ color:#ffb3c2; }
.rw-toast.ok{ color:#a7f3d0; }
`;
  }

  function ensureStyleOnce() {
    const id = "rw-widget-style";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = cssText();
    document.head.appendChild(s);
  }

  function buildDOM(container, opts) {
    ensureStyleOnce();

    const root = document.createElement("div");
    root.className = "rw-root";

    const card = document.createElement("div");
    card.className = "rw-card";

    const title = document.createElement("div");
    title.className = "rw-title";

    const h1 = document.createElement("h1");
    h1.textContent = opts.title || `HK Rewrite Bridge Demo (≤ ${opts.maxChars} chars)`;

    const status = document.createElement("div");
    status.className = "rw-status";

    const dot = document.createElement("span");
    dot.className = "rw-dot";

    const statusText = document.createElement("span");
    statusText.textContent = "Checking model…";

    status.appendChild(dot);
    status.appendChild(statusText);

    title.appendChild(h1);
    title.appendChild(status);

    const area = document.createElement("div");
    area.className = "rw-area";

    const ta = document.createElement("textarea");
    ta.className = "rw-textarea";
    ta.placeholder = opts.placeholder || `Type up to ${opts.maxChars} characters before rewriting…`;

    const footer = document.createElement("div");
    footer.className = "rw-footer";

    const counter = document.createElement("div");
    counter.className = "rw-counter";
    counter.innerHTML = `<span class="rw-count">0</span>/<span class="rw-max">${opts.maxChars}</span>`;

    const hint = document.createElement("div");
    hint.className = "rw-hint";
    hint.textContent = "Ready status will enable Rewrite";

    footer.appendChild(counter);
    footer.appendChild(hint);

    area.appendChild(ta);
    area.appendChild(footer);

    const actions = document.createElement("div");
    actions.className = "rw-actions";

    const undoBtn = document.createElement("button");
    undoBtn.className = "rw-btn";
    undoBtn.textContent = "Undo";
    undoBtn.disabled = true;

    const rewriteBtn = document.createElement("button");
    rewriteBtn.className = "rw-btn rw-primary";
    rewriteBtn.textContent = "Rewrite";
    rewriteBtn.disabled = true;

    actions.appendChild(undoBtn);
    actions.appendChild(rewriteBtn);

    const streamToggle = document.createElement("label");
    streamToggle.className = "rw-stream-toggle";

    const streamCheckbox = document.createElement("input");
    streamCheckbox.type = "checkbox";
    streamCheckbox.checked = !!opts.streamEnabledByDefault;

    const streamLabel = document.createElement("span");
    streamLabel.textContent = "Enable streaming";

    streamToggle.appendChild(streamCheckbox);
    streamToggle.appendChild(streamLabel);

    const toast = document.createElement("div");
    toast.className = "rw-toast";

    card.appendChild(title);
    card.appendChild(area);
    card.appendChild(actions);
    card.appendChild(streamToggle);
    card.appendChild(toast);

    root.appendChild(card);
    container.appendChild(root);

    return {
      root,
      dot,
      statusText,
      hint,
      ta,
      countSpan: counter.querySelector(".rw-count"),
      undoBtn,
      rewriteBtn,
      streamCheckbox,
      toast
    };
  }

  function setDot(dotEl, state) {
    dotEl.classList.remove("ready", "busy", "down");
    if (state === "ready") dotEl.classList.add("ready");
    else if (state === "busy") dotEl.classList.add("busy");
    else if (state === "down") dotEl.classList.add("down");
  }

  // -----------------------
  // Public API: mount
  // -----------------------
  async function mount(cfg) {
    const container = document.querySelector(cfg.containerSelector);
    if (!container) throw new Error("Container not found: " + cfg.containerSelector);

    const apiBase = (cfg.apiBase ?? "").replace(/\/+$/, "");
    const maxChars = Number.isFinite(cfg.maxChars) ? cfg.maxChars : 100;

    const STATUS_URL  = `${apiBase}/api/rewrite-bridge/model-status`;
    const REWRITE_URL = `${apiBase}/api/rewrite-bridge/rewrite`;

    // One shared poller for this STATUS_URL
    const poller = SharedStatus.get(STATUS_URL);
    if (Number.isFinite(cfg.statusPollIntervalMs)) poller.setIntervalMs(cfg.statusPollIntervalMs);

    const ui = buildDOM(container, {
      maxChars,
      title: cfg.title,
      placeholder: cfg.placeholder,
      streamEnabledByDefault: cfg.streamEnabledByDefault
    });

    const DRAFT_KEY = `rw_draft_v1:${window.location.pathname}:${cfg.containerSelector}:${apiBase}`;

    // Per-widget state
    let inFlight = false;
    let lastOriginalText = "";
    let sharedModelReady = false;
    let sharedPhase = "unknown";

    function makeEmitter() {
      const listeners = new Set();
      return {
        on(callback) {
          if (typeof callback !== "function") return () => {};
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        emit(payload) {
          for (const cb of listeners) {
            try { cb(payload); } catch { /* ignore */ }
          }
        },
        clear() {
          listeners.clear();
        }
      };
    }

    const rewriteStart = makeEmitter();
    const rewriteComplete = makeEmitter();
    const textChange = makeEmitter();

    function getCurrentText() {
      return String(ui.ta.value || "");
    }

    function toast(msg, type = "") {
      ui.toast.textContent = msg || "";
      ui.toast.className = "rw-toast" + (type ? " " + type : "");
    }

    function saveDraft() {
      try { sessionStorage.setItem(DRAFT_KEY, getCurrentText()); } catch { /* ignore storage errors */ }
    }

    function restoreDraft() {
      try {
        const saved = sessionStorage.getItem(DRAFT_KEY);
        if (typeof saved === "string" && saved.length > 0) {
          ui.ta.value = saved;
        }
      } catch {
        // Ignore storage errors.
      }
    }

    function renderHint() {
      const currentLength = getCurrentText().length;
      const trimmedLength = getCurrentText().trim().length;
      const isOverLimit = currentLength > maxChars;

      ui.countSpan.textContent = String(currentLength);
      ui.countSpan.parentElement.classList.toggle("over-limit", isOverLimit);
      ui.hint.classList.toggle("over-limit", isOverLimit);

      if (isOverLimit) {
        ui.hint.textContent = "Text exceeds limit; shorten before rewriting";
        return;
      }

      if (inFlight) {
        ui.hint.textContent = "Please wait…";
        return;
      }

      if (trimmedLength === 0) {
        ui.hint.textContent = `Enter up to ${maxChars} characters to rewrite`;
        return;
      }

      if (sharedPhase === "down") {
        ui.hint.textContent = "Will retry automatically";
      } else if (sharedPhase === "degraded") {
        ui.hint.textContent = "Reduced quality mode (retry if output looks off)";
      } else if (sharedPhase === "ready") {
        ui.hint.textContent = "Click Rewrite to convert";
      } else if (sharedPhase === "starting") {
        ui.hint.textContent = "Rewrite disabled while loading";
      } else {
        ui.hint.textContent = "Waiting for ready…";
      }
    }

    function syncButtons() {
      const text = (ui.ta.value || "").trim();
      const okLen = text.length > 0 && text.length <= maxChars;
      ui.rewriteBtn.disabled = !(sharedModelReady && okLen && !inFlight);
      ui.undoBtn.disabled = !(lastOriginalText && !inFlight);
      renderHint();
    }

    function updateCount() {
      textChange.emit({ text: getCurrentText() });
      saveDraft();
      syncButtons();
    }

    // Apply shared status to UI
    function applySharedState(st) {
      // UI rendering reads the canonical phase computed in pollOnce().
      // Keep this switch aligned with normalizeModelState() precedence.
      sharedModelReady = !!st.modelReady;
      sharedPhase = st.phase || "unknown";

      if (sharedPhase === "down") {
        setDot(ui.dot, "down");
        ui.statusText.textContent = st.statusText || "API unreachable";
        toast(st.lastError ? `Cannot reach API. ${st.lastError}` : "Cannot reach API.", "error");
      } else if (sharedPhase === "degraded") {
        setDot(ui.dot, "busy");
        ui.statusText.textContent = st.statusText || "Model degraded";
        if (!inFlight) toast("Model is degraded. Results may be lower quality.", "error");
      } else if (sharedPhase === "ready") {
        setDot(ui.dot, "ready");
        ui.statusText.textContent = st.statusText || "Model ready";
        // don't clear toast if we're mid-flight; keep "Working…"
        if (!inFlight) toast("");
      } else if (sharedPhase === "starting") {
        setDot(ui.dot, "busy");
        ui.statusText.textContent = st.statusText || "Model loading…";
        if (!inFlight) toast("Please wait for model to be ready.");
      } else {
        setDot(ui.dot, "busy");
        ui.statusText.textContent = st.statusText || "Checking model…";
        if (!inFlight) toast("");
      }

      syncButtons();
    }

    // Subscribe to shared poller
    const unsubscribe = poller.subscribe(applySharedState);

    function handleLoginRequired() {
      const RELOAD_TS_KEY = "rw_auth_reload_ts";
      const RELOAD_COUNT_KEY = "rw_auth_reload_count";
      const RELOAD_WINDOW_MS = 20000;
      const RELOAD_MAX_ATTEMPTS = 3;

      if (cfg.reloadOnLoginRequired !== false) {
        saveDraft();

        let now = Date.now();
        let firstTs = now;
        let count = 0;

        try {
          const storedTs = Number(sessionStorage.getItem(RELOAD_TS_KEY) || "0");
          const storedCount = Number(sessionStorage.getItem(RELOAD_COUNT_KEY) || "0");
          const inWindow = Number.isFinite(storedTs) && (now - storedTs) <= RELOAD_WINDOW_MS;

          if (inWindow) {
            firstTs = storedTs;
            count = Number.isFinite(storedCount) ? storedCount : 0;
          }

          count += 1;
          sessionStorage.setItem(RELOAD_TS_KEY, String(firstTs || now));
          sessionStorage.setItem(RELOAD_COUNT_KEY, String(count));
        } catch {
          // Ignore storage errors and fall back to a single reload attempt.
          count = 1;
        }

        if (count > RELOAD_MAX_ATTEMPTS) {
          const manualMessage = cfg.loginPageUrl
            ? `Login required. Reload attempts were exhausted. Sign in here, then retry:\n${cfg.loginPageUrl}`
            : "Login required. Re-authenticate in your org portal and retry.";
          toast(manualMessage, "error");
          return;
        }

        toast("Session expired. Reloading to sign in again…", "error");
        window.location.reload();
        return;
      }

      if (cfg.loginPageUrl) {
        toast(`Login required. Sign in here, then retry:\n${cfg.loginPageUrl}`, "error");
        return;
      }

      toast("Login required. Re-authenticate in your org portal and retry.", "error");
    }

    async function rewrite() {
      const original = (ui.ta.value || "").trim();
      if (!original) return;
      const before = getCurrentText();
      let success = false;
      let errorMessage = "";
      let restoreTextOnError = "";
      rewriteStart.emit({ text: before });

      inFlight = true;
      lastOriginalText = original;
      ui.ta.disabled = true;

      setDot(ui.dot, "busy");
      ui.statusText.textContent = "Rewriting…";
      toast("Working…");
      syncButtons();

      try {
        let attempts = 0;
        while (attempts < 6) {
          attempts++;

          const useStream = !!ui.streamCheckbox.checked;

          const res = await fetchWithTimeout(
            REWRITE_URL,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: original, stream: useStream }),
              redirect: "follow",
              credentials: "include"
            },
            65000
          );

          if (res.status === 401 || isLikelyAuthRedirect(res, REWRITE_URL)) {
            handleLoginRequired();
            return;
          }

          if (res.status === 403) {
            const t = await safeJson(res);
            toast(t?.error?.message || "Forbidden (account/domain not allowed).", "error");
            ui.hint.textContent = "Use an allowed account then retry";
            return;
          }

          if (res.status === 202) {
            const ra = Number(res.headers.get("Retry-After") || 2);
            toast(`Model warming up… retrying in ${ra}s`);
            ui.statusText.textContent = "Warming up…";
            await sleep(Math.min(Math.max(ra * 1000, 1000), 8000));
            await poller.pollOnce(); // shared poll
            continue;
          }

          if (!res.ok) {
            const t = await safeJson(res);
            throw new Error(t?.error?.message || `Rewrite failed: HTTP ${res.status}`);
          }

          if (useStream) {
            restoreTextOnError = before;

            let streamedText = "";
            let streamStarted = false;

            const streamResult = await consumeNdjsonStream(res, {
              onChunk: (chunkText) => {
                if (!streamStarted) {
                  // Only clear once we actually receive stream content.
                  ui.ta.value = "";
                  streamStarted = true;
                }
                streamedText += chunkText;
                ui.ta.value = streamedText;
                updateCount();
              }
            });

            if (streamResult.errorMessage) {
              throw new Error(streamResult.errorMessage);
            }
          } else {
            const data = await res.json();
            if (!data || data.ok !== true || typeof data.result !== "string") {
              throw new Error("Unexpected API response format.");
            }

            ui.ta.value = data.result;
            updateCount();
          }

          toast("Done.", "ok");
          success = true;

          // After rewrite, re-apply shared state (may flip to ready)
          applySharedState(poller.getState());
          return;
        }

        throw new Error("Model not ready after multiple retries. Please try again.");
      } catch (err) {
        if (restoreTextOnError) {
          ui.ta.value = restoreTextOnError;
          updateCount();
        }

        const msg = (err?.name === "AbortError") ? "Timeout. Please retry." : (err?.message || "Unknown error.");
        errorMessage = msg;
        toast(msg, "error");
        setDot(ui.dot, "down");
        ui.statusText.textContent = "Rewrite failed";
        ui.hint.textContent = "Check logs then retry";
      } finally {
        const after = getCurrentText();
        rewriteComplete.emit({ before, after, changed: after !== before, success, errorMessage });
        inFlight = false;
        ui.ta.disabled = false;
        await poller.pollOnce();     // shared poll
        applySharedState(poller.getState());
        syncButtons();
      }
    }

    function undo() {
      if (!lastOriginalText || inFlight) return;
      ui.ta.value = lastOriginalText;
      updateCount();
      toast("Reverted.", "ok");
      syncButtons();
    }

    // Wire events
    ui.ta.addEventListener("input", updateCount);
    ui.rewriteBtn.addEventListener("click", () => { if (!ui.rewriteBtn.disabled) rewrite(); });
    ui.undoBtn.addEventListener("click", () => undo());

    // Init
    restoreDraft();
    updateCount();
    // Force one shared poll now (subscribe already got a state, but do fresh poll)
    if (cfg.pollModelStatus !== false) await poller.pollOnce();

    return {
      pollStatusOnce: () => poller.pollOnce(),
      rewrite,
      undo,
      getCurrentText,
      onRewriteStart: (callback) => rewriteStart.on(callback),
      onRewriteComplete: (callback) => rewriteComplete.on(callback),
      onTextChange: (callback) => textChange.on(callback),
      destroy: () => {
        unsubscribe();
        rewriteStart.clear();
        rewriteComplete.clear();
        textChange.clear();
        container.innerHTML = "";
      }
    };
  }

  async function consumeNdjsonStream(res, { onChunk }) {
    if (!res.body || typeof res.body.getReader !== "function") {
      throw new Error("Streaming is not supported in this browser.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let errorMessage = "";

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (typeof payload.response === "string" && payload.response.length > 0) {
        onChunk(payload.response);
      }

      if (payload.error && typeof payload.error.message === "string" && payload.error.message.length > 0) {
        errorMessage = payload.error.message;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        handleLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      handleLine(buffer);
    }

    return { errorMessage };
  }

  global.RewriteWidget = { mount };
})(window);
