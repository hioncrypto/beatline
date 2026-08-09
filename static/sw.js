/* BeatLine service worker — background 15m target + clear-edge alerts */
const SW_VERSION = "3.17-no-tobeat-alert";
const TARGET_URL = "/api/target?tf=15m";
const EDGE_URL = "/api/clear-edge";
const HEALTH_URL = "/api/health";
const STATE_KEY = "kalshiFifteenState";
/** Persistent across SW script bumps — versioned caches wipe sticky memory. */
const STATE_CACHE = "beatline-sw-state-v1";
const STABLE_APP_URL = "https://beatline-1.onrender.com";
const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=https://github.com/hioncrypto/beatline";
const EDGE_NOTIFY_COOLDOWN_MS = 90_000;
const KEEP_ALIVE_MS = 4 * 60 * 1000;

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

async function readState() {
  const cache = await caches.open(STATE_CACHE);
  const res = await cache.match(STATE_KEY);
  if (!res) {
    return {
      ticker: null,
      target: null,
      chimeOn: true,
      edgeKey: null,
      edgeAsk: 0,
      edgeAt: 0,
    };
  }
  try {
    return await res.json();
  } catch {
    return {
      ticker: null,
      target: null,
      chimeOn: true,
      edgeKey: null,
      edgeAsk: 0,
      edgeAt: 0,
    };
  }
}

