/* BeatLine service worker — background 15m target + clear-edge alerts */
const SW_VERSION = "3.9-profit-chime";
const TARGET_URL = "/api/target?tf=15m";
const EDGE_URL = "/api/clear-edge";
const HEALTH_URL = "/api/health";
const STATE_KEY = "kalshiFifteenState";
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
      await Promise.all(keys.filter((k) => k !== SW_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
      startPollLoop();
    })()
  );
});

// Never break page loads — always go to network for navigations.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    fetch(req).catch(() => {
      if (req.mode === "navigate") {
        return new Response(
          `<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>
<body style='font-family:system-ui,sans-serif;background:#0b1210;color:#e7f6ee;padding:24px;line-height:1.45'>
<h1 style='margin:0 0 12px;font-size:1.4rem'>BeatLine offline</h1>
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
});

async function readState() {
  const cache = await caches.open(SW_VERSION);
  const res = await cache.match(STATE_KEY);
  if (!res) {
    return { ticker: null, target: null, chimeOn: true, edgeKey: null, edgeAt: 0 };
  }
  try {
    return await res.json();
  } catch {
    return { ticker: null, target: null, chimeOn: true, edgeKey: null, edgeAt: 0 };
  }
}

async function writeState(state) {
  const cache = await caches.open(SW_VERSION);
  await cache.put(
    STATE_KEY,
    new Response(JSON.stringify(state), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

async function hasVisibleClient() {
  const all = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of all) {
    try {
      if (client.visibilityState === "visible") return true;
    } catch {
      // ignore
    }
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

async function showEdgeNotification(payload, { force = false } = {}) {
  // When BeatLine is open and visible, the page plays its own edge chime —
  // skip a duplicate system banner. Background / locked: this notification
  // IS the audible chime (silent:false + renotify).
  if (!force && (await hasVisibleClient())) return;
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
  await self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png?v=2.6",
    badge: "/icons/icon-192.png?v=2.6",
    vibrate: [80, 40, 80, 40, 80, 40, 160],
    tag: "kalshi-clear-edge",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: {
      url: "/",
      ticker: payload && payload.ticker,
      kind: "clear_edge",
      side: payload && payload.side,
    },
  });
}

async function showProfitNotification(payload, { force = false } = {}) {
  // Foreground tab plays its own C–E–G — skip duplicate system tone.
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
  const changed =
    state.ticker &&
    ticker &&
    state.ticker !== ticker &&
    (data.source === "kalshi" || String(ticker).includes("KXBTC15M"));

  if (changed || forceNotify) {
    await showTargetNotification({
      beat,
      ticker,
      closeEt: data.close_et,
    });
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
    // Edge gone — allow a later re-alert after cooldown window.
    if (state.edgeKey && Date.now() - (Number(state.edgeAt) || 0) > 60000) {
      // keep key until server/client cooldown; don't wipe instantly
    }
    return;
  }
  const ask = Math.round(Number(data.ask_cents) || 0);
  const ticker = data.ticker || "";
  // Sticky per window+side (match page + push) so ask wobble doesn't re-ring.
  const sticky = `${ticker}:${data.side}`;
  const key = sticky;
  const now = Date.now();
  const lastAt = Number(state.edgeAt) || 0;
  const prevKey = state.edgeKey || "";
  const prevAsk = Number(state.edgeAsk) || 0;
  const sameSide = prevKey === sticky || prevKey.startsWith(`${sticky}:`);
  const askImproved = sameSide && prevAsk > 0 && prevAsk - ask >= 5;
  if (!forceNotify) {
    if (sameSide && !askImproved && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS) return;
    if (!sameSide && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS && prevKey) return;
  }
  state.edgeKey = sticky;
  state.edgeAsk = ask;
  state.edgeAt = now;
  await writeState(state);
  // Background poll found a clear edge — ring via system notification.
  await showEdgeNotification(
    {
      side: data.side,
      askCents: ask,
      pWin: data.p_win,
      suggest_stake: data.suggest_stake,
      beat: data.beat ?? data.price_to_beat,
      ticker: data.ticker,
    },
    { force: !(await hasVisibleClient()) }
  );
}

let pollTimer = null;
let keepAliveTimer = null;

async function keepServerAwake() {
  // Best-effort: free Render sleeps after idle; a ping from the SW (when the
  // browser lets it run) keeps the push watcher alive longer.
  try {
    await fetch(`${HEALTH_URL}?_=${Date.now()}`, { cache: "no-store" });
  } catch {
    // ignore
  }
}

function startPollLoop() {
  if (pollTimer) return;
  // Keep checking even if the page is backgrounded (while SW is allowed to run).
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
      showTargetNotification(
        {
          beat: msg.beat,
          ticker: msg.ticker || "TEST",
          closeEt: msg.closeEt,
        },
        { force: !!msg.force }
      )
    );
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
        const sameSide = prevKey === sticky || prevKey.startsWith(`${sticky}:`);
        const askImproved = sameSide && prevAsk > 0 && prevAsk - ask >= 5;
        if (!msg.bypassDedupe) {
          if (!msg.force) {
            if (sameSide && !askImproved && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS)
              return;
            if (!sameSide && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS && prevKey)
              return;
          } else if (sameSide && !askImproved && now - lastAt < 15_000) {
            // Even forced notifies: suppress rapid duplicates from ask wobble.
            return;
          }
        }
        state.edgeKey = sticky;
        state.edgeAsk = ask;
        state.edgeAt = now;
        await writeState(state);
        await showEdgeNotification(msg, { force: !!msg.force });
      })()
    );
  }
  if (msg.type === "edge-armed") {
    // Page already handled this edge in-app — remember it so SW/push don't
    // re-fire the same Best Side when the tab backgrounds.
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (msg.side) {
          const ticker = msg.ticker || "";
          state.edgeKey = `${ticker}:${msg.side}`;
          state.edgeAsk = Math.round(Number(msg.askCents) || 0);
          state.edgeAt = Date.now();
        } else if (msg.clear === false) {
          // keep edgeKey until cooldown; just touch timestamp
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
        // Sticky per window+side — ask wobble must not re-notify.
        const sticky = `${ticker}:${side}`;
        const key = sticky;
        const now = Date.now();
        const lastAt = Number(state.edgeAt) || 0;
        const prevKey = state.edgeKey || "";
        const prevAsk = Number(state.edgeAsk) || 0;
        const sameSide = prevKey === sticky || prevKey.startsWith(`${sticky}:`);
        const askImproved = sameSide && prevAsk > 0 && prevAsk - ask >= 5;
        if (
          sameSide &&
          !askImproved &&
          now - lastAt < EDGE_NOTIFY_COOLDOWN_MS
        ) {
          return;
        }
        if (!sameSide && now - lastAt < EDGE_NOTIFY_COOLDOWN_MS && prevKey) {
          return;
        }
        state.edgeKey = sticky;
        state.edgeAsk = ask;
        state.edgeAt = now;
        await writeState(state);
        const visible = await hasVisibleClient();
        // Web Push must surface when the app is backgrounded. Skip duplicate
        // system tone only when a visible tab is already handling it.
        if (visible) return;
        await showEdgeNotification(
          {
            side,
            askCents: ask,
            pWin: payload.p_win ?? payload.pWin,
            suggest_stake: payload.suggest_stake ?? payload.suggestStake,
            beat: payload.beat ?? payload.price_to_beat ?? payload.target,
            ticker: payload.ticker,
          },
          { force: true }
        );
      })()
    );
    return;
  }
  event.waitUntil(
    (async () => {
      await showTargetNotification(
        {
          beat: payload.beat ?? payload.price_to_beat ?? payload.target,
          ticker: payload.ticker,
          closeEt: payload.close_et || payload.closeEt,
        },
        { force: !(await hasVisibleClient()) }
      );
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // ignore
            }
          }
          return;
        }
      }
      await clients.openWindow(url);
    })()
  );
});
