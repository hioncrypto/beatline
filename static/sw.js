/* BeatLine service worker — background 15m target + clear-edge alerts */
const SW_VERSION = "3.30-bg-always-audible";
const TARGET_URL = "/api/target?tf=15m";
const EDGE_URL = "/api/clear-edge";
const HEALTH_URL = "/api/health";
const STATE_KEY = "kalshiFifteenState";
/** Persistent across SW script bumps — versioned caches wipe sticky memory. */
const STATE_CACHE = "beatline-sw-state-v1";
const STABLE_APP_URL = "https://beatline-1.onrender.com";
const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=https://github.com/hioncrypto/beatline";
const EDGE_NOTIFY_COOLDOWN_MS = 60_000;
/** Hit health often enough to keep Render free awake while SW is alive. */
const KEEP_ALIVE_MS = 60 * 1000;
const POLL_MS = 4_000;

/**
 * Chrome requires showNotification on every push (userVisibleOnly).
 * Returning without one can revoke the push subscription — silent BG death.
 */
async function showPushKeepalive(body) {
  try {
    await self.registration.showNotification("BeatLine", {
      body: body || "Alerts active",
      icon: "/icons/icon-192.png?v=2.6",
      badge: "/icons/icon-192.png?v=2.6",
      tag: "beatline-push-keepalive",
      renotify: false,
      silent: true,
      requireInteraction: false,
      data: { url: "/", kind: "keepalive" },
    });
  } catch {
    // ignore
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SW_VERSION));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SW_VERSION && k !== STATE_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
      startPollLoop();
    })()
  );
});