async function writeState(state) {
  const cache = await caches.open(STATE_CACHE);
  await cache.put(
    STATE_KEY,
    new Response(JSON.stringify(state), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

/**
 * True only when a BeatLine window is actually focused (user looking at it).
 * Used for optional FG dedupe — never as the sole reason to drop a push.
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
  // Foreground tab already chimed for new targets — skip duplicate system tone.
  if (!force && (await hasVisibleClient())) return;
  const title = "BeatLine · new 15m target";
  const body =
    payload && payload.beat != null
      ? `Price to beat $${Number(payload.beat).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}${payload.closeEt ? ` · settles ${payload.closeEt}` : ""}`
      : "A new 15-minute window just opened";
  await self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    vibrate: [80, 40, 80, 40, 160],
    tag: "kalshi-15m-target",
    renotify: true,
    requireInteraction: false,
    silent: false,
    data: { url: "/", ticker: payload && payload.ticker },
  });
}

async function broadcastEdgeAlert(payload) {
  const msg = {
    type: "apply-edge-alert",
    side: payload && payload.side,
    askCents:
      payload && (payload.askCents != null ? payload.askCents : payload.ask_cents),
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

async function showEdgeNotification(payload) {
  // Always show when called — callers own cooldown / ownership dedupe.
  // Background / locked: this notification IS the audible chime.
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
  await self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    vibrate: [80, 40, 80, 40, 80, 40, 160],
    tag: "kalshi-clear-edge",
    renotify: true,
    requireInteraction: false,
    silent: false,
    data: edgeData,
  });
  // Tell any open BeatLine windows to paint this Suggested buy so the
  // notification and in-app Best Side stay in sync (quiet — no re-chime).
  await broadcastEdgeAlert(edgeData);
}

async function showProfitNotification(payload, { force = false } = {}) {
  if (!force && (await hasVisibleClient())) return;
  const side = payload && payload.side === "below" ? "Below" : "Above";
  const pl = payload && payload.pl != null ? Number(payload.pl) : null;
  const plTxt =
    pl != null && Number.isFinite(pl)
      ? `${pl > 0 ? "+" : ""}$${Math.abs(pl).toFixed(2)}`
      : "Open mark turned positive";
  await self.registration.showNotification(`BeatLine · ${side} in profit`, {
    body: plTxt,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    vibrate: [40, 50, 40, 50, 120],
    tag: "beatline-open-profit",
    renotify: true,
    requireInteraction: false,
    silent: false,
    data: {
      url: "/",
      ticker: payload && payload.ticker,
      kind: "open_profit",
      side: payload && payload.side,
    },
  });
}

async function showLinkNotification(payload) {
  const url = (payload && payload.url) || "/";
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep raw
  }
  await self.registration.showNotification("BeatLine · new link", {
    body: `Tap to reopen — ${host}. Your balance and trade history follow you.`,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    vibrate: [100, 50, 100],
    tag: "beatline-new-link",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { url, kind: "new_link" },
  });
}

async function checkTarget(forceNotify) {
  const state = await readState();
  if (!state.chimeOn && !forceNotify) return;
  let data;
  try {
    const res = await fetch(`${TARGET_URL}&_=${Date.now()}`, { cache: "no-store" });
    data = await res.json();
  } catch {
    return;
  }
  const beat = data.price_to_beat ?? data.target;
  const ticker = data.ticker || null;
  // Track ticker/beat only — never alert on TO BEAT / new 15m generation.
  // (forceNotify is reserved for explicit Options → Test.)
  if (forceNotify) {
    await showTargetNotification(
      {
        beat,
        ticker,
        closeEt: data.close_et,
      },
      { force: true }
    );
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
    state.pendingEdgeKey = null;
    state.pendingEdgeCount = 0;
    await writeState(state);
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

  // Require the same clear edge on two SW polls before notifying — matches
  // server confirm and avoids phone alerts when the app still says wait.
  if (!forceNotify) {
    if (state.pendingEdgeKey === sticky) {
      state.pendingEdgeCount = (Number(state.pendingEdgeCount) || 0) + 1;
    } else {
      state.pendingEdgeKey = sticky;
      state.pendingEdgeCount = 1;
    }
    await writeState(state);
    if (state.pendingEdgeCount < 2) return;
  }

  if (!forceNotify) {
    // Same sticky recently sounded (BG notify or page chimed) — do not dump.
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
  await showEdgeNotification(payload);
  state.edgeKey = sticky;
  state.edgeAsk = ask;
  state.edgeAt = now;
  state.pendingEdgeKey = null;
  state.pendingEdgeCount = 0;
  await writeState(state);
}

let pollTimer = null;
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
  pollTimer = setInterval(() => {
    checkTarget(false);
    checkClearEdge(false);
  }, 12_000);
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(keepServerAwake, KEEP_ALIVE_MS);
  }
  checkTarget(false);
  checkClearEdge(false);
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
        startPollLoop();
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
        startPollLoop();
      })()
    );
  }
  if (msg.type === "get-edge-state") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        const all = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const payload = {
          type: "edge-state",
          edgeKey: state.edgeKey || null,
          edgeAsk: Number(state.edgeAsk) || 0,
          edgeAt: Number(state.edgeAt) || 0,
          chimeOn: !!state.chimeOn,
        };
        for (const client of all) {
          try {
            client.postMessage(payload);
          } catch {
            // ignore
          }
        }
      })()
    );
  }
  if (msg.type === "check-now") {
    event.waitUntil(
      (async () => {
        await checkTarget(!!msg.forceNotify);
        await checkClearEdge(!!msg.forceNotify);
      })()
    );
  }
  if (msg.type === "test-notify") {
    event.waitUntil(
      (async () => {
        await showTargetNotification(
          {
            beat: msg.beat,
            ticker: msg.ticker || "TEST",
            closeEt: msg.closeEt,
          },
          { force: true }
        );
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
        if (!msg.bypassDedupe) {
          if (!msg.force) {
            if (sameSide && !askImproved && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS)
              return;
          } else if (sameSide && !askImproved && now - lastAt < 15_000) {
            return;
          }
        }
        await showEdgeNotification(msg);
        state.edgeKey = sticky;
        state.edgeAsk = ask;
        state.edgeAt = now;
        await writeState(state);
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

        // NEVER drop on focused/visible — Android lies. Only dedupe if this
        // sticky already sounded recently (real notify or page chimed:true).
        if (
          sameSide &&
          !askImproved &&
          now - lastAt < EDGE_NOTIFY_COOLDOWN_MS
        ) {
          return;
        }

        await showEdgeNotification({
          side,
          askCents: ask,
          pWin: payload.p_win ?? payload.pWin,
          suggest_stake: payload.suggest_stake ?? payload.suggestStake,
          beat: payload.beat ?? payload.price_to_beat ?? payload.target,
          ticker: payload.ticker,
        });
        state.edgeKey = sticky;
        state.edgeAsk = ask;
        state.edgeAt = now;
        await writeState(state);
      })()
    );
    return;
  }
  event.waitUntil(
    (async () => {
      const state = await readState();
      const ticker = payload.ticker || "";
      const now = Date.now();
      const lastAt = Number(state.targetAt) || 0;
      if (
        state.notifiedTicker &&
        state.notifiedTicker === ticker &&
        now - lastAt < 120_000
      ) {
        return;
      }
      await showTargetNotification(
        {
          beat: payload.beat ?? payload.price_to_beat ?? payload.target,
          ticker: payload.ticker,
          closeEt: payload.close_et || payload.closeEt,
        },
        { force: true }
      );
      state.notifiedTicker = ticker;
      state.targetAt = now;
      if (ticker) state.ticker = ticker;
      await writeState(state);
    })()
  );
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
        if ("focus" in client) {
          await client.focus();
          if (data.kind === "clear_edge") {
            try {
              client.postMessage({ type: "apply-edge-alert", ...data });
            } catch {
              // ignore
            }
          }
          // Do NOT navigate an existing client — navigate reloads the page and
          // re-triggers open first-arm / alert dump.
          return;
        }
      }
      if (clients.openWindow) {
        const win = await clients.openWindow(url);
        if (win && data.kind === "clear_edge") {
          try {
            win.postMessage({ type: "apply-edge-alert", ...data });
          } catch {
            // ignore
          }
        }
      }
    })()
  );
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "kalshi-15m-check") {
    event.waitUntil(
      (async () => {
        await checkTarget(false);
        await checkClearEdge(false);
      })()
    );
  }
});
