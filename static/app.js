(() => {
  const TARGET_POLL_MS = 1_200;
  const CANDLE_POLL_MS = 10_000;
  const SPOT_POLL_MS = 1_500;
  const BOUNDARY_PAD_MS = 250;
  const ROLLOVER_BURST_MS = 60_000;
  const ROLLOVER_TICK_MS = 750;
  const TF_KEY = "kalshiChartTf";
  const CHIME_KEY = "kalshiChimeEnabled";
  const BG_ARMED_KEY = "kalshiBgAlertsArmed";
  const DEMO_KEY = "kalshiDemoState";
  const USER_ID_KEY = "beatlineUserId";
  const TRADE_HISTORY_KEY = "beatlineTradeHistory";
  const HISTORY_LIMIT = 50000;
  const DEMO_DEFAULT_START = 1000;
  const APP_VERSION = "10.07";
  /**
   * Best Side profile — catchy name for the August 5 winning setup.
   *
   * "green-spike" / Green Spike = August 5 morning rules (through v9.33):
   * clear-edge only when the model is a favorite (≥52% pWin). That selective
   * gate made the steep green climb on the Wins & P/L chart, before evening
   * v9.34–9.37 loosened alerts.
   *
   * Say "switch to Green Spike" later to mean this exact profile.
   * Do not edit thresholds casually — change BEST_SIDE_PROFILE for a new name.
   */
  const BEST_SIDE_PROFILE = "green-spike";
  const BEST_SIDE_PROFILE_LABEL = "Green Spike";
  /** Tape bias stays off under Green Spike (window-vs-beat only). */
  const TREND_BIAS_ENABLED = false;
  /** Display + day-boundary timezone for the whole app (PST/PDT). */
  const APP_TZ = "America/Los_Angeles";
  /** Day-equity schema: v2 = Pacific calendar day (not Eastern). */
  const DAY_EQUITY_VERSION = 2;
  const INVITEE_KEY = "beatlineInvitee";
  /** Always share this host — never a temp tunnel / preview origin. */
  const STABLE_APP_ORIGIN = "https://beatline-1.onrender.com";
  const TUTORIAL_KEY = "beatlineTutorialSeen";
  const OPEN_PL_COLLAPSE_KEY = "beatlineOpenPlCollapsed";
  const CHART_HEIGHT_KEY = "beatlineChartHeightPx";
  const SUMMARY_PUSH_KEY = "beatlineSummaryPushPx";
  const EDGE_ALERT_STORE_KEY = "beatlineEdgeAlertKey";
  const EPHEMERAL_DISMISS_KEY = "beatlineEphemeralDismissedAt";
  const PL_UI_KEY = "beatlinePlChartUi";
  const TRADE_HISTORY_UI_KEY = "beatlineTradeHistoryUi";
  const DAY_EQUITY_KEY = "beatlineDayEquity";
  const SUGGEST_LOG_KEY = "beatlineSuggestLog";
  const SUGGEST_LOG_LIMIT = 80;
  const VAPID_CACHE_KEY = "beatlineVapidPublic";
  const CHIME_GAP_MS = 4_500;

  function loadPlUi() {
    try {
      const raw = localStorage.getItem(PL_UI_KEY);
      if (!raw) return { optionsOpen: true, range: null, height: 180, dayLines: true };
      const parsed = JSON.parse(raw);
      const range =
        parsed.range &&
        Number.isFinite(Number(parsed.range.from)) &&
        Number.isFinite(Number(parsed.range.to))
          ? { from: Number(parsed.range.from), to: Number(parsed.range.to) }
          : null;
      const height = Number(parsed.height);
      return {
        // Default expanded so the chart is easy to find; remember either way.
        optionsOpen: parsed.optionsOpen == null ? true : !!parsed.optionsOpen,
        // Always open on full trade history — pinch/pan still works after.
        range: null,
        height:
          Number.isFinite(height) && height >= 120 && height <= 420
            ? Math.round(height)
            : 180,
        // Pacific midnight separators on the Options P/L chart.
        dayLines: parsed.dayLines == null ? true : !!parsed.dayLines,
      };
    } catch {
      return { optionsOpen: true, range: null, height: 180, dayLines: true };
    }
  }

  function savePlUi() {
    try {
      localStorage.setItem(
        PL_UI_KEY,
        JSON.stringify({
          optionsOpen: !!plUi.optionsOpen,
          range: plUi.range || null,
          height: plUi.height || 180,
          dayLines: plUi.dayLines !== false,
        })
      );
    } catch {
      // ignore quota
    }
  }

  function loadTradeHistoryUi() {
    try {
      const raw = localStorage.getItem(TRADE_HISTORY_UI_KEY);
      if (!raw) return { open: false };
      const parsed = JSON.parse(raw);
      return { open: !!parsed.open };
    } catch {
      return { open: false };
    }
  }

  function saveTradeHistoryUi() {
    try {
      localStorage.setItem(
        TRADE_HISTORY_UI_KEY,
        JSON.stringify({ open: !!tradeHistoryUi.open })
      );
    } catch {
      // ignore quota
    }
  }

  const TUTORIAL_STEPS = [
    {
      title: "Welcome to BeatLine",
      body: "BeatLine tracks Kalshi’s 15-minute BTC Price to beat. Live price, countdown, odds, and a TARGET line on the chart — all in one portrait screen.",
    },
    {
      title: "Read the window",
      body: "Price to beat is the line BTC must finish above or below. Live now is the current index. Time left is when this 15m window settles. The chart shows that TARGET as a dashed line.",
    },
    {
      title: "Odds & Best Side",
      body: "Market chance shows Above/Below pricing. Best Side scores distance from the beat, time left, ask, and fees — then suggests an advantageous dollar size for high ROI with limited bankroll risk. When a clear edge appears, BeatLine chimes; tap Best to open the buy sheet pre-filled.",
    },
    {
      title: "Set size, then buy",
      body: "Use the Trade size slider to compare win, cost, and ROI across dollar amounts. Then tap Buy Above, Best, or Buy Below — confirm or edit dollars in the sheet and slide to fill. Same-side taps add to the open position (avg entry).",
    },
    {
      title: "Rolling P/L",
      body: "After a buy, an Open trade card tracks live P/L as price and odds move: entry, bid, fees, vs beat, time left, and hold outcomes. Add more on the same side anytime. Close at bid anytime, or hold to window settle.",
    },
    {
      title: "Demo & alerts",
      body: "⋮ Options → Demo mode turns on a paper bankroll and session P/L. The bell enables automatic alerts for clear-edge Best Side moments.",
    },
  ];

  let tutorialIndex = 0;
  let tutorialOpen = false;

  const TF_LABELS = {
    "1m": "1m candles",
    "5m": "5m candles",
    "15m": "15m candles",
  };

  const el = {
    chart: document.getElementById("chart"),
    chartWrap: document.getElementById("chart-wrap"),
    toBeatChip: document.getElementById("to-beat-chip"),
    chartResizeTop: document.getElementById("chart-resize-top"),
    chartResizeBottom: document.getElementById("chart-resize-bottom"),
    appShell: document.querySelector(".app-shell"),
    tradePanel: document.querySelector(".trade-panel"),
    tradeStack: document.querySelector(".trade-stack"),
    timeframe: document.getElementById("timeframe"),
    chartTfLabel: document.getElementById("chart-tf-label"),
    summaryPanel: document.getElementById("summary-panel"),
    targetLabel: document.getElementById("target-label"),
    targetValue: document.getElementById("target-value"),
    targetMeta: document.getElementById("target-meta"),
    spotValue: document.getElementById("spot-value"),
    spotDelta: document.getElementById("spot-delta"),
    countdown: document.getElementById("countdown"),
    countdownMeta: document.getElementById("countdown-meta"),
    status: document.getElementById("status"),
    clock: document.getElementById("clock"),
    bgStatus: document.getElementById("bg-status"),
    pushBadge: document.getElementById("push-badge"),
    alertsStatusLine: document.getElementById("alerts-status-line"),
    alertsTest: document.getElementById("alerts-test"),
    alertsEnable: document.getElementById("alerts-enable"),
    rotateGate: document.getElementById("rotate-gate"),
    oddsRow: document.getElementById("odds-row"),
    yesPct: document.getElementById("yes-pct"),
    noPct: document.getElementById("no-pct"),
    yesBook: document.getElementById("yes-book"),
    noBook: document.getElementById("no-book"),
    oddsHint: document.getElementById("odds-hint"),
    edgeLine: document.getElementById("edge-line"),
    roiPanel: document.getElementById("roi-panel"),
    stakeStrip: document.getElementById("stake-strip"),
    stakeSlider: document.getElementById("stake-slider"),
    stakeValue: document.getElementById("stake-value"),
    bestSide: document.getElementById("best-side"),
    bestSideLabel: document.getElementById("best-side-label"),
    bestSideAmount: document.getElementById("best-side-amount"),
    bestSideSuggest: document.getElementById("best-side-suggest"),
    bestSideSuggestAmount: document.getElementById("best-side-suggest-amount"),
    bestSideSuggestMeta: document.getElementById("best-side-suggest-meta"),
    bestSideMeta: document.getElementById("best-side-meta"),
    roiAbovePrice: document.getElementById("roi-above-price"),
    roiAboveSummary: document.getElementById("roi-above-summary"),
    roiAboveDetail: document.getElementById("roi-above-detail"),
    roiBelowPrice: document.getElementById("roi-below-price"),
    roiBelowSummary: document.getElementById("roi-below-summary"),
    roiBelowDetail: document.getElementById("roi-below-detail"),
    dockBuyAbove: document.getElementById("dock-buy-above"),
    dockBuyBelow: document.getElementById("dock-buy-below"),
    dockBuyBest: document.getElementById("dock-buy-best"),
    dockAbovePct: document.getElementById("dock-above-pct"),
    dockBelowPct: document.getElementById("dock-below-pct"),
    dockBestDetail: document.getElementById("dock-best-detail"),
    settleBanner: document.getElementById("settle-banner"),
    settleTitle: document.getElementById("settle-title"),
    settleAvg: document.getElementById("settle-avg"),
    settleMeta: document.getElementById("settle-meta"),
    menuBtn: document.getElementById("menu-btn"),
    optionsBackdrop: document.getElementById("options-backdrop"),
    optionsSheet: document.getElementById("options-sheet"),
    optionsBody: document.getElementById("options-body"),
    optionsClose: document.getElementById("options-close"),
    tutorial: document.getElementById("tutorial"),
    tutorialBackdrop: document.getElementById("tutorial-backdrop"),
    tutorialTitle: document.getElementById("tutorial-title"),
    tutorialBody: document.getElementById("tutorial-body"),
    tutorialStepNum: document.getElementById("tutorial-step-num"),
    tutorialStepTotal: document.getElementById("tutorial-step-total"),
    tutorialNext: document.getElementById("tutorial-next"),
    tutorialSkip: document.getElementById("tutorial-skip"),
    tutorialOpen: document.getElementById("tutorial-open"),
    appVersionLine: document.getElementById("app-version-line"),
    systemHealth: document.getElementById("system-health"),
    appUpdate: document.getElementById("app-update"),
    pullRefresh: document.getElementById("pull-refresh"),
    pullRefreshLabel: document.getElementById("pull-refresh-label"),
    demoToggle: document.getElementById("demo-toggle"),
    demoAccount: document.getElementById("demo-account"),
    demoBalance: document.getElementById("demo-balance"),
    demoPl: document.getElementById("demo-pl"),
    demoStart: document.getElementById("demo-start"),
    demoReset: document.getElementById("demo-reset"),
    demoPosition: document.getElementById("demo-position"),
    demoBuyBest: document.getElementById("demo-buy-best"),
    demoBuyAbove: document.getElementById("demo-buy-above"),
    demoBuyBelow: document.getElementById("demo-buy-below"),
    demoLast: document.getElementById("demo-last"),
    tradeHistoryList: document.getElementById("trade-history-list"),
    tradeHistorySummary: document.getElementById("trade-history-summary"),
    tradeHistorySection: document.getElementById("trade-history-section"),
    tradeHistoryToggle: document.getElementById("trade-history-toggle"),
    tradeHistoryBody: document.getElementById("trade-history-body"),
    tradeHistoryChevron: document.getElementById("trade-history-chevron"),
    plChart: document.getElementById("pl-chart"),
    plChartEmpty: document.getElementById("pl-chart-empty"),
    plChartCaption: document.getElementById("pl-chart-caption"),
    plChartSection: document.querySelector(".pl-chart-section"),
    plChartToggle: document.getElementById("pl-chart-toggle"),
    plChartBody: document.getElementById("pl-chart-body"),
    plChartToggleMeta: document.getElementById("pl-chart-toggle-meta"),
    plChartStage: document.getElementById("pl-chart-stage"),
    plDayLines: document.getElementById("pl-day-lines"),
    plDayLinesCheck: document.getElementById("pl-day-lines-check"),
    plCrosshair: document.getElementById("pl-crosshair"),
    plCrosshairDate: document.getElementById("pl-crosshair-date"),
    plCrosshairPrice: document.getElementById("pl-crosshair-price"),
    plCrosshairBalance: document.getElementById("pl-crosshair-balance"),
    plCrosshairBalanceAmt: document.getElementById("pl-crosshair-balance-amt"),
    plCrosshairBalanceNote: document.getElementById("pl-crosshair-balance-note"),
    plChartReadout: document.getElementById("pl-chart-readout"),
    plChartReadoutMain: document.getElementById("pl-chart-readout-main"),
    plChartReadoutBalance: document.getElementById("pl-chart-readout-balance"),
    plChartReadoutBalanceAmt: document.getElementById(
      "pl-chart-readout-balance-amt"
    ),
    plChartReadoutBalanceNote: document.getElementById(
      "pl-chart-readout-balance-note"
    ),
    accountExport: document.getElementById("account-export"),
    accountImport: document.getElementById("account-import"),
    accountImportFile: document.getElementById("account-import-file"),
    accountUserId: document.getElementById("account-user-id"),
    accountCopyId: document.getElementById("account-copy-id"),
    accountCopyLink: document.getElementById("account-copy-link"),
    accountCopyConfirm: document.getElementById("account-copy-confirm"),
    accountRestoreId: document.getElementById("account-restore-id"),
    accountRestoreBtn: document.getElementById("account-restore-btn"),
    accountShareHint: document.getElementById("account-share-hint"),
    ephemeralBanner: document.getElementById("ephemeral-banner"),
    ephemeralExport: document.getElementById("ephemeral-export"),
    ephemeralDismiss: document.getElementById("ephemeral-dismiss"),
    demoMark: document.getElementById("demo-mark"),
    demoMarkPl: document.getElementById("demo-mark-pl"),
    demoMarkMeta: document.getElementById("demo-mark-meta"),
    demoClose: document.getElementById("demo-close"),
    demoLive: document.getElementById("demo-live"),
    demoLiveKicker: document.getElementById("demo-live-kicker"),
    demoLiveSide: document.getElementById("demo-live-side"),
    demoLivePl: document.getElementById("demo-live-pl"),
    demoLivePct: document.getElementById("demo-live-pct"),
    demoLiveFactors: document.getElementById("demo-live-factors"),
    demoLiveMeta: document.getElementById("demo-live-meta"),
    demoLiveClose: document.getElementById("demo-live-close"),
    openPlBar: document.getElementById("open-pl-bar"),
    openPlSide: document.getElementById("open-pl-side"),
    openPlValue: document.getElementById("open-pl-value"),
    openPlBalance: document.getElementById("open-pl-balance"),
    openPlDayPct: document.getElementById("open-pl-day-pct"),
    openPlSub: document.getElementById("open-pl-sub"),
    demoDayPct: document.getElementById("demo-day-pct"),
    strategyFollowed: document.getElementById("strategy-followed"),
    strategyOwn: document.getElementById("strategy-own"),
    strategyAll: document.getElementById("strategy-all"),
    strategyMissed: document.getElementById("strategy-missed"),
    strategyVerdict: document.getElementById("strategy-verdict"),
    strategyToday: document.getElementById("strategy-today"),
    strategyToggle: document.getElementById("strategy-toggle"),
    strategyBody: document.getElementById("strategy-body"),
    strategyChevron: document.getElementById("strategy-chevron"),
    strategySection: document.getElementById("strategy-section"),
    strategyBars: document.getElementById("strategy-bars"),
    strategyChartCaption: document.getElementById("strategy-chart-caption"),
    strategyChartEmpty: document.getElementById("strategy-chart-empty"),
    openPlAdd: document.getElementById("open-pl-add"),
    openPlClose: document.getElementById("open-pl-close"),
    openPlToggle: document.getElementById("open-pl-toggle"),
    openPlPeek: document.getElementById("open-pl-peek"),
    openPlBody: document.getElementById("open-pl-body"),
    buyBackdrop: document.getElementById("buy-backdrop"),
    buySheet: document.getElementById("buy-sheet"),
    buySheetTitle: document.getElementById("buy-sheet-title"),
    buySheetMeta: document.getElementById("buy-sheet-meta"),
    buySheetX: document.getElementById("buy-sheet-x"),
    buyAmount: document.getElementById("buy-amount"),
    buyRange: document.getElementById("buy-range"),
    buyRangeValue: document.getElementById("buy-range-value"),
    buySuggest: document.getElementById("buy-suggest"),
    buySuggestAmount: document.getElementById("buy-suggest-amount"),
    buySuggestMeta: document.getElementById("buy-suggest-meta"),
    buySuggestUse: document.getElementById("buy-suggest-use"),
    buyBalanceHint: document.getElementById("buy-balance-hint"),
    buyPreview: document.getElementById("buy-preview"),
    buySlide: document.getElementById("buy-slide"),
    buySlideFill: document.getElementById("buy-slide-fill"),
    buySlideLabel: document.getElementById("buy-slide-label"),
    buySlideThumb: document.getElementById("buy-slide-thumb"),
    kalshiLink: null,
  };

  let chart = null;
  let series = null;
  let plChart = null;
  let plCandlesCache = [];
  let plInspecting = false;
  let plSeries = null;
  let plChartFitted = false;
  let plUi = loadPlUi();
  let plRangeSaveTimer = null;
  let plRestoringRange = false;
  let plLastBarCount = 0;
  /** Right-axis Y zoom via scaleMargins (smaller = candles fill more). Chart box size stays fixed. */
  let plYMargin = 0.12;
  let tradeHistoryUi = loadTradeHistoryUi();
  let targetSeries = null;
  let targetLine = null;
  let settleLine = null;
  let breakevenLine = null;
  let entryLine = null;
  let lastCandleData = [];
  let lastTicker = null;
  let lastTarget = null;
  let lastFifteenTarget = null;
  let lastFifteenTicker = null;
  /** While > now, sync 15m ticker quietly — no open-from-background chime dump. */
  let suppressTargetChimeUntil = 0;
  /** While > now, do not FG Best-buy chime (resume / open quiet-sync). */
  let suppressEdgeChimeUntil = 0;
  let lastKalshiUrl = "https://kalshi.com/markets/kxbtc15m";
  let lastYesPct = null;
  let lastSettlementAvg = null;
  let lastSettlementSide = null;
  let lastSettlementMode = false;
  let lastThinBook = false;
  let closeTimeIso = null;
  let lastBestSideKey = null;
  let bestSideFlashTimer = null;
  let lastBestPick = null; // { side } | null when clear edge
  /**
   * Edge from a background notification — keep Suggested buy on screen so
   * opening the alert doesn't land on "No clear edge / wait" while the
   * phone just said Best buy.
   */
  let heldAlertEdge = null; // { side, askCents, pWin, suggestStake, ticker, beat, at }
  const HELD_ALERT_MS = 5 * 60 * 1000;
  const HELD_ALERT_KEY = "beatlineHeldAlertEdge";
  // Restored at boot via restoreEdgeAlertKeyFromSession() after helpers exist.
  let lastClearEdgeAlertKey = null;
  let lastClearEdgeAlertAt = 0;
  let lastClearEdgeGoneAt = 0;
  /**
   * Only set after a real chime / phone notification. Quiet-arm and session
   * restore must NOT write this — that was silencing FG forever.
   */
  let lastSoundedEdgeSticky = null; // `${ticker}:${side}`
  let lastSoundedAsk = 0;
  const EDGE_ALERT_COOLDOWN_MS = 90_000;
  const EDGE_GONE_RESET_MS = 45_000;
  let edgeAlertsArmed = false;
  /** Last SW edge sticky/timestamp — used to avoid re-chiming what BG already rang. */
  let swEdgeState = null; // { edgeKey, edgeAsk, edgeAt, chimeOn }
  // Hysteresis so Best Side doesn't flicker BUY ↔ wait and re-chime.
  let clearEdgeLatched = false;
  let clearEdgeLatchTicker = null;
  let lastChimeAt = 0;
  /** Replay Best Side tone after the next tap if AudioContext was suspended. */
  let pendingEdgeChime = false;
  /** Replay profit C–E–G after the next tap if audio was blocked. */
  let pendingProfitChime = false;
  let pendingProfitPayload = null;
  let openPlCollapsed = localStorage.getItem(OPEN_PL_COLLAPSE_KEY) === "1";
  let chartHeightPx = loadChartHeightPx();
  let summaryPushPx = loadSummaryPushPx();
  let summaryNaturalH = null;
  let lastBreakevenPrice = null;
  let settleHintByTicker = {};
  let optionsOpen = false;
  let buySheetOpen = false;
  let buySheetSide = null; // above | below
  let buySheetAmount = 1;
  let buySuggestStake = null;
  let buySlideDragging = false;
  let buySlideStartX = 0;
  let buySlideProgress = 0;
  let buySlideMax = 0;
  let buyConfirming = false;
  let demo = loadDemoState();
  let boundaryTimer = null;
  let rolloverTimer = null;
  let rolloverUntil = 0;
  let fittedOnce = false;
  let lastCandleCount = 0;
  let prevSpot = null;
  /** Recent live ticks for short-term trend ({ t, px }). */
  let spotTrail = [];
  const SPOT_TRAIL_MS = 12 * 60 * 1000;
  let audioCtx = null;
  // Chart candle size only — Price to beat is always Kalshi 15m.
  let currentTf = localStorage.getItem(TF_KEY) || "15m";
  if (!["1m", "5m", "15m"].includes(currentTf)) currentTf = "15m";
  let chimeOn = localStorage.getItem(CHIME_KEY);
  chimeOn = chimeOn === null ? true : chimeOn === "1";

  function money(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function loadTradeHistory() {
    try {
      const raw = localStorage.getItem(TRADE_HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((h) => h && typeof h === "object").slice(0, HISTORY_LIMIT);
    } catch {
      return [];
    }
  }

  function tradeHistoryId(h) {
    if (!h || typeof h !== "object") return "";
    if (h.id) return String(h.id);
    return [
      h.at || "",
      h.kind || "",
      h.side || "",
      h.ticker || "",
      h.pl ?? "",
      h.text || "",
    ].join("|");
  }

  /** Keep the full ledger across devices/sync — never drop older days on merge. */
  function mergeTradeHistory(...lists) {
    const byId = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        if (!h || typeof h !== "object") continue;
        const id = tradeHistoryId(h);
        if (!id || byId.has(id)) continue;
        byId.set(id, h);
      }
    }
    return Array.from(byId.values())
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, HISTORY_LIMIT);
  }

  function persistTradeHistory(list) {
    // Append-only ledger: never write a shorter/empty list over a longer one.
    const existing = (() => {
      try {
        const raw = localStorage.getItem(TRADE_HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const merged = mergeTradeHistory(list, existing);
    if (!merged.length && existing.length) return;
    try {
      localStorage.setItem(
        TRADE_HISTORY_KEY,
        JSON.stringify(merged.slice(0, HISTORY_LIMIT))
      );
    } catch {
      // quota — keep what we can in memory
    }
  }

  function demoLooksFresh(state) {
    if (!state) return true;
    const hist = Array.isArray(state.history) ? state.history : [];
    const realized = Number(state.realizedPl) || 0;
    const start = Number(state.start) || DEMO_DEFAULT_START;
    const bal = Number(state.balance);
    return (
      !state.position &&
      hist.length === 0 &&
      realized === 0 &&
      Number.isFinite(bal) &&
      Math.abs(bal - start) < 0.01
    );
  }

  function newUserId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID().replace(/-/g, "");
    }
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function getUserId() {
    try {
      let id = localStorage.getItem(USER_ID_KEY);
      if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;
      id = newUserId();
      localStorage.setItem(USER_ID_KEY, id);
      return id;
    } catch {
      return newUserId();
    }
  }

  function setUserId(id) {
    const uid = String(id || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(uid)) {
      throw new Error("Invalid account ID");
    }
    localStorage.setItem(USER_ID_KEY, uid);
    return uid;
  }

  function shortUserId(id) {
    const uid = id || getUserId();
    if (uid.length <= 12) return uid;
    return `${uid.slice(0, 6)}…${uid.slice(-4)}`;
  }

  function accountHeaders(extra) {
    return {
      "X-BeatLine-User": getUserId(),
      ...(extra || {}),
    };
  }

  function isInvitee() {
    try {
      return localStorage.getItem(INVITEE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setInvitee(on) {
    try {
      if (on) localStorage.setItem(INVITEE_KEY, "1");
      else localStorage.removeItem(INVITEE_KEY);
    } catch {
      // ignore
    }
  }

  /** Invite links mark the opener as non-sharer; strip the flag from the URL. */
  function consumeInviteLink() {
    try {
      const url = new URL(location.href);
      const flag =
        url.searchParams.get("invite") ||
        url.searchParams.get("shared") ||
        url.searchParams.get("from");
      if (flag === "1" || flag === "true" || flag === "share") {
        setInvitee(true);
        url.searchParams.delete("invite");
        url.searchParams.delete("shared");
        url.searchParams.delete("from");
        const clean = `${url.pathname}${url.search}${url.hash}` || "/";
        history.replaceState(null, "", clean);
      }
    } catch {
      // ignore
    }
  }

  function shareAppLink() {
    // Never copy temp tunnels (loca.lt / cloudflare) — those die and look
    // like "the BeatLine link doesn't work" to friends.
    const host = (location.hostname || "").toLowerCase();
    const local =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".local");
    const origin = local ? location.origin : STABLE_APP_ORIGIN;
    return `${origin}/?invite=1`;
  }

  function syncAccountShareUi() {
    if (el.accountUserId) el.accountUserId.textContent = shortUserId();
    const invitee = isInvitee();
    if (el.accountCopyLink) {
      el.accountCopyLink.hidden = invitee;
      el.accountCopyLink.setAttribute("aria-hidden", invitee ? "true" : "false");
    }
    if (el.accountShareHint) {
      el.accountShareHint.textContent = invitee
        ? "This is your private balance & trade history on this phone."
        : "Friends open your invite link and get their own private balance & trade history — not yours. They cannot reshare the app.";
    }
  }

  async function copyText(text) {
    const value = String(text || "");
    if (!value) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // fall through — common on some Android/PWA builds
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.width = "1px";
      ta.style.height = "1px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  function showCopyConfirm(ok, message, btn, okLabel) {
    if (el.accountCopyConfirm) {
      el.accountCopyConfirm.hidden = false;
      el.accountCopyConfirm.textContent = message;
      el.accountCopyConfirm.classList.toggle("is-ok", !!ok);
      el.accountCopyConfirm.classList.toggle("is-warn", !ok);
      clearTimeout(showCopyConfirm._timer);
      showCopyConfirm._timer = setTimeout(() => {
        if (!el.accountCopyConfirm) return;
        el.accountCopyConfirm.hidden = true;
        el.accountCopyConfirm.textContent = "";
        el.accountCopyConfirm.classList.remove("is-ok", "is-warn");
      }, 3200);
    }
    if (btn) {
      if (!btn.dataset.idleLabel) {
        btn.dataset.idleLabel = (btn.textContent || "").trim();
      }
      btn.textContent = ok ? okLabel || "Copied!" : "Copy failed";
      btn.classList.toggle("is-copied", !!ok);
      btn.classList.toggle("is-copy-failed", !ok);
      clearTimeout(btn._copyFlashTimer);
      btn._copyFlashTimer = setTimeout(() => {
        btn.textContent = btn.dataset.idleLabel || btn.textContent;
        btn.classList.remove("is-copied", "is-copy-failed");
      }, 2200);
    }
    setStatus(ok ? "ok" : "warn", message);
  }

  function wireAccountShareUi() {
    consumeInviteLink();
    syncAccountShareUi();
    if (el.accountCopyId) {
      el.accountCopyId.addEventListener("click", async () => {
        const ok = await copyText(getUserId());
        showCopyConfirm(
          ok,
          ok
            ? "Account ID copied — paste it on another phone to restore this book"
            : "Could not copy — long-press the ID above and copy it",
          el.accountCopyId,
          "Copied ID!"
        );
      });
    }
    if (el.accountCopyLink) {
      el.accountCopyLink.addEventListener("click", async () => {
        if (isInvitee()) {
          showCopyConfirm(
            false,
            "Sharing is only available on the original invite",
            el.accountCopyLink,
            "Copied!"
          );
          return;
        }
        const link = shareAppLink();
        const ok = await copyText(link);
        showCopyConfirm(
          ok,
          ok
            ? `Invite link copied — paste this: ${STABLE_APP_ORIGIN.replace("https://", "")}`
            : "Could not copy — send https://beatline-1.onrender.com/?invite=1 manually",
          el.accountCopyLink,
          "Copied!"
        );
      });
    }
    if (el.accountRestoreBtn && el.accountRestoreId) {
      el.accountRestoreBtn.addEventListener("click", async () => {
        const raw = String(el.accountRestoreId.value || "").trim();
        if (!raw) {
          setStatus("warn", "Paste an account ID to restore");
          return;
        }
        try {
          setUserId(raw);
        } catch (err) {
          setStatus("warn", err.message || "Invalid account ID");
          return;
        }
        try {
          localStorage.removeItem(DEMO_KEY);
          localStorage.removeItem(TRADE_HISTORY_KEY);
        } catch {
          // ignore
        }
        demo = loadDemoState();
        syncAccountShareUi();
        setStatus("loading", "Restoring private account…");
        await hydrateDemoFromServer();
        renderDemoUi();
        renderTradeHistory();
        applyPlUi();
        setStatus(
          "ok",
          `Restored account ${shortUserId()} · ${money(demo.balance)}`
        );
      });
    }
  }

  function applyDemoState(next, { syncServer, replaceHistory } = {}) {
    if (!next || typeof next !== "object") return;
    // Permanent trade ledger: always union with what we already have unless
    // an explicit backup replace is requested (still merges backup + ledger).
    const incoming = Array.isArray(next.history) ? next.history : [];
    const history = replaceHistory
      ? mergeTradeHistory(incoming, loadTradeHistory())
      : mergeTradeHistory(incoming, demo.history, loadTradeHistory());
    demo = {
      on: !!next.on,
      start:
        Number.isFinite(next.start) && next.start > 0
          ? next.start
          : DEMO_DEFAULT_START,
      balance: Number.isFinite(next.balance) ? next.balance : DEMO_DEFAULT_START,
      realizedPl: Number.isFinite(next.realizedPl) ? next.realizedPl : 0,
      position:
        next.position && typeof next.position === "object" ? next.position : null,
      lastResult:
        next.lastResult && typeof next.lastResult === "object"
          ? next.lastResult
          : null,
      history,
      updatedAt: Number(next.updatedAt) || Date.now(),
    };
    persistTradeHistory(demo.history);
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(demo));
    } catch {
      // ignore
    }
    if (syncServer) queueServerDemoSave();
    renderDemoUi();
    renderTradeHistory();
  }

  let serverSaveTimer = null;
  let serverSaveInFlight = false;

  function queueServerDemoSave() {
    if (serverSaveTimer) clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(() => {
      serverSaveTimer = null;
      pushDemoStateToServer().catch(() => {});
    }, 250);
  }

  async function pushDemoStateToServer() {
    if (serverSaveInFlight) {
      queueServerDemoSave();
      return;
    }
    serverSaveInFlight = true;
    try {
      const history = mergeTradeHistory(demo.history, loadTradeHistory());
      demo.history = history;
      persistTradeHistory(history);
      const payload = {
        ...demo,
        history,
        updatedAt: Date.now(),
      };
      demo.updatedAt = payload.updatedAt;
      await fetch("/api/demo-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...accountHeaders(),
        },
        body: JSON.stringify({ userId: getUserId(), state: payload }),
        cache: "no-store",
      });
    } catch {
      // keep local; retry on next save
    } finally {
      serverSaveInFlight = false;
    }
  }

  function isEphemeralHost() {
    const host = (location.hostname || "").toLowerCase();
    return (
      host.endsWith(".loca.lt") ||
      host.endsWith(".trycloudflare.com") ||
      host.endsWith(".lhr.life") ||
      host.endsWith(".localhost.run")
    );
  }

  function setupEphemeralBanner() {
    if (!el.ephemeralBanner) return;
    // Always start hidden; only temp tunnels may show it.
    el.ephemeralBanner.hidden = true;
    if (!isEphemeralHost()) return;
    try {
      const dismissedAt = Number(localStorage.getItem(EPHEMERAL_DISMISS_KEY) || 0);
      // Re-show every 6h so the permanent-host reminder stays visible.
      if (dismissedAt && Date.now() - dismissedAt < 6 * 60 * 60 * 1000) return;
    } catch {
      // ignore
    }
    el.ephemeralBanner.hidden = false;
    if (el.ephemeralExport) {
      el.ephemeralExport.addEventListener("click", () => exportAccountBackup());
    }
    if (el.ephemeralDismiss) {
      el.ephemeralDismiss.addEventListener("click", () => {
        el.ephemeralBanner.hidden = true;
        try {
          localStorage.setItem(EPHEMERAL_DISMISS_KEY, String(Date.now()));
        } catch {
          // ignore
        }
      });
    }
  }

  /** Recovered Aug 4–5 trades (seeded) so early W/L stay on history + charts. */
  let seedTradeHistoryCache = null;

  async function loadSeedTradeHistory() {
    if (Array.isArray(seedTradeHistoryCache)) return seedTradeHistoryCache;
    try {
      const res = await fetch(
        `/seed-trade-history.json?v=${encodeURIComponent(APP_VERSION)}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        seedTradeHistoryCache = [];
        return seedTradeHistoryCache;
      }
      const data = await res.json();
      seedTradeHistoryCache = Array.isArray(data && data.history)
        ? data.history.filter((h) => h && typeof h === "object")
        : [];
    } catch {
      seedTradeHistoryCache = [];
    }
    return seedTradeHistoryCache;
  }

  async function hydrateDemoFromServer() {
    try {
      // Re-attach any ledger rows that lived only in the dedicated key,
      // plus recovered Aug 4–5 seed trades for Wins & P/L / strategy charts.
      const seed = await loadSeedTradeHistory();
      demo.history = mergeTradeHistory(
        demo.history,
        loadTradeHistory(),
        seed
      );
      persistTradeHistory(demo.history);

      const res = await fetch(
        `/api/demo-account?userId=${encodeURIComponent(getUserId())}`,
        {
          cache: "no-store",
          headers: accountHeaders(),
        }
      );
      const data = await res.json();
      const remote = data && data.state;
      if (remote && typeof remote === "object") {
        const remoteFresh = demoLooksFresh(remote);
        const localFresh = demoLooksFresh(demo);
        const remoteAt = Number(remote.updatedAt) || 0;
        const localAt = Number(demo.updatedAt) || 0;
        const remoteHist = Array.isArray(remote.history) ? remote.history : [];
        const localHist = mergeTradeHistory(
          demo.history,
          loadTradeHistory(),
          seed
        );
        // Empty / wiped server (Render restart) must NEVER beat a local ledger.
        const preferRemote =
          !remoteFresh &&
          ((localFresh && remoteHist.length > 0) ||
            (!localFresh && remoteAt >= localAt && remoteHist.length > 0));
        const mergedHistory = mergeTradeHistory(remoteHist, localHist);
        if (preferRemote) {
          applyDemoState(
            { ...remote, history: mergedHistory },
            { syncServer: mergedHistory.length > remoteHist.length }
          );
          setStatus(
            "ok",
            `Account restored · ${money(demo.balance)}${
              demo.history && demo.history.length
                ? ` · ${demo.history.length} trades kept`
                : ""
            }`
          );
        } else {
          // Keep local balances; always absorb any remote trade rows.
          if (mergedHistory.length !== (demo.history || []).length) {
            demo.history = mergedHistory;
            persistTradeHistory(demo.history);
            saveDemoState();
            renderTradeHistory();
          }
        }
      }
      // Always re-upload the ledger so a wiped Render disk is healed.
      if ((demo.history && demo.history.length) || !demoLooksFresh(demo) || !remote) {
        await pushDemoStateToServer();
      }
    } catch {
      // offline / tunnel blip — keep localStorage ledger
    }
  }

  function loadDemoState() {
    const fallback = {
      on: false,
      start: DEMO_DEFAULT_START,
      balance: DEMO_DEFAULT_START,
      realizedPl: 0,
      position: null,
      lastResult: null,
      history: loadTradeHistory(),
      updatedAt: 0,
    };
    try {
      const raw = localStorage.getItem(DEMO_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      let history = mergeTradeHistory(
        Array.isArray(parsed.history) ? parsed.history : [],
        loadTradeHistory()
      );
      // Seed one row from lastResult if history is still empty (pre-history sessions).
      if (
        !history.length &&
        parsed.lastResult &&
        typeof parsed.lastResult === "object" &&
        parsed.lastResult.text
      ) {
        history = [
          {
            id: `seed-${Date.now()}`,
            at: Date.now(),
            kind: parsed.lastResult.won ? "settle" : "close",
            side: parsed.lastResult.side || "above",
            ticker: parsed.lastResult.ticker || null,
            contracts: null,
            askCents: null,
            total: null,
            fills: 1,
            exitCents: null,
            pl: Number(parsed.lastResult.pl),
            won: !!parsed.lastResult.won,
            accounted: false,
            text: parsed.lastResult.text,
          },
        ];
      }
      history = mergeTradeHistory(history);
      persistTradeHistory(history);
      return {
        on: !!parsed.on,
        start:
          Number.isFinite(parsed.start) && parsed.start > 0
            ? parsed.start
            : DEMO_DEFAULT_START,
        balance: Number.isFinite(parsed.balance) ? parsed.balance : DEMO_DEFAULT_START,
        realizedPl: Number.isFinite(parsed.realizedPl) ? parsed.realizedPl : 0,
        position: parsed.position && typeof parsed.position === "object" ? parsed.position : null,
        lastResult:
          parsed.lastResult && typeof parsed.lastResult === "object"
            ? parsed.lastResult
            : null,
        history,
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      return fallback;
    }
  }

  function saveDemoState() {
    try {
      if (!Array.isArray(demo.history)) demo.history = [];
      demo.history = mergeTradeHistory(demo.history, loadTradeHistory());
      demo.updatedAt = Date.now();
      persistTradeHistory(demo.history);
      localStorage.setItem(DEMO_KEY, JSON.stringify(demo));
    } catch {
      // ignore quota
    }
    queueServerDemoSave();
  }

  function pushTradeHistory(entry) {
    if (!entry || typeof entry !== "object") return;
    if (!Array.isArray(demo.history)) demo.history = [];
    const row = {
      id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: entry.at || Date.now(),
      ...entry,
    };
    // Append-only: never drop older rows when adding a new fill/close.
    demo.history = mergeTradeHistory([row], demo.history, loadTradeHistory());
    persistTradeHistory(demo.history);
  }

  function exportAccountBackup() {
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      userId: getUserId(),
      state: {
        on: !!demo.on,
        start: demo.start,
        balance: demo.balance,
        realizedPl: demo.realizedPl,
        position: demo.position,
        lastResult: demo.lastResult,
        history: Array.isArray(demo.history) ? demo.history : [],
        updatedAt: Date.now(),
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `beatline-account-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus("ok", "Account backup downloaded");
  }

  function importAccountBackupFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const state =
          parsed && parsed.state && typeof parsed.state === "object"
            ? parsed.state
            : parsed;
        if (!state || typeof state !== "object") {
          throw new Error("Invalid backup file");
        }
        if (
          !window.confirm(
            "Restore this backup’s balance and open trade? Trade history will be MERGED (nothing deleted)."
          )
        ) {
          return;
        }
        if (parsed && parsed.userId) {
          try {
            setUserId(parsed.userId);
            syncAccountShareUi();
          } catch {
            // keep current user id
          }
        }
        applyDemoState(
          {
            on: state.on !== false,
            start: state.start,
            balance: state.balance,
            realizedPl: state.realizedPl,
            position: state.position,
            lastResult: state.lastResult,
            history: state.history,
            updatedAt: Date.now(),
          },
          { syncServer: true, replaceHistory: false }
        );
        setStatus(
          "ok",
          `Backup restored · ${money(demo.balance)} · ${(demo.history || []).length} trades`
        );
      } catch (err) {
        setStatus("warn", `Import failed: ${err.message || err}`);
      }
    };
    reader.onerror = () => setStatus("warn", "Could not read backup file");
    reader.readAsText(file);
  }

  function formatHistoryTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString("en-US", {
        timeZone: APP_TZ,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  /** Closed settle/close rows with a real P/L, oldest → newest (all-time). */
  function closedPlTrades() {
    // Merge demo state + dedicated trade-history key so Options charts never
    // drop older days after a partial server sync.
    const list = mergeTradeHistory(
      Array.isArray(demo.history) ? demo.history : [],
      loadTradeHistory()
    );
    if (list.length && list.length !== (demo.history || []).length) {
      demo.history = list;
      persistTradeHistory(list);
    }
    return list
      .filter((t) => {
        if (!t || typeof t !== "object") return false;
        if (t.kind !== "settle" && t.kind !== "close") return false;
        return Number.isFinite(Number(t.pl));
      })
      .slice()
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  }

  function plHistoryDaySpan(closed) {
    if (!closed.length) return null;
    const first = Number(closed[0].at) || 0;
    const last = Number(closed[closed.length - 1].at) || 0;
    if (!first || !last) return null;
    const a = appDateKey(first);
    const b = appDateKey(last);
    if (!a || !b) return null;
    if (a === b) return a;
    return `${a} → ${b}`;
  }

  /**
   * Build equity candlesticks from the full trade log (all days):
   * each closed trade is one candle (open=equity before, close=equity after).
   * Green = win / equity up; red = loss / equity down.
   */
  function buildPlCandles() {
    const closed = closedPlTrades();
    const start =
      Number.isFinite(Number(demo.start)) && Number(demo.start) > 0
        ? Number(demo.start)
        : DEMO_DEFAULT_START;
    let equity = start;
    let lastTime = 0;
    const candles = [];
    for (const t of closed) {
      const pl = Number(t.pl);
      const open = Math.round(equity * 100) / 100;
      equity = Math.round((equity + pl) * 100) / 100;
      const close = equity;
      let time = Math.floor((Number(t.at) || Date.now()) / 1000);
      // Keep chronological uniqueness for LWC without collapsing same-second fills.
      if (time <= lastTime) time = lastTime + 1;
      lastTime = time;
      candles.push({
        time,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        pl,
        won: t.won === true || pl >= 0,
        side: t.side,
        kind: t.kind,
        at: Number(t.at) || time * 1000,
      });
    }
    // Optional live candle for open mark P/L.
    if (demo.position) {
      const mark = markOpenPosition(demo.position);
      if (mark && Number.isFinite(mark.unrealized)) {
        const open = Math.round(equity * 100) / 100;
        const close = Math.round((equity + mark.unrealized) * 100) / 100;
        let time = Math.floor(Date.now() / 1000);
        if (time <= lastTime) time = lastTime + 1;
        candles.push({
          time,
          open,
          high: Math.max(open, close),
          low: Math.min(open, close),
          close,
          pl: mark.unrealized,
          won: mark.unrealized >= 0,
          side: demo.position.side,
          kind: "open",
          at: Date.now(),
        });
      }
    }
    return {
      candles,
      start,
      equity,
      closedCount: closed.length,
      daySpan: plHistoryDaySpan(closed),
    };
  }

  function formatPlTickMark(time, tickMarkType) {
    const ts =
      typeof time === "number"
        ? time
        : time && typeof time === "object" && Number.isFinite(Number(time.timestamp))
          ? Number(time.timestamp)
          : NaN;
    if (!Number.isFinite(ts)) return "";
    const d = new Date(ts * 1000);
    // TickMarkType: Year=0, Month=1, DayOfMonth=2, Time=3, TimeWithSeconds=4
    if (tickMarkType === 0) {
      return d.toLocaleString("en-US", {
        timeZone: APP_TZ,
        year: "numeric",
      });
    }
    if (tickMarkType === 1) {
      return d.toLocaleString("en-US", {
        timeZone: APP_TZ,
        month: "short",
      });
    }
    if (tickMarkType <= 2) {
      return d.toLocaleString("en-US", {
        timeZone: APP_TZ,
        month: "short",
        day: "numeric",
      });
    }
    return d.toLocaleString("en-US", {
      timeZone: APP_TZ,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatPlCrosshairTime(time) {
    return formatPlTickMark(time, 3);
  }

  function isPlChartVisible() {
    return !!(optionsOpen && plUi && plUi.optionsOpen);
  }

  function applyPlChartHeight() {
    if (!el.plChart) return;
    const h = plUi.height || 180;
    el.plChart.style.height = `${h}px`;
  }

  function capturePlVisibleRange() {
    if (!plChart || plRestoringRange) return;
    try {
      const range = plChart.timeScale().getVisibleLogicalRange();
      if (
        range &&
        Number.isFinite(range.from) &&
        Number.isFinite(range.to) &&
        range.to > range.from
      ) {
        plUi.range = { from: range.from, to: range.to };
        if (plRangeSaveTimer) clearTimeout(plRangeSaveTimer);
        plRangeSaveTimer = setTimeout(() => savePlUi(), 200);
      }
    } catch {
      // ignore
    }
  }

  function restorePlVisibleRange(barCount) {
    if (!plChart) return false;
    const saved = plUi.range;
    if (
      !saved ||
      !Number.isFinite(saved.from) ||
      !Number.isFinite(saved.to) ||
      saved.to <= saved.from
    ) {
      return false;
    }
    // Keep the user's zoom place, including zoomed-out full-history views.
    // Only require some overlap with current bars so an empty window never sticks.
    const maxTo = Math.max(barCount - 0.5, 0.5);
    let from = saved.from;
    let to = saved.to;
    if (to < -0.5 || from > maxTo + 0.5) {
      return false;
    }
    // If history shrank a lot, nudge the window so it still covers data.
    if (to - from < 1) {
      to = from + 1;
    }
    plRestoringRange = true;
    try {
      plChart.timeScale().setVisibleLogicalRange({ from, to });
      plChartFitted = true;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        plRestoringRange = false;
      }, 50);
    }
  }

  function fitPlChartFull(barCount) {
    if (!plChart) return;
    try {
      plChart.timeScale().fitContent();
      plChart.timeScale().setVisibleLogicalRange({
        from: -0.5,
        to: Math.max(barCount - 0.5, 0.5),
      });
      plChartFitted = true;
      capturePlVisibleRange();
    } catch {
      try {
        plChart.timeScale().fitContent();
        plChartFitted = true;
      } catch {
        // ignore
      }
    }
  }

  /** First paint: recent trades so left/right pan has room (Fit all for everything). */
  function fitPlChartRecent(barCount) {
    if (!plChart) return;
    const n = Math.max(1, barCount);
    const visible = Math.min(16, Math.max(6, n));
    const to = n - 0.5;
    const from = Math.max(-0.5, to - visible);
    plRestoringRange = true;
    try {
      plChart.timeScale().setVisibleLogicalRange({ from, to });
      plChartFitted = true;
      plUi.range = { from, to };
      savePlUi();
    } catch {
      fitPlChartFull(barCount);
    } finally {
      setTimeout(() => {
        plRestoringRange = false;
      }, 50);
    }
  }

  /** Shift the visible trade window left (older) or right (newer). */
  function nudgePlPan(direction) {
    if (!plChart || !isPlChartVisible()) return;
    let range = null;
    try {
      range = plChart.timeScale().getVisibleLogicalRange();
    } catch {
      range = null;
    }
    const barCount = Math.max(1, plLastBarCount);
    if (
      !range ||
      !Number.isFinite(range.from) ||
      !Number.isFinite(range.to) ||
      range.to <= range.from
    ) {
      return;
    }
    const span = range.to - range.from;
    // If fully fit, zoom in a bit first so a pan actually moves.
    if (span >= barCount - 0.5) {
      nudgePlZoom(0.55);
      try {
        range = plChart.timeScale().getVisibleLogicalRange();
      } catch {
        return;
      }
      if (!range) return;
    }
    const shift = (range.to - range.from) * 0.85 * (direction < 0 ? -1 : 1);
    const next = {
      from: range.from + shift,
      to: range.to + shift,
    };
    plRestoringRange = true;
    try {
      plChart.timeScale().setVisibleLogicalRange(next);
      plUi.range = { from: next.from, to: next.to };
      savePlUi();
    } catch {
      // ignore
    } finally {
      setTimeout(() => {
        plRestoringRange = false;
      }, 50);
    }
  }

  function applyPlUi() {
    if (el.plChartSection) {
      el.plChartSection.classList.toggle("is-open", !!plUi.optionsOpen);
    }
    if (el.plChartToggle) {
      el.plChartToggle.setAttribute(
        "aria-expanded",
        plUi.optionsOpen ? "true" : "false"
      );
    }
    if (el.plChartBody) {
      el.plChartBody.hidden = !plUi.optionsOpen;
    }
    applyPlChartHeight();
    updatePlToggleMeta();
    if (isPlChartVisible()) {
      requestAnimationFrame(() => {
        resizePlChart();
        renderPlChart();
      });
    }
  }

  function setPlOptionsOpen(open) {
    // Save zoom place before collapsing so expand restores it.
    if (!open) capturePlVisibleRange();
    // Re-open always on the full trade history; pinch afterward.
    if (open) plUi.range = null;
    plUi.optionsOpen = !!open;
    savePlUi();
    applyPlUi();
    document.body.classList.remove("summary-collapsed");
    try {
      localStorage.removeItem("beatlineSummaryCollapsed");
    } catch {}
  }

  function nudgePlChartHeight(delta) {
    const next = Math.round(
      Math.min(420, Math.max(120, (plUi.height || 180) + delta))
    );
    if (next === plUi.height) return;
    plUi.height = next;
    savePlUi();
    applyPlChartHeight();
    requestAnimationFrame(() => {
      resizePlChart();
      // Keep the same logical window after a height change.
      if (plLastBarCount > 0) restorePlVisibleRange(plLastBarCount);
    });
  }

  /** Zoom the trade-history time window in (narrower) or out (wider). */
  function nudgePlZoom(factor) {
    if (!plChart || !isPlChartVisible()) return;
    let range = null;
    try {
      range = plChart.timeScale().getVisibleLogicalRange();
    } catch {
      range = null;
    }
    const barCount = Math.max(1, plLastBarCount);
    if (
      !range ||
      !Number.isFinite(range.from) ||
      !Number.isFinite(range.to) ||
      range.to <= range.from
    ) {
      range = { from: -0.5, to: Math.max(barCount - 0.5, 0.5) };
    }
    const mid = (range.from + range.to) / 2;
    let half = ((range.to - range.from) / 2) * factor;
    // Keep a usable window: at least ~3 bars; allow wide full-history zoom-out.
    half = Math.max(1.5, Math.min(half, Math.max(barCount, 8)));
    const next = {
      from: mid - half,
      to: mid + half,
    };
    plRestoringRange = true;
    try {
      plChart.timeScale().setVisibleLogicalRange(next);
      plUi.range = { from: next.from, to: next.to };
      savePlUi();
    } catch {
      // ignore
    } finally {
      setTimeout(() => {
        plRestoringRange = false;
      }, 50);
    }
  }

  function clearPlInspect() {
    plInspecting = false;
    if (el.plCrosshair) el.plCrosshair.hidden = true;
    if (el.plChartReadout) el.plChartReadout.hidden = true;
    try {
      if (plChart) plChart.clearCrosshairPosition();
    } catch {
      // ignore
    }
  }

  function nearestPlCandle(timeSec) {
    const candles = plCandlesCache || [];
    if (!candles.length || !Number.isFinite(timeSec)) return null;
    let best = candles[0];
    let bestDist = Math.abs(best.time - timeSec);
    for (let i = 1; i < candles.length; i++) {
      const d = Math.abs(candles[i].time - timeSec);
      if (d < bestDist) {
        best = candles[i];
        bestDist = d;
      }
    }
    return best;
  }

  function updatePlInspectAtClient(clientX, clientY) {
    if (!plChart || !el.plChart || !plSeries) return null;
    const rect = el.plChart.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    let time = null;
    try {
      time = plChart.timeScale().coordinateToTime(x);
    } catch {
      time = null;
    }

    const timeSec =
      typeof time === "number"
        ? time
        : time && Number.isFinite(Number(time.timestamp))
          ? Number(time.timestamp)
          : NaN;
    const candle = nearestPlCandle(timeSec);
    if (!candle) return null;

    // Snap both axes to the trade candle so only one clean crosshair shows.
    let lineX = x;
    let lineY = y;
    try {
      const cx = plChart.timeScale().timeToCoordinate(candle.time);
      if (cx != null && Number.isFinite(cx)) lineX = cx;
    } catch {
      // keep finger x
    }
    try {
      const cy = plSeries.priceToCoordinate(candle.close);
      if (cy != null && Number.isFinite(cy)) lineY = cy;
    } catch {
      // keep finger y
    }

    const pl = Number(candle.pl);
    const hasPl = Number.isFinite(pl);
    const plLabel = hasPl
      ? `${pl >= 0 ? "Gain" : "Loss"} ${formatPl(pl)}`
      : money(candle.close);
    const dateLabel = formatPlCrosshairTime(candle.time);

    if (el.plCrosshair) {
      el.plCrosshair.hidden = false;
      el.plCrosshair.style.setProperty("--pl-x", `${Math.round(lineX)}px`);
      el.plCrosshair.style.setProperty("--pl-y", `${Math.round(lineY)}px`);
      el.plCrosshair.classList.toggle("is-up", !!candle.won);
      el.plCrosshair.classList.toggle("is-down", !candle.won);
    }
    if (el.plCrosshairDate) {
      el.plCrosshairDate.textContent = dateLabel;
    }
    if (el.plCrosshairPrice) {
      // Little label on the trade: gain or loss first.
      el.plCrosshairPrice.textContent = hasPl
        ? plLabel
        : Number.isFinite(candle.open)
          ? `Balance ${money(candle.open)}`
          : "—";
      el.plCrosshairPrice.classList.toggle("is-up", !!candle.won);
      el.plCrosshairPrice.classList.toggle("is-down", !candle.won);
    }
    // White box: total account after this candle (prev balance + gain/loss).
    const balBefore = Number(candle.open);
    const balAfter = Number(candle.close);
    const mergeNote =
      Number.isFinite(balBefore) && hasPl
        ? `(${money(balBefore)} ${pl >= 0 ? "+" : "−"} ${money(
            Math.abs(pl)
          )})`
        : Number.isFinite(balBefore)
          ? `(from ${money(balBefore)})`
          : "(account at the time)";
    if (el.plCrosshairBalance) {
      el.plCrosshairBalance.hidden = !Number.isFinite(balAfter);
    }
    if (el.plCrosshairBalanceAmt && Number.isFinite(balAfter)) {
      el.plCrosshairBalanceAmt.textContent = money(balAfter);
    }
    if (el.plCrosshairBalanceNote) {
      el.plCrosshairBalanceNote.textContent = mergeNote;
    }

    if (el.plChartReadout) {
      el.plChartReadout.hidden = false;
      const sideBit = candle.side
        ? ` · ${candle.side === "above" ? "Above" : "Below"}`
        : "";
      const kindBit =
        candle.kind === "open"
          ? " · open mark"
          : candle.kind
            ? ` · ${candle.kind}`
            : "";
      if (el.plChartReadoutMain) {
        el.plChartReadoutMain.textContent = `${dateLabel} · ${plLabel}${sideBit}${kindBit}`;
      } else {
        el.plChartReadout.textContent = `${dateLabel} · ${plLabel}${sideBit}${kindBit}`;
      }
      if (el.plChartReadoutBalance) {
        el.plChartReadoutBalance.hidden = !Number.isFinite(balAfter);
      }
      if (el.plChartReadoutBalanceAmt && Number.isFinite(balAfter)) {
        el.plChartReadoutBalanceAmt.textContent = money(balAfter);
      }
      if (el.plChartReadoutBalanceNote) {
        el.plChartReadoutBalanceNote.textContent = mergeNote;
      }
      el.plChartReadout.classList.toggle("is-up", !!candle.won);
      el.plChartReadout.classList.toggle("is-down", !candle.won);
    }

    // Do NOT also drive Lightweight Charts' built-in crosshair — that stacked
    // a second set of lines on top of our overlay.
    return candle;
  }

  /**
   * Simple P/L chart gestures (chart box size stays fixed):
   * - one finger drag = pan left/right
   * - pinch = gentle time zoom
   * - tap = toggle inspect crosshair
   * - drag on right price numbers = zoom candles vertically (Y scale only)
   */
  function wirePlChartTouchGuards() {
    if (!el.plChart || el.plChart.dataset.touchGuarded === "1") return;
    el.plChart.dataset.touchGuarded = "1";
    const PRICE_AXIS_PX = 58;
    const MOVE_PX = 8;
    const TAP_MS = 320;
    const INSPECT_HOLD_MS = 420;

    let pinchStartDist = null;
    let pinchStartRange = null;
    let pinchMoved = false;
    let panStartX = null;
    let panStartRange = null;
    let panMoved = false;
    let axisMode = false;
    let axisStartY = null;
    let axisStartMargin = null;
    let axisMoved = false;
    let pressStartX = null;
    let pressStartY = null;
    let pressStartedAt = 0;
    let inspectHoldTimer = null;
    let inspectMode = false;
    let inspectAlreadyOn = false;
    let activatedInspect = false;

    const crosshairVisible = () =>
      !!(el.plCrosshair && !el.plCrosshair.hidden);

    const touchDist = (a, b) => {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.hypot(dx, dy);
    };

    const readRange = () => {
      try {
        return plChart && plChart.timeScale().getVisibleLogicalRange();
      } catch {
        return null;
      }
    };

    const applyRange = (from, to) => {
      if (!plChart || !Number.isFinite(from) || !Number.isFinite(to) || to <= from)
        return;
      // Block the range-change subscriber while we set it; endGesture saves.
      plRestoringRange = true;
      try {
        plChart.timeScale().setVisibleLogicalRange({ from, to });
      } catch {
        // ignore
      }
    };

    const commitVisibleRange = () => {
      plRestoringRange = false;
      capturePlVisibleRange();
    };

    const applyYMargin = (margin) => {
      if (!plChart) return;
      plYMargin = Math.min(0.42, Math.max(0.02, margin));
      try {
        const ps = plChart.priceScale("right");
        if (ps) {
          ps.applyOptions({
            autoScale: true,
            scaleMargins: { top: plYMargin, bottom: plYMargin },
          });
        }
      } catch {
        // ignore
      }
    };

    const clearInspectHold = () => {
      if (inspectHoldTimer) {
        clearTimeout(inspectHoldTimer);
        inspectHoldTimer = null;
      }
    };

    const beginInspectAt = (x, y) => {
      activatedInspect = true;
      inspectMode = true;
      plInspecting = true;
      panStartX = null;
      panStartRange = null;
      panMoved = false;
      try {
        if (navigator.vibrate) navigator.vibrate(8);
      } catch {
        // ignore
      }
      updatePlInspectAtClient(x, y);
    };

    const inPriceAxis = (clientX) => {
      const rect = el.plChart.getBoundingClientRect();
      return clientX - rect.left >= rect.width - PRICE_AXIS_PX;
    };

    const opts = { passive: false, capture: true };

    el.plChart.addEventListener(
      "touchstart",
      (ev) => {
        if (ev.touches && ev.touches.length >= 2) {
          ev.preventDefault();
          ev.stopPropagation();
          clearInspectHold();
          inspectMode = false;
          activatedInspect = false;
          axisMode = false;
          clearPlInspect();
          panStartX = null;
          panStartRange = null;
          panMoved = false;
          pinchStartDist = touchDist(ev.touches[0], ev.touches[1]);
          pinchStartRange = readRange();
          pinchMoved = false;
          return;
        }

        pinchStartDist = null;
        pinchStartRange = null;
        if (!(ev.touches && ev.touches.length === 1)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const t = ev.touches[0];
        pressStartX = t.clientX;
        pressStartY = t.clientY;
        pressStartedAt = Date.now();
        inspectAlreadyOn = crosshairVisible() || plInspecting;
        activatedInspect = false;
        inspectMode = false;
        panMoved = false;
        axisMoved = false;
        clearInspectHold();

        if (inPriceAxis(t.clientX)) {
          // Right-side price labels: vertical drag zooms candles, not chart size.
          axisMode = true;
          axisStartY = t.clientY;
          axisStartMargin = plYMargin;
          panStartX = null;
          panStartRange = null;
          return;
        }

        axisMode = false;
        axisStartMargin = null;
        panStartX = t.clientX;
        panStartRange = readRange();
        inspectHoldTimer = setTimeout(() => {
          inspectHoldTimer = null;
          if (!panMoved && !axisMoved) {
            beginInspectAt(pressStartX, pressStartY);
          }
        }, INSPECT_HOLD_MS);
      },
      opts
    );

    el.plChart.addEventListener(
      "touchmove",
      (ev) => {
        if (ev.touches && ev.touches.length >= 2) {
          ev.preventDefault();
          ev.stopPropagation();
          clearInspectHold();
          inspectMode = false;
          if (
            !plChart ||
            pinchStartDist == null ||
            pinchStartDist < 8 ||
            !pinchStartRange
          ) {
            return;
          }
          const d = touchDist(ev.touches[0], ev.touches[1]);
          if (d < 8) return;
          const raw = pinchStartDist / d;
          const factor = Math.pow(raw, 1.25);
          const mid = (pinchStartRange.from + pinchStartRange.to) / 2;
          const barCount = Math.max(1, plLastBarCount);
          let half =
            ((pinchStartRange.to - pinchStartRange.from) / 2) * factor;
          // Allow zooming out past full history so the whole ledger can hold.
          half = Math.max(2, Math.min(half, Math.max(barCount, 8)));
          pinchMoved = true;
          applyRange(mid - half, mid + half);
          return;
        }

        if (!(ev.touches && ev.touches.length === 1)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const t = ev.touches[0];

        if (axisMode && axisStartY != null && axisStartMargin != null) {
          const dy = t.clientY - axisStartY;
          if (Math.abs(dy) >= MOVE_PX) {
            axisMoved = true;
            clearInspectHold();
            clearPlInspect();
          }
          const h = Math.max(1, el.plChart.clientHeight || 180);
          // Drag up → smaller margins → candles expand. Drag down → contract.
          // Chart box / perimeter stays the same.
          applyYMargin(axisStartMargin + (dy / h) * 0.4);
          return;
        }

        if (inspectMode || activatedInspect) {
          updatePlInspectAtClient(t.clientX, t.clientY);
          return;
        }

        const movedFromStart =
          pressStartX != null
            ? Math.hypot(t.clientX - pressStartX, t.clientY - pressStartY)
            : 0;
        if (movedFromStart >= MOVE_PX) {
          clearInspectHold();
        } else {
          return;
        }

        if (panStartX == null || !panStartRange || !plChart) return;
        const dx = t.clientX - panStartX;
        if (Math.abs(dx) < 1) return;
        panMoved = true;
        clearPlInspect();
        const width = Math.max(
          1,
          (el.plChart.clientWidth || 1) - PRICE_AXIS_PX
        );
        const span = panStartRange.to - panStartRange.from;
        const shift = -(dx / width) * span;
        applyRange(panStartRange.from + shift, panStartRange.to + shift);
      },
      opts
    );

    const endGesture = () => {
      clearInspectHold();
      const wasPan = panMoved;
      const wasPinch = pinchMoved;
      const wasAxis = axisMode;
      const heldMs = pressStartedAt ? Date.now() - pressStartedAt : 0;
      const tapX = pressStartX;
      const tapY = pressStartY;
      const quickTap =
        !wasPan &&
        !wasPinch &&
        !wasAxis &&
        !activatedInspect &&
        heldMs > 0 &&
        heldMs < TAP_MS;
      const hadInspect = inspectAlreadyOn;

      pinchStartDist = null;
      pinchStartRange = null;
      pinchMoved = false;
      panStartX = null;
      panStartRange = null;
      panMoved = false;
      axisMode = false;
      axisStartY = null;
      axisStartMargin = null;
      axisMoved = false;
      pressStartX = null;
      pressStartY = null;
      pressStartedAt = 0;
      inspectMode = false;

      if (wasPan || wasPinch) {
        // Persist zoom/pan — do not snap back to the previous window.
        commitVisibleRange();
        clearPlInspect();
      } else if (wasAxis) {
        clearPlInspect();
      } else if (quickTap && hadInspect) {
        clearPlInspect();
      } else if (quickTap && !hadInspect && tapX != null && tapY != null) {
        beginInspectAt(tapX, tapY);
        plInspecting = true;
      } else if (activatedInspect) {
        plInspecting = true;
      }
      activatedInspect = false;
      inspectAlreadyOn = false;
    };
    el.plChart.addEventListener("touchend", endGesture, opts);
    el.plChart.addEventListener("touchcancel", endGesture, opts);

    el.plChart.addEventListener("mousemove", (ev) => {
      if (ev.buttons) {
        clearPlInspect();
        return;
      }
      if (!plInspecting && !crosshairVisible()) return;
      updatePlInspectAtClient(ev.clientX, ev.clientY);
    });
    el.plChart.addEventListener("mouseleave", () => {
      if (!plInspecting) clearPlInspect();
    });
    el.plChart.addEventListener("click", (ev) => {
      // Price-axis clicks are for vertical candle zoom via drag — ignore tap.
      if (inPriceAxis(ev.clientX)) return;
      if (crosshairVisible() || plInspecting) {
        ev.preventDefault();
        clearPlInspect();
        return;
      }
      updatePlInspectAtClient(ev.clientX, ev.clientY);
      plInspecting = true;
    });
    el.plChart.addEventListener("dblclick", (ev) => {
      if (!inPriceAxis(ev.clientX) || !plChart) return;
      applyYMargin(0.12);
    });
  }

  function applyTradeHistoryUi() {
    const open = !!tradeHistoryUi.open;
    if (el.tradeHistorySection) {
      el.tradeHistorySection.classList.toggle("is-open", open);
    }
    if (el.tradeHistoryToggle) {
      el.tradeHistoryToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (el.tradeHistoryBody) {
      el.tradeHistoryBody.hidden = !open;
    }
  }

  function setTradeHistoryOpen(open) {
    tradeHistoryUi.open = !!open;
    saveTradeHistoryUi();
    applyTradeHistoryUi();
    if (tradeHistoryUi.open) renderTradeHistory();
  }

  function formatWinLossRatio(wins, losses) {
    const w = Math.max(0, Math.floor(Number(wins) || 0));
    const l = Math.max(0, Math.floor(Number(losses) || 0));
    if (l === 0) return w > 0 ? "∞" : "—";
    const r = w / l;
    if (r >= 100) return r.toFixed(0);
    if (r >= 10) return r.toFixed(1);
    return (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, ".0");
  }

  function formatWinLossRecord(wins, losses) {
    const w = Math.max(0, Math.floor(Number(wins) || 0));
    const l = Math.max(0, Math.floor(Number(losses) || 0));
    return `${w}W-${l}L (${formatWinLossRatio(w, l)})`;
  }

  function updatePlToggleMeta() {
    if (!el.plChartToggleMeta) return;
    const closed = closedPlTrades();
    const wins = closed.filter((t) => t.won === true || Number(t.pl) >= 0).length;
    const losses = Math.max(0, closed.length - wins);
    const openBit = plUi.optionsOpen ? "Expanded" : "Collapsed";
    if (!closed.length) {
      el.plChartToggleMeta.textContent = `${openBit} · all-time trade log`;
      return;
    }
    const span = plHistoryDaySpan(closed);
    el.plChartToggleMeta.textContent = `${openBit} · ${closed.length} closed${
      span ? ` · ${span}` : ""
    } · ${formatWinLossRecord(wins, losses)}`;
  }

  function ensurePlChart() {
    if (plChart || !el.plChart || !window.LightweightCharts) return;
    const { createChart, CrosshairMode } = window.LightweightCharts;
    applyPlChartHeight();
    wirePlChartTouchGuards();
    plChart = createChart(el.plChart, {
      layout: {
        background: { color: "#0d1612" },
        textColor: "#8fa399",
        fontFamily: "IBM Plex Sans, Segoe UI, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      // Built-in crosshair off — custom overlay owns the single dotted pair.
      crosshair: {
        mode: (CrosshairMode && CrosshairMode.Hidden) || 2,
        vertLine: { visible: false, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        scaleMargins: { top: plYMargin, bottom: plYMargin },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 8,
        minBarSpacing: 0.1,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: formatPlTickMark,
      },
      localization: {
        timeFormatter: formatPlCrosshairTime,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: false,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: false,
      },
      width: el.plChart.clientWidth || 300,
      height: el.plChart.clientHeight || plUi.height || 180,
    });
    plSeries = plChart.addCandlestickSeries({
      upColor: "#1ac96b",
      downColor: "#d45454",
      borderVisible: false,
      wickUpColor: "#1ac96b",
      wickDownColor: "#d45454",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    try {
      plChart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        capturePlVisibleRange();
        updatePlDayLines();
      });
    } catch {
      // ignore
    }
  }

  /** Candle timestamp in ms. */
  function plCandleAtMs(c) {
    if (!c) return NaN;
    const at = Number(c.at);
    if (Number.isFinite(at) && at > 0) return at;
    const t = Number(c.time);
    return Number.isFinite(t) ? t * 1000 : NaN;
  }

  /**
   * Screen X for each Pacific midnight between trades.
   * Prefer exact midnight; fall back to midpoint between day-change candles.
   */
  function plDayLineXs() {
    const candles = plCandlesCache || [];
    if (!plChart || candles.length < 2) return [];
    const xs = [];
    let prevKey = appDateKey(plCandleAtMs(candles[0]));
    for (let i = 1; i < candles.length; i++) {
      const ms = plCandleAtMs(candles[i]);
      const key = appDateKey(ms);
      if (!key || key === prevKey) continue;
      prevKey = key;
      let x = null;
      // Exact Pacific midnight for this candle's calendar day.
      try {
        const midSec = Math.floor(startOfAppDayMs(ms) / 1000);
        x = plTimeToCoordinate(midSec);
      } catch {
        x = null;
      }
      // Fallback: halfway between the last prior-day bar and this bar.
      if (x == null || !Number.isFinite(x)) {
        try {
          const xa = plChart.timeScale().timeToCoordinate(candles[i - 1].time);
          const xb = plChart.timeScale().timeToCoordinate(candles[i].time);
          if (
            xa != null &&
            xb != null &&
            Number.isFinite(xa) &&
            Number.isFinite(xb)
          ) {
            x = (xa + xb) / 2;
          }
        } catch {
          x = null;
        }
      }
      if (x != null && Number.isFinite(x)) xs.push(x);
    }
    return xs;
  }

  /** Map a unix-sec time onto chart X, interpolating between neighboring bars. */
  function plTimeToCoordinate(timeSec) {
    if (!plChart || !Number.isFinite(timeSec)) return null;
    try {
      const x = plChart.timeScale().timeToCoordinate(timeSec);
      if (x != null && Number.isFinite(x)) return x;
    } catch {
      // fall through to manual interpolate
    }
    const candles = plCandlesCache || [];
    if (candles.length < 2) return null;
    if (timeSec <= candles[0].time) {
      try {
        return plChart.timeScale().timeToCoordinate(candles[0].time);
      } catch {
        return null;
      }
    }
    const last = candles[candles.length - 1];
    if (timeSec >= last.time) {
      try {
        return plChart.timeScale().timeToCoordinate(last.time);
      } catch {
        return null;
      }
    }
    for (let i = 1; i < candles.length; i++) {
      const a = candles[i - 1];
      const b = candles[i];
      if (b.time < timeSec) continue;
      if (b.time === a.time) {
        try {
          return plChart.timeScale().timeToCoordinate(a.time);
        } catch {
          return null;
        }
      }
      let xa = null;
      let xb = null;
      try {
        xa = plChart.timeScale().timeToCoordinate(a.time);
        xb = plChart.timeScale().timeToCoordinate(b.time);
      } catch {
        return null;
      }
      if (xa == null || xb == null || !Number.isFinite(xa) || !Number.isFinite(xb)) {
        return null;
      }
      const t = (timeSec - a.time) / (b.time - a.time);
      return xa + (xb - xa) * t;
    }
    return null;
  }

  function clearPlDayLines() {
    if (!el.plDayLines) return;
    el.plDayLines.innerHTML = "";
    el.plDayLines.hidden = true;
  }

  function updatePlDayLines() {
    if (!el.plDayLines) return;
    const on = plUi.dayLines !== false;
    if (el.plDayLinesCheck && el.plDayLinesCheck.checked !== on) {
      el.plDayLinesCheck.checked = on;
    }
    if (
      !on ||
      !plChart ||
      !isPlChartVisible() ||
      !plCandlesCache ||
      plCandlesCache.length < 2
    ) {
      clearPlDayLines();
      return;
    }
    const xs = plDayLineXs();
    if (!xs.length) {
      clearPlDayLines();
      return;
    }
    const chartW = el.plChart ? el.plChart.clientWidth || 0 : 0;
    // Keep lines off the right price axis gutter (~56–64px in LWC).
    const maxX = Math.max(0, chartW - 56);
    const frag = document.createDocumentFragment();
    let drawn = 0;
    for (const x of xs) {
      if (x == null || !Number.isFinite(x)) continue;
      if (x < 2 || x > maxX) continue;
      const line = document.createElement("div");
      line.className = "pl-day-line";
      line.style.left = `${x}px`;
      line.title = "Pacific midnight";
      frag.appendChild(line);
      drawn += 1;
    }
    el.plDayLines.innerHTML = "";
    if (!drawn) {
      el.plDayLines.hidden = true;
      return;
    }
    el.plDayLines.appendChild(frag);
    el.plDayLines.hidden = false;
  }

  function syncPlDayLinesToggle() {
    if (!el.plDayLinesCheck) return;
    el.plDayLinesCheck.checked = plUi.dayLines !== false;
  }

  function resizePlChart() {
    if (!plChart || !el.plChart || !isPlChartVisible()) return;
    applyPlChartHeight();
    const w = el.plChart.clientWidth;
    const h = el.plChart.clientHeight || plUi.height || 180;
    if (w > 0) plChart.applyOptions({ width: w, height: h });
    updatePlDayLines();
  }

  function renderPlChart() {
    if (!el.plChart) return;
    updatePlToggleMeta();
    if (!isPlChartVisible()) return;

    const { candles, start, closedCount, daySpan } = buildPlCandles();
    plCandlesCache = candles;
    const hasBars = candles.length > 0;

    if (el.plChartEmpty) el.plChartEmpty.hidden = hasBars;
    el.plChart.hidden = !hasBars;
    if (el.plChartCaption) {
      if (!hasBars) {
        el.plChartCaption.textContent =
          "All-time closed trades as equity candles · dates on bottom";
      } else {
        const wins = candles.filter((c) => c.kind !== "open" && c.won).length;
        const losses = Math.max(0, closedCount - wins);
        const last = candles[candles.length - 1];
        const net = Math.round((last.close - start) * 100) / 100;
        const spanBit = daySpan ? ` · ${daySpan}` : "";
        el.plChartCaption.textContent = `All-time · ${closedCount} closed · ${formatWinLossRecord(
          wins,
          losses
        )} · equity ${money(last.close)} (${formatPl(net)})${spanBit}`;
      }
    }

    if (!hasBars) {
      if (plSeries) {
        try {
          plSeries.setData([]);
        } catch {
          // ignore
        }
      }
      plLastBarCount = 0;
      clearPlDayLines();
      return;
    }

    ensurePlChart();
    if (!plSeries || !plChart) return;
    wirePlChartTouchGuards();
    resizePlChart();
    // Keep spacing stable when restoring a saved zoom place.
    const spacing = Math.max(
      2,
      Math.min(14, Math.floor(280 / Math.max(8, candles.length)))
    );
    try {
      // Low minBarSpacing so zooming out to the full ledger can hold.
      const scaleOpts = { minBarSpacing: 0.1, rightOffset: 4 };
      if (!plUi.range) scaleOpts.barSpacing = spacing;
      plChart.timeScale().applyOptions(scaleOpts);
    } catch {
      // ignore
    }
    plSeries.setData(
      candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    const barCount = candles.length;
    const grew = barCount > plLastBarCount;
    plLastBarCount = barCount;
    // Open on the full trade history; pinch/slide can zoom afterward.
    // Keep an in-session place only after the user has pinched/panned.
    const restored = restorePlVisibleRange(barCount);
    if (!restored) {
      fitPlChartFull(barCount);
    } else if (grew && plUi.range && plUi.range.to >= barCount - 2.5) {
      // If they were parked near the live edge, keep them at the new tip.
      try {
        plChart.timeScale().scrollToRealTime();
        capturePlVisibleRange();
      } catch {
        // ignore
      }
    }
    // After fit/restore so coordinates match the visible range.
    requestAnimationFrame(() => updatePlDayLines());
  }

  function renderTradeHistory() {
    demo.history = mergeTradeHistory(
      Array.isArray(demo.history) ? demo.history : [],
      loadTradeHistory()
    );
    const list = demo.history;
    const open = demo.position;
    const openMark = open ? markOpenPosition(open) : null;

    if (el.tradeHistorySummary) {
      if (!list.length && !open) {
        el.tradeHistorySummary.textContent = "No trades yet";
        el.tradeHistorySummary.classList.remove("is-up", "is-down");
      } else {
        const closedRows = list.filter(
          (t) =>
            (t.kind === "close" || t.kind === "settle") &&
            Number.isFinite(Number(t.pl))
        );
        const wins = closedRows.filter(
          (t) => t.won === true || Number(t.pl) >= 0
        ).length;
        const closed = closedRows.length;
        const totalPl = closedRows.reduce(
          (sum, t) => sum + (Number.isFinite(Number(t.pl)) ? Number(t.pl) : 0),
          0
        );
        const span = plHistoryDaySpan(
          closedRows
            .slice()
            .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
        );
        const openBit = open
          ? ` · open ${open.side === "above" ? "Above" : "Below"}`
          : "";
        const spanBit = span ? ` · ${span}` : "";
        el.tradeHistorySummary.textContent = closed
          ? `All-time · ${closed} closed · ${wins}W-${closed - wins}L · ${formatPl(
              totalPl
            )}${spanBit}${openBit}`
          : open
            ? `Open ${open.side === "above" ? "Above" : "Below"} · ${
                open.contracts
              } cts`
            : "All-time log";
        el.tradeHistorySummary.classList.toggle("is-up", totalPl > 0);
        el.tradeHistorySummary.classList.toggle("is-down", totalPl < 0);
      }
    }
    if (!el.tradeHistoryList) return;

    const rows = [];
    if (open) {
      const side = open.side === "above" ? "Above" : "Below";
      const pl = openMark && openMark.unrealized;
      const plClass =
        pl == null ? "" : pl >= 0 ? "is-win" : "is-loss";
      rows.push(
        `<article class="trade-history-item is-open ${plClass}">` +
          `<div class="trade-history-top">` +
          `<span class="trade-history-kind">OPEN ${side}</span>` +
          `<span class="trade-history-pl">${
            pl == null ? "—" : formatPl(pl)
          }</span>` +
          `</div>` +
          `<div class="trade-history-meta">${formatHistoryTime(
            open.openedAt || open.lastAddedAt || Date.now()
          )} · ${open.contracts} cts @ avg ${
            open.askCents != null ? open.askCents + "¢" : "—"
          }${open.fills > 1 ? ` · ${open.fills} fills` : ""} · paid ${money(
            open.total
          )}</div>` +
          `</article>`
      );
    }

    for (const t of list) {
      const side = t.side === "above" ? "Above" : t.side === "below" ? "Below" : "—";
      let kind = "CLOSED";
      if (t.kind === "settle") kind = t.won ? "WIN" : "LOSS";
      else if (t.kind === "buy") kind = "BOUGHT";
      else if (t.kind === "add") kind = "ADDED";
      else if (t.kind === "close") kind = "CLOSED";
      const plClass =
        t.pl == null ? "" : t.won || t.pl >= 0 ? "is-win" : "is-loss";
      const fills = t.fills > 1 ? ` · ${t.fills} fills` : "";
      const exit = t.exitCents != null ? ` @ ${t.exitCents}¢` : "";
      const mode = t.accounted ? "" : " · paper";
      const tag =
        t.followedSuggest === true
          ? " · Best Side"
          : t.followedSuggest === false
            ? " · Own call"
            : "";
      const plTxt =
        t.pl == null || !Number.isFinite(Number(t.pl))
          ? t.text || "—"
          : formatPl(Number(t.pl));
      rows.push(
        `<article class="trade-history-item ${plClass}">` +
          `<div class="trade-history-top">` +
          `<span class="trade-history-kind">${kind} ${side}${tag}</span>` +
          `<span class="trade-history-pl">${plTxt}</span>` +
          `</div>` +
          `<div class="trade-history-meta">${formatHistoryTime(t.at)} · ${
            t.contracts != null ? t.contracts : "—"
          } cts @ avg ${t.askCents != null ? t.askCents + "¢" : "—"}${fills}${exit} · paid ${
            t.total != null ? money(t.total) : "—"
          }${mode}</div>` +
          `</article>`
      );
    }

    if (!rows.length) {
      el.tradeHistoryList.innerHTML =
        '<div class="trade-history-empty">Buy, add, close, or settle — trades will list here.</div>';
      renderPlChart();
      return;
    }
    el.tradeHistoryList.innerHTML = rows.join("");
    renderPlChart();
  }

  function openOptions() {
    optionsOpen = true;
    if (el.optionsSheet) {
      el.optionsSheet.hidden = false;
      el.optionsSheet.removeAttribute("aria-hidden");
    }
    if (el.optionsBackdrop) {
      el.optionsBackdrop.hidden = false;
      el.optionsBackdrop.removeAttribute("aria-hidden");
    }
    if (el.menuBtn) el.menuBtn.setAttribute("aria-expanded", "true");
    renderDemoUi();
    renderTradeHistory();
    renderStrategyReport();
    applyTradeHistoryUi();
    syncAlertsUi();
    const resetScroll = () => {
      if (el.optionsBody) el.optionsBody.scrollTop = 0;
      if (el.optionsSheet) el.optionsSheet.scrollTop = 0;
    };
    resetScroll();
    requestAnimationFrame(() => {
      applyPlUi();
      resetScroll();
    });
  }

  function closeOptions() {
    optionsOpen = false;
    if (el.optionsSheet) {
      el.optionsSheet.hidden = true;
      el.optionsSheet.setAttribute("aria-hidden", "true");
    }
    if (el.optionsBackdrop) {
      el.optionsBackdrop.hidden = true;
      el.optionsBackdrop.setAttribute("aria-hidden", "true");
    }
    if (el.menuBtn) el.menuBtn.setAttribute("aria-expanded", "false");
  }

  function toggleOptions() {
    if (optionsOpen) closeOptions();
    else openOptions();
  }

  function renderTutorialStep() {
    const step = TUTORIAL_STEPS[tutorialIndex];
    if (!step) return;
    if (el.tutorialStepNum) el.tutorialStepNum.textContent = String(tutorialIndex + 1);
    if (el.tutorialStepTotal) el.tutorialStepTotal.textContent = String(TUTORIAL_STEPS.length);
    if (el.tutorialTitle) el.tutorialTitle.textContent = step.title;
    if (el.tutorialBody) el.tutorialBody.textContent = step.body;
    if (el.tutorialNext) {
      el.tutorialNext.textContent =
        tutorialIndex >= TUTORIAL_STEPS.length - 1 ? "Got it" : "Next";
    }
  }

  function openTutorial(fromStart) {
    closeOptions();
    dismissBuySheet();
    tutorialOpen = true;
    tutorialIndex = fromStart === false ? tutorialIndex : 0;
    if (el.tutorial) el.tutorial.hidden = false;
    if (el.tutorialBackdrop) el.tutorialBackdrop.hidden = false;
    renderTutorialStep();
  }

  function closeTutorial(markSeen) {
    tutorialOpen = false;
    if (el.tutorial) el.tutorial.hidden = true;
    if (el.tutorialBackdrop) el.tutorialBackdrop.hidden = true;
    if (markSeen) {
      try {
        localStorage.setItem(TUTORIAL_KEY, "1");
      } catch {
        // ignore
      }
    }
  }

  function nextTutorial() {
    if (tutorialIndex >= TUTORIAL_STEPS.length - 1) {
      closeTutorial(true);
      return;
    }
    tutorialIndex += 1;
    renderTutorialStep();
  }

  function getPositionBidCents(pos) {
    if (!pos) return null;
    const bid = pos.side === "above" ? lastRoiBids.above : lastRoiBids.below;
    if (bid != null && Number.isFinite(bid) && bid >= 1 && bid <= 99) {
      return Math.round(bid);
    }
    const ask = pos.side === "above" ? lastRoiAsks.above : lastRoiAsks.below;
    if (ask != null && Number.isFinite(ask) && ask >= 1 && ask <= 99) {
      return Math.round(ask);
    }
    return null;
  }

  function markOpenPosition(pos) {
    if (!pos) return null;
    const bidCents = getPositionBidCents(pos);
    const spotRaw = el.spotValue && el.spotValue.dataset.last;
    const spot = spotRaw != null ? Number(spotRaw) : null;
    const secs = secondsLeft();
    const marketAsk =
      pos.side === "above" ? lastRoiAsks.above : lastRoiAsks.below;
    const marketPct =
      pos.side === "above"
        ? lastYesPct
        : lastYesPct != null
          ? 100 - lastYesPct
          : null;
    const beat = pos.beat != null ? pos.beat : lastTarget;
    const delta =
      spot != null && Number.isFinite(spot) && beat != null && Number.isFinite(beat)
        ? spot - beat
        : null;
    const leadingSide =
      delta == null ? null : delta >= 0 ? "above" : "below";
    const settleNowWin = leadingSide != null && leadingSide === pos.side;
    const modelP =
      spot != null && beat != null ? modelProbAbove(spot, beat, secs) : null;
    const pWin =
      modelP == null ? null : pos.side === "above" ? modelP : 1 - modelP;

    const heldPlIfWin = Math.round((pos.contracts * 1 - pos.total) * 100) / 100;
    const heldPlIfLose = Math.round((0 - pos.total) * 100) / 100;
    const modelEvPl =
      pWin != null && Number.isFinite(pWin)
        ? Math.round((pWin * heldPlIfWin + (1 - pWin) * heldPlIfLose) * 100) / 100
        : null;

    if (bidCents == null) {
      return {
        bidCents: null,
        markValue: null,
        unrealized: null,
        unrealizedPct: null,
        exitFee: 0,
        proceeds: null,
        spot,
        beat,
        delta,
        secs,
        marketAsk,
        marketPct,
        settleNowWin,
        pWin,
        modelEvPl,
        heldWinPayout: pos.contracts * 1,
        heldPlIfWin,
        heldPlIfLose,
      };
    }
    const P = bidCents / 100;
    const gross = pos.contracts * P;
    const exitFee = kalshiTakerFee(pos.contracts, Math.min(0.99, Math.max(0.01, P)));
    const proceeds = Math.max(0, Math.round((gross - exitFee) * 100) / 100);
    const unrealized = Math.round((proceeds - pos.total) * 100) / 100;
    const unrealizedPct =
      pos.total > 0 ? Math.round((unrealized / pos.total) * 1000) / 10 : null;
    return {
      bidCents,
      markValue: Math.round(gross * 100) / 100,
      unrealized,
      unrealizedPct,
      exitFee,
      proceeds,
      spot,
      beat,
      delta,
      secs,
      marketAsk,
      marketPct,
      settleNowWin,
      pWin,
      modelEvPl,
      heldWinPayout: pos.contracts * 1,
      heldPlIfWin,
      heldPlIfLose,
    };
  }

  function markDemoPosition() {
    return markOpenPosition(demo.position);
  }

  function formatPl(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${money(n)}`;
  }

  function factorCell(label, value, span2) {
    return (
      `<div class="demo-live-factor${span2 ? " span2" : ""}">` +
      `<span class="fk">${label}</span>` +
      `<span class="fv">${value}</span></div>`
    );
  }

  function sessionPlBreakdown(mark) {
    const realized = Number(demo.realizedPl) || 0;
    const open =
      mark && mark.unrealized != null && Number.isFinite(mark.unrealized)
        ? mark.unrealized
        : 0;
    const total = Math.round((realized + open) * 100) / 100;
    return { realized, open, total, hasOpen: !!(demo.position && mark) };
  }

  /** Cash + open mark (what the account is worth if you closed now). */
  function accountEquityNow(mark) {
    if (!demo.on) return null;
    const cash = Number(demo.balance);
    if (!Number.isFinite(cash)) return null;
    if (mark && mark.proceeds != null && Number.isFinite(mark.proceeds)) {
      return Math.round((cash + mark.proceeds) * 100) / 100;
    }
    return Math.round(cash * 100) / 100;
  }

  function appDateKey(ms = Date.now()) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: APP_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(ms));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
      // fall through
    }
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: APP_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  /** UTC ms of Pacific local midnight for the app-day containing `ms`. */
  function startOfAppDayMs(ms = Date.now()) {
    const key = appDateKey(ms);
    let lo = ms - 48 * 3600 * 1000;
    let hi = ms + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (appDateKey(mid) < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Best-effort equity at Pacific midnight today:
   * current equity minus today's closed P/L minus open mark.
   * 15m books rarely span midnight, so this undoes a false ET 9pm rollover.
   */
  function estimateAppDayStartEquity(currentEquity) {
    if (!Number.isFinite(currentEquity)) return null;
    const since = startOfAppDayMs();
    let closedPl = 0;
    const hist = mergeTradeHistory(
      Array.isArray(demo.history) ? demo.history : [],
      loadTradeHistory()
    );
    for (const t of hist) {
      if (!t || typeof t !== "object") continue;
      if (t.kind !== "settle" && t.kind !== "close") continue;
      if (!Number.isFinite(Number(t.at)) || Number(t.at) < since) continue;
      if (Number.isFinite(Number(t.pl))) closedPl += Number(t.pl);
    }
    let openPl = 0;
    const pos = demo.position;
    if (pos) {
      const mark = markOpenPosition(pos);
      if (mark && Number.isFinite(mark.unrealized)) openPl = mark.unrealized;
    }
    const start = Math.round((currentEquity - closedPl - openPl) * 100) / 100;
    return start > 0 ? start : Math.round(currentEquity * 100) / 100;
  }

  function loadDayEquity() {
    try {
      const raw = localStorage.getItem(DAY_EQUITY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.date || !Number.isFinite(Number(parsed.equity))) {
        return null;
      }
      return {
        date: String(parsed.date),
        equity: Number(parsed.equity),
        tz: parsed.tz ? String(parsed.tz) : null,
        v: Number(parsed.v) || 1,
      };
    } catch {
      return null;
    }
  }

  function saveDayEquity(date, equity, extra = {}) {
    try {
      localStorage.setItem(
        DAY_EQUITY_KEY,
        JSON.stringify({
          date,
          equity: Math.round(Number(equity) * 100) / 100,
          tz: extra.tz || APP_TZ,
          v: extra.v != null ? extra.v : DAY_EQUITY_VERSION,
        })
      );
    } catch {
      // ignore
    }
  }

  /** Snapshot equity on first open of each Pacific calendar day. */
  function ensureDayEquity(currentEquity) {
    if (!Number.isFinite(currentEquity)) return null;
    const today = appDateKey();
    let stored = loadDayEquity();
    const isCurrentSchema =
      stored &&
      stored.tz === APP_TZ &&
      stored.v >= DAY_EQUITY_VERSION &&
      stored.date === today;

    if (isCurrentSchema) return stored;

    // Heal once from Eastern-midnight snapshots / pre-PT schema so Day %
    // tracks Pacific midnight — not 9pm PT (Eastern midnight).
    if (!stored || stored.tz !== APP_TZ || stored.v < DAY_EQUITY_VERSION) {
      const start = estimateAppDayStartEquity(currentEquity);
      stored = {
        date: today,
        equity: start,
        tz: APP_TZ,
        v: DAY_EQUITY_VERSION,
      };
      saveDayEquity(stored.date, stored.equity, { tz: stored.tz, v: stored.v });
      return stored;
    }

    // True Pacific date rollover after midnight.
    if (stored.date !== today) {
      stored = {
        date: today,
        equity: Math.round(currentEquity * 100) / 100,
        tz: APP_TZ,
        v: DAY_EQUITY_VERSION,
      };
      saveDayEquity(stored.date, stored.equity, { tz: stored.tz, v: stored.v });
    }
    return stored;
  }

  function dayChangePct(currentEquity) {
    const stored = ensureDayEquity(currentEquity);
    if (!stored || !(stored.equity > 0) || !Number.isFinite(currentEquity)) {
      return null;
    }
    return {
      pct: Math.round(((currentEquity - stored.equity) / stored.equity) * 1000) / 10,
      start: stored.equity,
      now: currentEquity,
      date: stored.date,
    };
  }

  function formatDayPct(pct) {
    if (pct == null || !Number.isFinite(pct)) return "—";
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(1)}%`;
  }

  function loadSuggestLog() {
    try {
      const raw = localStorage.getItem(SUGGEST_LOG_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistSuggestLog(list) {
    try {
      localStorage.setItem(
        SUGGEST_LOG_KEY,
        JSON.stringify((list || []).slice(0, SUGGEST_LOG_LIMIT))
      );
    } catch {
      // ignore
    }
  }

  function pushSuggestLog(entry) {
    if (!entry || !entry.side) return;
    const list = loadSuggestLog();
    const key =
      entry.key ||
      `${entry.ticker || "?"}:${entry.side}:${Math.round(entry.askCents || 0)}`;
    if (list[0] && list[0].key === key && !list[0].taken) {
      list[0] = { ...list[0], ...entry, key, at: entry.at || Date.now() };
    } else {
      list.unshift({
        id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: entry.at || Date.now(),
        ticker: entry.ticker || null,
        side: entry.side,
        askCents: entry.askCents != null ? Math.round(entry.askCents) : null,
        stake: entry.stake != null ? entry.stake : null,
        key,
        taken: !!entry.taken,
      });
    }
    persistSuggestLog(list.slice(0, SUGGEST_LOG_LIMIT));
  }

  function markSuggestTaken(ticker, side) {
    const list = loadSuggestLog();
    let changed = false;
    for (const row of list) {
      if (row.taken) continue;
      if (side && row.side !== side) continue;
      if (ticker && row.ticker && row.ticker !== ticker) continue;
      row.taken = true;
      row.takenAt = Date.now();
      changed = true;
      break;
    }
    if (changed) persistSuggestLog(list);
  }

  function followMetaForSide(side) {
    const clear = !!(lastBestPick && lastBestPick.side);
    const followed = !!(clear && lastBestPick.side === side);
    return {
      followedSuggest: followed,
      suggestSide: clear ? lastBestPick.side : null,
      entrySource: followed ? (buySheetFromBest ? "best" : "aligned") : "own",
    };
  }

  function summarizeStrategyBucket(trades) {
    const n = trades.length;
    const wins = trades.filter((t) => t.won === true || Number(t.pl) > 0).length;
    const losses = n - wins;
    const pl = trades.reduce(
      (sum, t) => sum + (Number.isFinite(Number(t.pl)) ? Number(t.pl) : 0),
      0
    );
    const avg = n ? Math.round((pl / n) * 100) / 100 : null;
    const wr = n ? Math.round((wins / n) * 1000) / 10 : null;
    return { n, wins, losses, pl: Math.round(pl * 100) / 100, avg, wr };
  }

  function formatStrategyBucket(label, s) {
    if (!s.n) return "No closes yet";
    const wr = s.wr != null ? `${s.wr}% win` : "—";
    const avg = s.avg != null ? ` · avg ${formatPl(s.avg)}` : "";
    return `${s.wins}W-${s.losses}L (${wr}) · ${formatPl(s.pl)}${avg}`;
  }

  function buildStrategyReport() {
    const closed = closedPlTrades();
    const followed = closed.filter((t) => t.followedSuggest === true);
    const own = closed.filter((t) => t.followedSuggest === false);
    const prior = closed.filter((t) => t.followedSuggest == null);
    const followedS = summarizeStrategyBucket(followed);
    const ownS = summarizeStrategyBucket(own);
    const priorS = summarizeStrategyBucket(prior);
    const allS = summarizeStrategyBucket(closed);
    const suggestLog = loadSuggestLog();
    const missed = suggestLog.filter((s) => !s.taken).length;
    const takenSuggest = suggestLog.filter((s) => s.taken).length;

    let verdict =
      "Tap Best when it lights up (app suggestion), or Buy Above/Below on your own. After those closes settle, this chart shows whether Best Side earns trust.";
    if (followedS.n >= 5 && ownS.n >= 5) {
      const wrDelta = (followedS.wr || 0) - (ownS.wr || 0);
      const plDelta = followedS.pl - ownS.pl;
      if (wrDelta >= 8 && plDelta > 0) {
        verdict = `Trust leaning yes: Best Side leads by ${formatPl(
          plDelta
        )} and +${wrDelta.toFixed(1)} pts win rate vs your calls (${followedS.n} vs ${ownS.n} closes).`;
      } else if (wrDelta <= -8 && plDelta < 0) {
        verdict = `Trust leaning no: your own calls lead by ${formatPl(
          -plDelta
        )} and +${Math.abs(wrDelta).toFixed(1)} pts win rate. App edge is not beating you yet.`;
      } else {
        verdict = `Too close to call: Best Side ${followedS.wr}% / ${formatPl(
          followedS.pl
        )} vs your ${ownS.wr}% / ${formatPl(ownS.pl)}. Keep sampling.`;
      }
    } else if (followedS.n + ownS.n > 0) {
      verdict = `Building the sample: Best Side ${followedS.n} closes · your calls ${ownS.n}${
        prior.length ? ` · ${prior.length} older untagged` : ""
      }. Aim for ~5+ of each before trusting the split.`;
    } else if (allS.n > 0) {
      verdict = `${allS.n} closes on file (${allS.wins}W-${allS.losses}L · ${formatPl(
        allS.pl
      )}), but none are tagged Best vs Own yet. New Best taps and own buys will split the next chart.`;
    }

    const mark = markOpenPosition(demo.position);
    const equity = demo.on ? accountEquityNow(mark) : null;
    const day = equity != null ? dayChangePct(equity) : null;

    return {
      followedS,
      ownS,
      priorS,
      allS,
      priorCount: prior.length,
      missed,
      takenSuggest,
      verdict,
      day,
      equity,
    };
  }

  function strategyBarColumn(label, s, tone) {
    const maxN = Math.max(1, s.wins, s.losses);
    const winH = s.n ? Math.max(8, Math.round((s.wins / maxN) * 100)) : 0;
    const lossH = s.n ? Math.max(8, Math.round((s.losses / maxN) * 100)) : 0;
    const wrTxt = s.wr != null ? `${s.wr}%` : "—";
    const plClass = s.pl > 0 ? "is-up" : s.pl < 0 ? "is-down" : "";
    return (
      `<div class="strategy-col ${tone}">` +
      `<div class="strategy-col-label">${label}</div>` +
      `<div class="strategy-col-pair" role="img" aria-label="${label}: ${s.wins} wins, ${s.losses} losses">` +
      `<div class="strategy-bar-wrap">` +
      `<div class="strategy-bar win" style="height:${winH}%"></div>` +
      `<span class="strategy-bar-n">${s.wins}</span>` +
      `<span class="strategy-bar-cap">W</span>` +
      `</div>` +
      `<div class="strategy-bar-wrap">` +
      `<div class="strategy-bar loss" style="height:${lossH}%"></div>` +
      `<span class="strategy-bar-n">${s.losses}</span>` +
      `<span class="strategy-bar-cap">L</span>` +
      `</div>` +
      `</div>` +
      `<div class="strategy-col-meta">` +
      `<strong>${wrTxt} win</strong>` +
      `<span class="${plClass}">${s.n ? formatPl(s.pl) : "—"}</span>` +
      `<em>${s.n} close${s.n === 1 ? "" : "s"}</em>` +
      `</div>` +
      `</div>`
    );
  }

  function renderStrategyChart(report) {
    if (!el.strategyBars) return;
    const hasAny = report.allS.n > 0;
    if (el.strategyChartEmpty) el.strategyChartEmpty.hidden = hasAny;
    el.strategyBars.hidden = !hasAny;
    if (el.strategyChartCaption) {
      el.strategyChartCaption.textContent = hasAny
        ? "Green = wins · Red = losses · compare Best Side vs your calls"
        : "Green = wins · Red = losses · taller = more trades";
    }
    if (!hasAny) {
      el.strategyBars.innerHTML = "";
      return;
    }
    const cols = [];
    // Always show Best + Own so the comparison is readable even at 0.
    cols.push(strategyBarColumn("Best Side", report.followedS, "is-followed"));
    cols.push(strategyBarColumn("Your calls", report.ownS, "is-own"));
    if (report.priorS.n > 0 && report.followedS.n + report.ownS.n === 0) {
      cols.push(strategyBarColumn("Before tags", report.priorS, "is-prior"));
    } else if (report.priorS.n > 0) {
      cols.push(strategyBarColumn("Untagged", report.priorS, "is-prior"));
    }
    cols.push(strategyBarColumn("All closes", report.allS, "is-all"));
    el.strategyBars.innerHTML = cols.join("");
  }

  function renderStrategyReport() {
    const report = buildStrategyReport();
    renderStrategyChart(report);
    if (el.strategyFollowed) {
      el.strategyFollowed.textContent = formatStrategyBucket(
        "Followed",
        report.followedS
      );
      el.strategyFollowed.classList.toggle("is-up", report.followedS.pl > 0);
      el.strategyFollowed.classList.toggle("is-down", report.followedS.pl < 0);
    }
    if (el.strategyOwn) {
      el.strategyOwn.textContent = formatStrategyBucket("Own", report.ownS);
      el.strategyOwn.classList.toggle("is-up", report.ownS.pl > 0);
      el.strategyOwn.classList.toggle("is-down", report.ownS.pl < 0);
    }
    if (el.strategyAll) {
      el.strategyAll.textContent = formatStrategyBucket("All", report.allS);
      el.strategyAll.classList.toggle("is-up", report.allS.pl > 0);
      el.strategyAll.classList.toggle("is-down", report.allS.pl < 0);
    }
    if (el.strategyMissed) {
      el.strategyMissed.textContent = `Suggestions logged ${
        report.missed + report.takenSuggest
      } · taken ${report.takenSuggest} · missed ${report.missed}${
        report.priorCount
          ? ` · ${report.priorCount} older closes untagged`
          : ""
      }`;
    }
    if (el.strategyVerdict) el.strategyVerdict.textContent = report.verdict;
    if (el.strategyToday) {
      if (report.day) {
        el.strategyToday.textContent = `Today ${formatDayPct(report.day.pct)} · start ${money(
          report.day.start
        )} → ${money(report.day.now)} (PT day)`;
        el.strategyToday.classList.toggle("is-up", report.day.pct > 0);
        el.strategyToday.classList.toggle("is-down", report.day.pct < 0);
      } else {
        el.strategyToday.textContent = "Today — turn on Demo to track day %";
        el.strategyToday.classList.remove("is-up", "is-down");
      }
    }
  }

  let buySheetFromBest = false;
  let lastLoggedSuggestKey = null;

  function loadChartHeightPx() {
    try {
      const n = Number(localStorage.getItem(CHART_HEIGHT_KEY));
      if (Number.isFinite(n) && n >= 90 && n <= 2000) return Math.round(n);
    } catch {
      // ignore
    }
    return null;
  }

  function saveChartHeightPx(px) {
    try {
      if (px == null) localStorage.removeItem(CHART_HEIGHT_KEY);
      else localStorage.setItem(CHART_HEIGHT_KEY, String(Math.round(px)));
    } catch {
      // ignore
    }
  }

  function loadSummaryPushPx() {
    try {
      const n = Number(localStorage.getItem(SUMMARY_PUSH_KEY));
      if (Number.isFinite(n) && n >= 0 && n <= 900) return Math.round(n);
    } catch {
      // ignore
    }
    return 0;
  }

  function saveSummaryPushPx(px) {
    try {
      if (!px) localStorage.removeItem(SUMMARY_PUSH_KEY);
      else localStorage.setItem(SUMMARY_PUSH_KEY, String(Math.round(px)));
    } catch {
      // ignore
    }
  }

  /** Natural summary height (Price to beat strip) before top-grip push. */
  function measureSummaryNaturalH() {
    if (!el.summaryPanel) return 0;
    if (summaryNaturalH != null && summaryNaturalH > 0) return summaryNaturalH;
    const prevMax = el.summaryPanel.style.maxHeight;
    const prevMin = el.summaryPanel.style.minHeight;
    const prevOverflow = el.summaryPanel.style.overflow;
    const prevFlex = el.summaryPanel.style.flex;
    el.summaryPanel.style.maxHeight = "";
    el.summaryPanel.style.minHeight = "";
    el.summaryPanel.style.overflow = "";
    el.summaryPanel.style.flex = "";
    summaryNaturalH = Math.round(el.summaryPanel.getBoundingClientRect().height);
    el.summaryPanel.style.maxHeight = prevMax;
    el.summaryPanel.style.minHeight = prevMin;
    el.summaryPanel.style.overflow = prevOverflow;
    el.summaryPanel.style.flex = prevFlex;
    return summaryNaturalH;
  }

  /** Top grip pushes the numbers strip away so the chart can grow into it. */
  function applySummaryPush(px, { persist = true } = {}) {
    if (!el.summaryPanel) {
      summaryPushPx = 0;
      return;
    }
    const natural = measureSummaryNaturalH();
    summaryPushPx = Math.round(Math.min(Math.max(natural, 0), Math.max(0, px)));
    const h = Math.max(0, natural - summaryPushPx);
    if (summaryPushPx <= 0 || h >= natural - 1) {
      summaryPushPx = 0;
      el.summaryPanel.style.removeProperty("max-height");
      el.summaryPanel.style.removeProperty("min-height");
      el.summaryPanel.style.removeProperty("overflow");
      el.summaryPanel.style.removeProperty("flex");
      el.summaryPanel.style.removeProperty("opacity");
      el.summaryPanel.style.removeProperty("padding");
      el.summaryPanel.style.removeProperty("margin");
      el.summaryPanel.style.removeProperty("border-width");
      document.body.classList.remove("summary-pushed");
    } else {
      el.summaryPanel.style.setProperty("flex", "0 0 auto", "important");
      el.summaryPanel.style.setProperty("max-height", `${h}px`, "important");
      el.summaryPanel.style.setProperty("min-height", "0px", "important");
      el.summaryPanel.style.setProperty("overflow", "hidden", "important");
      if (h < 8) {
        el.summaryPanel.style.setProperty("opacity", "0", "important");
        el.summaryPanel.style.setProperty("padding", "0", "important");
        el.summaryPanel.style.setProperty("margin", "0", "important");
        el.summaryPanel.style.setProperty("border-width", "0", "important");
      } else {
        el.summaryPanel.style.removeProperty("opacity");
        el.summaryPanel.style.removeProperty("padding");
        el.summaryPanel.style.removeProperty("margin");
        el.summaryPanel.style.removeProperty("border-width");
      }
      document.body.classList.add("summary-pushed");
    }
    if (persist) saveSummaryPushPx(summaryPushPx);
  }

  function chartHeightLimits() {
    const shell = document.querySelector(".app-shell");
    const shellH = shell ? shell.clientHeight : window.innerHeight || 640;
    let padTop = 0;
    let padBottom = 0;
    if (shell) {
      try {
        const cs = getComputedStyle(shell);
        padTop = parseFloat(cs.paddingTop) || 0;
        padBottom = parseFloat(cs.paddingBottom) || 0;
      } catch {
        // ignore
      }
    }
    // Flex children use the content box. Padding already reserves the fixed
    // buy-dock / open-P/L — do not subtract those heights again.
    const avail = Math.max(0, shellH - padTop - padBottom);
    const top = document.querySelector(".top");
    const topH = top ? top.getBoundingClientRect().height : 52;
    const summaryH = el.summaryPanel
      ? el.summaryPanel.getBoundingClientRect().height
      : 0;
    const topGrip = el.chartResizeTop
      ? el.chartResizeTop.getBoundingClientRect().height
      : 40;
    const botGrip = el.chartResizeBottom
      ? el.chartResizeBottom.getBoundingClientRect().height
      : 40;
    // Chart size may push Best Side / trade controls below the fold.
    // fitMax puts the bottom grip at the buy-dock edge; overshoot lets the
    // chart grow further so the shell scrolls and trade sits underneath.
    // Top grip can also crush the summary strip, which raises fitMax live.
    const minTrade = 0;
    const minChart = 96;
    const fitMax = avail - topH - summaryH - topGrip - botGrip;
    const maxChart = Math.max(
      minChart,
      Math.min(2000, fitMax + Math.max(320, Math.round(avail * 0.55)))
    );
    return {
      minChart,
      maxChart,
      minTrade,
      fitMax,
      shellH,
      avail,
      topH,
      summaryH,
      topGrip,
      botGrip,
    };
  }

  function applyChartHeight(px, { persist = true } = {}) {
    if (!el.chartWrap) return;
    if (px == null || !Number.isFinite(px)) {
      chartHeightPx = null;
      el.chartWrap.style.flex = "";
      el.chartWrap.style.height = "";
      el.chartWrap.style.minHeight = "";
      el.chartWrap.style.maxHeight = "";
      if (el.tradePanel) {
        el.tradePanel.style.maxHeight = "";
        el.tradePanel.style.minHeight = "";
      }
      if (el.tradeStack) {
        el.tradeStack.style.flex = "";
        el.tradeStack.style.minHeight = "";
        el.tradeStack.style.maxHeight = "";
      }
      document.body.classList.remove("chart-height-locked");
      if (persist) saveChartHeightPx(null);
      setTimeout(resizeChart, 40);
      return;
    }
    const { minChart, maxChart } = chartHeightLimits();
    chartHeightPx = Math.round(Math.min(maxChart, Math.max(minChart, px)));
    el.chartWrap.style.setProperty("flex", `0 0 ${chartHeightPx}px`, "important");
    el.chartWrap.style.setProperty("height", `${chartHeightPx}px`, "important");
    el.chartWrap.style.setProperty("min-height", `${chartHeightPx}px`, "important");
    el.chartWrap.style.setProperty("max-height", `${chartHeightPx}px`, "important");
    // Keep trade strip at natural height — a tall chart pushes it below the
    // fold; the locked shell scrolls so Best Side / slider / odds stay reachable.
    if (el.tradeStack) {
      el.tradeStack.style.flex = "0 0 auto";
      el.tradeStack.style.setProperty("min-height", "0px", "important");
      el.tradeStack.style.setProperty("max-height", "none", "important");
      if (el.tradePanel) {
        el.tradePanel.style.maxHeight = "";
        el.tradePanel.style.minHeight = "";
      }
    } else if (el.tradePanel) {
      el.tradePanel.style.maxHeight = "";
      el.tradePanel.style.minHeight = "";
    }
    document.body.classList.add("chart-height-locked");
    if (persist) saveChartHeightPx(chartHeightPx);
    setTimeout(resizeChart, 40);
  }

  /** Reflow chart + trade strip after open-P/L drawer height changes. */
  function reflowAfterOpenPlChange() {
    if (chartHeightPx != null) {
      applyChartHeight(chartHeightPx, { persist: false });
    } else {
      setTimeout(resizeChart, 60);
    }
  }

  function wireChartResizeHandle(handle, mode) {
    if (!handle) return;
    let startY = null;
    let startH = null;
    let startPush = 0;
    let pointerId = null;

    const onMove = (clientY) => {
      if (startY == null || startH == null) return;
      const dy = clientY - startY;
      // Top: drag up grows chart and pushes Price-to-beat away.
      // Bottom: drag down grows chart and pushes trade controls away.
      const delta = mode === "top" ? -dy * 4 : dy * 4;
      if (mode === "top") {
        // Crush or restore the Price-to-beat strip so the chart can use that space.
        applySummaryPush(startPush + delta, { persist: false });
      }
      applyChartHeight(startH + delta, { persist: false });
    };

    const onEnd = () => {
      if (startY == null) return;
      startY = null;
      startH = null;
      pointerId = null;
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing-chart");
      window.removeEventListener("pointermove", onWinPointerMove);
      window.removeEventListener("pointerup", onWinPointerUp);
      window.removeEventListener("pointercancel", onWinPointerUp);
      window.removeEventListener("touchmove", onWinTouchMove);
      window.removeEventListener("touchend", onWinTouchEnd);
      window.removeEventListener("touchcancel", onWinTouchEnd);
      if (chartHeightPx != null) saveChartHeightPx(chartHeightPx);
      saveSummaryPushPx(summaryPushPx);
      setTimeout(resizeChart, 40);
    };

    const onWinPointerMove = (ev) => {
      if (startY == null) return;
      if (pointerId >= 0 && ev.pointerId !== pointerId) return;
      ev.preventDefault();
      onMove(ev.clientY);
    };
    const onWinPointerUp = (ev) => {
      if (pointerId >= 0 && ev.pointerId !== pointerId) return;
      onEnd();
    };
    const onWinTouchMove = (ev) => {
      if (startY == null) return;
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      ev.preventDefault();
      onMove(t.clientY);
    };
    const onWinTouchEnd = () => onEnd();

    const begin = (clientY, pid) => {
      pointerId = pid == null ? -1 : pid;
      startY = clientY;
      startPush = summaryPushPx || 0;
      summaryNaturalH = null;
      measureSummaryNaturalH();
      startH =
        chartHeightPx != null
          ? chartHeightPx
          : el.chartWrap
            ? el.chartWrap.getBoundingClientRect().height
            : 240;
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing-chart");
      window.addEventListener("pointermove", onWinPointerMove, { passive: false });
      window.addEventListener("pointerup", onWinPointerUp);
      window.addEventListener("pointercancel", onWinPointerUp);
      window.addEventListener("touchmove", onWinTouchMove, { passive: false });
      window.addEventListener("touchend", onWinTouchEnd);
      window.addEventListener("touchcancel", onWinTouchEnd);
    };

    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        // ignore — window listeners still drive the drag
      }
      begin(ev.clientY, ev.pointerId);
    });
    handle.addEventListener("pointermove", (ev) => {
      if (pointerId == null || (pointerId >= 0 && ev.pointerId !== pointerId)) return;
      if (startY == null) return;
      ev.preventDefault();
      onMove(ev.clientY);
    });
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    // Reflow while resizing (summary crush / chart grow) can drop capture.
    // Window listeners keep the gesture alive — do not end on lost capture.

    handle.addEventListener(
      "touchstart",
      (ev) => {
        if (pointerId != null && pointerId >= 0) return;
        const t = ev.touches && ev.touches[0];
        if (!t) return;
        ev.preventDefault();
        begin(t.clientY, -1);
      },
      { passive: false }
    );
    handle.addEventListener(
      "touchmove",
      (ev) => {
        if (startY == null) return;
        if (pointerId != null && pointerId >= 0) return;
        const t = ev.touches && ev.touches[0];
        if (!t) return;
        ev.preventDefault();
        onMove(t.clientY);
      },
      { passive: false }
    );
    handle.addEventListener(
      "touchend",
      () => {
        if (pointerId != null && pointerId >= 0) return;
        onEnd();
      },
      { passive: true }
    );
  }

  function setOpenPlCollapsed(collapsed, opts = {}) {
    const next = !!collapsed;
    const changed = next !== openPlCollapsed;
    openPlCollapsed = next;
    try {
      localStorage.setItem(OPEN_PL_COLLAPSE_KEY, openPlCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
    document.body.classList.toggle("open-pl-collapsed", openPlCollapsed);
    if (el.openPlBar) el.openPlBar.classList.toggle("is-collapsed", openPlCollapsed);
    if (el.openPlToggle) {
      el.openPlToggle.setAttribute("aria-expanded", openPlCollapsed ? "false" : "true");
      el.openPlToggle.title = openPlCollapsed
        ? "Show trade metrics"
        : "Slide trade metrics away";
    }
    // Only reflow on a real collapse toggle — re-applying on every P/L tick
    // was crushing the trade strip. Best Side is outside that strip now, but
    // chart leftover height still needs updating when the drawer moves.
    if ((changed || opts.forceResize) && !opts.skipResize) {
      reflowAfterOpenPlChange();
      // Match open-pl CSS transition so leftover height uses final drawer size.
      setTimeout(reflowAfterOpenPlChange, 220);
    }
  }

  /** Approximate inverse error function for model break-even spot. */
  function erfinvApprox(x) {
    const a = 0.147;
    const sign = x < 0 ? -1 : 1;
    const z = Math.min(0.999, Math.max(-0.999, x));
    const ln = Math.log(1 - z * z);
    const t = 2 / (Math.PI * a) + ln / 2;
    return sign * Math.sqrt(Math.sqrt(t * t - ln / a) - t);
  }

  function modelBreakevenSpot(pos, secsLeft) {
    if (!pos || pos.beat == null || !Number.isFinite(pos.beat)) return null;
    if (!(pos.contracts > 0) || !(pos.total > 0)) return null;
    const costPer = pos.total / pos.contracts;
    let needAbove = Math.min(0.92, Math.max(0.08, costPer));
    // Above needs P(above) >= costPer; Below needs P(below) >= costPer
    // => P(above) <= 1 - costPer
    if (pos.side === "below") needAbove = 1 - needAbove;
    const t = Math.max(1, Number(secsLeft) || 1);
    const sigma = Math.max(
      8,
      Math.abs(pos.beat) * 0.55 * Math.sqrt(t / (365.25 * 24 * 3600))
    );
    const z = Math.SQRT2 * erfinvApprox(2 * needAbove - 1);
    if (!Number.isFinite(z)) return null;
    return Math.round((pos.beat + sigma * z) * 100) / 100;
  }

  function renderOpenPlBar(pos, mark) {
    if (!el.openPlBar) return;
    const hadOpen = document.body.classList.contains("has-open-pl");
    if (!pos) {
      el.openPlBar.hidden = true;
      document.body.classList.remove("has-open-pl");
      document.body.classList.remove("open-pl-collapsed");
      clearBreakevenLines();
      if (lastTarget != null) applyTargetLine(lastTarget, "TO BEAT");
      if (hadOpen) {
        setTimeout(reflowAfterOpenPlChange, 40);
        setTimeout(reflowAfterOpenPlChange, 220);
      }
      return;
    }
    el.openPlBar.hidden = false;
    document.body.classList.add("has-open-pl");
    // Sync collapse chrome without a layout resize on every mark tick.
    setOpenPlCollapsed(openPlCollapsed, { skipResize: true });
    if (!hadOpen) {
      // First paint of the drawer — reserve space so Best Side isn't covered.
      setTimeout(reflowAfterOpenPlChange, 40);
      setTimeout(reflowAfterOpenPlChange, 220);
    }
    const side = pos.side === "above" ? "Above" : "Below";
    const accounted = pos.accounted !== false && demo.on;
    const sess = sessionPlBreakdown(mark);
    const beSpot = modelBreakevenSpot(pos, mark && mark.secs);
    lastBreakevenPrice = beSpot;
    applyBreakevenLines(pos.beat, pos.entrySpot, beSpot, pos.side);
    // Price to beat must stay visible while a trade is open.
    const beatKeep =
      pos.beat != null && Number.isFinite(Number(pos.beat))
        ? Number(pos.beat)
        : lastTarget;
    if (beatKeep != null && Number.isFinite(beatKeep)) {
      applyTargetLine(beatKeep, "TO BEAT");
    }

    if (el.openPlSide) {
      const fills = pos.fills > 1 ? ` · ${pos.fills} fills` : "";
      el.openPlSide.textContent = `Buy ${side} · ${pos.contracts} cts @ avg ${pos.askCents}¢${fills}`;
      el.openPlSide.classList.toggle("is-up", pos.side === "above");
      el.openPlSide.classList.toggle("is-down", pos.side === "below");
    }
    if (el.openPlValue) {
      el.openPlValue.textContent =
        mark && mark.unrealized != null ? formatPl(mark.unrealized) : "—";
      el.openPlValue.classList.toggle(
        "is-up",
        !!(mark && mark.unrealized > 0)
      );
      el.openPlValue.classList.toggle(
        "is-down",
        !!(mark && mark.unrealized < 0)
      );
    }
    if (el.openPlBalance) {
      const equity = accounted ? accountEquityNow(mark) : null;
      if (equity != null) {
        el.openPlBalance.hidden = false;
        el.openPlBalance.textContent = `(${money(equity)})`;
      } else {
        el.openPlBalance.hidden = true;
        el.openPlBalance.textContent = "";
      }
      if (el.openPlDayPct) {
        const day = equity != null ? dayChangePct(equity) : null;
        if (day) {
          el.openPlDayPct.hidden = false;
          el.openPlDayPct.textContent = `(${formatDayPct(day.pct)})`;
          el.openPlDayPct.classList.toggle("is-up", day.pct > 0);
          el.openPlDayPct.classList.toggle("is-down", day.pct < 0);
        } else {
          el.openPlDayPct.hidden = true;
          el.openPlDayPct.textContent = "";
          el.openPlDayPct.classList.remove("is-up", "is-down");
        }
      }
    }
    if (el.openPlPeek) {
      const plTxt =
        mark && mark.unrealized != null ? formatPl(mark.unrealized) : "—";
      el.openPlPeek.textContent = `Open ${side} ${plTxt} · tap to expand`;
      el.openPlPeek.classList.toggle("is-up", !!(mark && mark.unrealized > 0));
      el.openPlPeek.classList.toggle("is-down", !!(mark && mark.unrealized < 0));
    }
    if (el.openPlSub) {
      const bits = [];
      if (mark && mark.bidCents != null) bits.push(`bid ${mark.bidCents}¢`);
      if (mark && mark.unrealizedPct != null) {
        const sign = mark.unrealizedPct > 0 ? "+" : "";
        bits.push(`${sign}${mark.unrealizedPct.toFixed(1)}%`);
      }
      if (mark && mark.modelEvPl != null) {
        bits.push(`EV ${formatPl(mark.modelEvPl)}`);
      }
      if (mark && mark.pWin != null) {
        bits.push(`${Math.round(mark.pWin * 100)}% win`);
      }
      if (mark && mark.delta != null) {
        bits.push(
          `${mark.delta >= 0 ? "+" : ""}$${mark.delta.toFixed(0)} vs beat`
        );
      }
      if (beSpot != null) {
        bits.push(`B/E $${beSpot.toFixed(0)}`);
      }
      if (mark && mark.secs != null) {
        bits.push(
          `${Math.floor(mark.secs / 60)}:${String(mark.secs % 60).padStart(2, "0")} left`
        );
      }
      if (mark && mark.settleNowWin != null) {
        bits.push(mark.settleNowWin ? "winning now" : "losing now");
      }
      bits.push(`session ${formatPl(sess.total)}`);
      el.openPlSub.textContent = bits.join(" · ");
    }
    if (el.openPlClose) {
      el.openPlClose.disabled = !mark || mark.bidCents == null;
      el.openPlClose.textContent = accounted
        ? "Close at bid · post P/L"
        : "Close at bid · clear mark";
    }
    if (el.openPlAdd) {
      const side = pos.side === "above" ? "Above" : "Below";
      el.openPlAdd.disabled = !canBuySide(pos.side);
      el.openPlAdd.textContent = `Add ${side}`;
    }
  }

  function renderOpenPositionUi() {
    const pos = demo.position;
    const mark = markOpenPosition(pos);
    renderOpenPlBar(pos, mark);
    maybeAlertProfit(pos, mark);
    // Keep the chart clear: factor card lives in Options / bottom strip, not summary.
    if (el.demoLive) el.demoLive.hidden = true;
    return mark;
  }

  function renderDemoUi() {
    if (el.menuBtn) el.menuBtn.classList.toggle("is-demo", !!demo.on);
    if (el.demoToggle) el.demoToggle.checked = !!demo.on;
    if (el.demoAccount) el.demoAccount.hidden = !demo.on;
    if (el.demoStart && document.activeElement !== el.demoStart) {
      el.demoStart.value = String(Math.round(demo.start));
    }
    if (el.demoBalance) el.demoBalance.textContent = money(demo.balance);
    if (el.demoDayPct) {
      const markForDay = markOpenPosition(demo.position);
      const equity = demo.on ? accountEquityNow(markForDay) : null;
      const day = equity != null ? dayChangePct(equity) : null;
      if (day) {
        el.demoDayPct.textContent = `Day ${formatDayPct(day.pct)} · from ${money(
          day.start
        )}`;
        el.demoDayPct.classList.toggle("is-up", day.pct > 0);
        el.demoDayPct.classList.toggle("is-down", day.pct < 0);
      } else {
        el.demoDayPct.textContent = "Day —";
        el.demoDayPct.classList.remove("is-up", "is-down");
      }
    }
    if (el.demoPl) {
      const markPreview = markOpenPosition(demo.position);
      const sess = sessionPlBreakdown(markPreview);
      if (sess.hasOpen) {
        el.demoPl.textContent =
          `Session ${formatPl(sess.total)} · realized ${formatPl(
            sess.realized
          )} · open ${formatPl(sess.open)}`;
      } else {
        el.demoPl.textContent = `Session P/L ${formatPl(sess.realized)}`;
      }
      el.demoPl.classList.toggle("is-up", sess.total > 0);
      el.demoPl.classList.toggle("is-down", sess.total < 0);
    }

    const pos = demo.position;
    const mark = renderOpenPositionUi();

    if (el.demoPosition) {
      if (!pos) {
        el.demoPosition.textContent = "Flat";
      } else {
        el.demoPosition.textContent = formatPositionSummary(pos);
      }
    }

    if (el.demoMark) el.demoMark.hidden = !pos;
    if (el.demoClose) el.demoClose.hidden = !pos;
    if (pos && mark) {
      if (el.demoMarkPl) {
        el.demoMarkPl.textContent =
          mark.unrealized == null
            ? "Mark —"
            : `Open P/L ${formatPl(mark.unrealized)}`;
        el.demoMarkPl.classList.toggle("is-up", mark.unrealized > 0);
        el.demoMarkPl.classList.toggle("is-down", mark.unrealized < 0);
      }
      if (el.demoMarkMeta) {
        const timeTxt =
          mark.secs != null
            ? `${Math.floor(mark.secs / 60)}:${String(mark.secs % 60).padStart(2, "0")} left`
            : "— left";
        const deltaTxt =
          mark.delta != null
            ? `live ${mark.delta >= 0 ? "+" : ""}$${mark.delta.toFixed(0)} vs beat`
            : "live —";
        el.demoMarkMeta.textContent =
          mark.bidCents == null
            ? `Waiting for bid · ${deltaTxt} · ${timeTxt}`
            : `Bid ${mark.bidCents}¢ · exit ~${money(mark.proceeds)} · ${deltaTxt} · ${timeTxt}`;
      }
    }

    if (el.demoLast) {
      const r = demo.lastResult;
      el.demoLast.classList.remove("is-win", "is-loss");
      if (!r) {
        el.demoLast.textContent = "No trades yet";
      } else {
        el.demoLast.textContent = r.text;
        el.demoLast.classList.toggle("is-win", !!r.won);
        el.demoLast.classList.toggle("is-loss", !r.won);
      }
    }
    renderTradeHistory();
    const busyAbove = !!demo.position && !canBuySide("above");
    const busyBelow = !!demo.position && !canBuySide("below");
    if (el.demoBuyBest) {
      const bestSide = lastBestPick && lastBestPick.side;
      const bestLocked =
        !bestSide || (demo.position ? !canBuySide(bestSide) : false);
      // Keep clickable when locked so we can explain "close first to flip".
      el.demoBuyBest.disabled = !demo.on;
      el.demoBuyBest.classList.toggle("is-locked", !!demo.on && bestLocked);
      el.demoBuyBest.setAttribute(
        "aria-disabled",
        !demo.on || bestLocked ? "true" : "false"
      );
    }
    if (el.demoBuyAbove) {
      el.demoBuyAbove.disabled = !demo.on;
      el.demoBuyAbove.classList.toggle("is-locked", !!demo.on && busyAbove);
      el.demoBuyAbove.setAttribute(
        "aria-disabled",
        !demo.on || busyAbove ? "true" : "false"
      );
    }
    if (el.demoBuyBelow) {
      el.demoBuyBelow.disabled = !demo.on;
      el.demoBuyBelow.classList.toggle("is-locked", !!demo.on && busyBelow);
      el.demoBuyBelow.setAttribute(
        "aria-disabled",
        !demo.on || busyBelow ? "true" : "false"
      );
    }
    if (el.demoClose) el.demoClose.disabled = !pos || !mark || mark.bidCents == null;
    syncBuyDock();
  }

  function closeDemoPosition() {
    const pos = demo.position;
    if (!pos) return;
    const mark = markOpenPosition(pos);
    if (!mark || mark.bidCents == null || mark.proceeds == null) {
      setStatus("warn", "No live bid to close against");
      return;
    }
    const pl = mark.unrealized;
    const accounted = pos.accounted !== false && demo.on;
    if (accounted) {
      demo.balance = Math.round((demo.balance + mark.proceeds) * 100) / 100;
      demo.realizedPl = Math.round((demo.realizedPl + pl) * 100) / 100;
    }
    const sideLabel = pos.side === "above" ? "Above" : "Below";
    const won = pl >= 0;
    demo.lastResult = {
      won,
      pl,
      side: pos.side,
      ticker: pos.ticker,
      text: accounted
        ? `CLOSED ${sideLabel} @ ${mark.bidCents}¢ · ${formatPl(pl)} · bal ${money(
            demo.balance
          )}`
        : `CLOSED ${sideLabel} @ ${mark.bidCents}¢ · ${formatPl(pl)} · paper`,
    };
    pushTradeHistory({
      id: `${Date.now()}-${pos.ticker || "x"}`,
      at: Date.now(),
      kind: "close",
      side: pos.side,
      ticker: pos.ticker || null,
      contracts: pos.contracts,
      askCents: pos.askCents,
      total: pos.total,
      fills: pos.fills || 1,
      exitCents: mark.bidCents,
      pl,
      won,
      accounted: !!accounted,
      followedSuggest:
        pos.followedSuggest == null ? null : !!pos.followedSuggest,
      suggestSide: pos.suggestSide || null,
      entrySource: pos.entrySource || null,
    });
    demo.position = null;
    saveDemoState();
    renderDemoUi();
    renderStrategyReport();
    setStatus(won ? "ok" : "warn", demo.lastResult.text);
  }

  function setDemoOn(on) {
    demo.on = !!on;
    saveDemoState();
    renderDemoUi();
    setStatus("ok", demo.on ? "Demo on" : "Demo off");
  }

  function resetDemoAccount() {
    let start = Number(el.demoStart && el.demoStart.value);
    if (!Number.isFinite(start) || start < 10) start = DEMO_DEFAULT_START;
    start = Math.min(100000, Math.round(start));
    demo.start = start;
    demo.balance = start;
    demo.realizedPl = 0;
    demo.position = null;
    demo.lastResult = null;
    // NEVER clear trade history — bankroll reset keeps the all-time ledger.
    demo.history = mergeTradeHistory(demo.history, loadTradeHistory());
    persistTradeHistory(demo.history);
    saveDayEquity(appDateKey(), start, { tz: APP_TZ, v: DAY_EQUITY_VERSION });
    saveDemoState();
    renderDemoUi();
    renderTradeHistory();
    renderPlChart();
    renderStrategyReport();
    setStatus(
      "ok",
      `Demo reset · ${money(start)} · ${(demo.history || []).length} trades kept`
    );
  }

  const BUY_AMOUNT_MIN = 1;
  const BUY_AMOUNT_MAX = 100;

  function buyAmountCap() {
    const hard = BUY_AMOUNT_MAX;
    if (demo.on) {
      return Math.max(
        BUY_AMOUNT_MIN,
        Math.min(hard, Math.floor(demo.balance) || BUY_AMOUNT_MIN)
      );
    }
    return hard;
  }

  function clampBuyAmount(n) {
    const cap = buyAmountCap();
    let v = Number(n);
    if (!Number.isFinite(v)) v = buySheetAmount;
    return Math.max(BUY_AMOUNT_MIN, Math.min(cap, Math.round(v)));
  }

  /** Same-side adds are always allowed; only opposite side is locked. */
  function canBuySide(side) {
    const pos = demo.position;
    if (!pos) return true;
    if (side !== "above" && side !== "below") return false;
    return pos.side === side;
  }

  function formatPositionSummary(pos) {
    if (!pos) return "Flat";
    const side = pos.side === "above" ? "Above" : "Below";
    const fills = pos.fills > 1 ? ` · ${pos.fills} fills` : "";
    return `Buy ${side} · ${pos.contracts} cts @ avg ${pos.askCents}¢ · paid ${money(
      pos.total
    )}${fills}`;
  }

  function demoBuy(side, amountUsd) {
    const existing = demo.position;
    if (existing && existing.side !== side) {
      setStatus(
        "warn",
        `Already long ${existing.side === "above" ? "Above" : "Below"} — close first to flip`
      );
      return false;
    }
    const stake = amountUsd != null ? Number(amountUsd) : tradeStake;
    if (!(stake > 0)) {
      setStatus("warn", "Enter a dollar amount");
      return false;
    }
    if (!lastTicker || lastTarget == null) {
      setStatus("warn", "Wait for a live window");
      return false;
    }
    const ask = side === "above" ? lastRoiAsks.above : lastRoiAsks.below;
    const sized = roiForStake(ask, stake);
    if (!sized || sized.empty) {
      setStatus("warn", "Need a live ask");
      return false;
    }
    const accounted = existing
      ? existing.accounted !== false && demo.on
      : !!demo.on;
    if (accounted && sized.total > demo.balance + 1e-9) {
      setStatus("warn", "Not enough demo balance");
      return false;
    }
    if (accounted) {
      demo.balance = Math.round((demo.balance - sized.total) * 100) / 100;
    }
    const spotRaw = el.spotValue && el.spotValue.dataset.last;
    const spotN = spotRaw != null ? Number(spotRaw) : null;
    const entrySpot =
      spotN != null && Number.isFinite(spotN) ? spotN : null;
    const follow = followMetaForSide(side);

    if (existing) {
      const nextContracts = existing.contracts + sized.contracts;
      const nextCost = Math.round((existing.cost + sized.cost) * 100) / 100;
      const nextFee = Math.round((existing.fee + sized.fee) * 100) / 100;
      const nextTotal = Math.round((existing.total + sized.total) * 100) / 100;
      const avgAsk =
        nextContracts > 0
          ? Math.round(
              (existing.askCents * existing.contracts +
                sized.askCents * sized.contracts) /
                nextContracts
            )
          : sized.askCents;
      let nextEntry = existing.entrySpot;
      if (entrySpot != null && Number.isFinite(entrySpot)) {
        if (existing.entrySpot != null && Number.isFinite(existing.entrySpot)) {
          nextEntry =
            Math.round(
              ((existing.entrySpot * existing.contracts +
                entrySpot * sized.contracts) /
                nextContracts) *
                100
            ) / 100;
        } else {
          nextEntry = entrySpot;
        }
      }
      demo.position = {
        ...existing,
        ticker: lastTicker || existing.ticker,
        askCents: avgAsk,
        contracts: nextContracts,
        cost: nextCost,
        fee: nextFee,
        total: nextTotal,
        beat: lastTarget != null ? lastTarget : existing.beat,
        entrySpot: nextEntry,
        fills: (existing.fills || 1) + 1,
        lastAddedAt: Date.now(),
        accounted: existing.accounted !== false ? accounted : false,
        followedSuggest:
          !!existing.followedSuggest || !!follow.followedSuggest,
        suggestSide: follow.suggestSide || existing.suggestSide || null,
        entrySource: follow.entrySource || existing.entrySource || "own",
      };
    } else {
      demo.position = {
        ticker: lastTicker,
        side,
        askCents: sized.askCents,
        contracts: sized.contracts,
        cost: sized.cost,
        fee: sized.fee,
        total: sized.total,
        beat: lastTarget,
        entrySpot,
        openedAt: Date.now(),
        fills: 1,
        accounted,
        followedSuggest: !!follow.followedSuggest,
        suggestSide: follow.suggestSide,
        entrySource: follow.entrySource,
        profitChimed: false,
      };
    }
    if (follow.followedSuggest) markSuggestTaken(lastTicker, side);
    // Keep main trade-size slider in sync for Best Side sizing ($1–$100).
    if (stake >= BUY_AMOUNT_MIN && stake <= BUY_AMOUNT_MAX) {
      setTradeStake(Math.round(stake));
    }
    const added = !!existing;
    pushTradeHistory({
      id: `${Date.now()}-${added ? "add" : "buy"}-${lastTicker || "x"}`,
      at: Date.now(),
      kind: added ? "add" : "buy",
      side,
      ticker: lastTicker || null,
      contracts: sized.contracts,
      askCents: sized.askCents,
      total: sized.total,
      fills: 1,
      exitCents: null,
      pl: null,
      won: null,
      accounted: !!accounted,
      followedSuggest: !!follow.followedSuggest,
      suggestSide: follow.suggestSide,
      entrySource: follow.entrySource,
    });
    saveDemoState();
    refreshBestSide();
    renderDemoUi();
    renderStrategyReport();
    const sideLabel = side === "above" ? "Above" : "Below";
    setStatus(
      "ok",
      accounted
        ? `${added ? "Added to" : "Demo bought"} ${sideLabel} · ${sized.contracts} cts${
            added ? ` · now ${demo.position.contracts}` : ""
          }${follow.followedSuggest ? " · Best Side" : ""}`
        : `${added ? "Added to" : "Paper bought"} ${sideLabel} · ${sized.contracts} cts${
            added ? ` · now ${demo.position.contracts}` : ""
          }${follow.followedSuggest ? " · Best Side" : ""}`
    );
    return true;
  }

  function setBuyAmountUi(n, syncStake) {
    const amt = clampBuyAmount(n);
    buySheetAmount = amt;
    if (el.buyAmount && document.activeElement !== el.buyAmount) {
      el.buyAmount.value = String(amt);
    } else if (el.buyAmount && document.activeElement === el.buyAmount) {
      // Keep typing free; commit on change/blur via callers.
    } else if (el.buyAmount) {
      el.buyAmount.value = String(amt);
    }
    if (el.buyRange) {
      const cap = buyAmountCap();
      el.buyRange.min = String(BUY_AMOUNT_MIN);
      el.buyRange.max = String(cap);
      el.buyRange.value = String(Math.min(amt, cap));
      el.buyRange.setAttribute("aria-valuenow", String(amt));
      el.buyRange.setAttribute("aria-valuemax", String(cap));
    }
    if (el.buyRangeValue) el.buyRangeValue.textContent = `$${amt}`;
    document.querySelectorAll(".buy-chip").forEach((btn) => {
      const chipAmt = Number(btn.dataset.amt);
      btn.classList.toggle("is-active", chipAmt === amt);
    });
    if (syncStake) setTradeStake(amt);
    return amt;
  }

  function readBuyAmount() {
    const n = clampBuyAmount(el.buyAmount && el.buyAmount.value);
    setBuyAmountUi(n, false);
    return n;
  }

  function refreshBuySheetPreview() {
    if (!buySheetOpen || !buySheetSide) return;
    const side = buySheetSide;
    const amount = readBuyAmount();
    const ask = side === "above" ? lastRoiAsks.above : lastRoiAsks.below;
    const sized = roiForStake(ask, amount);
    if (el.buyBalanceHint) {
      el.buyBalanceHint.textContent = demo.on
        ? `Bal ${money(demo.balance)}`
        : "Paper · rolling P/L";
    }
    if (el.buySheetMeta) {
      const askTxt = ask != null ? `${Math.round(ask)}¢ ask` : "ask —";
      const adding = !!(demo.position && demo.position.side === side);
      el.buySheetMeta.textContent = adding
        ? `Add ${side === "above" ? "Above" : "Below"} · ${askTxt} · now ${
            demo.position.contracts
          } cts @ avg ${demo.position.askCents}¢`
        : `${side === "above" ? "Above" : "Below"} · ${askTxt} · live Kalshi book`;
    }
    if (el.buyPreview) {
      if (!sized || sized.empty) {
        el.buyPreview.textContent = "Enter an amount to preview contracts + fees";
      } else {
        const adding = !!(demo.position && demo.position.side === side);
        const afterCts = adding
          ? demo.position.contracts + sized.contracts
          : sized.contracts;
        el.buyPreview.textContent =
          `${sized.contracts} contracts · cost ${money(sized.cost)} + fee ${money(
            sized.fee
          )} · total ${money(sized.total)} · win ${money(sized.profitIfWin)} (${
            sized.roiIfWin != null
              ? `${sized.roiIfWin >= 0 ? "+" : ""}${sized.roiIfWin.toFixed(0)}%`
              : "—"
          })${adding ? ` · position → ${afterCts} cts` : ""}`;
      }
    }
    if (el.buySlideLabel && !buyConfirming) {
      const adding = !!(demo.position && demo.position.side === side);
      const label = adding
        ? side === "above"
          ? "Slide to add Above"
          : "Slide to add Below"
        : side === "above"
          ? "Slide to buy Above"
          : "Slide to buy Below";
      el.buySlideLabel.textContent = label;
    }
    renderBuySuggest(side, amount);
  }

  function renderBuySuggest(side, currentAmount) {
    if (!el.buySuggest) return;
    const s = suggestForSide(side);
    if (s && s.atRiskCap) {
      buySuggestStake = null;
      el.buySuggest.hidden = false;
      el.buySuggest.classList.remove("is-active");
      if (el.buySuggestAmount) {
        el.buySuggestAmount.textContent = "Hold — max risk";
      }
      if (el.buySuggestMeta) {
        const pct = bankPctText(s.bankPct);
        el.buySuggestMeta.textContent = pct
          ? `Open already risks ${pct} of balance`
          : "Open position at max suggested risk";
      }
      if (el.buySuggestUse) {
        el.buySuggestUse.textContent = "—";
        el.buySuggestUse.disabled = true;
      }
      return;
    }
    buySuggestStake =
      s && !s.lowProb && s.stake >= BUY_AMOUNT_MIN ? s.stake : null;
    if (buySuggestStake == null) {
      el.buySuggest.hidden = true;
      return;
    }
    el.buySuggest.hidden = false;
    const atSuggested = Math.round(Number(currentAmount) || 0) === buySuggestStake;
    el.buySuggest.classList.toggle("is-active", atSuggested);
    if (el.buySuggestAmount) {
      el.buySuggestAmount.textContent = `$${buySuggestStake}${
        s.contracts ? ` · ${s.contracts} cts` : ""
      }`;
    }
    if (el.buySuggestMeta) {
      const roi =
        s.roiIfWin != null
          ? `${s.roiIfWin >= 0 ? "+" : ""}${s.roiIfWin.toFixed(0)}% if win`
          : "";
      const conf = s.pWin != null ? `${Math.round(s.pWin * 100)}% model` : "";
      const bankTxt = bankPctText(s.bankPct);
      const bank = bankTxt ? `${bankTxt} of balance` : "";
      const cool =
        s.streak >= 2 ? "cooled after losses" : s.streak >= 1 ? "sized down" : "";
      el.buySuggestMeta.textContent = [conf, roi, bank, cool]
        .filter(Boolean)
        .join(" · ");
    }
    if (el.buySuggestUse) {
      el.buySuggestUse.textContent = atSuggested ? "Set" : "Use";
      el.buySuggestUse.disabled = atSuggested;
    }
  }

  function setBuySlideProgress(pct) {
    buySlideProgress = Math.max(0, Math.min(1, pct));
    const thumbTravel = Math.max(0, buySlideMax);
    const x = buySlideProgress * thumbTravel;
    if (el.buySlideThumb) {
      el.buySlideThumb.style.transform = `translateX(${x}px)`;
    }
    if (el.buySlideFill) {
      // No resting halo around the thumb — fill only the track behind it
      // once the user starts sliding.
      const trackW = Math.max(1, (el.buySlide && el.buySlide.clientWidth) || 1);
      const thumbW =
        (el.buySlideThumb && el.buySlideThumb.offsetWidth) || 48;
      const fillPx =
        buySlideProgress <= 0.001 ? 0 : Math.min(trackW, x + thumbW * 0.5);
      el.buySlideFill.style.width = `${(fillPx / trackW) * 100}%`;
    }
    if (el.buySlide) {
      el.buySlide.setAttribute("aria-valuenow", String(Math.round(buySlideProgress * 100)));
    }
  }

  function resetBuySlide() {
    buySlideDragging = false;
    buyConfirming = false;
    if (el.buySlide) el.buySlide.classList.remove("is-complete");
    setBuySlideProgress(0);
    refreshBuySheetPreview();
  }

  function measureBuySlide() {
    if (!el.buySlide || !el.buySlideThumb) {
      buySlideMax = 0;
      return;
    }
    buySlideMax = Math.max(0, el.buySlide.clientWidth - el.buySlideThumb.offsetWidth - 8);
  }

  function openBuySheet(side, opts = {}) {
    if (side !== "above" && side !== "below") return;
    if (demo.position && !canBuySide(side)) {
      const held = demo.position.side === "above" ? "Above" : "Below";
      setStatus(
        "warn",
        `Already long ${held} — tap Close at bid first to flip`
      );
      // Expand the open-P/L drawer so Close is obvious.
      try {
        setOpenPlCollapsed(false);
        if (el.openPlClose) {
          el.openPlClose.classList.add("is-pulse");
          setTimeout(() => {
            try {
              el.openPlClose.classList.remove("is-pulse");
            } catch (_) {}
          }, 1600);
        }
      } catch {
        // ignore
      }
      return;
    }
    const ask = side === "above" ? lastRoiAsks.above : lastRoiAsks.below;
    if (ask == null || !(ask >= 1 && ask <= 99)) {
      setStatus("warn", "Need a live ask");
      return;
    }
    closeOptions();
    buySheetSide = side;
    buySheetOpen = true;
    buySheetFromBest = !!opts.fromBest;
    const adding = !!(demo.position && demo.position.side === side);
    // Always size from the live suggestion after a buy too (adds / re-entry).
    const wantSuggest = opts.useSuggest !== false;
    const sideSuggest = suggestForSide(side);
    const suggested = !wantSuggest
      ? null
      : lastBestPick &&
          lastBestPick.side === side &&
          lastBestPick.suggestedStake >= BUY_AMOUNT_MIN
        ? lastBestPick.suggestedStake
        : sideSuggest &&
            !sideSuggest.lowProb &&
            sideSuggest.stake >= BUY_AMOUNT_MIN
          ? sideSuggest.stake
          : null;
    // Prefer Best Side suggestion when buying the suggested side.
    const preferred =
      suggested != null
        ? suggested
        : buySheetAmount >= BUY_AMOUNT_MIN
          ? buySheetAmount
          : tradeStake >= BUY_AMOUNT_MIN
            ? tradeStake
            : BUY_AMOUNT_MIN;
    if (el.buyAmount) {
      el.buyAmount.min = String(BUY_AMOUNT_MIN);
      el.buyAmount.max = String(buyAmountCap());
    }
    setBuyAmountUi(preferred, suggested != null);
    if (el.buySheet) {
      el.buySheet.hidden = false;
      el.buySheet.classList.remove("is-done");
      el.buySheet.classList.toggle("is-below", side === "below");
    }
    if (el.buyBackdrop) el.buyBackdrop.hidden = false;
    if (el.buySheetTitle) {
      el.buySheetTitle.textContent = adding
        ? side === "above"
          ? "Add to Above"
          : "Add to Below"
        : side === "above"
          ? "Buy Above"
          : "Buy Below";
    }
    const kicker = document.querySelector(".buy-sheet-kicker");
    if (kicker) {
      kicker.textContent =
        suggested != null
          ? demo.on
            ? `Suggested $${suggested} · high ROI / low risk`
            : `Suggested $${suggested} · high ROI / low risk`
          : adding
            ? demo.on
              ? "Demo add · averages into open position"
              : "Paper add · averages into open position"
            : demo.on
              ? "Demo order"
              : "Paper order · rolling P/L";
    }
    resetBuySlide();
    requestAnimationFrame(() => {
      measureBuySlide();
      setBuySlideProgress(0);
      refreshBuySheetPreview();
    });
  }

  function dismissBuySheet(afterMs) {
    const finish = () => {
      buySheetOpen = false;
      buySheetSide = null;
      buyConfirming = false;
      if (el.buySheet) {
        el.buySheet.hidden = true;
        el.buySheet.classList.remove("is-done", "is-below");
      }
      if (el.buyBackdrop) el.buyBackdrop.hidden = true;
      resetBuySlide();
    };
    if (afterMs && el.buySheet && buySheetOpen) {
      el.buySheet.classList.add("is-done");
      setTimeout(finish, afterMs);
    } else {
      finish();
    }
  }

  function confirmBuyFromSheet() {
    if (buyConfirming || !buySheetSide) return;
    buyConfirming = true;
    if (el.buySlide) el.buySlide.classList.add("is-complete");
    if (el.buySlideLabel) {
      el.buySlideLabel.textContent =
        demo.position && demo.position.side === buySheetSide ? "Added" : "Bought";
    }
    setBuySlideProgress(1);
    const ok = demoBuy(buySheetSide, readBuyAmount());
    if (!ok) {
      buyConfirming = false;
      if (el.buySlide) el.buySlide.classList.remove("is-complete");
      resetBuySlide();
      return;
    }
    dismissBuySheet(380);
  }

  function onBuySlidePointerDown(ev) {
    if (!buySheetOpen || buyConfirming) return;
    measureBuySlide();
    buySlideDragging = true;
    const point = ev.touches ? ev.touches[0] : ev;
    buySlideStartX = point.clientX - buySlideProgress * buySlideMax;
    if (el.buySlide && el.buySlide.setPointerCapture && ev.pointerId != null) {
      try {
        el.buySlide.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
    }
    ev.preventDefault();
  }

  function onBuySlidePointerMove(ev) {
    if (!buySlideDragging || buyConfirming) return;
    const point = ev.touches ? ev.touches[0] : ev;
    const x = point.clientX - buySlideStartX;
    setBuySlideProgress(buySlideMax > 0 ? x / buySlideMax : 0);
    ev.preventDefault();
  }

  function onBuySlidePointerUp(ev) {
    if (!buySlideDragging) return;
    buySlideDragging = false;
    if (buySlideProgress >= 0.92) {
      confirmBuyFromSheet();
    } else {
      setBuySlideProgress(0);
    }
    if (ev && el.buySlide && el.buySlide.releasePointerCapture && ev.pointerId != null) {
      try {
        el.buySlide.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
    }
  }

  function demoBuyBest() {
    if (!lastBestPick || !lastBestPick.side) {
      setStatus("warn", "No clear Best Side yet");
      return;
    }
    openBuySheet(lastBestPick.side, { useSuggest: true, fromBest: true });
  }

  function resolveOutcomeForTicker(ticker, beatHint) {
    const hinted = ticker ? settleHintByTicker[ticker] : null;
    if (hinted === "above" || hinted === "below") return hinted;
    if (lastSettlementSide === "above" || lastSettlementSide === "below") {
      if (!ticker || ticker === lastTicker) return lastSettlementSide;
    }
    const beat =
      beatHint != null && Number.isFinite(beatHint)
        ? beatHint
        : lastTarget;
    // Prefer Kalshi settlement average over live tick — live can reverse after 0:00.
    if (
      lastSettlementAvg != null &&
      Number.isFinite(lastSettlementAvg) &&
      beat != null &&
      Number.isFinite(beat)
    ) {
      return lastSettlementAvg >= beat ? "above" : "below";
    }
    const spotRaw = el.spotValue && el.spotValue.dataset.last;
    const spot = spotRaw != null ? Number(spotRaw) : null;
    if (spot != null && Number.isFinite(spot) && beat != null && Number.isFinite(beat)) {
      return spot >= beat ? "above" : "below";
    }
    return null;
  }

  function windowHasClosed(data) {
    if (!data) return false;
    if (data.stale_previous || data.waiting_next) return true;
    if (data.seconds_to_close != null && Number(data.seconds_to_close) <= 0) {
      return true;
    }
    const closeIso = data.close_time || closeTimeIso;
    if (closeIso) {
      const ms = Date.parse(closeIso);
      if (Number.isFinite(ms) && ms <= Date.now()) return true;
    }
    return false;
  }

  function settleDemoPosition(tickerJustClosed, opts = {}) {
    const pos = demo.position;
    if (!pos) return false;
    if (tickerJustClosed && pos.ticker && pos.ticker !== tickerJustClosed) {
      return false;
    }
    if (opts.settleSide === "above" || opts.settleSide === "below") {
      if (pos.ticker) settleHintByTicker[pos.ticker] = opts.settleSide;
    }
    let outcome = resolveOutcomeForTicker(pos.ticker, pos.beat);
    if (!outcome && opts.force) {
      const beat =
        pos.beat != null && Number.isFinite(Number(pos.beat))
          ? Number(pos.beat)
          : lastTarget;
      const avg =
        opts.settleAvg != null && Number.isFinite(opts.settleAvg)
          ? Number(opts.settleAvg)
          : lastSettlementAvg;
      if (avg != null && Number.isFinite(avg) && beat != null && Number.isFinite(beat)) {
        outcome = avg >= beat ? "above" : "below";
      } else {
        const spotRaw = el.spotValue && el.spotValue.dataset.last;
        let spot = spotRaw != null ? Number(spotRaw) : null;
        if (spot == null || !Number.isFinite(spot)) {
          spot =
            pos.entrySpot != null && Number.isFinite(Number(pos.entrySpot))
              ? Number(pos.entrySpot)
              : null;
        }
        if (
          spot != null &&
          Number.isFinite(spot) &&
          beat != null &&
          Number.isFinite(beat)
        ) {
          outcome = spot >= beat ? "above" : "below";
        }
      }
    }
    // Never leave a trade open across windows when force-settling.
    if (!outcome && opts.force) {
      const hinted = pos.ticker ? settleHintByTicker[pos.ticker] : null;
      if (hinted === "above" || hinted === "below") outcome = hinted;
    }
    if (!outcome) return false;
    const won = outcome === pos.side;
    const payout = won ? pos.contracts * 1 : 0;
    const pl = Math.round((payout - pos.total) * 100) / 100;
    const accounted = pos.accounted !== false && demo.on;
    if (accounted) {
      demo.balance = Math.round((demo.balance + payout) * 100) / 100;
      demo.realizedPl = Math.round((demo.realizedPl + pl) * 100) / 100;
    }
    const sideLabel = pos.side === "above" ? "Above" : "Below";
    demo.lastResult = {
      won,
      pl,
      side: pos.side,
      ticker: pos.ticker,
      text: accounted
        ? won
          ? `SETTLED WIN ${sideLabel} · ${money(pl)} · bal ${money(demo.balance)}`
          : `SETTLED LOSS ${sideLabel} · ${money(pl)} · bal ${money(demo.balance)}`
        : won
          ? `SETTLED WIN ${sideLabel} · ${money(pl)} · paper`
          : `SETTLED LOSS ${sideLabel} · ${money(pl)} · paper`,
    };
    pushTradeHistory({
      id: `${Date.now()}-${pos.ticker || "x"}`,
      at: Date.now(),
      kind: "settle",
      side: pos.side,
      ticker: pos.ticker || null,
      contracts: pos.contracts,
      askCents: pos.askCents,
      total: pos.total,
      fills: pos.fills || 1,
      exitCents: null,
      pl,
      won,
      accounted: !!accounted,
      outcome,
      followedSuggest:
        pos.followedSuggest == null ? null : !!pos.followedSuggest,
      suggestSide: pos.suggestSide || null,
      entrySource: pos.entrySource || null,
    });
    demo.position = null;
    saveDemoState();
    renderDemoUi();
    renderStrategyReport();
    setStatus(won ? "ok" : "warn", demo.lastResult.text);
    return true;
  }

  /** Settle an open demo trade once its 15m window is over. */
  function trySettleOpenAfterClose(data, prevTicker, prevSettleSide, prevSettleAvg) {
    const pos = demo.position;
    if (!pos) return false;
    const liveTicker = data && data.ticker ? data.ticker : null;
    const closed = windowHasClosed(data);
    const rolled =
      !!(prevTicker && liveTicker && prevTicker !== liveTicker) ||
      !!(data && data.waiting_next) ||
      !!(data && data.stale_previous);
    // Position is from a prior window (app slept through 0:00 / reopen).
    const stalePosition =
      !!(pos.ticker && liveTicker && pos.ticker !== liveTicker) ||
      !!(prevTicker && pos.ticker && pos.ticker === prevTicker && rolled);

    if (prevTicker && (prevSettleSide === "above" || prevSettleSide === "below")) {
      settleHintByTicker[prevTicker] = prevSettleSide;
    }
    if (
      data &&
      (data.settlement_side === "above" || data.settlement_side === "below")
    ) {
      const tipTicker = data.ticker || prevTicker || pos.ticker;
      if (tipTicker) settleHintByTicker[tipTicker] = data.settlement_side;
    }

    // Still inside the live window for THIS position — keep marking.
    if (!closed && !rolled && !stalePosition) return false;

    const targetTicker =
      stalePosition && pos.ticker
        ? pos.ticker
        : rolled && prevTicker && pos.ticker === prevTicker
          ? prevTicker
          : pos.ticker;
    return settleDemoPosition(targetTicker, {
      force: true,
      settleSide: prevSettleSide || data.settlement_side || null,
      settleAvg:
        prevSettleAvg != null
          ? prevSettleAvg
          : data.settlement_avg != null
            ? data.settlement_avg
            : lastSettlementAvg,
    });
  }

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  async function ensureAudioReady() {
    const ctx = ensureAudio();
    if (!ctx) return null;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }
    return ctx;
  }

  /** Build a short ascending WAV for HTMLAudio fallback (iOS-friendly). */
  function buildChimeWavUrl(tones) {
    const sr = 22050;
    const gap = Math.floor(sr * 0.03);
    let total = gap;
    for (const tone of tones) total += Math.floor(sr * tone.d) + gap;
    const data = new Float32Array(total);
    let cursor = gap;
    for (const tone of tones) {
      const n = Math.floor(sr * tone.d);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env = Math.min(1, i / (sr * 0.01)) * Math.min(1, (n - i) / (sr * 0.03));
        data[cursor + i] = Math.sin(2 * Math.PI * tone.f * t) * 0.55 * env;
      }
      cursor += n + gap;
    }
    const bytes = new ArrayBuffer(44 + data.length * 2);
    const view = new DataView(bytes);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + data.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, data.length * 2, true);
    let o = 44;
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  }

  let edgeChimeUrl = null;
  let targetChimeUrl = null;
  let clickChimeUrl = null;
  let profitChimeUrl = null;
  let edgeAudioEl = null;
  let targetAudioEl = null;
  let clickAudioEl = null;
  let profitAudioEl = null;
  let audioUnlocked = false;
  /** Last ADD ABOVE / ADD BELOW suggestion key that already clicked. */
  let lastAddSuggestClickKey = null;

  function getEdgeAudio() {
    if (!edgeChimeUrl) {
      // C5–E5–G5 upward reward — Best-buy trigger (not the old sharp ding).
      edgeChimeUrl = buildChimeWavUrl([
        { f: 523.25, d: 0.16 },
        { f: 659.25, d: 0.16 },
        { f: 783.99, d: 0.55 },
      ]);
    }
    if (!edgeAudioEl) {
      edgeAudioEl = new Audio(edgeChimeUrl);
      edgeAudioEl.preload = "auto";
      edgeAudioEl.setAttribute("playsinline", "true");
    }
    return edgeAudioEl;
  }

  function getTargetAudio() {
    if (!targetChimeUrl) {
      targetChimeUrl = buildChimeWavUrl([
        { f: 880, d: 0.18 },
        { f: 1175, d: 0.28 },
      ]);
    }
    if (!targetAudioEl) {
      targetAudioEl = new Audio(targetChimeUrl);
      targetAudioEl.preload = "auto";
      targetAudioEl.setAttribute("playsinline", "true");
    }
    return targetAudioEl;
  }

  function getClickAudio() {
    if (!clickChimeUrl) {
      // Short sharp tick — distinct from the Best Side ascending tone.
      clickChimeUrl = buildChimeWavUrl([{ f: 1680, d: 0.045 }]);
    }
    if (!clickAudioEl) {
      clickAudioEl = new Audio(clickChimeUrl);
      clickAudioEl.preload = "auto";
      clickAudioEl.setAttribute("playsinline", "true");
    }
    return clickAudioEl;
  }

  /** C5–E5–G5 ascending reward for first mark into profit. */
  function getProfitAudio() {
    if (!profitChimeUrl) {
      // Clear ascending C–E–G with a longer ring on G.
      profitChimeUrl = buildChimeWavUrl([
        { f: 523.25, d: 0.16 },
        { f: 659.25, d: 0.16 },
        { f: 783.99, d: 0.55 },
      ]);
    }
    if (!profitAudioEl) {
      profitAudioEl = new Audio(profitChimeUrl);
      profitAudioEl.preload = "auto";
      profitAudioEl.setAttribute("playsinline", "true");
    }
    return profitAudioEl;
  }

  /** Call from a user gesture so later alert tones are allowed. */
  function unlockAudioPlayback() {
    const ctx = ensureAudio();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    // Prime HTMLAudio — required on iOS before programmatic .play() works.
    // Only reset the element if it is still muted (our unlock priming). If a
    // real chime unmuted and started while unlock was pending, do not kill it.
    const prime = (a) => {
      if (!a) return;
      try {
        const wasMuted = a.muted;
        a.muted = true;
        const p = a.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            if (!a.muted) return;
            a.pause();
            a.currentTime = 0;
            a.muted = wasMuted;
          }).catch(() => {
            if (a.muted) a.muted = wasMuted;
          });
        } else {
          a.pause();
          a.currentTime = 0;
          a.muted = wasMuted;
        }
      } catch {
        // ignore
      }
    };
    try {
      prime(getEdgeAudio());
    } catch {
      // ignore
    }
    try {
      prime(getClickAudio());
    } catch {
      // ignore
    }
    try {
      prime(getProfitAudio());
    } catch {
      // ignore
    }
    try {
      prime(getTargetAudio());
    } catch {
      // ignore
    }
    audioUnlocked = true;
  }

  function playHtmlChime(kind) {
    try {
      const a =
        kind === "edge"
          ? getEdgeAudio()
          : kind === "click"
            ? getClickAudio()
            : kind === "profit"
              ? getProfitAudio()
              : getTargetAudio();
      a.muted = false;
      a.volume = 1;
      a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.then === "function") return p.then(() => true).catch(() => false);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  function scheduleOscTones(ctx, tones, wave, peakGain) {
    const now = ctx.currentTime;
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave;
      osc.frequency.value = tone.f;
      gain.gain.setValueAtTime(0.0001, now + tone.t);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + tone.t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.t + tone.d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.t);
      osc.stop(now + tone.t + tone.d + 0.02);
    }
  }

  function vibrateEdge() {
    if (!navigator.vibrate) return;
    try {
      navigator.vibrate([30, 40, 30, 40, 90]);
    } catch {
      // ignore
    }
  }

  function loadStoredEdgeAlertKey() {
    try {
      const raw = sessionStorage.getItem(EDGE_ALERT_STORE_KEY);
      if (raw == null || raw === "") return null;
      return raw;
    } catch {
      return null;
    }
  }

  function restoreEdgeAlertKeyFromSession() {
    const key = loadStoredEdgeAlertKey();
    if (!key || key === "none") return;
    lastClearEdgeAlertKey = key;
    // Identity only — do NOT arm or mark sounded. A quiet-restored sticky
    // used to block alertClearEdge for the whole window with no chime.
  }

  function markEdgeSounded(best, { ask } = {}) {
    if (!best || !best.side) return;
    const ticker = lastTicker || lastFifteenTicker || "";
    const a =
      ask != null
        ? Math.round(Number(ask) || 0)
        : Math.round(Number(best.askCents) || 0);
    lastSoundedEdgeSticky = `${ticker}:${best.side}`;
    lastSoundedAsk = a || 0;
    lastClearEdgeAlertAt = Date.now();
  }

  function sameSoundedSticky(sticky) {
    if (!lastSoundedEdgeSticky || !sticky) return false;
    if (lastSoundedEdgeSticky === sticky) return true;
    // Tolerate ticker-less sticky matches on side.
    const a = String(lastSoundedEdgeSticky).split(":");
    const b = String(sticky).split(":");
    const sideA = a.length >= 2 ? a[a.length - 1] : "";
    const sideB = b.length >= 2 ? b[b.length - 1] : "";
    if (!sideA || sideA !== sideB) return false;
    const tickA = a.length >= 2 ? a.slice(0, -1).join(":") : "";
    const tickB = b.length >= 2 ? b.slice(0, -1).join(":") : "";
    return !tickA || !tickB || tickA === tickB;
  }

  function persistEdgeAlertKey(key) {
    try {
      if (key == null) sessionStorage.removeItem(EDGE_ALERT_STORE_KEY);
      else sessionStorage.setItem(EDGE_ALERT_STORE_KEY, String(key));
    } catch {
      // ignore
    }
  }

  function canPlayTone() {
    const now = Date.now();
    if (now - lastChimeAt < CHIME_GAP_MS) return false;
    lastChimeAt = now;
    return true;
  }

  async function playChime(force) {
    if (!chimeOn && !force) return false;
    if (document.visibilityState !== "visible") return false;
    if (!force && !canPlayTone()) return false;
    if (force) lastChimeAt = Date.now();
    let ok = await playHtmlChime("target");
    if (!ok) {
      const ctx = await ensureAudioReady();
      if (ctx && ctx.state === "running") {
        scheduleOscTones(
          ctx,
          [
            { f: 880, t: 0.0, d: 0.18 },
            { f: 1174.7, t: 0.14, d: 0.28 },
          ],
          "sine",
          0.35
        );
        ok = true;
      }
    }
    if (navigator.vibrate) {
      try {
        navigator.vibrate([40, 60, 80]);
      } catch {
        // ignore
      }
    }
    return ok;
  }

  /** C5–E5–G5 upward reward for clear-edge Best-buy. */
  async function playEdgeChime(force) {
    if (!chimeOn && !force) return false;
    if (document.visibilityState !== "visible") return false;
    // Always debounce unless forced (audio-fallback / test paths).
    if (!force && !canPlayTone()) return false;
    if (force) lastChimeAt = Date.now();
    // HTMLAudio first — reliable on iPhone PWAs after unlockAudioPlayback().
    let ok = await playHtmlChime("edge");
    if (!ok) {
      const ctx = await ensureAudioReady();
      if (ctx && ctx.state === "running") {
        scheduleOscTones(
          ctx,
          [
            { f: 523.25, t: 0.0, d: 0.16 },
            { f: 659.25, t: 0.15, d: 0.16 },
            { f: 783.99, t: 0.3, d: 0.6 },
          ],
          "sine",
          0.48
        );
        ok = true;
      }
    }
    if (!ok) pendingEdgeChime = true;
    if (navigator.vibrate) {
      try {
        navigator.vibrate([30, 40, 30, 40, 90]);
      } catch {
        // ignore
      }
    }
    return ok;
  }

  /**
   * Short click for each new ADD ABOVE / ADD BELOW suggestion.
   * Keeps the original Best Side alert tone; this is an extra tick after it.
   */
  async function playAddSuggestClick({ afterTone = false } = {}) {
    if (!chimeOn) return false;
    if (document.visibilityState !== "visible") return false;
    const play = async () => {
      let ok = await playHtmlChime("click");
      if (!ok) {
        const ctx = await ensureAudioReady();
        if (ctx && ctx.state === "running") {
          scheduleOscTones(
            ctx,
            [{ f: 1680, t: 0.0, d: 0.05 }],
            "square",
            0.28
          );
          ok = true;
        }
      }
      if (ok && navigator.vibrate) {
        try {
          navigator.vibrate(18);
        } catch {
          // ignore
        }
      }
      return ok;
    };
    if (afterTone) {
      await new Promise((r) => setTimeout(r, 420));
      return play();
    }
    return play();
  }

  /**
   * Click once per new ADD ABOVE / ADD BELOW suggestion (same-side add).
   * Original clear-edge alert tone is unchanged — click is additive.
   */
  function maybeClickAddSuggest(best, { sameAsOpen, atRiskCap, suggestStake, afterTone }) {
    if (!best || !best.side) return;
    if (!sameAsOpen || atRiskCap) {
      if (!sameAsOpen) lastAddSuggestClickKey = null;
      return;
    }
    const ask = Math.round(Number(best.askCents) || 0);
    const stake = suggestStake != null ? suggestStake : Math.round(Number(tradeStake) || 0);
    const ticker = lastTicker || lastFifteenTicker || "";
    const key = `${ticker}:${best.side}:${ask}:${stake}`;
    if (key === lastAddSuggestClickKey) return;
    lastAddSuggestClickKey = key;
    playAddSuggestClick({ afterTone: !!afterTone });
  }

  function scheduleProfitOsc(ctx) {
    scheduleOscTones(
      ctx,
      [
        { f: 523.25, t: 0.0, d: 0.16 },
        { f: 659.25, t: 0.15, d: 0.16 },
        { f: 783.99, t: 0.3, d: 0.6 },
      ],
      "sine",
      0.48
    );
  }

  /** C–E–G upward reward when open mark first flips positive. */
  async function playProfitChime(force) {
    if (!chimeOn && !force) return false;
    if (document.visibilityState !== "visible") return false;
    lastChimeAt = Date.now();
    unlockAudioPlayback();
    let ok = false;
    // Prefer Web Audio when running — more reliable than a fresh HTMLAudio
    // element that may not have been gesture-unlocked yet on iOS.
    const ctx = await ensureAudioReady();
    if (ctx && ctx.state === "running") {
      scheduleProfitOsc(ctx);
      ok = true;
    }
    const htmlOk = await playHtmlChime("profit");
    ok = ok || htmlOk;
    if (!ok) pendingProfitChime = true;
    else pendingProfitChime = false;
    if (ok && navigator.vibrate) {
      try {
        navigator.vibrate([40, 50, 40, 50, 120]);
      } catch {
        // ignore
      }
    }
    return ok;
  }

  function alertProfit(pos, mark) {
    if (!chimeOn) return;
    const sideLabel = pos && pos.side === "below" ? "Below" : "Above";
    const plTxt =
      mark && mark.unrealized != null ? formatPl(mark.unrealized) : "in profit";
    const visible =
      document.visibilityState === "visible" && !document.hidden;
    const canNotify =
      "Notification" in window && Notification.permission === "granted";
    const payload = {
      side: pos && pos.side,
      pl: mark && mark.unrealized,
      ticker: (pos && pos.ticker) || lastTicker || lastFifteenTicker || "",
      chimeOn,
    };
    pendingProfitPayload = payload;
    setStatus("ok", `In profit · ${sideLabel} ${plTxt}`);

    ensureAudioReady().then(async (ctx) => {
      if (visible) {
        const played = await playProfitChime(true);
        if (!played) {
          pendingProfitChime = true;
          if (canNotify) {
            postToSW({ type: "profit-notify", force: true, ...payload });
          }
        }
        return;
      }
      // Background / locked — system notification is the audible cue.
      if (canNotify) {
        postToSW({ type: "profit-notify", force: true, ...payload });
      } else {
        try {
          new Notification(`BeatLine · ${sideLabel} in profit`, {
            body: plTxt,
            tag: "beatline-open-profit",
            renotify: true,
            silent: false,
          });
        } catch {
          // ignore
        }
      }
    });
  }

  /**
   * Ring once the first time an open trade's mark is positive.
   * Persisted on the position so reopen / first-tick-already-green still works
   * without re-ringing after a successful chime.
   */
  function maybeAlertProfit(pos, mark) {
    if (!pos) {
      pendingProfitChime = false;
      pendingProfitPayload = null;
      return;
    }
    if (
      !mark ||
      mark.unrealized == null ||
      !Number.isFinite(mark.unrealized)
    ) {
      return;
    }
    if (pos.profitChimed) return;
    if (!(mark.unrealized > 0)) return;
    pos.profitChimed = true;
    saveDemoState();
    alertProfit(pos, mark);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function ensureServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js?v=3.24", {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      swReg = reg;
      if (!ensureServiceWorker._msgBound) {
        ensureServiceWorker._msgBound = true;
        navigator.serviceWorker.addEventListener("message", (ev) => {
          const msg = ev && ev.data;
          if (!msg || !msg.type) return;
          if (msg.type === "edge-state") {
            swEdgeState = {
              edgeKey: msg.edgeKey || null,
              edgeAsk: Number(msg.edgeAsk) || 0,
              edgeAt: Number(msg.edgeAt) || 0,
              chimeOn: !!msg.chimeOn,
            };
            return;
          }
          // Live market Best-buy from server/SW while the app is visible.
          if (msg.type === "market-edge-alert") {
            handleMarketEdgeAlert(msg);
            return;
          }
        });
      }
      postToSW({ type: "get-edge-state" });
      // Brief wait so cold-open first-arm can see a recent BG sticky.
      await new Promise((r) => setTimeout(r, 200));
      // Drop any old notify-held Best Side from prior builds.
      clearHeldAlertEdge();
      return reg;
    } catch (err) {
      console.warn("SW register failed", err);
      return null;
    }
  }

  function postToSW(msg) {
    const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (ctrl) ctrl.postMessage(msg);
    else if (swReg && swReg.active) swReg.active.postMessage(msg);
  }

  /** Page is in front — use visibility, not focus (Android steals focus often). */
  function pageOwnsAlerts() {
    return document.visibilityState === "visible" && !document.hidden;
  }

  /**
   * Server/SW detected a live clear edge while this page is visible.
   * Always try to chime — this is the FG delivery path for pushes that would
   * otherwise only keepalive and leave the user with no phone notify either.
   */
  function handleMarketEdgeAlert(payload) {
    if (!chimeOn) return;
    if (!pageOwnsAlerts()) return;
    if (!payload || !payload.side) return;
    const side = payload.side === "below" ? "below" : "above";
    const ask = Math.round(
      Number(payload.askCents != null ? payload.askCents : payload.ask_cents) ||
        0
    );
    const ticker =
      payload.ticker || lastTicker || lastFifteenTicker || "";
    const sticky = `${ticker}:${side}`;
    if (sameSoundedSticky(sticky)) return;
    if (demo.position && demo.position.side !== side) return;
    const best = {
      side,
      askCents: ask || null,
      pWin:
        payload.pWin != null
          ? Number(payload.pWin)
          : payload.p_win != null
            ? Number(payload.p_win)
            : null,
      suggestedStake:
        payload.suggestStake != null
          ? Number(payload.suggestStake)
          : payload.suggest_stake != null
            ? Number(payload.suggest_stake)
            : null,
    };
    // Bypass resume suppress — this is a live market signal, not a reopen dump.
    const sideLabel = side === "above" ? "Above" : "Below";
    const sug = best.suggestedStake;
    setStatus(
      "ok",
      sug != null
        ? `Clear edge · Buy ${sideLabel} · suggest $${Math.round(sug)}${
            ask ? ` @ ${ask}¢` : ""
          }`
        : `Clear edge · Buy ${sideLabel}${ask ? ` @ ${ask}¢` : ""}`
    );
    ensureAudioReady().then(async () => {
      const played = await playEdgeChime(true);
      vibrateEdge();
      try {
        flashBestSide();
      } catch {
        // ignore
      }
      if (played) {
        pendingEdgeChime = false;
        markEdgeSounded(best, { ask });
        quietArmClearEdge(best, { chimed: true, ticker });
      } else {
        pendingEdgeChime = true;
      }
    });
  }

  function swAlreadySoundedEdge(best) {
    if (!best || !best.side) return false;
    const ticker = lastTicker || lastFifteenTicker || "";
    const sticky = `${ticker}:${best.side}`;
    const now = Date.now();

    // Only trust a real audible event (SW edgeAt after notify / chimed:true).
    // Do NOT treat lastClearEdgeAlertKey alone as sounded — quiet-arm and
    // failed autoplay used to stamp the key and then block pending replay.
    if (!swEdgeState) return false;
    const key = swEdgeState.edgeKey || "";
    const at = Number(swEdgeState.edgeAt) || 0;
    if (!at || now - at >= EDGE_ALERT_COOLDOWN_MS) return false;
    if (key === sticky || key.startsWith(`${sticky}:`)) return true;
    const keySide = String(key).split(":").pop();
    const keyTicker = String(key).includes(":")
      ? String(key).slice(0, String(key).lastIndexOf(":"))
      : "";
    if (keySide === best.side && (!keyTicker || !ticker)) return true;
    return false;
  }

  function quietArmClearEdge(best, { chimed = false, ticker: tickerOverride } = {}) {
    if (!best || !best.side) return;
    const ask = Math.round(Number(best.askCents) || 0);
    const ticker =
      tickerOverride || lastTicker || lastFifteenTicker || "";
    lastClearEdgeAlertKey = `${ticker}:${best.side}:${ask}`;
    lastClearEdgeGoneAt = 0;
    persistEdgeAlertKey(lastClearEdgeAlertKey);
    edgeAlertsArmed = true;
    if (chimed) lastClearEdgeAlertAt = Date.now();
    postToSW({
      type: "edge-armed",
      side: best.side,
      askCents: ask || null,
      ticker,
      chimeOn,
      chimed: !!chimed,
    });
    if (!swEdgeState) swEdgeState = { edgeKey: null, edgeAsk: 0, edgeAt: 0, chimeOn };
    swEdgeState.edgeKey = `${ticker}:${best.side}`;
    swEdgeState.edgeAsk = ask || 0;
    if (chimed) swEdgeState.edgeAt = Date.now();
  }

  function readHeldAlertEdge() {
    if (heldAlertEdge && heldAlertEdge.side) return heldAlertEdge;
    try {
      const raw = sessionStorage.getItem(HELD_ALERT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.side) return null;
      heldAlertEdge = parsed;
      return heldAlertEdge;
    } catch {
      return null;
    }
  }

  function clearHeldAlertEdge() {
    heldAlertEdge = null;
    try {
      sessionStorage.removeItem(HELD_ALERT_KEY);
    } catch {
      // ignore
    }
  }

  function holdAlertEdgeFromNotify(_payload) {
    // No-op: phone notifications must not drive in-app Best Side.
    // Foreground alerts come only from live market scoring in refreshBestSide.
  }

  function heldAlertStillValid() {
    const held = readHeldAlertEdge();
    if (!held || !held.side) return null;
    // Notify-sourced holds from older builds — never trust them for UI.
    if (held.fromNotify) {
      clearHeldAlertEdge();
      return null;
    }
    if (Date.now() - (Number(held.at) || 0) > HELD_ALERT_MS) {
      clearHeldAlertEdge();
      return null;
    }
    if (held.ticker && lastTicker && held.ticker !== lastTicker) {
      clearHeldAlertEdge();
      return null;
    }
    return held;
  }

  function paintHeldAlertEdge(held) {
    if (!held || !held.side || !el.bestSide) return false;
    const side = held.side;
    const ask =
      held.askCents != null
        ? held.askCents
        : side === "above"
          ? lastRoiAsks.above
          : lastRoiAsks.below;
    const pWin =
      held.pWin != null && Number.isFinite(held.pWin) ? held.pWin : 0.55;
    const scored = {
      side,
      askCents: ask,
      pWin,
      ev: Math.max(0.02, pWin - (Number(ask) || 50) / 100),
      score: 0.08,
      roiIfWin: null,
      contracts: null,
      total: null,
      profitIfWin: null,
    };
    const suggestion =
      held.suggestStake != null
        ? {
            stake: held.suggestStake,
            pWin,
            atRiskCap: false,
            lowProb: false,
            contracts: 0,
            total: held.suggestStake,
            profitIfWin: 0,
            roiIfWin: null,
            bankPct: null,
            streak: 0,
            note: "from alert",
          }
        : suggestStakeForEdge(scored);
    const suggestStake =
      suggestion && suggestion.stake >= BUY_AMOUNT_MIN ? suggestion.stake : null;
    lastBestPick = {
      side,
      askCents: ask,
      pWin,
      suggestedStake: suggestStake,
      suggestion,
      fromAlert: true,
    };
    setBestHealthSnap({
      clear: true,
      side,
      askCents: ask,
      pWin,
      suggestedStake: suggestStake,
    });
    el.bestSide.hidden = false;
    try {
      setTimeout(reflowAfterOpenPlChange, 40);
    } catch {
      // ignore
    }
    el.bestSide.classList.toggle("is-below", side === "below");
    el.bestSide.classList.toggle("is-none", false);
    el.bestSide.classList.toggle("is-above", side === "above");
    if (el.bestSideLabel) {
      el.bestSideLabel.textContent =
        side === "above" ? "BUY ABOVE" : "BUY BELOW";
    }
    if (el.bestSideAmount) {
      el.bestSideAmount.textContent =
        suggestStake != null
          ? `From alert · tap to buy $${suggestStake}`
          : "From alert · open buy sheet";
    }
    if (el.bestSideMeta) {
      const conf = Math.round(pWin * 100);
      const askTxt = ask != null ? `ask ${ask}¢` : "ask —";
      el.bestSideMeta.textContent = `${conf}% model · ${askTxt} · alert hold · live may have moved`;
    }
    renderBestSideSuggest(side, suggestion, { waiting: false, fromAlert: true });
    setRoiCardBest(side);
    setDockBestDetail(
      suggestStake != null
        ? `${side === "above" ? "Above" : "Below"} $${suggestStake}`
        : `${side === "above" ? "Above" : "Below"}`,
      side
    );
    lastBestSideKey = `alert:${side}`;
    return true;
  }

  function setPushBadge(on) {
    if (!el.pushBadge) return;
    el.pushBadge.classList.toggle("is-on", !!on);
    el.pushBadge.setAttribute("aria-pressed", on ? "true" : "false");
    el.pushBadge.title = on
      ? "Alerts on — tone for Best buy (works in background)"
      : "Alerts off — tap to enable Best-buy tone";
  }

  function setBgStatus(ok, text) {
    if (!el.bgStatus) return;
    if (!text) {
      el.bgStatus.hidden = true;
      el.bgStatus.textContent = "";
      return;
    }
    el.bgStatus.hidden = false;
    el.bgStatus.textContent = text;
    el.bgStatus.classList.toggle("ok", !!ok);
    el.bgStatus.classList.toggle("warn", !ok);
  }

  /** Light in-app health report — not every poll; ~60s + on open/resume. */
  const SYSTEM_HEALTH_MS = 60_000;
  let systemHealthTimer = null;
  let systemHealthRunning = false;
  let lastSystemHealthAt = 0;
  let lastHealthOk = null;
  let lastHealthIssues = [];
  /** Latest /api/clear-edge snapshot for the health chip. */
  let lastHealthEdge = null;
  /**
   * Live Best Buy Above/Below for the health chip (clear or wait).
   * Updated from refreshBestSide — not only when lastBestPick is set.
   */
  let lastBestHealthSnap = null;

  function setBestHealthSnap(snap) {
    lastBestHealthSnap = snap;
    refreshSystemHealthBestBuy();
  }

  function formatBestBuyHealthBit() {
    const snap = lastBestHealthSnap;
    if (snap && snap.side) {
      const side = snap.side === "below" ? "Below" : "Above";
      const ask =
        snap.askCents != null && Number.isFinite(Number(snap.askCents))
          ? Math.round(Number(snap.askCents))
          : null;
      const conf =
        snap.pWin != null && Number.isFinite(Number(snap.pWin))
          ? Math.round(Number(snap.pWin) * 100)
          : null;
      const stake =
        snap.suggestedStake != null &&
        Number.isFinite(Number(snap.suggestedStake))
          ? Math.round(Number(snap.suggestedStake))
          : null;
      if (snap.clear) {
        let s = `Buy ${side}`;
        if (ask != null) s += ` @ ${ask}¢`;
        if (conf != null) s += ` · ${conf}%`;
        if (stake != null) s += ` · $${stake}`;
        return s;
      }
      if (snap.waitWhy) return `Wait ${side} · ${snap.waitWhy}`;
      if (conf != null && conf < 52) {
        return `Wait ${side} · ${conf}% (need ≥52%)`;
      }
      return ask != null ? `Wait ${side} @ ${ask}¢` : `Wait ${side}`;
    }
    const pick = lastBestPick;
    if (pick && pick.side) {
      const side = pick.side === "below" ? "Below" : "Above";
      const ask =
        pick.askCents != null && Number.isFinite(Number(pick.askCents))
          ? Math.round(Number(pick.askCents))
          : null;
      const conf =
        pick.pWin != null && Number.isFinite(Number(pick.pWin))
          ? Math.round(Number(pick.pWin) * 100)
          : null;
      const stake =
        pick.suggestedStake != null && Number.isFinite(Number(pick.suggestedStake))
          ? Math.round(Number(pick.suggestedStake))
          : null;
      let s = `Buy ${side}`;
      if (ask != null) s += ` @ ${ask}¢`;
      if (conf != null) s += ` · ${conf}%`;
      if (stake != null) s += ` · $${stake}`;
      return s;
    }
    const edge = lastHealthEdge;
    if (edge && edge.side) {
      const side = edge.side === "below" ? "Below" : "Above";
      const ask =
        edge.ask_cents != null && Number.isFinite(Number(edge.ask_cents))
          ? Math.round(Number(edge.ask_cents))
          : null;
      const conf =
        edge.p_win != null && Number.isFinite(Number(edge.p_win))
          ? Math.round(Number(edge.p_win) * 100)
          : null;
      if (edge.clear) {
        let s = `Buy ${side}`;
        if (ask != null) s += ` @ ${ask}¢`;
        if (conf != null) s += ` · ${conf}%`;
        return s;
      }
      if (conf != null && conf < 52) {
        return `Wait ${side} · ${conf}% (need ≥52%)`;
      }
      if (edge.reject === "ev" || (edge.ev != null && Number(edge.ev) <= 0.01)) {
        return `Wait ${side} · edge thin`;
      }
      return ask != null ? `Wait ${side} @ ${ask}¢` : `Wait ${side}`;
    }
    return "No Best buy yet";
  }

  function paintSystemHealth(healthy, issues) {
    if (!el.systemHealth) return;
    lastHealthOk = !!healthy;
    lastHealthIssues = issues || [];
    el.systemHealth.classList.remove("is-checking");
    el.systemHealth.classList.toggle("is-ok", !!healthy);
    el.systemHealth.classList.toggle("is-bad", !healthy);
    const bestBit = formatBestBuyHealthBit();
    if (healthy) {
      el.systemHealth.textContent = `Healthy · ${bestBit}`;
      el.systemHealth.title =
        "Server, Best-buy alerts, service worker, and push look good · " + bestBit;
      return;
    }
    const detail = (issues && issues[0]) || "check Options → Alerts";
    el.systemHealth.innerHTML =
      '<span class="system-health-strike">Healthy</span>' +
      `<span class="system-health-detail">${detail}</span>` +
      `<span class="system-health-detail"> · ${bestBit}</span>`;
    el.systemHealth.title =
      (issues && issues.length ? issues.join(" · ") : detail) +
      " · " +
      bestBit +
      " — Options → Alerts → Enable / Test";
  }

  function refreshSystemHealthBestBuy() {
    if (!el.systemHealth || lastHealthOk == null) return;
    paintSystemHealth(lastHealthOk, lastHealthIssues);
  }

  async function runSystemHealthReport({ force = false } = {}) {
    if (!el.systemHealth) return;
    if (systemHealthRunning) return;
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (!force && now - lastSystemHealthAt < 12_000) return;
    systemHealthRunning = true;
    lastSystemHealthAt = now;
    try {
      const issues = [];

      try {
        const res = await fetch(`/api/health?_=${Date.now()}`, {
          cache: "no-store",
        });
        const health = await res.json();
        if (!(health && health.ok)) issues.push("server down");
        else if (health.push === false) issues.push("push disabled");
      } catch {
        issues.push("server unreachable");
      }

      try {
        const er = await fetch(`/api/clear-edge?_=${Date.now()}`, {
          cache: "no-store",
        });
        if (!er.ok) issues.push("edge API bad");
        else {
          const edge = await er.json().catch(() => null);
          if (!(edge && edge.ok)) issues.push("edge API bad");
          else lastHealthEdge = edge;
        }
      } catch {
        issues.push("edge API down");
      }

      if (!chimeOn) {
        issues.push("alerts off");
      } else if (!("Notification" in window)) {
        issues.push("no notifications API");
      } else if (Notification.permission === "denied") {
        issues.push("notify blocked");
      } else if (Notification.permission !== "granted") {
        issues.push("notify not allowed");
      } else {
        try {
          const reg =
            swReg ||
            (await navigator.serviceWorker.getRegistration().catch(() => null));
          if (!reg) {
            issues.push("no service worker");
          } else {
            const sub = await reg.pushManager.getSubscription();
            if (!sub) issues.push("no push subscription");
            else if (
              !(
                navigator.serviceWorker.controller ||
                (reg.active && reg.active.state === "activated")
              )
            ) {
              issues.push("service worker inactive");
            }
          }
        } catch {
          issues.push("push check failed");
        }
      }

      paintSystemHealth(issues.length === 0, issues);
    } finally {
      systemHealthRunning = false;
    }
  }

  function startSystemHealthLoop() {
    runSystemHealthReport({ force: true });
    if (systemHealthTimer) clearInterval(systemHealthTimer);
    systemHealthTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        runSystemHealthReport({ force: false });
      }
    }, SYSTEM_HEALTH_MS);
  }

  function isBgArmed() {
    if (localStorage.getItem(BG_ARMED_KEY) === "1") return true;
    return (
      "Notification" in window &&
      Notification.permission === "granted" &&
      localStorage.getItem(BG_ARMED_KEY) !== "0"
    );
  }

  function alertsAreOn() {
    return (
      chimeOn &&
      isBgArmed() &&
      "Notification" in window &&
      Notification.permission === "granted"
    );
  }

  function syncAlertsUi() {
    const on = alertsAreOn();
    setPushBadge(on);
    if (el.alertsStatusLine) {
      if (on) {
        el.alertsStatusLine.textContent =
          "On — live Best-buy chime in-app · phone notify when away";
      } else if (chimeOn && "Notification" in window && Notification.permission === "denied") {
        el.alertsStatusLine.textContent =
          "Blocked — site settings → Notifications → Allow, then Enable";
      } else if (chimeOn && "Notification" in window && Notification.permission !== "granted") {
        el.alertsStatusLine.textContent =
          "Off — tap Enable and Allow Notifications (needed for background)";
      } else {
        el.alertsStatusLine.textContent =
          "Off — tap Enable for Best Side buy alerts";
      }
    }
    if (el.alertsEnable) {
      el.alertsEnable.textContent = on ? "Disable" : "Enable";
      el.alertsEnable.classList.toggle("primary", !on);
      el.alertsEnable.classList.toggle("ghost", on);
    }
    if (!on) {
      if ("Notification" in window && Notification.permission === "denied") {
        setBgStatus(false, "Alerts blocked — allow Notifications, then tap 🔔");
      } else {
        setBgStatus(false, "Alerts off — tap 🔔 → Allow, or Options → Enable");
      }
    } else {
      setBgStatus(null, "");
    }
    // Refresh the top health chip when alert state changes (cheap debounce).
    runSystemHealthReport({ force: false });
  }

  async function runChimeTest() {
    unlockAudioPlayback();
    await ensureAudioReady();
    // Best-buy tone (what clear-edge uses) — not the old TO BEAT chime.
    await playEdgeChime(true);
    vibrateEdge();
    if ("Notification" in window && Notification.permission === "granted") {
      // Real background path first: server → Web Push → SW clear_edge.
      try {
        await subscribePush({ forceRefresh: false });
        await fetch("/api/push/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            beat: lastFifteenTarget || lastTarget,
            close_et: closeTimeIso,
            side: (lastBestPick && lastBestPick.side) || "above",
            ask_cents: (lastBestPick && lastBestPick.askCents) || 40,
            p_win: (lastBestPick && lastBestPick.pWin) || 0.55,
            suggest_stake: (lastBestPick && lastBestPick.suggestedStake) || 25,
            ticker: `TEST-${Date.now()}`,
          }),
          cache: "no-store",
        });
      } catch {
        // fall through to local SW notify
      }
      // Local SW Best-buy notification (works even if server push is down).
      postToSW({
        type: "edge-notify",
        force: true,
        bypassDedupe: true,
        side: (lastBestPick && lastBestPick.side) || "above",
        askCents: (lastBestPick && lastBestPick.askCents) || 40,
        pWin: (lastBestPick && lastBestPick.pWin) || 0.55,
        suggestStake: (lastBestPick && lastBestPick.suggestedStake) || 25,
        ticker: lastTicker || lastFifteenTicker || "TEST",
        beat: lastTarget || lastFifteenTarget,
        chimeOn: true,
      });
    }
    setStatus(
      "ok",
      "Test: FG chime now · leave app + Test again for phone notify"
    );
  }

  async function ensureNotificationPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const res = await Notification.requestPermission();
    return res === "granted";
  }

  async function turnAlertsOn() {
    unlockAudioPlayback();
    await ensureAudioReady();
    chimeOn = true;
    localStorage.setItem(CHIME_KEY, "1");
    postToSW({ type: "set-chime", enabled: true });
    // Fresh enable — allow the next real clear edge to sound.
    lastSoundedEdgeSticky = null;
    lastSoundedAsk = 0;
    lastClearEdgeAlertAt = 0;
    pendingEdgeChime = false;
    const allowed = await ensureNotificationPermission();
    if (!allowed) {
      syncAlertsUi();
      setStatus("warn", "Allow Notifications to enable alerts");
      return false;
    }
    const ok = await subscribePush({ forceRefresh: true });
    if (!ok) {
      syncAlertsUi();
      setStatus("warn", "Could not enable push alerts — try Update now, then Enable again");
      return false;
    }
    localStorage.setItem(BG_ARMED_KEY, "1");
    syncAlertsUi();
    await runChimeTest();
    setStatus("ok", "Alerts on — FG chime when open · BG notification when away");
    return true;
  }

  async function turnAlertsOff() {
    chimeOn = false;
    pendingEdgeChime = false;
    localStorage.setItem(CHIME_KEY, "0");
    localStorage.setItem(BG_ARMED_KEY, "0");
    postToSW({ type: "set-chime", enabled: false });
    await unsubscribePush();
    syncAlertsUi();
    setStatus("ok", "Alerts off");
  }

  async function toggleAlerts() {
    if (alertsAreOn()) await turnAlertsOff();
    else await turnAlertsOn();
  }

  async function subscribePush({ forceRefresh = false } = {}) {
    const reg = swReg || (await ensureServiceWorker());
    if (!reg || !reg.pushManager) return false;
    const allowed = await ensureNotificationPermission();
    if (!allowed) return false;
    try {
      const keyRes = await fetch("/api/push/vapid-public", { cache: "no-store" });
      const keyData = await keyRes.json();
      if (!keyData.ok || !keyData.publicKey) return false;
      const publicKey = String(keyData.publicKey);
      let cachedKey = null;
      try {
        cachedKey = localStorage.getItem(VAPID_CACHE_KEY);
      } catch {
        // ignore
      }
      let sub = await reg.pushManager.getSubscription();
      // Render restarts regenerate VAPID keys — old subs go dead. Also force a
      // fresh subscribe when we have no cached key (stale browser subscription).
      // forceRefresh recovers after Chrome revoked a sub that went silent.
      const keyMismatch = !cachedKey || cachedKey !== publicKey;
      if (sub && (keyMismatch || forceRefresh)) {
        try {
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch {
          // ignore
        }
        try {
          await sub.unsubscribe();
        } catch {
          // ignore
        }
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) return false;
      try {
        localStorage.setItem(VAPID_CACHE_KEY, publicKey);
      } catch {
        // ignore
      }
      postToSW({ type: "set-chime", enabled: chimeOn });
      return true;
    } catch (err) {
      console.warn("push subscribe failed", err);
      return false;
    }
  }

  async function unsubscribePush() {
    try {
      const reg = swReg || (await ensureServiceWorker());
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      postToSW({ type: "set-chime", enabled: false });
    } catch {
      // ignore
    }
  }

  async function alertNewTarget(beat, ticker, closeEt) {
    // TO BEAT / new 15m window must NOT alert — only sync SW ticker state.
    // Best-buy (clear edge) is the alert trigger users want.
    postToSW({
      type: "arm-state",
      ticker,
      target: beat,
      chimeOn,
    });
  }

  function maybeChimeNewFifteenTarget(beat, ticker, source, closeEt) {
    const isFifteen =
      source === "kalshi" || (ticker && String(ticker).includes("KXBTC15M"));
    if (!isFifteen) return;

    const beatReady = beat != null && Number.isFinite(beat);
    // Quiet sync only — never chime or notify on TO BEAT generation.
    if (ticker) lastFifteenTicker = ticker;
    if (beatReady) lastFifteenTarget = beat;
    postToSW({
      type: "arm-state",
      ticker: lastFifteenTicker,
      target: lastFifteenTarget,
      chimeOn,
    });
  }

  function alertClearEdge(best) {
    if (!best || !best.side) return false;
    if (!chimeOn) return false;
    // Waiting for unlock tap to replay — don't re-enter every poll.
    if (pendingEdgeChime) return false;
    // Flat: always alert. Same-side open: still alert (add decision).
    // Opposite open: skip — that used to spam BUY while already long the other way.
    if (demo.position && demo.position.side !== best.side) return false;

    const side = best.side;
    const ask = Math.round(Number(best.askCents) || 0);
    const ticker = lastTicker || lastFifteenTicker || "";
    const sticky = `${ticker}:${side}`;
    const alertKey = `${ticker}:${side}:${ask}`;
    const now = Date.now();

    // Brief reopen quiet window only — do NOT mark sounded here.
    // Marking sounded without chiming/notifying silenced both phone and FG.
    if (now < suppressEdgeChimeUntil) {
      return false;
    }

    if (now - lastClearEdgeAlertAt < EDGE_ALERT_COOLDOWN_MS) return false;

    const sameSounded = sameSoundedSticky(sticky);
    const askImproved =
      sameSounded &&
      lastSoundedAsk > 0 &&
      ask > 0 &&
      lastSoundedAsk - ask >= 5;

    // Dedupe on what actually chimed/notified — never on quiet-arm keys.
    if (sameSounded && !askImproved) return false;

    // Remember identity so refresh doesn't thrash UI; sounding stamps separately.
    lastClearEdgeAlertKey = alertKey;
    lastClearEdgeGoneAt = 0;
    persistEdgeAlertKey(alertKey);

    const sideLabel = side === "above" ? "Above" : "Below";
    const sug =
      lastBestPick && lastBestPick.side === side && lastBestPick.suggestedStake
        ? lastBestPick.suggestedStake
        : null;
    setStatus(
      "ok",
      sug != null
        ? `Clear edge · Buy ${sideLabel} · suggest $${sug}${ask ? ` @ ${ask}¢` : ""}`
        : `Clear edge · Buy ${sideLabel}${ask ? ` @ ${ask}¢` : ""}`
    );

    const visible = pageOwnsAlerts();
    const canNotify =
      "Notification" in window && Notification.permission === "granted";
    const edgePayload = {
      side,
      askCents: ask || null,
      pWin: best.pWin,
      suggestStake: sug,
      ticker: lastTicker || lastFifteenTicker,
      beat: lastTarget,
      chimeOn,
    };

    // Foreground (focused): in-app chime (+ vibrate). Background: system notification.
    ensureAudioReady().then(async () => {
      if (visible) {
        const played = await playEdgeChime(true);
        vibrateEdge();
        try {
          flashBestSide();
        } catch {
          // ignore
        }
        if (!played) {
          // Autoplay blocked — retry on the next tap. Do not mark sounded.
          pendingEdgeChime = true;
        } else {
          pendingEdgeChime = false;
          markEdgeSounded(best, { ask });
          postToSW({
            type: "edge-armed",
            side,
            askCents: ask || null,
            ticker: lastTicker || lastFifteenTicker || "",
            chimeOn,
            chimed: true,
          });
          if (!swEdgeState) {
            swEdgeState = { edgeKey: null, edgeAsk: 0, edgeAt: 0, chimeOn };
          }
          const t = lastTicker || lastFifteenTicker || "";
          swEdgeState.edgeKey = `${t}:${side}`;
          swEdgeState.edgeAsk = ask || 0;
          swEdgeState.edgeAt = Date.now();
        }
        return;
      }

      // App in background / locked — phone notification is the chime.
      // Best Side UI stays on live market only (no notify mirroring).
      if (canNotify) {
        const ctrl =
          navigator.serviceWorker && navigator.serviceWorker.controller;
        if (ctrl) {
          postToSW({ type: "edge-notify", force: true, ...edgePayload });
          markEdgeSounded(best, { ask });
        } else {
          try {
            const title =
              sug != null
                ? `BeatLine · Best buy ${sideLabel} · $${sug}`
                : `BeatLine · Best buy · ${sideLabel}`;
            const bits = [];
            if (ask) bits.push(`ask ${ask}¢`);
            if (best.pWin != null) bits.push(`${Math.round(best.pWin * 100)}% model`);
            new Notification(title, {
              body: bits.length ? bits.join(" · ") : "Clear Best Side edge",
              tag: "kalshi-clear-edge",
              renotify: true,
              silent: false,
            });
            markEdgeSounded(best, { ask });
          } catch {
            // ignore — leave unsounded so a later path can still ring
          }
        }
      }
    });
    return true;
  }

  let swReg = null;

  function setStatus(state, text) {
    el.status.dataset.state = state;
    el.status.textContent = text;
  }

  function setTfLabel() {
    if (el.chartTfLabel) {
      el.chartTfLabel.textContent = `Chart · ${TF_LABELS[currentTf] || currentTf}`;
    }
  }

  function formatWindow(closeIso, closeEt) {
    // Always render settle time in Pacific from the ISO close, so labels
    // stay PST/PDT even if an older server still sends an ET string.
    if (closeIso) {
      try {
        return new Date(closeIso).toLocaleString("en-US", {
          timeZone: APP_TZ,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZoneName: "short",
        });
      } catch {
        // fall through
      }
    }
    return closeEt || "";
  }

  function bookText(bid, ask) {
    if (bid == null && ask == null) return "book —";
    if (bid != null && ask != null) return `bid ${bid}¢ · ask ${ask}¢`;
    if (bid != null) return `bid ${bid}¢`;
    return `ask ${ask}¢`;
  }

  let lastRoiAsks = { above: null, below: null };
  let lastRoiBids = { above: null, below: null };
  const STAKE_KEY = "kalshiTradeStake";
  let tradeStake = Number(localStorage.getItem(STAKE_KEY));
  if (!Number.isFinite(tradeStake)) tradeStake = 1;
  tradeStake = Math.max(1, Math.min(100, Math.round(tradeStake)));
  if (tradeStake < 1) tradeStake = 1;

  function dollars(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /** Kalshi taker fee ≈ round_up(0.07 × C × P × (1 − P)) to the next cent. */
  function kalshiTakerFee(contracts, priceDollars) {
    const C = Math.max(0, contracts);
    const P = Math.min(0.99, Math.max(0.01, priceDollars));
    const raw = 0.07 * C * P * (1 - P);
    return Math.ceil(raw * 100 - 1e-9) / 100;
  }

  /**
   * Spend about `stakeUsd` buying this side at the ask (taker).
   * Returns null if we can't price it.
   */
  function roiForStake(askCents, stakeUsd) {
    if (askCents == null || !Number.isFinite(askCents)) return null;
    const P = askCents / 100;
    if (!(P > 0 && P < 1)) return null;
    if (!(stakeUsd > 0)) {
      return {
        askCents: Math.round(askCents),
        contracts: 0,
        cost: 0,
        fee: 0,
        total: 0,
        winPayout: 0,
        profitIfWin: 0,
        roiIfWin: null,
        empty: true,
      };
    }
    const contracts = Math.max(1, Math.floor(stakeUsd / P));
    const cost = contracts * P;
    const fee = kalshiTakerFee(contracts, P);
    const total = cost + fee;
    const winPayout = contracts * 1;
    const profitIfWin = winPayout - total;
    const roiIfWin = total > 0 ? (profitIfWin / total) * 100 : null;
    return {
      askCents: Math.round(askCents),
      contracts,
      cost,
      fee,
      total,
      winPayout,
      profitIfWin,
      roiIfWin,
      empty: false,
    };
  }

  /** Standard normal CDF (Abramowitz & Stegun 26.2.17). */
  function normalCdf(x) {
    if (!Number.isFinite(x)) return 0.5;
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const erf =
      1 -
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * erf);
  }

  /**
   * Model P(Above) from live vs beat and time left.
   * Uses ~55% annualized BTC vol; settlement mode trusts the running avg.
   */
  function noteSpotTrail(px) {
    if (!TREND_BIAS_ENABLED) return;
    if (px == null || !Number.isFinite(px)) return;
    const t = Date.now();
    spotTrail.push({ t, px });
    const cutoff = t - SPOT_TRAIL_MS;
    while (spotTrail.length && spotTrail[0].t < cutoff) spotTrail.shift();
    if (spotTrail.length > 180) spotTrail = spotTrail.slice(-180);
  }

  /**
   * Short-term BTC tape: up / down / flat over ~5–10 minutes.
   * When enabled, Best Side prefers with-trend buys (Below in a dump).
   */
  function shortTermTrend() {
    if (!TREND_BIAS_ENABLED) {
      return { bias: "flat", strength: 0, move5: 0, move10: 0 };
    }
    const now = Date.now();
    let move5 = null;
    let move10 = null;
    if (spotTrail.length >= 4) {
      const last = spotTrail[spotTrail.length - 1].px;
      const in5 = spotTrail.filter((p) => p.t >= now - 5 * 60 * 1000);
      const in10 = spotTrail.filter((p) => p.t >= now - 10 * 60 * 1000);
      if (in5.length >= 2) move5 = last - in5[0].px;
      if (in10.length >= 2) move10 = last - in10[0].px;
    }
    if (
      (move5 == null || move10 == null) &&
      Array.isArray(lastCandleData) &&
      lastCandleData.length >= 4
    ) {
      const bars = lastCandleData;
      const last = Number(bars[bars.length - 1].close);
      let step = 60;
      const dt =
        Number(bars[bars.length - 1].time) - Number(bars[bars.length - 2].time);
      if (Number.isFinite(dt) && dt > 0) step = dt;
      const n5 = Math.max(1, Math.round(300 / step));
      const n10 = Math.max(1, Math.round(600 / step));
      if (move5 == null && bars.length > n5) {
        move5 = last - Number(bars[bars.length - 1 - n5].close);
      }
      if (move10 == null && bars.length > n10) {
        move10 = last - Number(bars[bars.length - 1 - n10].close);
      }
    }
    const m5 = move5 == null ? 0 : move5;
    const m10 = move10 == null ? 0 : move10;
    if (move5 == null && move10 == null) {
      return { bias: "flat", strength: 0, move5: 0, move10: 0 };
    }
    // ~$80 / 5m or ~$140 / 10m ≈ strong tape on BTC.
    const down = Math.max(-m5 / 80, -m10 / 140, 0);
    const up = Math.max(m5 / 80, m10 / 140, 0);
    let strength = 0;
    if (down > up && down >= 0.35) strength = -Math.min(1, down);
    else if (up > down && up >= 0.35) strength = Math.min(1, up);
    const bias =
      strength <= -0.35 ? "down" : strength >= 0.35 ? "up" : "flat";
    return { bias, strength, move5: m5, move10: m10 };
  }

  function applyTrendToScores(scored, trend) {
    if (!TREND_BIAS_ENABLED) return scored;
    if (!trend || trend.bias === "flat" || !scored.length) return scored;
    const mag = Math.abs(trend.strength);
    return scored.map((s) => {
      let score = s.score;
      if (trend.bias === "down" && s.side === "above") {
        score -= 0.1 + 0.18 * mag;
      } else if (trend.bias === "up" && s.side === "below") {
        score -= 0.1 + 0.18 * mag;
      } else if (trend.bias === "down" && s.side === "below") {
        // Actively prefer downside buys in a dump.
        score += 0.08 * mag;
      } else if (trend.bias === "up" && s.side === "above") {
        score += 0.08 * mag;
      }
      return { ...s, score, trendBias: trend.bias };
    });
  }

  function modelProbAbove(spot, beat, secsLeft) {
    if (spot == null || beat == null || !Number.isFinite(spot) || !Number.isFinite(beat)) {
      return null;
    }
    if (lastSettlementMode && lastSettlementSide === "above") return 0.97;
    if (lastSettlementMode && lastSettlementSide === "below") return 0.03;
    if (lastSettlementMode && lastSettlementAvg != null && Number.isFinite(lastSettlementAvg)) {
      const d = lastSettlementAvg - beat;
      // Soft settle lean while samples accumulate.
      return normalCdf(d / Math.max(8, Math.abs(beat) * 0.00015));
    }
    const t = Math.max(1, Number(secsLeft) || 1);
    // Dollar sigma over remaining window (~55% ann. vol), floored for noise.
    const sigma = Math.max(
      8,
      Math.abs(beat) * 0.55 * Math.sqrt(t / (365.25 * 24 * 3600))
    );
    return normalCdf((spot - beat) / sigma);
  }

  function scoreSide(side, askCents, modelProb, stakeUsd) {
    if (askCents == null || modelProb == null || !Number.isFinite(modelProb)) {
      return null;
    }
    const sized = roiForStake(askCents, Math.max(1, stakeUsd || 1));
    if (!sized) return null;
    const bought = stakeUsd > 0 ? roiForStake(askCents, stakeUsd) : null;
    const pWin = side === "above" ? modelProb : 1 - modelProb;
    const costPer = sized.total / Math.max(1, sized.contracts);
    const ev = pWin * 1 - costPer;
    const risk = Math.max(0.04, 1 - pWin);
    return {
      side,
      askCents: sized.askCents,
      pWin,
      ev,
      risk,
      score: ev / risk,
      costPer,
      roiIfWin: bought && !bought.empty ? bought.roiIfWin : sized.roiIfWin,
      contracts: bought && !bought.empty ? bought.contracts : 0,
      total: bought && !bought.empty ? bought.total : 0,
      profitIfWin: bought && !bought.empty ? bought.profitIfWin : 0,
    };
  }

  /** Bankroll used for suggested sizing (demo balance when on). */
  function sizingBankroll() {
    if (demo.on && Number.isFinite(demo.balance)) {
      return Math.max(0, demo.balance);
    }
    const start = Number(demo.start);
    return Number.isFinite(start) && start > 0 ? start : DEMO_DEFAULT_START;
  }

  const SUGGEST_STEPS = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100];

  function snapSuggestStake(n, cap) {
    const target = Math.max(BUY_AMOUNT_MIN, Math.min(cap, Math.round(n)));
    let best = BUY_AMOUNT_MIN;
    let bestDist = Infinity;
    for (const step of SUGGEST_STEPS) {
      if (step > cap) break;
      const d = Math.abs(step - target);
      if (d < bestDist || (d === bestDist && step <= target)) {
        best = step;
        bestDist = d;
      }
    }
    // Prefer not rounding *up* past Kelly target when risk-averse.
    if (best > target && bestDist > 0) {
      const lower = SUGGEST_STEPS.filter((s) => s <= target && s <= cap);
      if (lower.length) best = lower[lower.length - 1];
    }
    return Math.max(BUY_AMOUNT_MIN, Math.min(cap, best));
  }

  /**
   * Suggest $ for a clear Best Side — Green Spike sizing (Aug 5 / v9.33):
   * fractional Kelly ~22–40%, bank risk ~2.5–12%. No drawdown/streak shrink.
   */
  function suggestStakeForEdge(best) {
    if (!best || best.askCents == null) return null;
    const bank = sizingBankroll();
    const hardCap = Math.max(
      BUY_AMOUNT_MIN,
      Math.min(BUY_AMOUNT_MAX, Math.floor(bank) || BUY_AMOUNT_MIN)
    );
    const unit = roiForStake(best.askCents, Math.min(10, hardCap));
    if (!unit || unit.empty || !(unit.contracts > 0)) return null;
    const costPer = unit.total / unit.contracts;
    if (!(costPer > 0 && costPer < 1)) return null;

    const pWin = Math.max(0.01, Math.min(0.99, Number(best.pWin) || 0.5));
    const edge = pWin - costPer;
    if (!(edge > 0)) {
      const minSized = roiForStake(best.askCents, BUY_AMOUNT_MIN);
      return {
        stake: BUY_AMOUNT_MIN,
        contracts: minSized && !minSized.empty ? minSized.contracts : 0,
        total: minSized && !minSized.empty ? minSized.total : BUY_AMOUNT_MIN,
        profitIfWin: minSized && !minSized.empty ? minSized.profitIfWin : 0,
        roiIfWin:
          minSized && !minSized.empty ? minSized.roiIfWin : unit.roiIfWin,
        bankPct: bank > 0 ? (BUY_AMOUNT_MIN / bank) * 100 : 0,
        pWin,
        lowProb: pWin < 0.5,
        note: "no edge at this ask",
      };
    }

    const kellyFull = edge / (1 - costPer);
    const edgeStrength = Math.min(
      1,
      Math.max(0, (Number(best.score) - 0.04) / 0.18)
    );
    const kellyShare = 0.22 + 0.18 * edgeStrength; // ~22–40% Kelly
    let maxBankPct = 0.03 + 0.07 * edgeStrength;
    const roi = Number(best.roiIfWin);
    if (Number.isFinite(roi)) {
      if (roi >= 120) maxBankPct *= 1.15;
      else if (roi < 40) maxBankPct *= 0.7;
    }
    maxBankPct = Math.min(0.12, Math.max(0.025, maxBankPct));

    const kellyUsd = bank * kellyFull * kellyShare;
    const riskUsd = bank * maxBankPct;
    let raw = Math.min(kellyUsd, riskUsd, hardCap);
    const minForOne = Math.ceil(costPer * 100) / 100;
    raw = Math.max(raw, Math.min(hardCap, Math.max(BUY_AMOUNT_MIN, minForOne)));

    const stake = snapSuggestStake(raw, hardCap);
    const sized = roiForStake(best.askCents, stake);
    return {
      stake,
      pWin,
      atRiskCap: false,
      lowProb: pWin < 0.5,
      contracts: sized && !sized.empty ? sized.contracts : 0,
      total: sized && !sized.empty ? sized.total : stake,
      profitIfWin: sized && !sized.empty ? sized.profitIfWin : 0,
      roiIfWin: sized && !sized.empty ? sized.roiIfWin : unit.roiIfWin,
      bankPct: bank > 0 ? (stake / bank) * 100 : 0,
      streak: 0,
      note: "¼-Kelly bal",
    };
  }

  /**
   * Suggested size for either side (not just Best Side) so the buy sheet can
   * always recommend a stake: maximize ROI while capping bankroll risk.
   */
  function suggestForSide(side) {
    if (side !== "above" && side !== "below") return null;
    const ask = side === "above" ? lastRoiAsks.above : lastRoiAsks.below;
    if (ask == null || !Number.isFinite(ask)) return null;
    const spotRaw = el.spotValue && el.spotValue.dataset.last;
    const spot = spotRaw != null ? Number(spotRaw) : null;
    const beat = lastTarget;
    const secs = secondsLeft();
    if (spot == null || beat == null || secs == null) return null;
    const modelP = modelProbAbove(spot, beat, secs);
    if (modelP == null) return null;
    const scored = scoreSide(side, ask, modelP, tradeStake);
    if (!scored) return null;
    const suggestion = suggestStakeForEdge(scored);
    if (!suggestion) return null;
    return { ...suggestion, side, pWin: scored.pWin, ev: scored.ev };
  }

  function secondsLeft() {
    if (!closeTimeIso) return null;
    const end = Date.parse(closeTimeIso);
    if (!Number.isFinite(end)) return null;
    return Math.max(0, Math.floor((end - Date.now()) / 1000));
  }

  function flashBestSide() {
    if (!el.bestSide) return;
    el.bestSide.classList.remove("is-flash");
    // Restart CSS animation.
    void el.bestSide.offsetWidth;
    el.bestSide.classList.add("is-flash");
    if (bestSideFlashTimer) clearTimeout(bestSideFlashTimer);
    bestSideFlashTimer = setTimeout(() => {
      if (el.bestSide) el.bestSide.classList.remove("is-flash");
    }, 1300);
  }

  async function refreshVersionLine() {
    if (!el.appVersionLine) return;
    let server = null;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = await res.json();
      server = data && data.version;
    } catch {
      // offline — show what we have
    }
    el.appVersionLine.textContent = server
      ? `App ${APP_VERSION} · ${BEST_SIDE_PROFILE_LABEL} · server ${server}`
      : `App ${APP_VERSION} · ${BEST_SIDE_PROFILE_LABEL}`;
  }

  /**
   * Drop the service worker + caches and hard-reload, so a home-screen PWA
   * picks up new code without digging through Android settings.
   * Saved balance/history live in localStorage + the server, so they survive.
   */
  async function forceAppUpdate() {
    if (el.appUpdate) {
      el.appUpdate.disabled = true;
      el.appUpdate.textContent = "Updating…";
    }
    setStatus("ok", "Fetching latest BeatLine…");
    try {
      await pushDemoStateToServer();
    } catch {
      // keep going; local copy still intact
    }
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // ignore
    }
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      // ignore
    }
    const url = new URL(window.location.href);
    url.searchParams.set("fresh", String(Date.now()));
    window.location.replace(url.toString());
  }

  /**
   * Pull-to-refresh. Requires a hard downward pull while every scroll
   * parent is already at the top — normal up/down scrolling must not fire.
   */
  const PULL_ARM_PX = 56; // ignore small downward noise while scrolling
  const PULL_TRIGGER_PX = 160; // hard pull before release will update
  const PULL_MAX_PX = 220;
  let pullStartY = null;
  let pullStartX = null;
  let pullActive = false;
  let pullDistance = 0;
  let pullRunning = false;

  function setPullIndicator(distance, ready) {
    if (!el.pullRefresh) return;
    const shown = distance > PULL_ARM_PX;
    el.pullRefresh.classList.toggle("is-visible", shown);
    el.pullRefresh.classList.toggle("is-ready", !!ready);
    const y = Math.min(distance, PULL_MAX_PX);
    el.pullRefresh.style.transform = `translate(-50%, ${Math.max(
      -120,
      y - 44
    )}px)`;
    if (el.pullRefreshLabel && !pullRunning) {
      el.pullRefreshLabel.textContent = ready
        ? "Release to update"
        : "Pull hard to refresh";
    }
  }

  function resetPullIndicator() {
    pullStartY = null;
    pullStartX = null;
    pullActive = false;
    pullDistance = 0;
    if (!el.pullRefresh) return;
    el.pullRefresh.classList.remove("is-visible", "is-ready", "is-loading");
    el.pullRefresh.style.transform = "translate(-50%, -120%)";
  }

  /** True when this node (and ancestors) are scrolled away from the top. */
  function hasScrollRoomAbove(from) {
    let node = from instanceof Element ? from : null;
    while (node && node !== document.documentElement) {
      try {
        const style = window.getComputedStyle(node);
        const oy = style.overflowY;
        const canScroll =
          oy === "auto" || oy === "scroll" || oy === "overlay" || node === el.appShell;
        if (canScroll && node.scrollTop > 2) return true;
      } catch {
        // ignore
      }
      node = node.parentElement;
    }
    // Locked tall chart makes .app-shell the page scroller.
    if (el.appShell && el.appShell.scrollTop > 2) return true;
    if (el.tradeStack && el.tradeStack.scrollTop > 2) return true;
    return false;
  }

  /** Only start the gesture where a hard pull-down isn't already a scroll. */
  function pullAllowedFrom(target) {
    if (pullRunning || buySheetOpen || optionsOpen || tutorialOpen) return false;
    if (!(target instanceof Element)) return false;
    if (target.closest("#chart, .chart-wrap, .chart-resize, .buy-sheet, .options-sheet, .tutorial"))
      return false;
    if (target.closest("input, button, a, .open-pl-bar, .stake-slider-wrap"))
      return false;
    // Any scrollable panel mid-scroll → this is page scrolling, not refresh.
    if (hasScrollRoomAbove(target)) return false;
    return true;
  }

  function onPullStart(ev) {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    if (!pullAllowedFrom(ev.target)) {
      pullStartY = null;
      pullStartX = null;
      return;
    }
    pullStartY = t.clientY;
    pullStartX = t.clientX;
    pullActive = false;
    pullDistance = 0;
  }

  function onPullMove(ev) {
    if (pullStartY == null || pullRunning) return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    // If a scroller moved off the top mid-gesture, abort.
    if (hasScrollRoomAbove(ev.target)) {
      resetPullIndicator();
      return;
    }
    const dy = t.clientY - pullStartY;
    const dx = Math.abs(t.clientX - (pullStartX || t.clientX));
    // Sideways / diagonal pans are not a refresh pull.
    if (dx > 28 && dx > dy * 0.7) {
      resetPullIndicator();
      return;
    }
    if (dy <= PULL_ARM_PX) {
      if (pullActive) {
        pullActive = false;
        pullDistance = 0;
        setPullIndicator(0, false);
      }
      return;
    }
    pullActive = true;
    // Rubber-band so it never feels like a free-scrolling page.
    pullDistance =
      dy < PULL_MAX_PX ? dy : PULL_MAX_PX + (dy - PULL_MAX_PX) * 0.15;
    setPullIndicator(pullDistance, pullDistance >= PULL_TRIGGER_PX);
  }

  function onPullEnd() {
    if (pullStartY == null || pullRunning) return;
    const trigger = pullActive && pullDistance >= PULL_TRIGGER_PX;
    if (!trigger) {
      resetPullIndicator();
      return;
    }
    pullRunning = true;
    if (el.pullRefresh) {
      el.pullRefresh.classList.add("is-visible", "is-ready", "is-loading");
      el.pullRefresh.style.transform = "translate(-50%, 12px)";
    }
    if (el.pullRefreshLabel) el.pullRefreshLabel.textContent = "Updating…";
    forceAppUpdate();
  }

  function bankPctText(pct) {
    if (pct == null || !Number.isFinite(pct)) return null;
    if (pct > 0 && pct < 1) return "<1%";
    return `${pct.toFixed(0)}%`;
  }

  /** Suggested-buy row inside the Best Side block. */
  function renderBestSideSuggest(side, suggestion, opts = {}) {
    if (!el.bestSideSuggest) return;
    const s = suggestion || (side ? suggestForSide(side) : null);
    if (!side || !s) {
      el.bestSideSuggest.hidden = true;
      return;
    }
    if (s.atRiskCap) {
      el.bestSideSuggest.hidden = false;
      el.bestSideSuggest.classList.add("is-waiting");
      el.bestSideSuggest.classList.remove("is-below");
      const kicker = el.bestSideSuggest.querySelector(".best-side-suggest-kicker");
      if (kicker) kicker.textContent = "Position sized";
      if (el.bestSideSuggestAmount) {
        el.bestSideSuggestAmount.textContent = "Hold — max risk";
      }
      if (el.bestSideSuggestMeta) {
        const pct = bankPctText(s.bankPct);
        el.bestSideSuggestMeta.textContent = pct
          ? `Open position already risks ${pct} of balance`
          : "Open position at max suggested risk";
      }
      return;
    }
    if (!(s.stake >= BUY_AMOUNT_MIN)) {
      el.bestSideSuggest.hidden = true;
      return;
    }
    const waiting = !!opts.waiting || !!s.lowProb;
    const adding = !!opts.adding;
    el.bestSideSuggest.hidden = false;
    el.bestSideSuggest.classList.toggle("is-waiting", waiting);
    el.bestSideSuggest.classList.toggle("is-below", !waiting && side === "below");
    const conf = s.pWin != null ? Math.round(s.pWin * 100) : null;
    const kicker = el.bestSideSuggest.querySelector(".best-side-suggest-kicker");
    if (kicker) {
      kicker.textContent = s.lowProb
        ? "Suggested buy"
        : adding
          ? "Suggested add"
          : opts.fromAlert
            ? "From alert"
            : waiting
              ? "Best lean"
              : "Suggested buy";
    }
    if (el.bestSideSuggestAmount) {
      if (waiting || s.lowProb) {
        el.bestSideSuggestAmount.textContent =
          side === "above" ? "Above · wait" : "Below · wait";
      } else {
        el.bestSideSuggestAmount.textContent = `$${s.stake}${
          s.contracts ? ` · ${s.contracts} cts` : ""
        }`;
      }
    }
    if (el.bestSideSuggestMeta) {
      if (waiting || s.lowProb) {
        el.bestSideSuggestMeta.textContent =
          conf != null
            ? `${conf}% model · no clear edge at this ask yet`
            : "No clear edge at this ask yet";
      } else {
        const roi =
          s.roiIfWin != null
            ? `${s.roiIfWin >= 0 ? "+" : ""}${s.roiIfWin.toFixed(0)}% if win`
            : "";
        const bankTxt = bankPctText(s.bankPct);
        const bank = bankTxt ? `risks ${bankTxt} of balance` : "";
        const cool =
          s.streak >= 2 ? "cooled after losses" : s.streak >= 1 ? "sized down" : "";
        const lead = adding
          ? `${side === "above" ? "Above" : "Below"} add size`
          : `${side === "above" ? "Above" : "Below"}`;
        el.bestSideSuggestMeta.textContent = [lead, roi, bank, cool]
          .filter(Boolean)
          .join(" · ");
      }
    }
  }

  function setRoiCardBest(side) {
    const above = document.querySelector(".roi-card.above");
    const below = document.querySelector(".roi-card.below");
    if (above) above.classList.toggle("is-best", side === "above");
    if (below) below.classList.toggle("is-best", side === "below");
  }

  function setDockBestDetail(text, side) {
    if (el.dockBestDetail) el.dockBestDetail.textContent = text || "—";
    if (el.dockBuyBest) {
      el.dockBuyBest.classList.toggle("is-above", side === "above");
      el.dockBuyBest.classList.toggle("is-below", side === "below");
      el.dockBuyBest.classList.toggle("is-none", !side);
    }
  }

  function markClearEdgeGone() {
    const now = Date.now();
    if (!lastClearEdgeGoneAt) lastClearEdgeGoneAt = now;
    if (now - lastClearEdgeGoneAt >= EDGE_GONE_RESET_MS) {
      lastClearEdgeAlertKey = "none";
      persistEdgeAlertKey("none");
      lastSoundedEdgeSticky = null;
      lastSoundedAsk = 0;
    }
  }

  function refreshBestSide() {
    if (!el.bestSide) return;
    const wasVisible = !el.bestSide.hidden;
    const spotRaw = el.spotValue && el.spotValue.dataset.last;
    const spot = spotRaw != null ? Number(spotRaw) : null;
    const beat = lastTarget;
    const secs = secondsLeft();
    const aboveAsk = lastRoiAsks.above;
    const belowAsk = lastRoiAsks.below;

    const syncBestSideLayout = () => {
      const nowVisible = !el.bestSide.hidden;
      if (nowVisible !== wasVisible) {
        setTimeout(reflowAfterOpenPlChange, 40);
      }
    };

    if (
      spot == null ||
      !Number.isFinite(spot) ||
      beat == null ||
      !Number.isFinite(beat) ||
      secs == null ||
      (aboveAsk == null && belowAsk == null)
    ) {
      // Keep the last Best Side paint during brief data gaps (open-P/L
      // reflows / spot hiccups) so the card doesn't blink out.
      if (lastBestPick && lastBestPick.side) return;
      // Phone alert landed but tape/network is gone — still show Suggested buy.
      const heldGap = heldAlertStillValid();
      if (heldGap && paintHeldAlertEdge(heldGap)) {
        if (!edgeAlertsArmed) edgeAlertsArmed = true;
        syncBestSideLayout();
        return;
      }
      el.bestSide.hidden = true;
      renderBestSideSuggest(null, null);
      setRoiCardBest(null);
      setDockBestDetail("—", null);
      lastBestSideKey = null;
      lastBestPick = null;
      clearEdgeLatched = false;
      markClearEdgeGone();
      setBestHealthSnap(null);
      syncBestSideLayout();
      return;
    }

    const modelP = modelProbAbove(spot, beat, secs);
    let scored = [];
    const a = scoreSide("above", aboveAsk, modelP, tradeStake);
    const b = scoreSide("below", belowAsk, modelP, tradeStake);
    if (a) scored.push(a);
    if (b) scored.push(b);
    if (!scored.length) {
      if (lastBestPick && lastBestPick.side) return;
      const heldEmpty = heldAlertStillValid();
      if (heldEmpty && paintHeldAlertEdge(heldEmpty)) {
        if (!edgeAlertsArmed) edgeAlertsArmed = true;
        syncBestSideLayout();
        return;
      }
      el.bestSide.hidden = true;
      renderBestSideSuggest(null, null);
      setRoiCardBest(null);
      setDockBestDetail("—", null);
      lastBestPick = null;
      clearEdgeLatched = false;
      markClearEdgeGone();
      setBestHealthSnap(null);
      syncBestSideLayout();
      return;
    }

    scored.sort((x, y) => y.score - x.score);
    // Green Spike: no tape lean — pure window-vs-beat scoring.
    if (TREND_BIAS_ENABLED) {
      const trend = shortTermTrend();
      scored = applyTrendToScores(scored, trend);
      scored.sort((x, y) => y.score - x.score);
    }
    let best = scored[0];
    // Haircut noisy/thin books and early-window coin flips with tiny edge.
    if (lastThinBook) best = { ...best, score: best.score - 0.08 };
    // Profile: Green Spike (August 5 morning / v9.33).
    // Simple favorites-only clear edge — no sticky latch, no cheap underdogs.
    clearEdgeLatched = false;
    const clear =
      best.ev > 0.01 &&
      best.score > 0.04 &&
      best.pWin >= 0.52 &&
      !(secs > 12 * 60 && Math.abs(best.ev) < 0.03);

    if (clear) {
      // Keep a matching held alert for open-time dedupe; only drop stale
      // holds for a different ticker/side.
      const held = readHeldAlertEdge();
      if (
        held &&
        held.side &&
        (held.side !== best.side ||
          (held.ticker && lastTicker && held.ticker !== lastTicker))
      ) {
        clearHeldAlertEdge();
      }
    } else {
      // Live tape not clear — never paint Best Side from a phone notification.
      // (Older builds held notify payloads here; that caused false in-app alerts.)
    }

    el.bestSide.hidden = false;
    syncBestSideLayout();
    el.bestSide.classList.toggle("is-below", clear && best.side === "below");
    el.bestSide.classList.toggle("is-none", !clear);
    el.bestSide.classList.toggle("is-above", clear && best.side === "above");

    if (!clear) {
      if (el.bestSideLabel) el.bestSideLabel.textContent = "No clear edge";
      if (el.bestSideAmount) {
        el.bestSideAmount.textContent =
          tradeStake > 0 ? `Holding $${tradeStake}` : "Set a trade size";
      }
      // Compact wait state — avoid a tall Suggested Buy card stacking over ROI.
      renderBestSideSuggest(best.side, suggestStakeForEdge(best), {
        waiting: true,
      });
      if (el.bestSideMeta) {
        const lead = spot - beat;
        const conf = Math.round((Number(best.pWin) || 0) * 100);
        const why =
          best.pWin < 0.52
            ? `${conf}% model (need ≥52%)`
            : best.ev <= 0.01
              ? "edge too thin"
              : "wait for better ask";
        el.bestSideMeta.textContent = `Live ${
          lead >= 0 ? "+" : ""
        }$${lead.toFixed(0)} · ${why} · no alert yet`;
      }
      setRoiCardBest(null);
      setDockBestDetail("Wait", null);
      lastBestPick = null;
      const conf = Math.round((Number(best.pWin) || 0) * 100);
      const waitWhy =
        best.pWin < 0.52
          ? `${conf}% (need ≥52%)`
          : best.ev <= 0.01
            ? "edge thin"
            : "better ask";
      setBestHealthSnap({
        clear: false,
        side: best.side,
        askCents: best.askCents,
        pWin: best.pWin,
        suggestedStake: null,
        waitWhy,
      });
      const noneKey = "none";
      if (lastBestSideKey !== noneKey) {
        lastBestSideKey = noneKey;
        flashBestSide();
      }
      if (!edgeAlertsArmed) {
        edgeAlertsArmed = true;
        if (!lastClearEdgeAlertKey) {
          lastClearEdgeAlertKey = "none";
          persistEdgeAlertKey("none");
        }
      } else {
        markClearEdgeGone();
      }
      return;
    }

    lastClearEdgeGoneAt = 0;
    const suggestion = suggestStakeForEdge(best);
    const atRiskCap = !!(suggestion && suggestion.atRiskCap);
    const suggestStake =
      !atRiskCap &&
      suggestion &&
      suggestion.stake >= BUY_AMOUNT_MIN
        ? suggestion.stake
        : null;
    if (suggestStake != null && suggestion) {
      best = {
        ...best,
        contracts: suggestion.contracts || best.contracts,
        total: suggestion.total || best.total,
        profitIfWin: suggestion.profitIfWin || best.profitIfWin,
        roiIfWin:
          suggestion.roiIfWin != null ? suggestion.roiIfWin : best.roiIfWin,
      };
    }
    lastBestPick = {
      side: best.side,
      askCents: best.askCents,
      pWin: best.pWin,
      suggestedStake: suggestStake,
      suggestion,
      atRiskCap,
    };
    setBestHealthSnap({
      clear: true,
      side: best.side,
      askCents: best.askCents,
      pWin: best.pWin,
      suggestedStake: suggestStake,
    });
    const suggestKey = `${lastTicker || "?"}:${best.side}:${Math.round(
      Number(best.askCents) || 0
    )}`;
    if (suggestKey !== lastLoggedSuggestKey) {
      lastLoggedSuggestKey = suggestKey;
      pushSuggestLog({
        ticker: lastTicker || null,
        side: best.side,
        askCents: best.askCents,
        stake: suggestStake,
        key: suggestKey,
      });
    }
    const openPos = demo.position;
    const sameAsOpen = !!(openPos && openPos.side === best.side);
    const oppositeOpen = !!(openPos && openPos.side !== best.side);
    const label = atRiskCap
      ? sameAsOpen
        ? best.side === "above"
          ? "HOLD ABOVE"
          : "HOLD BELOW"
        : best.side === "above"
          ? "BUY ABOVE"
          : "BUY BELOW"
      : oppositeOpen
      ? best.side === "above"
        ? "BEST ABOVE"
        : "BEST BELOW"
      : sameAsOpen
        ? best.side === "above"
          ? "ADD ABOVE"
          : "ADD BELOW"
        : best.side === "above"
          ? "BUY ABOVE"
          : "BUY BELOW";
    if (el.bestSideLabel) el.bestSideLabel.textContent = label;
    if (el.bestSideAmount) {
      if (atRiskCap && sameAsOpen) {
        el.bestSideAmount.textContent = "Max risk — no add suggested";
      } else if (oppositeOpen) {
        el.bestSideAmount.textContent =
          suggestStake != null
            ? `Best entry $${suggestStake} · close to flip`
            : `Edge vs your ${
                openPos.side === "above" ? "Above" : "Below"
              } · close to flip`;
      } else if (suggestStake != null) {
        el.bestSideAmount.textContent = sameAsOpen
          ? `Tap to add $${suggestStake}`
          : `Tap to buy $${suggestStake}`;
      } else if (tradeStake <= 0) {
        el.bestSideAmount.textContent = "Set a trade size";
      } else {
        el.bestSideAmount.textContent = `${
          sameAsOpen ? "Add" : "Buy"
        } $${tradeStake} · ${best.contracts} contract${
          best.contracts === 1 ? "" : "s"
        }`;
      }
    }
    if (el.bestSideMeta) {
      const roiTxt =
        best.roiIfWin != null
          ? `${best.roiIfWin >= 0 ? "+" : ""}${best.roiIfWin.toFixed(0)}% if win`
          : "";
      const conf = Math.round(best.pWin * 100);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      const lead = spot - beat;
      const openNote = sameAsOpen
        ? ` · open ${openPos.contracts} cts`
        : oppositeOpen
          ? ` · opposite your open ${openPos.side === "above" ? "Above" : "Below"}`
          : "";
      const sizeNote = atRiskCap
        ? " · hold size"
        : suggestion && suggestStake != null
          ? ` · ~${suggestion.bankPct.toFixed(0)}% bal`
          : "";
      const coolNote =
        suggestion && suggestion.streak >= 2 ? " · cooled" : "";
      el.bestSideMeta.textContent =
        `${conf}% model · ask ${best.askCents}¢ · ${roiTxt}${sizeNote}${coolNote} · live ${
          lead >= 0 ? "+" : ""
        }$${lead.toFixed(0)} · ${m}:${String(s).padStart(2, "0")} left${openNote}`;
    }
    // Keep suggesting entry side + $ size after a fill (adds / next entry),
    // same as before the buy — don't blank the suggestion once you're in.
    renderBestSideSuggest(best.side, suggestion, {
      waiting: false,
      adding: sameAsOpen,
    });
    setRoiCardBest(best.side);
    setDockBestDetail(
      atRiskCap && sameAsOpen
        ? "Hold · max risk"
        : suggestStake != null
          ? `${best.side === "above" ? "Above" : "Below"} $${suggestStake}`
          : `${best.side === "above" ? "Above" : "Below"} ${best.askCents}¢`,
      best.side
    );

    const key = clear
      ? `${best.side}:${Math.round(Number(best.askCents) || 0)}:${
          openPos ? openPos.side : "flat"
        }`
      : "none";
    if (key !== lastBestSideKey) {
      lastBestSideKey = key;
      flashBestSide();
    }
    let didEdgeAlert = false;
    if (!edgeAlertsArmed) {
      edgeAlertsArmed = true;
      // First paint: chime only for a NEW sticky. If BG already notified this
      // edge (SW/held/session), quiet-sync — never dump on open.
      if (
        chimeOn &&
        !atRiskCap &&
        !swAlreadySoundedEdge(best) &&
        !heldAlertStillValid()
      ) {
        didEdgeAlert = !!alertClearEdge(best);
      } else {
        if (swAlreadySoundedEdge(best) || heldAlertStillValid()) {
          markEdgeSounded(best);
        }
        quietArmClearEdge(best, { chimed: false });
      }
      maybeClickAddSuggest(best, {
        sameAsOpen,
        atRiskCap,
        suggestStake,
        afterTone: didEdgeAlert,
      });
      return;
    }
    if (!atRiskCap) didEdgeAlert = !!alertClearEdge(best);
    // Extra click for every new ADD ABOVE / ADD BELOW (keeps original alert tone).
    maybeClickAddSuggest(best, {
      sameAsOpen,
      atRiskCap,
      suggestStake,
      afterTone: didEdgeAlert,
    });
  }

  function fillRoiCard(priceEl, summaryEl, detailEl, askCents, stakeUsd) {
    if (priceEl) {
      priceEl.textContent =
        askCents != null && Number.isFinite(askCents)
          ? `Ask ${Math.round(askCents)}¢`
          : "Ask —";
    }
    const r = roiForStake(askCents, stakeUsd);
    if (!r) {
      if (summaryEl) summaryEl.textContent = "—";
      if (detailEl) detailEl.textContent = "Need a live ask";
      return false;
    }
    if (r.empty) {
      if (summaryEl) summaryEl.textContent = "Slide to size a trade";
      if (detailEl) detailEl.textContent = "Set a dollar amount above";
      return true;
    }
    const roiTxt =
      r.roiIfWin != null
        ? `${r.roiIfWin >= 0 ? "+" : ""}${r.roiIfWin.toFixed(0)}%`
        : "—";
    if (summaryEl) {
      summaryEl.textContent = `Win ${dollars(r.profitIfWin)} · ${roiTxt}`;
    }
    if (detailEl) {
      detailEl.innerHTML =
        `${r.contracts} contracts<br>` +
        `Cost ${dollars(r.cost)} + fee ${dollars(r.fee)}<br>` +
        `Total ${dollars(r.total)} · lose = ${dollars(r.total)}`;
    }
    return true;
  }

  function syncStakeUi() {
    if (el.stakeSlider) {
      el.stakeSlider.value = String(tradeStake);
      el.stakeSlider.setAttribute("aria-valuenow", String(tradeStake));
    }
    if (el.stakeValue) el.stakeValue.textContent = `$${tradeStake}`;
  }

  function renderRoi() {
    if (!el.roiPanel) return;
    syncStakeUi();
    const okA = fillRoiCard(
      el.roiAbovePrice,
      el.roiAboveSummary,
      el.roiAboveDetail,
      lastRoiAsks.above,
      tradeStake
    );
    const okB = fillRoiCard(
      el.roiBelowPrice,
      el.roiBelowSummary,
      el.roiBelowDetail,
      lastRoiAsks.below,
      tradeStake
    );
    el.roiPanel.hidden = !(okA || okB);
    if (el.stakeStrip) el.stakeStrip.hidden = !(okA || okB);
    try {
      refreshBestSide();
    } catch (err) {
      console.warn("refreshBestSide failed", err);
      try {
        setStatus("warn", String(err && err.message ? err.message : err));
      } catch {
        // ignore
      }
    }
    renderDemoUi();
    syncBuyDock();
  }

  function syncBuyDock() {
    const pos = demo.position;
    const canAbove = canBuySide("above");
    const canBelow = canBuySide("below");
    if (el.dockAbovePct) {
      el.dockAbovePct.textContent =
        lastRoiAsks.above != null ? `${Math.round(lastRoiAsks.above)}¢` : "—";
    }
    if (el.dockBelowPct) {
      el.dockBelowPct.textContent =
        lastRoiAsks.below != null ? `${Math.round(lastRoiAsks.below)}¢` : "—";
    }
    if (el.dockBuyAbove) {
      // Never HTML-disable opposite side — clicks must explain "close to flip".
      el.dockBuyAbove.disabled = false;
      el.dockBuyAbove.classList.toggle("is-locked", !canAbove);
      el.dockBuyAbove.setAttribute("aria-disabled", canAbove ? "false" : "true");
      const label = el.dockBuyAbove.querySelector(".dock-label");
      if (label) {
        label.textContent =
          pos && pos.side === "above"
            ? "Add Above"
            : pos && pos.side === "below"
              ? "Close to flip"
              : "Buy Above";
      }
    }
    if (el.dockBuyBelow) {
      el.dockBuyBelow.disabled = false;
      el.dockBuyBelow.classList.toggle("is-locked", !canBelow);
      el.dockBuyBelow.setAttribute("aria-disabled", canBelow ? "false" : "true");
      const label = el.dockBuyBelow.querySelector(".dock-label");
      if (label) {
        label.textContent =
          pos && pos.side === "below"
            ? "Add Below"
            : pos && pos.side === "above"
              ? "Close to flip"
              : "Buy Below";
      }
    }
    if (el.dockBuyBest) {
      const bestSide = lastBestPick && lastBestPick.side;
      const canBest = !!(bestSide && canBuySide(bestSide));
      el.dockBuyBest.disabled = false;
      el.dockBuyBest.classList.toggle("is-locked", !canBest);
      el.dockBuyBest.setAttribute("aria-disabled", canBest ? "false" : "true");
      const label = el.dockBuyBest.querySelector(".dock-label");
      if (label) {
        if (!bestSide) label.textContent = "Best";
        else if (pos && pos.side === bestSide) label.textContent = "Add Best";
        else if (pos && pos.side !== bestSide) label.textContent = "Close to flip";
        else label.textContent = "Best";
      }
    }
  }

  function setTradeStake(n) {
    tradeStake = Math.max(1, Math.min(100, Math.round(Number(n) || 1)));
    localStorage.setItem(STAKE_KEY, String(tradeStake));
    renderRoi();
  }

  function updateRoi(data) {
    let aboveAsk = data && data.yes_ask_pct;
    let belowAsk = data && data.no_ask_pct;
    let aboveBid = data && data.yes_bid_pct;
    let belowBid = data && data.no_bid_pct;
    if (aboveAsk == null && data && data.yes_pct != null) aboveAsk = data.yes_pct;
    if (belowAsk == null && data && data.no_pct != null) belowAsk = data.no_pct;
    if (belowAsk == null && data && data.yes_bid_pct != null) {
      belowAsk = Math.max(1, 100 - data.yes_bid_pct);
    }
    if (aboveAsk == null && data && data.no_bid_pct != null) {
      aboveAsk = Math.max(1, 100 - data.no_bid_pct);
    }
    // Reject locked/extreme asks (settlement 0–1¢) — prefer mid %.
    const usable = (c) => c != null && Number.isFinite(c) && c >= 1 && c <= 99;
    const midOk = (c) => usable(c) && c >= 5 && c <= 95;
    if ((!usable(aboveAsk) || (aboveAsk <= 2 && midOk(data && data.yes_pct))) && usable(data && data.yes_pct)) {
      aboveAsk = data.yes_pct;
    }
    if ((!usable(belowAsk) || (belowAsk <= 2 && midOk(data && data.no_pct))) && usable(data && data.no_pct)) {
      belowAsk = data.no_pct;
    }
    if (!usable(aboveAsk)) aboveAsk = null;
    if (!usable(belowAsk)) belowAsk = null;
    if (aboveBid == null && data && data.yes_pct != null) {
      aboveBid = Math.max(1, Math.round(data.yes_pct) - 1);
    }
    if (belowBid == null && data && data.no_pct != null) {
      belowBid = Math.max(1, Math.round(data.no_pct) - 1);
    }
    if (belowBid == null && aboveAsk != null) {
      belowBid = Math.max(1, 100 - aboveAsk);
    }
    if (aboveBid == null && belowAsk != null) {
      aboveBid = Math.max(1, 100 - belowAsk);
    }
    if (!usable(aboveBid)) aboveBid = aboveAsk != null ? Math.max(1, aboveAsk - 1) : null;
    if (!usable(belowBid)) belowBid = belowAsk != null ? Math.max(1, belowAsk - 1) : null;
    lastRoiAsks = { above: aboveAsk, below: belowAsk };
    lastRoiBids = { above: aboveBid, below: belowBid };
    renderRoi();
    if (buySheetOpen) refreshBuySheetPreview();
  }

  function updateOdds(data) {
    if (!el.oddsRow || !el.yesPct || !el.noPct) return;
    const yes = data && data.yes_pct;
    const no = data && data.no_pct;
    if (yes == null || no == null || !Number.isFinite(yes) || !Number.isFinite(no)) {
      // Keep the last good Market Chance paint through brief Kalshi gaps /
      // rollover blips — flashing "—" looked like the book was broken.
      if (lastYesPct != null) {
        if (el.oddsHint) {
          el.oddsHint.textContent = "Refreshing book…";
        }
        return;
      }
      el.oddsRow.hidden = true;
      el.yesPct.textContent = "—";
      el.noPct.textContent = "—";
      if (el.yesBook) el.yesBook.textContent = "—";
      if (el.noBook) el.noBook.textContent = "—";
      if (el.roiPanel) el.roiPanel.hidden = true;
      if (el.stakeStrip) el.stakeStrip.hidden = true;
      if (el.bestSide) el.bestSide.hidden = true;
      setRoiCardBest(null);
      return;
    }
    el.oddsRow.hidden = false;
    el.yesPct.textContent = `${Math.round(yes)}%`;
    el.noPct.textContent = `${Math.round(no)}%`;
    lastYesPct = Math.round(yes);
    if (el.yesBook) {
      el.yesBook.textContent = bookText(data.yes_bid_pct, data.yes_ask_pct);
    }
    if (el.noBook) {
      el.noBook.textContent = bookText(data.no_bid_pct, data.no_ask_pct);
    }
    if (el.oddsHint) {
      if (data.thin_book) el.oddsHint.textContent = "Wide spread · thin book";
      else if (data.odds_fresh) el.oddsHint.textContent = "Fresh window · book mid";
      else if (data.spread_cents != null) {
        el.oddsHint.textContent = `Spread ${data.spread_cents}¢`;
      } else el.oddsHint.textContent = "What traders are pricing";
    }
    lastThinBook = !!(data && data.thin_book);
    updateRoi(data);
  }

  function updateEdgeLine(spot) {
    if (!el.edgeLine) return;
    if (
      spot == null ||
      !Number.isFinite(spot) ||
      lastTarget == null ||
      !Number.isFinite(lastTarget) ||
      lastYesPct == null
    ) {
      el.edgeLine.hidden = true;
      el.edgeLine.textContent = "";
      return;
    }
    const delta = spot - lastTarget;
    const side = delta >= 0 ? "above" : "below";
    const abs = Math.abs(delta);
    let left = "—";
    if (closeTimeIso) {
      const ms = Date.parse(closeTimeIso) - Date.now();
      if (Number.isFinite(ms) && ms > 0) {
        const sec = Math.floor(ms / 1000);
        left = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      } else if (Number.isFinite(ms) && ms <= 0) left = "0:00";
    }
    el.edgeLine.hidden = false;
    el.edgeLine.textContent = `Live is $${abs.toFixed(2)} ${side} beat · Above ${lastYesPct}% · ${left} left`;
  }

  function updateSettlement(data) {
    if (!el.settleBanner) return;
    const mode = !!(data && data.settlement_mode);
    lastSettlementMode = mode;
    lastSettlementSide = (data && data.settlement_side) || null;
    if (
      lastTicker &&
      (lastSettlementSide === "above" || lastSettlementSide === "below")
    ) {
      settleHintByTicker[lastTicker] = lastSettlementSide;
    }
    if (!mode) {
      el.settleBanner.hidden = true;
      el.settleBanner.classList.remove("is-above", "is-below");
      lastSettlementAvg = null;
      applySettleLine(null);
      refreshBestSide();
      return;
    }
    el.settleBanner.hidden = false;
    const avg = data.settlement_avg;
    lastSettlementAvg = avg;
    const side = data.settlement_side;
    el.settleBanner.classList.toggle("is-above", side === "above");
    el.settleBanner.classList.toggle("is-below", side === "below");
    if (el.settleTitle) {
      el.settleTitle.textContent =
        side === "above"
          ? "Last minute · average is ABOVE"
          : side === "below"
            ? "Last minute · average is BELOW"
            : "Last minute · settling now";
    }
    if (el.settleAvg) {
      el.settleAvg.textContent =
        avg != null && Number.isFinite(avg)
          ? `${money(avg)} avg`
          : "Collecting samples…";
    }
    if (el.settleMeta) {
      const n = data.settlement_samples || 0;
      const d = data.settlement_delta;
      const deltaTxt =
        d != null && Number.isFinite(d)
          ? ` · ${d >= 0 ? "+" : "-"}$${Math.abs(d).toFixed(2)} vs beat`
          : "";
      el.settleMeta.textContent = `Kalshi settles on a 60-second average, not the last tick · ${n}/60 samples${deltaTxt}`;
    }
    applySettleLine(avg);
    refreshBestSide();
    if (demo.position) renderDemoUi();
  }

  function updateSpot(lastClose) {
    if (!el.spotValue) return;
    if (lastClose == null || !Number.isFinite(lastClose)) {
      el.spotValue.textContent = "—";
      if (el.spotDelta) {
        el.spotDelta.textContent = "—";
        el.spotDelta.className = "spot-delta";
      }
      updateEdgeLine(null);
      return;
    }
    el.spotValue.textContent = money(lastClose);
    el.spotValue.dataset.last = String(lastClose);
    noteSpotTrail(lastClose);

    if (prevSpot != null && Number.isFinite(prevSpot)) {
      if (lastClose > prevSpot) el.spotValue.style.color = "#1ac96b";
      else if (lastClose < prevSpot) el.spotValue.style.color = "#d45454";
    }
    prevSpot = lastClose;

    if (el.spotDelta) {
      if (lastTarget != null && Number.isFinite(lastTarget)) {
        const delta = lastClose - lastTarget;
        const sign = delta >= 0 ? "+" : "-";
        el.spotDelta.textContent = `${sign}$${Math.abs(delta).toFixed(2)}`;
        el.spotDelta.className = "spot-delta " + (delta >= 0 ? "up" : "down");
      } else {
        el.spotDelta.textContent = "—";
        el.spotDelta.className = "spot-delta";
      }
    }
    updateEdgeLine(lastClose);
    refreshBestSide();
    if (demo.position) renderDemoUi();
  }

  function updateCountdown() {
    if (!el.countdown) return;
    if (!closeTimeIso) {
      el.countdown.textContent = "—:—";
      el.countdown.classList.remove("urgent");
      if (el.countdownMeta) el.countdownMeta.textContent = "Until this 15m window ends";
      refreshBestSide();
      return;
    }
    const end = Date.parse(closeTimeIso);
    if (!Number.isFinite(end)) {
      el.countdown.textContent = "—:—";
      refreshBestSide();
      return;
    }
    let ms = end - Date.now();
    if (ms <= 0) {
      el.countdown.textContent = "0:00";
      el.countdown.classList.add("urgent");
      if (el.countdownMeta) {
        el.countdownMeta.textContent = "Window closed · settling trade…";
      }
      startRolloverBurst();
      // Lock the demo trade at close — don't leave it open to reverse.
      if (demo.position) {
        settleDemoPosition(demo.position.ticker, {
          force: true,
          settleSide: lastSettlementSide,
          settleAvg: lastSettlementAvg,
        });
      }
      refreshBestSide();
      if (demo.position) renderDemoUi();
      return;
    }
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    el.countdown.textContent = `${m}:${String(s).padStart(2, "0")}`;
    el.countdown.classList.toggle("urgent", totalSec <= 60);
    if (el.countdownMeta) {
      el.countdownMeta.textContent =
        totalSec <= 60
          ? "Final minute — settlement average decides the winner"
          : "Until this 15m window ends";
    }
    if (totalSec <= 25) startRolloverBurst();
    refreshBestSide();
    if (demo.position) renderDemoUi();
  }

  function clearRolloverBurst() {
    if (rolloverTimer) {
      clearInterval(rolloverTimer);
      rolloverTimer = null;
    }
    rolloverUntil = 0;
  }

  function startRolloverBurst() {
    const until = Date.now() + ROLLOVER_BURST_MS;
    if (rolloverUntil > Date.now() && until - rolloverUntil < 5_000) {
      rolloverUntil = Math.max(rolloverUntil, until);
      return;
    }
    rolloverUntil = until;
    if (rolloverTimer) return;
    const tick = () => {
      if (Date.now() > rolloverUntil) {
        clearRolloverBurst();
        return;
      }
      refreshTarget({ forceCandles: true });
      refreshSpot();
    };
    tick();
    rolloverTimer = setInterval(tick, ROLLOVER_TICK_MS);
  }

  function scheduleBoundaryRefresh(closeIso) {
    if (boundaryTimer) {
      clearTimeout(boundaryTimer);
      boundaryTimer = null;
    }
    if (!closeIso) return;
    const closeMs = Date.parse(closeIso);
    if (!Number.isFinite(closeMs)) return;
    const wait = Math.max(250, closeMs + BOUNDARY_PAD_MS - Date.now());
    boundaryTimer = setTimeout(() => {
      startRolloverBurst();
    }, wait);
  }

  function ensureChart() {
    if (chart || !window.LightweightCharts) return;
    const { createChart, CrosshairMode, LineStyle } = window.LightweightCharts;
    chart = createChart(el.chart, {
      layout: {
        background: { color: "#121c18" },
        textColor: "#8fa399",
        fontFamily: "IBM Plex Sans, Segoe UI, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        // Start zoomed in near live price / TO BEAT; pinch or scroll for more history.
        barSpacing: 18,
        minBarSpacing: 2,
        rightOffset: 3,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    series = chart.addCandlestickSeries({
      upColor: "#1ac96b",
      downColor: "#d45454",
      borderVisible: false,
      wickUpColor: "#1ac96b",
      wickDownColor: "#d45454",
      // Keep Price to beat (and settle avg) inside the visible scale.
      autoscaleInfoProvider: (original) => {
        const res = original();
        if (!res) return res;
        const extras = [
          lastTarget,
          lastSettlementAvg,
          lastBreakevenPrice,
          demo.position && demo.position.entrySpot,
          demo.position && demo.position.beat,
        ].filter((v) => v != null && Number.isFinite(v));
        if (!extras.length) return res;
        let min = res.priceRange ? res.priceRange.minValue : extras[0];
        let max = res.priceRange ? res.priceRange.maxValue : extras[0];
        for (const v of extras) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        const pad = Math.max((max - min) * 0.1, 25);
        return {
          ...res,
          priceRange: {
            minValue: min - pad,
            maxValue: max + pad,
          },
        };
      },
    });
    ensureChart.LineStyle = LineStyle;
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (lastTarget != null) syncToBeatChip(lastTarget, true);
      });
    } catch {
      // ignore
    }
    resizeChart();
  }

  function resizeChart() {
    if (!chart || !el.chart) return;
    const wrap = el.chart.parentElement;
    const width = el.chart.clientWidth || (wrap && wrap.clientWidth) || 0;
    let height = el.chart.clientHeight || 0;
    if ((height < 120 || width < 40) && wrap) {
      const tf = wrap.querySelector(".tf-btns");
      const tfH = tf ? tf.offsetHeight : 0;
      height = Math.max(height, wrap.clientHeight - tfH - 2);
    }
    const w = Math.max(1, Math.floor(width || 1));
    const h = Math.max(1, Math.floor(height || 1));
    if (w < 40 || h < 80) return;
    chart.applyOptions({ width: w, height: h });
    if (lastTarget != null) syncToBeatChip(lastTarget, true);
  }

  /** Default viewport: ~8–10 recent candles (zoomed in), not full history. */
  const CHART_VISIBLE_BARS = 10;

  function applyDefaultChartZoom() {
    if (!chart || !lastCandleData.length) return;
    const n = lastCandleData.length;
    const visible = Math.min(CHART_VISIBLE_BARS, n);
    try {
      chart.timeScale().setVisibleLogicalRange({
        from: n - visible,
        to: n - 1 + 2,
      });
    } catch {
      try {
        chart.timeScale().scrollToRealTime();
      } catch {
        // ignore
      }
    }
  }

  function clearTargetLine() {
    if (targetLine && series) {
      try {
        series.removePriceLine(targetLine);
      } catch {
        // ignore
      }
    }
    targetLine = null;
    syncToBeatChip(null, false);
  }

  function clearTargetSeries() {
    if (targetSeries && chart) {
      try {
        chart.removeSeries(targetSeries);
      } catch {
        // ignore
      }
    }
    targetSeries = null;
  }

  function clearSettleLine() {
    if (settleLine && series) {
      try {
        series.removePriceLine(settleLine);
      } catch {
        // ignore
      }
    }
    settleLine = null;
  }

  function clearBreakevenLines() {
    if (breakevenLine && series) {
      try {
        series.removePriceLine(breakevenLine);
      } catch {
        // ignore
      }
    }
    if (entryLine && series) {
      try {
        series.removePriceLine(entryLine);
      } catch {
        // ignore
      }
    }
    breakevenLine = null;
    entryLine = null;
    lastBreakevenPrice = null;
  }

  function buildFlatLineData(price) {
    if (!Number.isFinite(price) || !lastCandleData.length) return [];
    const t0 = lastCandleData[0].time;
    const t1 = lastCandleData[lastCandleData.length - 1].time;
    if (t0 == null || t1 == null) return [];
    if (t0 === t1) return [{ time: t0, value: price }];
    return [
      { time: t0, value: price },
      { time: t1, value: price },
    ];
  }

  function applyBreakevenLines(beat, entrySpot, modelBe, side) {
    ensureChart();
    clearBreakevenLines();
    if (!series || !demo.position) return;

    // Price to beat stays on TARGET — only add trade-specific model / entry lines.
    const winAt = beat != null && Number.isFinite(Number(beat)) ? Number(beat) : null;
    lastBreakevenPrice = winAt;

    if (
      modelBe != null &&
      Number.isFinite(modelBe) &&
      (winAt == null || Math.abs(modelBe - winAt) > 8)
    ) {
      entryLine = series.createPriceLine({
        price: modelBe,
        color: "#ffd28a",
        lineWidth: 2,
        lineStyle: (ensureChart.LineStyle && ensureChart.LineStyle.Dotted) || 1,
        axisLabelVisible: true,
        title: "MODEL B/E",
      });
      lastBreakevenPrice = modelBe;
    } else if (entrySpot != null && Number.isFinite(entrySpot)) {
      entryLine = series.createPriceLine({
        price: entrySpot,
        color: "#8ab4ff",
        lineWidth: 1,
        lineStyle: (ensureChart.LineStyle && ensureChart.LineStyle.Dotted) || 1,
        axisLabelVisible: true,
        title: "ENTRY",
      });
    }

    try {
      series.applyOptions({});
    } catch {
      // ignore
    }
  }

  function syncToBeatChip(price, visible) {
    if (!el.toBeatChip) return;
    const show = !!visible && price != null && Number.isFinite(Number(price));
    if (!show) {
      el.toBeatChip.hidden = true;
      return;
    }
    // Sit on the right price axis, just above the white beat price tag.
    let y = null;
    try {
      if (series) y = series.priceToCoordinate(Number(price));
    } catch {
      y = null;
    }
    if (y == null || !Number.isFinite(y)) {
      el.toBeatChip.hidden = true;
      return;
    }
    el.toBeatChip.hidden = false;
    el.toBeatChip.style.top = `${Math.max(2, y)}px`;
  }

  function applyTargetLine(target, title) {
    const price = target == null || target === "" ? NaN : Number(target);
    lastTarget = Number.isFinite(price) ? price : null;
    ensureChart();
    if (!chart) return;

    if (lastTarget == null) {
      clearTargetLine();
      syncToBeatChip(null, false);
      if (targetSeries) {
        try {
          targetSeries.setData([]);
        } catch {
          // ignore
        }
      }
      return;
    }

    const dash =
      (ensureChart.LineStyle && ensureChart.LineStyle.Dashed) || 2;

    // Keep the dashed beat line + axis price; "TO BEAT" chip sits above the
    // right-axis price tag (see #to-beat-chip) so it never covers candles.
    if (series) {
      clearTargetLine();
      targetLine = series.createPriceLine({
        price: lastTarget,
        color: "#f4fff8",
        lineWidth: 2,
        lineStyle: dash,
        axisLabelVisible: true,
        title: "",
      });
    }
    syncToBeatChip(lastTarget, true);

    // Full-width dashed line — no last-value label (that caused the double TO BEAT).
    if (!targetSeries) {
      targetSeries = chart.addLineSeries({
        color: "rgba(244,255,248,0.95)",
        lineWidth: 2,
        lineStyle: dash,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        title: "",
      });
    }
    const flat = buildFlatLineData(lastTarget);
    if (flat.length) {
      try {
        targetSeries.setData(flat);
      } catch {
        // ignore
      }
    }

    try {
      if (series) series.applyOptions({});
    } catch {
      // ignore
    }
  }

  function reapplyChartOverlays() {
    if (lastTarget != null && Number.isFinite(lastTarget)) {
      applyTargetLine(lastTarget, "TO BEAT");
    }
    if (lastSettlementAvg != null && Number.isFinite(lastSettlementAvg)) {
      applySettleLine(lastSettlementAvg);
    }
    if (demo.position) {
      const beSpot = modelBreakevenSpot(demo.position, secondsLeft());
      applyBreakevenLines(
        demo.position.beat,
        demo.position.entrySpot,
        beSpot,
        demo.position.side
      );
      const beatKeep =
        demo.position.beat != null && Number.isFinite(Number(demo.position.beat))
          ? Number(demo.position.beat)
          : lastTarget;
      if (beatKeep != null && Number.isFinite(beatKeep)) {
        applyTargetLine(beatKeep, "TO BEAT");
      }
    }
  }

  function applySettleLine(avg) {
    ensureChart();
    if (!series || avg == null || !Number.isFinite(avg)) {
      clearSettleLine();
      return;
    }
    const opts = {
      price: avg,
      color: "#ffd28a",
      lineWidth: 2,
      lineStyle: (ensureChart.LineStyle && ensureChart.LineStyle.Solid) || 0,
      axisLabelVisible: true,
      title: "AVG",
    };
    clearSettleLine();
    settleLine = series.createPriceLine(opts);
    try {
      series.applyOptions({});
    } catch {
      // ignore
    }
  }

  async function refreshTarget(opts = {}) {
    const forceCandles = !!opts.forceCandles;
    try {
      const res = await fetch(`/api/target?tf=15m&_=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      const beatRaw = data.price_to_beat ?? data.target;
      const beat =
        beatRaw == null || beatRaw === "" ? null : Number(beatRaw);
      const beatOk = beat != null && Number.isFinite(beat) ? beat : null;
      const prevClose = closeTimeIso;
      const prevTicker = lastTicker;
      const prevSettleSide = lastSettlementSide;
      const prevSettleAvg = lastSettlementAvg;
      closeTimeIso = data.close_time || null;
      updateCountdown();
      updateSettlement(data);

      if (data.kalshi_url && el.kalshiLink) {
        lastKalshiUrl = data.kalshi_url;
        el.kalshiLink.href = data.kalshi_url;
      }

      const rolled =
        (prevTicker && data.ticker && prevTicker !== data.ticker) ||
        (prevClose && closeTimeIso && prevClose !== closeTimeIso) ||
        !!data.stale_previous ||
        !!data.waiting_next;

      // Auto-settle as soon as the clock hits zero / window is stale — don't
      // wait for the next ticker (that gap left open trades stuck at 0:00).
      trySettleOpenAfterClose(data, prevTicker, prevSettleSide, prevSettleAvg);

      if (rolled && (data.odds_fresh || data.stale_previous || data.yes_pct == null)) {
        updateOdds({
          yes_pct: data.yes_pct != null && !data.stale_previous ? data.yes_pct : 50,
          no_pct: data.no_pct != null && !data.stale_previous ? data.no_pct : 50,
          yes_bid_pct: data.yes_bid_pct,
          yes_ask_pct: data.yes_ask_pct,
          no_bid_pct: data.no_bid_pct,
          no_ask_pct: data.no_ask_pct,
          spread_cents: data.spread_cents,
          thin_book: data.thin_book,
          odds_fresh: true,
        });
      } else {
        updateOdds(data);
      }

      if (el.targetLabel) {
        el.targetLabel.textContent = "Price to beat";
      }

      if ((!data.ok && beatOk == null) || data.waiting_next) {
        trySettleOpenAfterClose(data, prevTicker, prevSettleSide, prevSettleAvg);
        setStatus("warn", data.error || "Waiting for next window");
        el.targetValue.textContent = beatOk != null ? money(beatOk) : "—";
        el.targetMeta.textContent = data.error || "Next Kalshi 15m opening…";
        if (beatOk == null) applyTargetLine(null);
        else applyTargetLine(beatOk, "TO BEAT");
        startRolloverBurst();
        scheduleBoundaryRefresh(data.close_time);
        return;
      }

      if (beatOk == null) {
        setStatus("warn", "Price to beat TBD");
        el.targetValue.textContent = "TBD";
        el.targetMeta.textContent = data.error || "Waiting for Kalshi to post the beat";
        applyTargetLine(null);
        updateOdds({ yes_pct: 50, no_pct: 50, odds_fresh: true });
        maybeChimeNewFifteenTarget(null, data.ticker, data.source, data.close_et);
        startRolloverBurst();
      } else {
        lastTicker = data.ticker;
        setStatus(
          "ok",
          data.settlement_mode
            ? "Settling…"
            : data.stale_previous
              ? "Rolling…"
              : rolled
                ? "New 15m window"
                : "Live"
        );
        el.targetValue.textContent = money(beatOk);
        const win = formatWindow(data.close_time, data.close_et);
        if (data.beat_source === "brti") {
          el.targetMeta.textContent = win
            ? `BRTI open avg · settles ${win}`
            : "BRTI open avg (Kalshi TBD)";
        } else {
          el.targetMeta.textContent = win
            ? `This window settles ${win}`
            : "Kalshi 15-minute market";
        }
        applyTargetLine(beatOk, "TO BEAT");
        maybeChimeNewFifteenTarget(beatOk, data.ticker, data.source, data.close_et);
        if (el.spotValue && el.spotValue.dataset.last) {
          updateSpot(Number(el.spotValue.dataset.last));
        }
        if (rolled || forceCandles || data.settlement_mode) {
          refreshCandles().then(() => applyTargetLine(beatOk, "TO BEAT"));
        } else {
          applyTargetLine(beatOk, "TO BEAT");
        }
        if (rolled || data.settlement_mode) startRolloverBurst();
        if (
          rolled &&
          !data.stale_previous &&
          closeTimeIso &&
          Date.parse(closeTimeIso) > Date.now() + 5_000
        ) {
          rolloverUntil = Math.max(rolloverUntil, Date.now() + 25_000);
        }
      }
      scheduleBoundaryRefresh(data.close_time);
    } catch (err) {
      setStatus("warn", "Target fetch failed");
      el.targetMeta.textContent = String(err.message || err);
    }
  }

  async function refreshSpot() {
    try {
      const res = await fetch(`/api/spot?_=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok || data.price == null) return;
      updateSpot(Number(data.price));
    } catch {
      // keep last spot
    }
  }

  async function refreshCandles() {
    try {
      const res = await fetch(
        `/api/candles?tf=${encodeURIComponent(currentTf)}&_=${Date.now()}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!data.ok) {
        setStatus("warn", data.error || "Candles error");
        return;
      }
      ensureChart();
      if (!series) return;
      const candles = data.candles || [];
      lastCandleData = candles;
      const grew =
        candles.length > lastCandleCount + 20 ||
        (lastCandleCount > 0 && candles.length < lastCandleCount - 20);
      series.setData(candles);
      // Price lines can drop on setData — always redraw beat / overlays.
      reapplyChartOverlays();
      if (!el.spotValue?.dataset.last && candles.length) {
        updateSpot(candles[candles.length - 1].close);
      }
      resizeChart();
      // Zoom to recent bars on first paint / big history jumps (not fit-all).
      if (!fittedOnce || grew) {
        applyDefaultChartZoom();
        fittedOnce = true;
        lastCandleCount = candles.length;
        reapplyChartOverlays();
      }
    } catch (err) {
      setStatus("warn", "Candle fetch failed");
    }
  }

  function syncTfButtons() {
    if (!el.timeframe) return;
    el.timeframe.querySelectorAll(".tf-btn").forEach((btn) => {
      const on = btn.dataset.tf === currentTf;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setTimeframe(tf) {
    if (!["1m", "5m", "15m"].includes(tf) || tf === currentTf) {
      syncTfButtons();
      return;
    }
    currentTf = tf;
    localStorage.setItem(TF_KEY, currentTf);
    fittedOnce = false;
    lastCandleCount = 0;
    syncTfButtons();
    setTfLabel();
    setStatus("loading", `Loading ${currentTf} chart…`);
    // Only candles change — keep Kalshi 15m target/odds/countdown.
    refreshCandles();
  }

  function tickClock() {
    if (el.clock) {
      el.clock.textContent = new Date().toLocaleTimeString("en-US", {
        timeZone: APP_TZ,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    updateCountdown();
  }

  function isLandscapeNow() {
    try {
      const type = String((screen.orientation && screen.orientation.type) || "");
      if (type.startsWith("landscape")) return true;
      if (type.startsWith("portrait")) return false;
    } catch {
      // fall through
    }
    return window.matchMedia("(orientation: landscape)").matches;
  }

  function syncRotateGate() {
    if (!el.rotateGate) return;
    const landscape = isLandscapeNow();
    el.rotateGate.hidden = !landscape;
  }

  async function lockOrientationPortrait() {
    const orient = screen.orientation;
    if (!orient || typeof orient.lock !== "function") return false;
    try {
      await orient.lock("portrait-primary");
      return true;
    } catch {
      try {
        await orient.lock("portrait");
        return true;
      } catch {
        return false;
      }
    }
  }

  function isInstalledPwa() {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
      if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
      if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
      if (navigator.standalone === true) return true;
    } catch {
      // ignore
    }
    return false;
  }

  async function enterFullscreenIfNeeded() {
    // Do not call the Fullscreen API in a normal browser tab — Chrome shows a
    // sticky "site — To exit full screen" toast that covers Market Chance.
    // Installed PWAs already run without browser chrome; no API call needed.
    if (isInstalledPwa()) return true;
    return false;
  }

  async function ensurePortraitLock(fromGesture) {
    // Orientation.lock may work in installed PWAs. Never force browser
    // fullscreen just to unlock it — that toast is worse than a soft lock miss.
    if (fromGesture || isInstalledPwa()) {
      await lockOrientationPortrait();
    }
    syncRotateGate();
    setTimeout(resizeChart, 100);
    setTimeout(resizeChart, 350);
  }

  function tryLockPortrait() {
    ensurePortraitLock(false);
  }

  function afterOrientationSettle() {
    ensurePortraitLock(false);
    setTimeout(resizeChart, 50);
    setTimeout(resizeChart, 250);
    setTimeout(resizeChart, 600);
  }

  function boot() {
    // Short sync window for SW edge-state — do not quiet-ack/mark sounded.
    suppressEdgeChimeUntil = Date.now() + 2500;
    suppressTargetChimeUntil = Date.now() + 4000;
    pendingEdgeChime = false;
    if (!window.LightweightCharts) {
      setStatus("warn", "Chart library failed to load");
      return;
    }
    syncRotateGate();
    tryLockPortrait();
    if (el.timeframe) {
      syncTfButtons();
      el.timeframe.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".tf-btn");
        if (!btn || !el.timeframe.contains(btn)) return;
        setTimeframe(btn.dataset.tf);
        unlockAudioPlayback();
        ensurePortraitLock(true);
      });
    }
    if (el.pushBadge) {
      el.pushBadge.addEventListener("click", () => {
        ensurePortraitLock(true);
        toggleAlerts();
      });
    }
    if (el.alertsEnable) {
      el.alertsEnable.addEventListener("click", () => {
        unlockAudioPlayback();
        toggleAlerts();
      });
    }
    if (el.alertsTest) {
      el.alertsTest.addEventListener("click", () => {
        unlockAudioPlayback();
        runChimeTest();
      });
    }
    if (el.rotateGate) {
      el.rotateGate.addEventListener("click", () => {
        ensurePortraitLock(true);
      });
    }
    if (el.stakeSlider) {
      syncStakeUi();
      const onStake = () => setTradeStake(el.stakeSlider.value);
      el.stakeSlider.addEventListener("input", onStake);
      el.stakeSlider.addEventListener("change", onStake);
    }
    if (el.menuBtn) {
      el.menuBtn.addEventListener("click", () => {
        ensurePortraitLock(true);
        toggleOptions();
      });
    }
    if (el.optionsClose) {
      el.optionsClose.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeOptions();
      });
    }
    if (el.optionsBackdrop) {
      el.optionsBackdrop.addEventListener("click", (ev) => {
        ev.preventDefault();
        closeOptions();
      });
    }
    if (el.demoToggle) {
      el.demoToggle.addEventListener("change", () => {
        setDemoOn(el.demoToggle.checked);
      });
    }
    if (el.demoReset) {
      el.demoReset.addEventListener("click", () => {
        resetDemoAccount();
      });
    }
    if (el.plChartToggle) {
      el.plChartToggle.addEventListener("click", () => {
        setPlOptionsOpen(!plUi.optionsOpen);
      });
    }
    if (el.plDayLinesCheck) {
      syncPlDayLinesToggle();
      el.plDayLinesCheck.addEventListener("change", () => {
        plUi.dayLines = !!el.plDayLinesCheck.checked;
        savePlUi();
        updatePlDayLines();
      });
    }
    if (el.tradeHistoryToggle) {
      el.tradeHistoryToggle.addEventListener("click", () => {
        setTradeHistoryOpen(!tradeHistoryUi.open);
      });
      applyTradeHistoryUi();
    }
    if (el.strategyToggle && el.strategyBody) {
      el.strategyToggle.addEventListener("click", () => {
        const open = el.strategyBody.hidden;
        el.strategyBody.hidden = !open;
        el.strategyToggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (el.strategySection) {
          el.strategySection.classList.toggle("is-open", open);
        }
        if (open) renderStrategyReport();
      });
      el.strategyBody.hidden = false;
      el.strategyToggle.setAttribute("aria-expanded", "true");
      if (el.strategySection) el.strategySection.classList.add("is-open");
    }
    if (el.buySuggestUse) {
      el.buySuggestUse.addEventListener("click", () => {
        if (buySuggestStake != null) setBuyAmountUi(buySuggestStake, true);
      });
    }
    if (el.appUpdate) {
      el.appUpdate.addEventListener("click", () => forceAppUpdate());
      refreshVersionLine();
    }
    document.addEventListener("touchstart", onPullStart, { passive: true });
    document.addEventListener("touchmove", onPullMove, { passive: true });
    document.addEventListener("touchend", onPullEnd, { passive: true });
    document.addEventListener("touchcancel", () => resetPullIndicator(), {
      passive: true,
    });
    if (el.accountExport) {
      el.accountExport.addEventListener("click", () => exportAccountBackup());
    }
    if (el.accountImport && el.accountImportFile) {
      el.accountImport.addEventListener("click", () => el.accountImportFile.click());
      el.accountImportFile.addEventListener("change", () => {
        const file = el.accountImportFile.files && el.accountImportFile.files[0];
        importAccountBackupFile(file);
        el.accountImportFile.value = "";
      });
    }
    if (el.demoBuyBest) {
      el.demoBuyBest.addEventListener("click", () => demoBuyBest());
    }
    if (el.demoBuyAbove) {
      el.demoBuyAbove.addEventListener("click", () => openBuySheet("above"));
    }
    if (el.demoBuyBelow) {
      el.demoBuyBelow.addEventListener("click", () => openBuySheet("below"));
    }
    if (el.dockBuyAbove) {
      el.dockBuyAbove.addEventListener("click", () => openBuySheet("above"));
    }
    if (el.dockBuyBelow) {
      el.dockBuyBelow.addEventListener("click", () => openBuySheet("below"));
    }
    if (el.dockBuyBest) {
      el.dockBuyBest.addEventListener("click", () => demoBuyBest());
    }
    if (el.demoClose) {
      el.demoClose.addEventListener("click", () => closeDemoPosition());
    }
    if (el.demoLiveClose) {
      el.demoLiveClose.addEventListener("click", () => closeDemoPosition());
    }
    if (el.openPlClose) {
      el.openPlClose.addEventListener("click", () => closeDemoPosition());
    }
    if (el.openPlAdd) {
      el.openPlAdd.addEventListener("click", () => {
        const pos = demo.position;
        if (!pos || !pos.side) {
          setStatus("warn", "No open position to add to");
          return;
        }
        openBuySheet(pos.side);
      });
    }
    if (el.openPlToggle) {
      el.openPlToggle.addEventListener("click", () => {
        setOpenPlCollapsed(!openPlCollapsed);
      });
    }
    if (el.openPlBar) {
      let dragY = null;
      const onStart = (y) => {
        dragY = y;
      };
      const onEnd = (y) => {
        if (dragY == null) return;
        const dy = y - dragY;
        dragY = null;
        if (dy > 28) setOpenPlCollapsed(true);
        else if (dy < -28) setOpenPlCollapsed(false);
      };
      el.openPlBar.addEventListener(
        "touchstart",
        (ev) => {
          if (ev.touches && ev.touches[0]) onStart(ev.touches[0].clientY);
        },
        { passive: true }
      );
      el.openPlBar.addEventListener(
        "touchend",
        (ev) => {
          const t = ev.changedTouches && ev.changedTouches[0];
          if (t) onEnd(t.clientY);
        },
        { passive: true }
      );
    }
    if (el.buySheetX) {
      el.buySheetX.addEventListener("click", () => dismissBuySheet());
    }
    if (el.buyBackdrop) {
      el.buyBackdrop.addEventListener("click", () => dismissBuySheet());
    }
    if (el.buyAmount) {
      const syncAmt = () => {
        const amt = clampBuyAmount(el.buyAmount.value);
        el.buyAmount.value = String(amt);
        setBuyAmountUi(amt, true);
        refreshBuySheetPreview();
      };
      el.buyAmount.addEventListener("input", () => {
        // Allow free typing; clamp lightly only when valid number.
        const raw = Number(el.buyAmount.value);
        if (Number.isFinite(raw) && raw >= BUY_AMOUNT_MIN) {
          setBuyAmountUi(Math.min(buyAmountCap(), Math.round(raw)), false);
          refreshBuySheetPreview();
        }
      });
      el.buyAmount.addEventListener("change", syncAmt);
      el.buyAmount.addEventListener("blur", syncAmt);
    }
    if (el.buyRange) {
      const onRange = () => {
        setBuyAmountUi(el.buyRange.value, true);
        if (el.buyAmount) el.buyAmount.value = String(buySheetAmount);
        refreshBuySheetPreview();
      };
      el.buyRange.addEventListener("input", onRange);
      el.buyRange.addEventListener("change", onRange);
    }
    document.querySelectorAll(".buy-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const amt = Number(btn.dataset.amt);
        if (!Number.isFinite(amt)) return;
        setBuyAmountUi(amt, true);
        if (el.buyAmount) el.buyAmount.value = String(buySheetAmount);
        refreshBuySheetPreview();
      });
    });
    if (el.buySlide) {
      el.buySlide.addEventListener("pointerdown", onBuySlidePointerDown);
      el.buySlide.addEventListener("pointermove", onBuySlidePointerMove);
      el.buySlide.addEventListener("pointerup", onBuySlidePointerUp);
      el.buySlide.addEventListener("pointercancel", onBuySlidePointerUp);
      el.buySlide.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === "ArrowRight") {
          ev.preventDefault();
          setBuySlideProgress(1);
          confirmBuyFromSheet();
        } else if (ev.key === "Escape") {
          dismissBuySheet();
        }
      });
    }
    if (el.bestSide) {
      el.bestSide.style.cursor = "pointer";
      el.bestSide.title = "Tap to buy suggested size";
      el.bestSide.addEventListener("click", () => {
        if (lastBestPick && lastBestPick.side) {
          openBuySheet(lastBestPick.side, { useSuggest: true, fromBest: true });
        } else if (demo.on) setStatus("warn", "No clear Best Side yet");
        else {
          setStatus("warn", "Turn on Demo in Options");
          openOptions();
        }
      });
    }
    document.querySelectorAll(".roi-card.above").forEach((card) => {
      card.style.cursor = "pointer";
      card.addEventListener("click", () => openBuySheet("above"));
    });
    document.querySelectorAll(".roi-card.below").forEach((card) => {
      card.style.cursor = "pointer";
      card.addEventListener("click", () => openBuySheet("below"));
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && tutorialOpen) closeTutorial(false);
      else if (ev.key === "Escape" && buySheetOpen) dismissBuySheet();
      else if (ev.key === "Escape" && optionsOpen) closeOptions();
    });
    if (el.tutorialOpen) {
      el.tutorialOpen.addEventListener("click", () => openTutorial(true));
    }
    if (el.tutorialNext) {
      el.tutorialNext.addEventListener("click", () => nextTutorial());
    }
    if (el.tutorialSkip) {
      el.tutorialSkip.addEventListener("click", () => closeTutorial(true));
    }
    if (el.tutorialBackdrop) {
      el.tutorialBackdrop.addEventListener("click", () => closeTutorial(false));
    }
    renderDemoUi();
    applyPlUi();
    if (summaryPushPx > 0) applySummaryPush(summaryPushPx, { persist: false });
    if (chartHeightPx != null) applyChartHeight(chartHeightPx, { persist: false });
    wireChartResizeHandle(el.chartResizeTop, "top");
    wireChartResizeHandle(el.chartResizeBottom, "bottom");
    syncAlertsUi();
    startSystemHealthLoop();
    try {
      if (localStorage.getItem(TUTORIAL_KEY) !== "1") {
        setTimeout(() => openTutorial(true), 700);
      }
    } catch {
      // ignore
    }
    const unlock = () => {
      unlockAudioPlayback();
      // After resume suppress window, allow a true pending replay from a
      // failed autoplay — but never during the open quiet-sync.
      if (
        pendingEdgeChime &&
        chimeOn &&
        Date.now() >= suppressEdgeChimeUntil
      ) {
        pendingEdgeChime = false;
        playEdgeChime(true).then((ok) => {
          if (ok) {
            if (lastBestPick && lastBestPick.side) {
              markEdgeSounded(lastBestPick);
              quietArmClearEdge(lastBestPick, { chimed: true });
            } else {
              lastClearEdgeAlertAt = Date.now();
            }
          } else {
            pendingEdgeChime = true;
          }
        });
        vibrateEdge();
      }
      if (pendingProfitChime && chimeOn) {
        pendingProfitChime = false;
        playProfitChime(true);
      }
      ensurePortraitLock(true);
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        unlockAudioPlayback();
        ensurePortraitLock(true);
        startRolloverBurst();
        // Quiet-sync any 15m window that rolled while we were away — do not
        // dump the "new 15m target / Price to beat" chime on open.
        suppressTargetChimeUntil = Date.now() + 4000;
        // Brief SW sync only. If BG already notified, swAlreadySoundedEdge
        // blocks re-chime. If BG missed, allow a real catch-up chime after sync
        // — that is the buy signal, not a false dump.
        suppressEdgeChimeUntil = Date.now() + 2500;
        pendingEdgeChime = false;
        postToSW({ type: "get-edge-state" });
        if (lastBestPick && lastBestPick.side) {
          const ask = Math.round(Number(lastBestPick.askCents) || 0);
          const ticker = lastTicker || lastFifteenTicker || "";
          lastClearEdgeAlertKey = `${ticker}:${lastBestPick.side}:${ask}`;
          persistEdgeAlertKey(lastClearEdgeAlertKey);
          edgeAlertsArmed = true;
          // Only mark sounded when SW already rang this sticky while away.
          if (swAlreadySoundedEdge(lastBestPick)) {
            markEdgeSounded(lastBestPick, { ask });
          }
          quietArmClearEdge(lastBestPick, { chimed: false });
        }
        if (
          chimeOn &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          subscribePush().catch(() => {});
        }
        setTimeout(() => {
          // Re-read SW state then score — catch-up chime if phone never got it.
          postToSW({ type: "get-edge-state" });
          setTimeout(() => {
            refreshTarget({ forceCandles: true });
          }, 200);
        }, 300);
        runSystemHealthReport({ force: true });
      } else {
        // Page hidden — system notification is the only audible chime.
        if (
          chimeOn &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          subscribePush().catch(() => {});
        }
        postToSW({
          type: "arm-state",
          ticker: lastFifteenTicker,
          target: lastFifteenTarget,
          chimeOn,
        });
        if (chimeOn && lastBestPick && lastBestPick.side) {
          const ask = Math.round(Number(lastBestPick.askCents) || 0);
          const ticker = lastTicker || lastFifteenTicker || "";
          const wasPending = !!pendingEdgeChime;
          pendingEdgeChime = false;
          // Backup BG path when leaving the app on a clear edge — server push
          // can miss brief windows; SW cooldown still dedupes.
          postToSW({
            type: "edge-notify",
            force: true,
            bypassDedupe: wasPending,
            side: lastBestPick.side,
            askCents: ask || null,
            pWin: lastBestPick.pWin,
            suggestStake: lastBestPick.suggestedStake,
            ticker,
            beat: lastTarget,
            chimeOn,
          });
          if (wasPending) markEdgeSounded(lastBestPick, { ask });
        }
        // Poll for a NEW clear edge while backgrounded (SW + server push).
        postToSW({ type: "check-now", forceNotify: false });
      }
    });

    setTfLabel();
    ensureChart();
    resizeChart();
    ensureServiceWorker().then(async (reg) => {
      swReg = reg;
      postToSW({ type: "set-chime", enabled: chimeOn });
      // Always re-register with the server when permission is already granted —
      // Render restarts wipe subscribers and rotate VAPID keys.
      if (
        chimeOn &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        const ok = await subscribePush().catch(() => false);
        if (ok) localStorage.setItem(BG_ARMED_KEY, "1");
        else {
          localStorage.setItem(BG_ARMED_KEY, "0");
          setBgStatus(
            false,
            "Background push not registered — Options → Enable, then Test"
          );
        }
        syncAlertsUi();
      }
      if (reg && "periodicSync" in reg) {
        try {
          await reg.periodicSync.register("kalshi-15m-check", {
            minInterval: 15 * 60 * 1000,
          });
        } catch {
          // unsupported / not granted
        }
      }
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        const msg = event.data || {};
        if (msg.type === "play-edge-chime") {
          // Legacy SW messages — ignore on open/resume quiet-sync and when hidden.
          if (!chimeOn) return;
          if (document.visibilityState !== "visible") return;
          if (Date.now() < suppressEdgeChimeUntil) return;
          unlockAudioPlayback();
          playEdgeChime(true);
        }
      });
    }
    // Target first so Price-to-beat line exists when candles paint.
    // Wait for SW edge-state so open first-arm doesn't re-blast a BG sticky.
    getUserId();
    wireAccountShareUi();
    setupEphemeralBanner();
    restoreEdgeAlertKeyFromSession();
    Promise.all([hydrateDemoFromServer(), ensureServiceWorker()]).finally(() => {
      refreshTarget()
        .then(() => refreshCandles())
        .then(refreshSpot);
    });
    setInterval(refreshTarget, TARGET_POLL_MS);
    setInterval(refreshCandles, CANDLE_POLL_MS);
    setInterval(refreshSpot, SPOT_POLL_MS);
    setInterval(tickClock, 250);
    // Keep fighting landscape — Android can ignore a single lock call.
    setInterval(() => {
      syncRotateGate();
      if (isLandscapeNow()) ensurePortraitLock(false);
    }, 700);
    tickClock();
    window.addEventListener("resize", () => {
      syncRotateGate();
      tryLockPortrait();
      summaryNaturalH = null;
      if (summaryPushPx > 0) applySummaryPush(summaryPushPx, { persist: false });
      if (chartHeightPx != null) applyChartHeight(chartHeightPx, { persist: false });
      resizeChart();
      if (isPlChartVisible()) resizePlChart();
    });
    if (typeof ResizeObserver === "function" && el.chart) {
      const ro = new ResizeObserver(() => resizeChart());
      ro.observe(el.chart);
      if (el.chart.parentElement) ro.observe(el.chart.parentElement);
    }
    if (typeof ResizeObserver === "function" && el.plChart) {
      const plRo = new ResizeObserver(() => {
        if (isPlChartVisible()) resizePlChart();
      });
      plRo.observe(el.plChart);
    }
    window.addEventListener("orientationchange", afterOrientationSettle);
    if (screen.orientation && typeof screen.orientation.addEventListener === "function") {
      screen.orientation.addEventListener("change", afterOrientationSettle);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    window.addEventListener("load", boot);
  }
})();
