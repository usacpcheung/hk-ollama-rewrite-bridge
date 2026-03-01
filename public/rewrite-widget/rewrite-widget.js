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

  function isLikelyAuthRedirect(res) {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) return true;
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
        status: "unknown",
        serviceState: "unknown",
        modelReady: false,
        reachable: true,
        lastError: "",
        lastUpdatedMs: 0
      };

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
          const res = await fetchWithTimeout(statusUrl, { method: "GET" }, 8000);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json();
          const status = String(data?.status || "unknown");
          const serviceState = String(data?.serviceState || "unknown");
          const modelReady = (status === "ready");

          setState({
            reachable: true,
            lastError: "",
            status,
            serviceState,
            modelReady
          });
        } catch (e) {
          setState({
            reachable: false,
            lastError: e?.message || "Model status error",
            status: "down",
            serviceState: "down",
            modelReady: false
          });
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
.rw-counter,.rw-hint{ font-size:12px; color:var(--muted); pointer-events:none; }
.rw-actions{ margin-top:12px; display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
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
    ta.maxLength = opts.maxChars;
    ta.placeholder = opts.placeholder || `Type up to ${opts.maxChars} characters…`;

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

    const toast = document.createElement("div");
    toast.className = "rw-toast";

    card.appendChild(title);
    card.appendChild(area);
    card.appendChild(actions);
    card.appendChild(toast);

    root.appendChild(card);
    container.appendChild(root);

    return { root, dot, statusText, hint, ta, countSpan: counter.querySelector(".rw-count"), undoBtn, rewriteBtn, toast };
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
      placeholder: cfg.placeholder
    });

    // Per-widget state
    let inFlight = false;
    let lastOriginalText = "";
    let sharedModelReady = false;
    let sharedStatus = "unknown";
    let sharedServiceState = "unknown";
    let sharedReachable = true;

    function toast(msg, type = "") {
      ui.toast.textContent = msg || "";
      ui.toast.className = "rw-toast" + (type ? " " + type : "");
    }

    function syncButtons() {
      const text = (ui.ta.value || "").trim();
      const okLen = text.length > 0 && text.length <= maxChars;
      ui.rewriteBtn.disabled = !(sharedModelReady && okLen && !inFlight);
      ui.undoBtn.disabled = !(lastOriginalText && !inFlight);
    }

    function updateCount() {
      ui.countSpan.textContent = String((ui.ta.value || "").length);
      syncButtons();
    }

    // Apply shared status to UI
    function applySharedState(st) {
      sharedModelReady = !!st.modelReady;
      sharedStatus = st.status || "unknown";
      sharedServiceState = st.serviceState || "unknown";
      sharedReachable = !!st.reachable;

      if (!sharedReachable) {
        setDot(ui.dot, "down");
        ui.statusText.textContent = "API unreachable";
        ui.hint.textContent = "Will retry automatically";
        toast(st.lastError ? `Cannot reach API. ${st.lastError}` : "Cannot reach API.", "error");
      } else if (sharedStatus === "degraded") {
        setDot(ui.dot, "busy");
        ui.statusText.textContent = "Model degraded";
        ui.hint.textContent = "Reduced quality mode (retry if output looks off)";
        if (!inFlight) toast("Model is degraded. Results may be lower quality.", "error");
      } else if (sharedServiceState === "ready") {
        setDot(ui.dot, "ready");
        ui.statusText.textContent = "Model ready";
        ui.hint.textContent = "Click Rewrite to convert";
        // don't clear toast if we're mid-flight; keep "Working…"
        if (!inFlight) toast("");
      } else if (sharedServiceState === "starting") {
        setDot(ui.dot, "busy");
        ui.statusText.textContent = "Model loading…";
        ui.hint.textContent = "Rewrite disabled while loading";
        if (!inFlight) toast("Please wait for model to be ready.");
      } else if (sharedServiceState === "degraded") {
        setDot(ui.dot, "down");
        ui.statusText.textContent = "Model degraded";
        ui.hint.textContent = "Operator action needed (retry later)";
        if (!inFlight) toast("Service degraded. Try again later.", "error");
      } else {
        setDot(ui.dot, "busy");
        ui.statusText.textContent = `State: ${sharedServiceState}`;
        ui.hint.textContent = "Waiting for ready…";
        if (!inFlight) toast("");
      }

      syncButtons();
    }

    // Subscribe to shared poller
    const unsubscribe = poller.subscribe(applySharedState);

    function handleLoginRequired() {
      const loginUrl = cfg.loginPageUrl || "/tools/rewritedemo.html";
      if (cfg.reloadOnLoginRequired !== false) {
        toast("Session expired. Reloading to sign in again…", "error");
        window.location.reload();
        return;
      }
      toast(`Login required. Open this page to sign in, then retry:\n${loginUrl}`, "error");
    }

    async function rewrite() {
      const original = (ui.ta.value || "").trim();
      if (!original) return;

      inFlight = true;
      lastOriginalText = original;
      ui.ta.disabled = true;

      setDot(ui.dot, "busy");
      ui.statusText.textContent = "Rewriting…";
      ui.hint.textContent = "Please wait…";
      toast("Working…");
      syncButtons();

      try {
        let attempts = 0;
        while (attempts < 6) {
          attempts++;

          const res = await fetchWithTimeout(
            REWRITE_URL,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: original }),
              redirect: "follow",
              credentials: "include"
            },
            65000
          );

          if (isLikelyAuthRedirect(res) || res.status === 401) {
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

          const data = await res.json();
          if (!data || data.ok !== true || typeof data.result !== "string") {
            throw new Error("Unexpected API response format.");
          }

          ui.ta.value = data.result;
          updateCount();
          toast("Done.", "ok");

          // After rewrite, re-apply shared state (may flip to ready)
          applySharedState(poller.getState());
          return;
        }

        throw new Error("Model not ready after multiple retries. Please try again.");
      } catch (err) {
        const msg = (err?.name === "AbortError") ? "Timeout. Please retry." : (err?.message || "Unknown error.");
        toast(msg, "error");
        setDot(ui.dot, "down");
        ui.statusText.textContent = "Rewrite failed";
        ui.hint.textContent = "Check logs then retry";
      } finally {
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
    updateCount();
    // Force one shared poll now (subscribe already got a state, but do fresh poll)
    if (cfg.pollModelStatus !== false) await poller.pollOnce();

    return {
      pollStatusOnce: () => poller.pollOnce(),
      rewrite,
      undo,
      destroy: () => {
        unsubscribe();
        container.innerHTML = "";
      }
    };
  }

  global.RewriteWidget = { mount };
})(window);