// Never break page loads — always go to network for navigations.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match("/");
        if (cached) return cached;
        // Tunnel hostnames die when Cloudflare restarts — send people to the
        // stable Render URL instead of a blank offline error.
        const host = self.location && self.location.hostname;
        if (host && (host.includes("trycloudflare.com") || host.includes("ngrok"))) {
          return new Response(
            `<!doctype html><meta charset="utf-8" />
<title>BeatLine — tunnel expired</title>
<body style="font-family:system-ui;background:#0b1210;color:#e8f0ec;padding:2rem">
<h1>Tunnel link expired</h1>
<p>Open the live app:</p>
<p><a style='color:#7dffb3' href='${STABLE_APP_URL}'>${STABLE_APP_URL}</a></p>
<p>Or redeploy: <a style='color:#ffd089' href='${RENDER_DEPLOY_URL}'>Render</a></p>
</body>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
        return Response.error();
      })
    );
    return;
  }
});

async function writeState(state) {
  // Keep a memory copy so poll/push still work if Cache API is evicted.
  self.__beatlineSwState = state;
  try {
    const cache = await caches.open(STATE_CACHE);
    await cache.put(
      STATE_KEY,
      new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json" },
      })
    );
  } catch {
    // Quota / cleared cache — do not kill the alert path.
  }
}

async function readState() {
  // Prefer in-memory state — cache may be stale after a failed write/eviction.
  if (self.__beatlineSwState && typeof self.__beatlineSwState === "object") {
    return self.__beatlineSwState;
  }
  try {
    const cache = await caches.open(STATE_CACHE);
    const res = await cache.match(STATE_KEY);
    if (res) {
      try {
        const parsed = await res.json();
        if (parsed && typeof parsed === "object") {
          self.__beatlineSwState = parsed;
          return parsed;
        }
      } catch {
        // fall through
      }
    }
  } catch {
    // Cache API unavailable / cleared
  }
  return {
    ticker: null,
    target: null,
    chimeOn: true,
    edgeKey: null,
    edgeAsk: 0,
    edgeAt: 0,
  };
}

/**
 * True only when a BeatLine window is actually focused.
 * Never use this to DROP a Best-buy tray notify — Android lies about
 * focused/visible while backgrounded. Kept for optional FG extras only.
 */
async function hasFocusedClient() {
  const all = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of all) {
    try {
      if (client.focused) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function hasVisibleClient() {
  return hasFocusedClient();
}

async function broadcastMarketEdgeAlert(payload) {
  const msg = {
    type: "market-edge-alert",
    side: payload && payload.side,
    askCents:
      payload &&
      (payload.askCents != null ? payload.askCents : payload.ask_cents),
    pWin: payload && (payload.pWin != null ? payload.pWin : payload.p_win),
    suggestStake:
      payload &&
      (payload.suggestStake != null
        ? payload.suggestStake
        : payload.suggest_stake),
    beat: payload && (payload.beat ?? payload.price_to_beat ?? payload.target),
    ticker: payload && payload.ticker,
  };
  try {
    const all = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of all) {
      try {
        client.postMessage(msg);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function sameEdgeSticky(prevKey, sticky) {
  if (!prevKey || !sticky) return false;
  if (prevKey === sticky) return true;
  if (prevKey.startsWith(`${sticky}:`)) return true;
  // Side-only match when ticker was missing on either side.
  const prevSide = String(prevKey).split(":").pop();
  const side = String(sticky).split(":").pop();
  const prevTicker = String(prevKey).includes(":")
    ? String(prevKey).slice(0, String(prevKey).lastIndexOf(":"))
    : "";
  const ticker = String(sticky).includes(":")
    ? String(sticky).slice(0, String(sticky).lastIndexOf(":"))
    : "";
  if (prevSide && side && prevSide === side && (!prevTicker || !ticker)) {
    return true;
  }
  return false;
}

async function showTargetNotification(payload, { force = false } = {}) {
  // New 15m / TO BEAT must never sound an alarm — silent keepalive only.
  void payload;
  void force;
  await showPushKeepalive("TO BEAT updated");
}

/**
 * ALWAYS show an audible Best-buy tray notification.
 * Never skip on focused/visible — that repeatedly killed BG alerts on Android.
 * Also broadcast so an open focused page can play the in-app C–E–G chime.
 * Returns true after the audible tray notify fires.
 */
async function broadcastEdgeNotified(payload) {
  const ask =
    payload && payload.askCents != null
      ? Math.round(Number(payload.askCents))
      : payload && payload.ask_cents != null
        ? Math.round(Number(payload.ask_cents))
        : null;
  const ticker = (payload && payload.ticker) || "";
  const side = payload && payload.side === "below" ? "below" : "above";
  const msg = {
    type: "edge-notified",
    side,
    askCents: ask,
    ticker,
    edgeKey: `${ticker}:${side}`,
    edgeAt: Date.now(),
  };
  try {
    const all = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of all) {
      try {
        client.postMessage(msg);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

async function showEdgeNotification(payload, { force = false } = {}) {
  void force; // force kept for callers; tray always sounds now
  // Additive FG chime — never a substitute for the tray notify.
  await broadcastMarketEdgeAlert(payload);

  const side = payload && payload.side === "below" ? "Below" : "Above";
  const ask =
    payload && payload.askCents != null
      ? Math.round(Number(payload.askCents))
      : payload && payload.ask_cents != null
        ? Math.round(Number(payload.ask_cents))
        : null;
  const conf =
    payload && payload.pWin != null
      ? Math.round(Number(payload.pWin) * 100)
      : payload && payload.p_win != null
        ? Math.round(Number(payload.p_win) * 100)
        : null;
  const stake =
    payload && payload.suggest_stake != null
      ? Math.round(Number(payload.suggest_stake))
      : payload && payload.suggestStake != null
        ? Math.round(Number(payload.suggestStake))
        : null;
  const title =
    stake != null
      ? `BeatLine · Best buy ${side} · $${stake}`
      : `BeatLine · Best buy · ${side}`;
  const bits = [];
  if (ask != null) bits.push(`ask ${ask}¢`);
  if (conf != null) bits.push(`${conf}% model`);
  if (stake != null) bits.push(`suggest $${stake}`);
  if (payload && payload.beat != null) {
    bits.push(
      `beat $${Number(payload.beat).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    );
  }
  const body = bits.length
    ? bits.join(" · ")
    : "Clear Best Side edge — open BeatLine";
  const edgeData = {
    url: "/",
    ticker: payload && payload.ticker,
    kind: "clear_edge",
    side: payload && payload.side,
    askCents: ask,
    pWin: payload && (payload.pWin ?? payload.p_win),
    suggestStake: stake,
    beat: payload && (payload.beat ?? payload.price_to_beat ?? payload.target),
  };
  try {
    await self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png?v=2.6",
      badge: "/icons/icon-192.png?v=2.6",
      vibrate: [80, 40, 80, 40, 80, 40, 160],
      tag: "kalshi-clear-edge",
      renotify: true,
      requireInteraction: true,
      silent: false,
      data: edgeData,
    });
  } catch {
    // Tray failed — do not stamp sounded / edgeAt.
    return false;
  }
  try {
    const state = await readState();
    state.lastEdgeAlert = { ...edgeData, at: Date.now() };
    state.edgeKey = `${edgeData.ticker || ""}:${edgeData.side || ""}`;
    state.edgeAsk = ask || 0;
    state.edgeAt = Date.now();
    await writeState(state);
  } catch {
    // ignore
  }
  await broadcastEdgeNotified(payload);
  return true;
}

async function showProfitNotification(payload, { force = false } = {}) {
  if (!force && (await hasVisibleClient())) return;
  const side = payload && payload.side === "below" ? "Below" : "Above";
  const pl = payload && payload.pl != null ? Number(payload.pl) : null;
  const plTxt =
    pl != null && Number.isFinite(pl)
      ? `${pl > 0 ? "+" : ""}$${Math.abs(pl).toFixed(2)}`
      : "in profit";
  await self.registration.showNotification(`BeatLine · ${side} in profit`, {
    body: plTxt,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    vibrate: [40, 50, 40, 50, 120],
    tag: "kalshi-profit",
    renotify: true,
    requireInteraction: false,
    silent: false,
    data: { url: "/", kind: "profit", side: payload && payload.side },
  });
}

async function showLinkNotification(payload) {
  const url = (payload && payload.url) || STABLE_APP_URL;
  await self.registration.showNotification("BeatLine · new link", {
    body: url,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    tag: "beatline-new-link",
    renotify: true,
    requireInteraction: false,
    silent: false,
    data: { url },
  });
}

async function checkTarget(forceNotify) {
  const state = await readState();
  if (!state.chimeOn && !forceNotify) return;
  let data;
  try {
    const res = await fetch(`${TARGET_URL}&_=${Date.now()}`, {
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    return;
  }
  const ticker = data && data.ticker;
  const beat = data && (data.price_to_beat ?? data.target);
  // Quiet sync only — never alert on new TO BEAT / 15m window.
  if (ticker && ticker !== state.notifiedTicker) {
    state.notifiedTicker = ticker;
  }
  state.ticker = ticker || state.ticker;
  if (beat != null) state.target = beat;
  await writeState(state);
}

async function checkClearEdge(forceNotify) {
  const state = await readState();
  if (!state.chimeOn && !forceNotify) return;
  let data;
  try {
    const res = await fetch(`${EDGE_URL}?_=${Date.now()}`, { cache: "no-store" });
    data = await res.json();
  } catch {
    return;
  }
  if (!data || !data.clear || !data.side) {
    // Re-read so we don't clobber a concurrent push's edgeAt / chimeOn.
    const fresh = await readState();
    fresh.pendingEdgeKey = null;
    fresh.pendingEdgeCount = 0;
    await writeState(fresh);
    return;
  }

  const ask = Math.round(Number(data.ask_cents) || 0);
  const ticker = data.ticker || "";
  const sticky = `${ticker}:${data.side}`;
  const now = Date.now();
  const lastAt = Number(state.edgeAt) || 0;
  const prevKey = state.edgeKey || "";
  const prevAsk = Number(state.edgeAsk) || 0;
  const sameSide = sameEdgeSticky(prevKey, sticky);
  const askImproved = sameSide && prevAsk > 0 && prevAsk - ask >= 5;

  // Fire on first clear sight — multi-poll confirm missed brief Best-buys.
  if (!forceNotify) {
    if (sameSide && !askImproved && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS) {
      return;
    }
  }

  const payload = {
    side: data.side,
    askCents: ask,
    pWin: data.p_win,
    suggest_stake: data.suggest_stake,
    beat: data.beat ?? data.price_to_beat,
    ticker: data.ticker,
  };
  const sounded = await showEdgeNotification(payload, {
    force: !!forceNotify,
  });
  const next = await readState();
  if (sounded) {
    next.edgeKey = sticky;
    next.edgeAsk = ask;
    next.edgeAt = now;
  }
  next.pendingEdgeKey = null;
  next.pendingEdgeCount = 0;
  await writeState(next);
}

let pollTimer = null;
let pollInFlight = false;
let keepAliveTimer = null;

async function keepServerAwake() {
  try {
    await fetch(`${HEALTH_URL}?_=${Date.now()}`, { cache: "no-store" });
  } catch {
    // ignore
  }
}

function startPollLoop() {
  if (pollTimer) return;
  // Serialize writes — overlapping polls raced sticky edgeAt / chimeOn.
  pollTimer = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    (async () => {
      try {
        await checkTarget(false);
        await checkClearEdge(false);
      } catch {
        // ignore
      } finally {
        pollInFlight = false;
      }
    })();
  }, POLL_MS);
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(keepServerAwake, KEEP_ALIVE_MS);
  }
  if (!pollInFlight) {
    pollInFlight = true;
    (async () => {
      try {
        await checkTarget(false);
        await checkClearEdge(false);
      } catch {
        // ignore
      } finally {
        pollInFlight = false;
      }
    })();
  }
  keepServerAwake();
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "set-chime") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        state.chimeOn = !!msg.enabled;
        await writeState(state);
      })()
    );
  }
  if (msg.type === "arm-state") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (msg.ticker) state.ticker = msg.ticker;
        if (msg.target != null) state.target = msg.target;
        if (typeof msg.chimeOn === "boolean") state.chimeOn = msg.chimeOn;
        await writeState(state);
      })()
    );
  }
  if (msg.type === "get-edge-state") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        const client = event.source;
        if (client && client.postMessage) {
          client.postMessage({
            type: "edge-state",
            edgeKey: state.edgeKey || null,
            edgeAsk: Number(state.edgeAsk) || 0,
            edgeAt: Number(state.edgeAt) || 0,
            chimeOn: !!state.chimeOn,
          });
        }
      })()
    );
  }
  if (msg.type === "check-now") {
    event.waitUntil(
      (async () => {
        startPollLoop();
        await checkTarget(!!msg.forceNotify);
        await checkClearEdge(!!msg.forceNotify);
      })()
    );
  }
  if (msg.type === "test-notify") {
    event.waitUntil(
      (async () => {
        // Audible Best-buy (not TO BEAT) — exercises the real BG tray path.
        await showEdgeNotification(
          {
            side: msg.side || "above",
            askCents: msg.askCents != null ? msg.askCents : 40,
            pWin: msg.pWin != null ? msg.pWin : 0.55,
            suggestStake: msg.suggestStake != null ? msg.suggestStake : 25,
            beat: msg.beat,
            ticker: msg.ticker || "TEST",
          },
          { force: true }
        );
      })()
    );
  }
  if (msg.type === "target-armed") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (msg.ticker) {
          state.notifiedTicker = msg.ticker;
          state.targetAt = Date.now();
          state.ticker = msg.ticker;
          await writeState(state);
        }
      })()
    );
  }
  if (msg.type === "target-notify") {
    // Intentionally ignored — TO BEAT generation must not alert.
    return;
  }
  if (msg.type === "edge-notify") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (!state.chimeOn && !msg.force) return;
        const side = msg.side || "above";
        const ask = Math.round(Number(msg.askCents) || 0);
        const ticker = msg.ticker || "";
        const sticky = `${ticker}:${side}`;
        const now = Date.now();
        const lastAt = Number(state.edgeAt) || 0;
        const prevKey = state.edgeKey || "";
        const prevAsk = Number(state.edgeAsk) || 0;
        const sameSide = sameEdgeSticky(prevKey, sticky);
        const askImproved = sameSide && prevAsk > 0 && prevAsk - ask >= 5;
        // force / bypass always sounds. Non-force respects cooldown.
        if (!msg.force && !msg.bypassDedupe) {
          if (sameSide && !askImproved && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS) {
            await showPushKeepalive("Best buy already alerted");
            return;
          }
        }
        const sounded = await showEdgeNotification(msg, { force: true });
        if (sounded) {
          const next = await readState();
          next.edgeKey = sticky;
          next.edgeAsk = ask;
          next.edgeAt = now;
          await writeState(next);
        }
      })()
    );
  }
  if (msg.type === "edge-armed") {
    // Page already handled this sticky in-app (chimed or quiet-synced).
    // Only stamp edgeAt when chimed:true so quiet-arm does not block a
    // legitimate background notify that never sounded.
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (msg.side) {
          const ticker = msg.ticker || "";
          state.edgeKey = `${ticker}:${msg.side}`;
          state.edgeAsk = Math.round(Number(msg.askCents) || 0);
          if (msg.chimed === true) state.edgeAt = Date.now();
        }
        if (typeof msg.chimeOn === "boolean") state.chimeOn = msg.chimeOn;
        await writeState(state);
      })()
    );
  }
  if (msg.type === "profit-notify") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (!state.chimeOn && !msg.force) return;
        await showProfitNotification(msg, { force: !!msg.force });
      })()
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const kind = payload.type || payload.kind || "new_target";
  if (kind === "new_link") {
    event.waitUntil(showLinkNotification({ url: payload.url }));
    return;
  }
  if (kind === "clear_edge") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        const ask = Math.round(
          Number(payload.ask_cents ?? payload.askCents) || 0
        );
        const side = payload.side || "above";
        const ticker = payload.ticker || "";
        const sticky = `${ticker}:${side}`;
        const now = Date.now();
        const lastAt = Number(state.edgeAt) || 0;
        const prevKey = state.edgeKey || "";
        const prevAsk = Number(state.edgeAsk) || 0;
        const sameSide = sameEdgeSticky(prevKey, sticky);
        const askImproved = sameSide && prevAsk > 0 && prevAsk - ask >= 5;

        // ALWAYS audible for Best-buy pushes. Never gate on hasFocusedClient —
        // Android often reports focused while backgrounded/locked, which turned
        // real BG alerts into silent keepalives (FG chime worked; phone stayed quiet).
        // Same-tag renotify replaces itself instead of stacking spam.
        void askImproved;
        void lastAt;
        const sounded = await showEdgeNotification({
          side,
          askCents: ask,
          pWin: payload.p_win ?? payload.pWin,
          suggest_stake: payload.suggest_stake ?? payload.suggestStake,
          beat: payload.beat ?? payload.price_to_beat ?? payload.target,
          ticker: payload.ticker,
        });
        if (sounded) {
          const next = await readState();
          next.edgeKey = sticky;
          next.edgeAsk = ask;
          next.edgeAt = now;
          await writeState(next);
        } else {
          // Still satisfy Chrome userVisibleOnly if tray failed.
          await showPushKeepalive("Best buy alert");
        }
      })()
    );
    return;
  }
  // new_target / TO BEAT — no user alert, but still show a silent
  // notification so Chrome does not revoke the push subscription.
  if (kind === "new_target" || kind === "to_beat") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        const ticker = payload.ticker || "";
        const beat = payload.beat ?? payload.price_to_beat ?? payload.target;
        if (ticker) state.ticker = ticker;
        if (beat != null) state.target = beat;
        await writeState(state);
        await showPushKeepalive("TO BEAT updated");
      })()
    );
    return;
  }
  // Unknown / missing type — keepalive only.
  event.waitUntil(showPushKeepalive("BeatLine"));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const url = data.url || "/";
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        try {
          if ("focus" in client) {
            await client.focus();
            if (client.navigate) await client.navigate(url);
            return;
          }
        } catch {
          // ignore
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })()
  );
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "kalshi-15m-check") {
    event.waitUntil(
      (async () => {
        startPollLoop();
        await checkTarget(false);
        await checkClearEdge(false);
        await keepServerAwake();
      })()
    );
  }
});

startPollLoop();
