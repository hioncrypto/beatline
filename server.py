#!/usr/bin/env python3
"""
Kalshi BTC Price-to-beat chart server (Android PWA).

- Chart + moving price: CF Benchmarks BRTI (same index Kalshi uses)
- Price to beat, countdown, Yes/No %: always live Kalshi KXBTC15M
- Chart buttons 1m / 5m / 15m only change BRTI candle size
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))
STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = Path(__file__).resolve().parent / "data"
PUSH_SUBS_FILE = DATA_DIR / "push_subscriptions.json"
DEMO_ACCOUNT_FILE = DATA_DIR / "demo_account.json"
ACCOUNTS_DIR = DATA_DIR / "accounts"
KALSHI_CREDS_FILE = DATA_DIR / "kalshi_credentials.json"
AUTO_TRADE_LOG_FILE = DATA_DIR / "auto_trade_log.json"
SEED_TRADE_HISTORY_FILE = STATIC_DIR / "seed-trade-history.json"
VAPID_PRIVATE = DATA_DIR / "vapid_private.pem"
VAPID_PUBLIC_RAW = DATA_DIR / "vapid_public_raw.txt"
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:kalshi-btc-target@localhost")
# Production Trade API (same host as public markets). Override for Kalshi demo.
KALSHI_API_BASE = os.environ.get(
    "KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"
).rstrip("/")
DEMO_HISTORY_LIMIT = 50000
_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_demo_lock = threading.Lock()
_kalshi_creds_lock = threading.Lock()


def _normalize_user_id(raw) -> str | None:
    if raw is None:
        return None
    uid = str(raw).strip()
    if not _USER_ID_RE.match(uid):
        return None
    return uid


def _account_path(user_id: str) -> Path:
    return ACCOUNTS_DIR / f"{user_id}.json"


def _list_account_ids() -> list[str]:
    ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
    ids = []
    for p in ACCOUNTS_DIR.glob("*.json"):
        if _normalize_user_id(p.stem):
            ids.append(p.stem)
    return ids


# Chart candle size + settlement window length (seconds) per TF.
TIMEFRAMES = {
    "1m": {
        "label": "1 minute",
        "granularity": 60,
        "window_sec": 60,
        # ~6h of 1m bars (CF BRTI alone only covers ~60m).
        "candle_limit": 360,
        "kalshi_series": ["KXBTC1M", "KXBTC15M"],
    },
    "5m": {
        "label": "5 minutes",
        "granularity": 300,
        "window_sec": 300,
        # ~24h of 5m bars.
        "candle_limit": 288,
        "kalshi_series": ["KXBTC5M", "KXBTC15M"],
    },
    "15m": {
        "label": "15 minutes",
        "granularity": 900,
        "window_sec": 900,
        # ~48h of 15m bars.
        "candle_limit": 192,
        "kalshi_series": ["KXBTC15M"],
    },
}

COINBASE_CANDLES = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
COINBASE_TICKER = "https://api.exchange.coinbase.com/products/BTC-USD/ticker"
KALSHI_MARKETS = "https://api.elections.kalshi.com/trade-api/v2/markets"
# Same CF Benchmarks BRTI index Kalshi uses for BTC 15m charts / settlement.
CF_BRTI_VALUES = "https://www.cfbenchmarks.com/api/v1/values?id=BRTI"
CF_BASIC_USER = os.environ.get("CF_API_USER", "cfbenchmarksws2")
CF_BASIC_PASS = os.environ.get(
    "CF_API_PASS", "e3709a02-9876-45ea-ac46-e9020e06d7c6"
)

UA = "kalshi-btc-target/2.0 (+android-pwa)"

_cache_lock = threading.RLock()
_target_cache: dict = {}  # key -> {at, payload}
_candles_cache: dict = {"at": 0.0, "key": None, "payload": None}
_spot_cache: dict = {"at": 0.0, "payload": None}
_brti_cache: dict = {"at": 0.0, "ticks": None, "error": None}
_push_lock = threading.Lock()
_push_subs: list[dict] = []
_last_push_ticker: str | None = None
_last_edge_key: str | None = None
_last_edge_at: float = 0.0
_last_edge_gone_at: float = 0.0
_last_edge_ask: int | None = None
_clear_edge_latched: bool = False
_clear_edge_latch_ticker: str | None = None
# Require the same clear edge on consecutive polls before Web Push — stops
# one-tick flashes that notify the phone while the in-app Best Side still
# shows "wait / no clear edge".
_edge_confirm_key: str | None = None
_edge_confirm_count: int = 0
EDGE_CONFIRM_POLLS = 1
_vapid_app_server_key: str | None = None
_vapid_private_path: str | None = None
TARGET_TTL = 0.75
CANDLES_TTL = 5.0
SPOT_TTL = 1.0
BRTI_TTL = 1.0
PUSH_POLL_SEC = 2.0
EDGE_PUSH_COOLDOWN_SEC = 60.0
EDGE_GONE_RESET_SEC = 60.0
SETTLE_WINDOW_SEC = 60.0
KALSHI_SERIES_URL = "https://kalshi.com/markets/kxbtc15m"
# Live Auto-trade (server-side): fills on the same clear-edge pulse as alerts,
# even when the PWA is backgrounded / suspended.
_auto_trade_lock = threading.Lock()
_last_auto_trade_key: str | None = None
_last_auto_trade_at: float = 0.0
_last_auto_trade_note: str = ""
_last_auto_trade_attempt_at: float = 0.0
# Last server auto-entry we believe is still open: {ticker, side, contracts}
_last_auto_position: dict | None = None
AUTO_FILL_SLIP_CENTS = 3
AUTO_TRADE_RETRY_SEC = 4.0
AUTO_TRADE_LOG_LIMIT = 40


def _load_auto_trade_log() -> list:
    if not AUTO_TRADE_LOG_FILE.exists():
        return []
    try:
        raw = json.loads(AUTO_TRADE_LOG_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("attempts"), list):
            return raw["attempts"]
        if isinstance(raw, list):
            return raw
    except Exception:
        pass
    return []


def _save_auto_trade_log(attempts: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = AUTO_TRADE_LOG_FILE.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"attempts": attempts[-AUTO_TRADE_LOG_LIMIT:]}, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, AUTO_TRADE_LOG_FILE)


def log_auto_trade_attempt(entry: dict) -> dict:
    """Append one auto-trade attempt so we can prove whether the bot fired."""
    global _last_auto_trade_note
    row = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ts": time.time(),
        **(entry or {}),
    }
    with _auto_trade_lock:
        attempts = _load_auto_trade_log()
        # Dedupe repeated skip noise (auto_off / live_off) within 90s.
        if row.get("skipped") or row.get("kind") in (
            "auto_off",
            "live_off",
            "not_connected",
            "need_flip",
            "size_zero",
        ):
            for prev in reversed(attempts[-8:]):
                if not isinstance(prev, dict):
                    continue
                if (
                    prev.get("kind") == row.get("kind")
                    and prev.get("ticker") == row.get("ticker")
                    and prev.get("side") == row.get("side")
                    and row["ts"] - float(prev.get("ts") or 0) < 90
                ):
                    prev["at"] = row["at"]
                    prev["ts"] = row["ts"]
                    prev["note"] = row.get("note") or prev.get("note")
                    _save_auto_trade_log(attempts)
                    if row.get("note"):
                        _last_auto_trade_note = str(row["note"])
                    return prev
        attempts.append(row)
        _save_auto_trade_log(attempts)
        note = row.get("note") or row.get("error") or row.get("result")
        if note:
            _last_auto_trade_note = str(note)
    return row


def auto_trade_status() -> dict:
    """Armed flags + recent attempts — used to verify the auto trader."""
    creds = get_kalshi_credentials()
    attempts = _load_auto_trade_log()
    live_on = bool(creds and creds.get("live_enabled"))
    auto_on = bool(creds and creds.get("auto_trade"))
    connected = bool(creds)
    return {
        "ok": True,
        "connected": connected,
        "live_enabled": live_on,
        "auto_trade": auto_on,
        "auto_flip": bool(creds and creds.get("auto_flip")),
        "server_armed": bool(connected and live_on and auto_on),
        "last_auto_trade_key": _last_auto_trade_key,
        "last_auto_trade_at": _last_auto_trade_at or None,
        "last_auto_trade_note": _last_auto_trade_note or None,
        "last_auto_position": _last_auto_position,
        "attempts": attempts[-12:],
        "attempt_count": len(attempts),
    }


def _parse_dollars(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _dollars_to_pct_cents(value) -> int | None:
    """Kalshi UI shows whole cents truncated (0.999 → 99), not rounded (100)."""
    dollars = _parse_dollars(value)
    if dollars is None:
        return None
    dollars = max(0.0, min(1.0, dollars))
    return int(dollars * 100 + 1e-9)


def parse_close_ms(close_time) -> float | None:
    if not close_time:
        return None
    try:
        if isinstance(close_time, (int, float)):
            return float(close_time) * (1000 if close_time < 1e12 else 1)
        dt = datetime.fromisoformat(str(close_time).replace("Z", "+00:00"))
        return dt.timestamp() * 1000.0
    except Exception:
        return None


def parse_open_ms(open_time) -> float | None:
    return parse_close_ms(open_time)


def market_odds(market: dict) -> dict:
    """
    Yes/No % the way Kalshi's UI tends to show them.
    Prefer live bid/ask mid over a stale last trade right after a new
    15m window opens (last can still look like 1%/99% briefly).
    """
    last = _parse_dollars(market.get("last_price_dollars"))
    yes_bid = _parse_dollars(market.get("yes_bid_dollars"))
    yes_ask = _parse_dollars(market.get("yes_ask_dollars"))
    no_bid = _parse_dollars(market.get("no_bid_dollars"))
    no_ask = _parse_dollars(market.get("no_ask_dollars"))
    mid = None
    if yes_bid is not None and yes_ask is not None:
        mid = (yes_bid + yes_ask) / 2.0

    open_ms = parse_open_ms(market.get("open_time"))
    age_sec = None
    if open_ms is not None:
        age_sec = max(0.0, time.time() - open_ms / 1000.0)

    # Fresh window: lean on the book (near 50/50), not a leftover last print.
    fresh = age_sec is not None and age_sec < 90.0
    last_extreme = last is not None and (last <= 0.08 or last >= 0.92)

    if fresh:
        if mid is not None:
            yes = mid
        elif last is not None and not last_extreme:
            yes = last
        else:
            yes = 0.50
    elif mid is not None:
        # Prefer live book over last for displayable "fair" price.
        yes = mid
    elif last is not None:
        yes = last
    elif yes_bid is not None:
        yes = yes_bid
    elif yes_ask is not None:
        yes = yes_ask
    else:
        yes = None

    spread_cents = None
    if yes_bid is not None and yes_ask is not None:
        spread_cents = max(0, int(round((yes_ask - yes_bid) * 100)))

    if yes is None:
        return {
            "yes_pct": None,
            "no_pct": None,
            "yes_bid_pct": _dollars_to_pct_cents(yes_bid),
            "yes_ask_pct": _dollars_to_pct_cents(yes_ask),
            "no_bid_pct": _dollars_to_pct_cents(no_bid),
            "no_ask_pct": _dollars_to_pct_cents(no_ask),
            "last_pct": _dollars_to_pct_cents(last),
            "spread_cents": spread_cents,
            "odds_fresh": fresh,
            "thin_book": spread_cents is not None and spread_cents >= 5,
        }

    yes_pct = int(max(0.0, min(1.0, yes)) * 100 + 1e-9)
    live = market.get("status") in ("active", "open", "initialized")
    if live:
        yes_pct = min(99, max(1, yes_pct))
    no_pct = 100 - yes_pct

    return {
        "yes_pct": yes_pct,
        "no_pct": no_pct,
        "yes_bid_pct": _dollars_to_pct_cents(yes_bid),
        "yes_ask_pct": _dollars_to_pct_cents(yes_ask),
        "no_bid_pct": _dollars_to_pct_cents(no_bid),
        "no_ask_pct": _dollars_to_pct_cents(no_ask),
        "last_pct": _dollars_to_pct_cents(last),
        "spread_cents": spread_cents,
        "odds_fresh": bool(fresh),
        "thin_book": bool(spread_cents is not None and spread_cents >= 5),
    }


def kalshi_market_url(ticker: str | None, event_ticker: str | None) -> str:
    if event_ticker:
        return f"{KALSHI_SERIES_URL}/{str(event_ticker).lower()}"
    if ticker:
        return f"{KALSHI_SERIES_URL}/{str(ticker).lower()}"
    return KALSHI_SERIES_URL


def pick_current_market(markets: list) -> dict | None:
    """
    Pick the *current* 15m window — newest market that has already opened
    and has not closed yet. Never cling to an expired market.
    """
    now_ms = time.time() * 1000.0
    openish = [
        m
        for m in markets
        if m.get("status") in ("active", "open", "initialized")
    ] or list(markets)

    current = []
    for m in openish:
        open_ms = parse_open_ms(m.get("open_time"))
        close_ms = parse_close_ms(m.get("close_time"))
        if close_ms is None:
            continue
        # Strict: do not keep markets after close.
        if close_ms <= now_ms:
            continue
        # Prefer markets that have opened (or are about to within 3s).
        if open_ms is not None and open_ms > now_ms + 3_000:
            continue
        remaining = close_ms - now_ms
        current.append((open_ms or 0.0, remaining, m))

    if current:
        # Newest open_time first; among ties, more time remaining.
        current.sort(key=lambda x: (x[0], x[1]), reverse=True)
        # If the newest has almost no time left but a later window already
        # opened, prefer the later one.
        best = current[0]
        for cand in current:
            if cand[0] > best[0] and cand[1] > 5_000:
                best = cand
                break
        # Prefer a market that already has Price to beat among the newest cohort.
        newest_open = current[0][0]
        cohort = [p for p in current if abs(p[0] - newest_open) < 1_000]
        with_target = [p for p in cohort if parse_target(p[2]) is not None]
        return (with_target or cohort or current)[0][2]

    # No live window: next upcoming open (rollover gap).
    upcoming = []
    for m in openish:
        open_ms = parse_open_ms(m.get("open_time"))
        close_ms = parse_close_ms(m.get("close_time"))
        if open_ms is None or close_ms is None:
            continue
        if open_ms >= now_ms - 5_000 and close_ms > now_ms:
            upcoming.append((open_ms, m))
    if upcoming:
        upcoming.sort(key=lambda x: x[0])
        return upcoming[0][1]
    return None


def brti_open_beat(ticks: list[dict], open_ms: float | None) -> float | None:
    """
    Kalshi Price to beat = average of 60 BRTI 1s samples in the minute before open.

    Kalshi often leaves yes_sub_title / floor_strike as TBD for minutes after the
    window opens. Compute the same official index average so TO BEAT can show.
    """
    if open_ms is None or not ticks:
        return None
    now_ms = time.time() * 1000.0
    # Don't invent a beat before the open minute has finished.
    if now_ms < open_ms:
        return None
    window_start = open_ms - SETTLE_WINDOW_SEC * 1000.0
    by_sec: dict[int, float] = {}
    for t in ticks:
        tm = float(t["time_ms"])
        if window_start <= tm <= open_ms:
            by_sec[int(tm // 1000)] = float(t["value"])
    samples = list(by_sec.values())
    # Need a near-full open minute; partial averages disagree with Kalshi.
    if len(samples) < 50:
        return None
    return round(sum(samples) / len(samples), 2)


def brti_settlement_snapshot(
    ticks: list[dict], close_ms: float | None, beat: float | None
) -> dict:
    """
    Kalshi crypto settlement = average of 60 BRTI 1s samples in the final minute.
    While that minute is running, return the running average of samples so far.
    """
    now_ms = time.time() * 1000.0
    out = {
        "settlement_mode": False,
        "settlement_avg": None,
        "settlement_samples": 0,
        "settlement_delta": None,
        "settlement_side": None,  # above | below | null
        "seconds_to_close": None,
        "settle_window_sec": SETTLE_WINDOW_SEC,
    }
    if close_ms is None:
        return out
    seconds_to_close = (close_ms - now_ms) / 1000.0
    out["seconds_to_close"] = seconds_to_close
    window_start = close_ms - SETTLE_WINDOW_SEC * 1000.0
    # Enter settlement mode in the final minute (and briefly after close).
    if seconds_to_close > SETTLE_WINDOW_SEC:
        return out
    out["settlement_mode"] = True
    end_ms = min(now_ms, close_ms)
    samples = [
        float(t["value"])
        for t in ticks
        if window_start <= float(t["time_ms"]) <= end_ms
    ]
    # Prefer in-window samples only — prior[-60] without a window filter can
    # invent a settlement side from stale ticks and fire false clear edges.
    out["settlement_samples"] = len(samples)
    if not samples:
        return out
    avg = sum(samples) / len(samples)
    # Kalshi rounds settlement-style values to 2 decimals in practice.
    avg = round(avg, 2)
    out["settlement_avg"] = avg
    if beat is not None and Number_is_finite(beat):
        delta = avg - float(beat)
        out["settlement_delta"] = round(delta, 2)
        out["settlement_side"] = "above" if delta >= 0 else "below"
    return out


def Number_is_finite(x) -> bool:
    try:
        return x is not None and float(x) == float(x) and abs(float(x)) != float("inf")
    except (TypeError, ValueError):
        return False


def http_get_json(url: str, timeout: float = 20.0, headers: dict | None = None):
    hdrs = {"Accept": "application/json", "User-Agent": UA}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def http_get_json_basic(url: str, user: str, password: str, timeout: float = 20.0):
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return http_get_json(
        url,
        timeout=timeout,
        headers={"Authorization": f"Basic {token}"},
    )


def fetch_brti_ticks(force: bool = False) -> list[dict]:
    """1-second CF Benchmarks BRTI ticks (≈ last 60 minutes)."""
    now = time.time()
    with _cache_lock:
        if (
            not force
            and _brti_cache["ticks"]
            and now - _brti_cache["at"] < BRTI_TTL
        ):
            return _brti_cache["ticks"]
    data = http_get_json_basic(CF_BRTI_VALUES, CF_BASIC_USER, CF_BASIC_PASS)
    payload = data.get("payload") or []
    ticks = []
    for row in payload:
        try:
            ticks.append(
                {
                    "time_ms": int(row["time"]),
                    "value": float(row["value"]),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    ticks.sort(key=lambda t: t["time_ms"])
    with _cache_lock:
        _brti_cache["at"] = time.time()
        _brti_cache["ticks"] = ticks
        _brti_cache["error"] = None
    return ticks


def brti_to_candles(ticks: list[dict], granularity: int, limit: int) -> list[dict]:
    """Resample 1s BRTI ticks into OHLC candles (same index Kalshi charts)."""
    buckets: dict[int, list[float]] = {}
    for tick in ticks:
        ts = int(tick["time_ms"] // 1000)
        bucket = ts - (ts % granularity)
        v = float(tick["value"])
        if bucket not in buckets:
            buckets[bucket] = [v, v, v, v]  # o,h,l,c
        else:
            o, h, l, c = buckets[bucket]
            buckets[bucket] = [o, max(h, v), min(l, v), v]
    candles = [
        {
            "time": t,
            "open": ohlc[0],
            "high": ohlc[1],
            "low": ohlc[2],
            "close": ohlc[3],
        }
        for t, ohlc in sorted(buckets.items())
    ]
    return candles[-limit:]


def fetch_coinbase_candles(granularity: int, limit: int) -> list[dict]:
    """Paginate Coinbase BTC-USD candles (API returns ≤300 bars per request)."""
    if limit <= 0:
        return []
    per_page = 300
    pages = max(1, (limit + per_page - 1) // per_page)
    by_time: dict[int, dict] = {}
    t_end = int(time.time())
    for _ in range(pages):
        t_start = t_end - granularity * per_page
        qs = urllib.parse.urlencode(
            {
                "granularity": granularity,
                "start": datetime.fromtimestamp(t_start, tz=timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "end": datetime.fromtimestamp(t_end, tz=timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
            }
        )
        raw = http_get_json(f"{COINBASE_CANDLES}?{qs}")
        if not isinstance(raw, list) or not raw:
            break
        oldest = None
        for r in raw:
            try:
                t = int(r[0])
                by_time[t] = {
                    "time": t,
                    "open": float(r[3]),
                    "high": float(r[2]),
                    "low": float(r[1]),
                    "close": float(r[4]),
                }
                if oldest is None or t < oldest:
                    oldest = t
            except (TypeError, ValueError, IndexError):
                continue
        if oldest is None:
            break
        t_end = oldest
        if len(by_time) >= limit:
            break
    return [by_time[t] for t in sorted(by_time)][-limit:]


def merge_candle_history(
    history: list[dict], tip: list[dict], limit: int
) -> list[dict]:
    """Stitch longer exchange history with recent BRTI tip (BRTI wins on overlap)."""
    by_time: dict[int, dict] = {int(c["time"]): c for c in history}
    for c in tip:
        by_time[int(c["time"])] = c
    return [by_time[t] for t in sorted(by_time)][-limit:]


def parse_target(market: dict) -> float | None:
    floor = market.get("floor_strike")
    if isinstance(floor, (int, float)):
        return float(floor)
    sub = market.get("yes_sub_title") or ""
    m = re.search(r"Target\s*Price:\s*\$?\s*([0-9,]+(?:\.\d+)?)", sub, re.I)
    if not m:
        return None
    return float(m.group(1).replace(",", ""))


def format_pt(ts_iso_or_unix) -> str | None:
    try:
        if isinstance(ts_iso_or_unix, (int, float)):
            dt = datetime.fromtimestamp(ts_iso_or_unix, tz=timezone.utc)
        else:
            dt = datetime.fromisoformat(str(ts_iso_or_unix).replace("Z", "+00:00"))
        dt = dt.astimezone(ZoneInfo("America/Los_Angeles"))
        return (
            dt.strftime("%I:%M%p PT")
            .lstrip("0")
            .replace("AM", "am")
            .replace("PM", "pm")
        )
    except Exception:
        return None


# Back-compat alias — API field is still close_et but values are Pacific.
format_et = format_pt


def fetch_kalshi_markets(series: str) -> list:
    """Open markets plus nearby unopened windows (for seamless rollover)."""
    markets: list = []
    seen = set()
    queries = [
        f"{KALSHI_MARKETS}?limit=30&status=open&series_ticker={urllib.parse.quote(series)}",
        f"{KALSHI_MARKETS}?limit=40&status=unopened&series_ticker={urllib.parse.quote(series)}",
    ]
    for url in queries:
        try:
            data = http_get_json(url, timeout=12.0)
        except Exception:
            continue
        for m in data.get("markets") or []:
            ticker = m.get("ticker")
            if not ticker or ticker in seen:
                continue
            seen.add(ticker)
            markets.append(m)
    return markets


def fetch_kalshi_series_target(series: str) -> dict | None:
    markets = fetch_kalshi_markets(series)
    if not markets:
        return None
    market = pick_current_market(markets)
    if not market:
        return {
            "ok": False,
            "source": "kalshi",
            "series": series,
            "target": None,
            "price_to_beat": None,
            "ticker": None,
            "event_ticker": None,
            "kalshi_url": KALSHI_SERIES_URL,
            "open_time": None,
            "close_time": None,
            "close_et": None,
            "subtitle": None,
            "title": None,
            "label": "Price to beat",
            "yes_pct": None,
            "no_pct": None,
            "yes_bid_pct": None,
            "yes_ask_pct": None,
            "no_bid_pct": None,
            "no_ask_pct": None,
            "last_pct": None,
            "spread_cents": None,
            "odds_fresh": False,
            "thin_book": False,
            "stale_previous": True,
            "waiting_next": True,
            "settlement_mode": False,
            "settlement_avg": None,
            "settlement_samples": 0,
            "settlement_delta": None,
            "settlement_side": None,
            "error": "Waiting for next Kalshi 15m market…",
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    target = parse_target(market)
    beat_source = "kalshi" if target is not None else None
    close_et = format_et(market.get("close_time"))
    odds = market_odds(market)
    close_ms = parse_close_ms(market.get("close_time"))
    open_ms = parse_open_ms(market.get("open_time"))
    now_ms = time.time() * 1000.0
    stale_previous = bool(close_ms is not None and close_ms <= now_ms)
    waiting_next = bool(open_ms is not None and open_ms > now_ms)

    # Kalshi TBD after open → derive Price to beat from CF BRTI (same index).
    ticks: list[dict] | None = None
    if target is None and not waiting_next and open_ms is not None:
        try:
            ticks = fetch_brti_ticks()
            provisional = brti_open_beat(ticks, open_ms)
            if provisional is not None:
                target = provisional
                beat_source = "brti"
        except Exception:
            pass

    settle = {
        "settlement_mode": False,
        "settlement_avg": None,
        "settlement_samples": 0,
        "settlement_delta": None,
        "settlement_side": None,
        "seconds_to_close": None,
        "settle_window_sec": SETTLE_WINDOW_SEC,
    }
    try:
        if ticks is None:
            ticks = fetch_brti_ticks()
        settle = brti_settlement_snapshot(ticks, close_ms, target)
    except Exception:
        pass

    err = None
    if target is None:
        err = "Price to beat TBD (waiting for window open)"
    elif beat_source == "brti":
        err = None  # live beat from BRTI; Kalshi subtitle may still say TBD

    return {
        "ok": True,
        "source": "kalshi",
        "series": series,
        "target": target,
        "price_to_beat": target,
        "beat_source": beat_source,
        "ticker": market.get("ticker"),
        "event_ticker": market.get("event_ticker"),
        "kalshi_url": kalshi_market_url(market.get("ticker"), market.get("event_ticker")),
        "open_time": market.get("open_time"),
        "close_time": market.get("close_time"),
        "close_et": close_et,
        "subtitle": market.get("yes_sub_title"),
        "title": market.get("title") or "BTC above or below in 15 minutes?",
        "label": f"Price to beat · {close_et}" if close_et else "Price to beat",
        "yes_pct": odds["yes_pct"],
        "no_pct": odds["no_pct"],
        "yes_bid_pct": odds.get("yes_bid_pct"),
        "yes_ask_pct": odds.get("yes_ask_pct"),
        "no_bid_pct": odds.get("no_bid_pct"),
        "no_ask_pct": odds.get("no_ask_pct"),
        "last_pct": odds.get("last_pct"),
        "spread_cents": odds.get("spread_cents"),
        "odds_fresh": odds.get("odds_fresh"),
        "thin_book": odds.get("thin_book"),
        "stale_previous": stale_previous,
        "waiting_next": waiting_next,
        "settlement_mode": settle.get("settlement_mode"),
        "settlement_avg": settle.get("settlement_avg"),
        "settlement_samples": settle.get("settlement_samples"),
        "settlement_delta": settle.get("settlement_delta"),
        "settlement_side": settle.get("settlement_side"),
        "seconds_to_close": settle.get("seconds_to_close"),
        "error": err,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def fetch_target_payload(tf: str = "15m") -> dict:
    """
    Price to beat is ALWAYS the live Kalshi KXBTC15M market.

    Chart timeframe (1m/5m/15m) only affects candles on the client — never the
    Kalshi target, countdown, or Above/Below odds.
    """
    _ = tf
    cache_key = "15m"
    now = time.time()
    cached_payload = None
    refresh_settle = False
    close_ms = None
    with _cache_lock:
        cached = _target_cache.get(cache_key)
        if cached:
            payload = cached["payload"] or {}
            close_ms = parse_close_ms(payload.get("close_time"))
            expired = close_ms is not None and close_ms <= now * 1000.0
            settling = bool(payload.get("settlement_mode"))
            age = now - cached["at"]
            ttl = (
                0.35
                if expired or settling or payload.get("price_to_beat") is None
                else TARGET_TTL
            )
            if not expired and age < ttl:
                if settling:
                    # Refresh settlement outside the lock (avoids deadlock).
                    cached_payload = dict(payload)
                    refresh_settle = True
                else:
                    return payload

    if refresh_settle and cached_payload is not None:
        try:
            ticks = fetch_brti_ticks()
            settle = brti_settlement_snapshot(
                ticks, close_ms, cached_payload.get("price_to_beat")
            )
            cached_payload.update(settle)
            with _cache_lock:
                _target_cache[cache_key] = {"at": time.time(), "payload": cached_payload}
            return cached_payload
        except Exception:
            return cached_payload

    payload = fetch_kalshi_series_target("KXBTC15M")
    if payload:
        payload["timeframe"] = "15m"
        payload["chart_tf_hint"] = "candles only — target is always Kalshi 15m"
    else:
        # Fail closed — never present Coinbase as Kalshi Price to beat.
        payload = {
            "ok": False,
            "source": "kalshi",
            "series": "KXBTC15M",
            "timeframe": "15m",
            "target": None,
            "price_to_beat": None,
            "ticker": None,
            "event_ticker": None,
            "kalshi_url": KALSHI_SERIES_URL,
            "yes_pct": None,
            "no_pct": None,
            "stale_previous": True,
            "waiting_next": True,
            "settlement_mode": False,
            "error": "Kalshi unreachable — pull to refresh",
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    with _cache_lock:
        _target_cache[cache_key] = {"at": time.time(), "payload": payload}
    return payload


def fetch_spot() -> dict:
    """Live moving price = CF Benchmarks BRTI (same source Kalshi uses)."""
    now = time.time()
    with _cache_lock:
        if _spot_cache["payload"] and now - _spot_cache["at"] < SPOT_TTL:
            return _spot_cache["payload"]
    try:
        ticks = fetch_brti_ticks()
        if not ticks:
            raise RuntimeError("No BRTI ticks")
        last = ticks[-1]
        payload = {
            "ok": True,
            "symbol": "BRTI",
            "source": "cf_benchmarks",
            "label": "CF BRTI (Kalshi)",
            "price": float(last["value"]),
            "time": datetime.fromtimestamp(
                last["time_ms"] / 1000.0, tz=timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "bid": None,
            "ask": None,
            "error": None,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    except Exception as exc:
        # Fallback only if CF is down — still label clearly.
        try:
            data = http_get_json(COINBASE_TICKER)
            price = float(data.get("price"))
            payload = {
                "ok": True,
                "symbol": "BTC-USD",
                "source": "coinbase_fallback",
                "label": "Coinbase (BRTI unavailable)",
                "price": price,
                "bid": float(data["bid"]) if data.get("bid") is not None else None,
                "ask": float(data["ask"]) if data.get("ask") is not None else None,
                "time": data.get("time"),
                "error": f"BRTI fallback: {exc}",
                "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        except Exception as exc2:
            payload = {
                "ok": False,
                "symbol": "BRTI",
                "source": None,
                "price": None,
                "error": f"BRTI: {exc}; Coinbase: {exc2}",
                "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
    with _cache_lock:
        _spot_cache["at"] = time.time()
        _spot_cache["payload"] = payload
    return payload


def fetch_candles(granularity: int = 60, limit: int = 300) -> dict:
    """Chart candles: Coinbase history + CF BRTI tip (Kalshi's index).

    CF BRTI values only cover ~60 minutes. Coinbase fills older bars so the
    chart shows multi-hour (or multi-day) price history; recent bars prefer BRTI.
    """
    now = time.time()
    key = (granularity, limit, "brti+coinbase")
    with _cache_lock:
        if (
            _candles_cache["payload"]
            and _candles_cache["key"] == key
            and now - _candles_cache["at"] < CANDLES_TTL
        ):
            return _candles_cache["payload"]

    brti_candles: list[dict] = []
    brti_err: Exception | None = None
    try:
        ticks = fetch_brti_ticks()
        brti_candles = brti_to_candles(ticks, granularity, limit)
        if not brti_candles:
            raise RuntimeError("No BRTI candles")
    except Exception as exc:
        brti_err = exc

    cb_candles: list[dict] = []
    cb_err: Exception | None = None
    try:
        cb_candles = fetch_coinbase_candles(granularity, limit)
        if not cb_candles:
            raise RuntimeError("No Coinbase candles")
    except Exception as exc:
        cb_err = exc

    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if brti_candles and cb_candles:
        candles = merge_candle_history(cb_candles, brti_candles, limit)
        payload = {
            "ok": True,
            "symbol": "BRTI",
            "source": "cf_benchmarks+coinbase",
            "label": "BRTI tip + Coinbase history",
            "granularity": granularity,
            "candles": candles,
            "brti_bars": len(brti_candles),
            "history_bars": len(cb_candles),
            "error": None,
            "fetched_at": fetched_at,
        }
    elif brti_candles:
        payload = {
            "ok": True,
            "symbol": "BRTI",
            "source": "cf_benchmarks",
            "label": "CF BRTI (Kalshi)",
            "granularity": granularity,
            "candles": brti_candles[-limit:],
            "error": f"Coinbase history unavailable: {cb_err}" if cb_err else None,
            "fetched_at": fetched_at,
        }
    elif cb_candles:
        payload = {
            "ok": True,
            "symbol": "BTC-USD",
            "source": "coinbase_fallback",
            "label": "Coinbase (BRTI unavailable)",
            "granularity": granularity,
            "candles": cb_candles[-limit:],
            "error": f"BRTI fallback: {brti_err}",
            "fetched_at": fetched_at,
        }
    else:
        payload = {
            "ok": False,
            "symbol": "BRTI",
            "source": None,
            "granularity": granularity,
            "candles": [],
            "error": f"BRTI: {brti_err}; Coinbase: {cb_err}",
            "fetched_at": fetched_at,
        }

    with _cache_lock:
        _candles_cache["at"] = time.time()
        _candles_cache["key"] = key
        _candles_cache["payload"] = payload
    return payload


def ensure_vapid_keys() -> tuple[str | None, str | None]:
    """Return (applicationServerKey, private_pem_path).

    Prefer env VAPID_PRIVATE_PEM + VAPID_PUBLIC_KEY so Render restarts don't
    wipe keys (ephemeral disk) and kill all push subscriptions.
    """
    global _vapid_app_server_key, _vapid_private_path
    if _vapid_app_server_key and _vapid_private_path:
        return _vapid_app_server_key, _vapid_private_path
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid
    except Exception as exc:
        print(f"[kalshi-btc-target] Web Push unavailable (install pywebpush): {exc}")
        return None, None

    env_pub = (os.environ.get("VAPID_PUBLIC_KEY") or "").strip()
    env_priv = (os.environ.get("VAPID_PRIVATE_PEM") or "").strip()
    if env_pub and env_priv:
        priv_path = DATA_DIR / "vapid_private_env.pem"
        priv_path.write_text(env_priv if env_priv.endswith("\n") else env_priv + "\n")
        VAPID_PUBLIC_RAW.write_text(env_pub)
        _vapid_app_server_key = env_pub
        _vapid_private_path = str(priv_path)
        print("[kalshi-btc-target] VAPID keys loaded from environment")
        return _vapid_app_server_key, _vapid_private_path

    vapid = Vapid()
    if VAPID_PRIVATE.is_file() and VAPID_PUBLIC_RAW.is_file():
        vapid = Vapid.from_file(str(VAPID_PRIVATE))
        app_key = VAPID_PUBLIC_RAW.read_text().strip()
    else:
        vapid.generate_keys()
        vapid.save_key(str(VAPID_PRIVATE))
        raw = vapid.public_key.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        app_key = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
        VAPID_PUBLIC_RAW.write_text(app_key)
        print(
            "[kalshi-btc-target] generated new VAPID keys — set VAPID_PUBLIC_KEY + "
            "VAPID_PRIVATE_PEM on Render to keep push alive across restarts"
        )

    _vapid_app_server_key = app_key
    _vapid_private_path = str(VAPID_PRIVATE)
    return _vapid_app_server_key, _vapid_private_path


def load_push_subs() -> None:
    global _push_subs
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not PUSH_SUBS_FILE.is_file():
        _push_subs = []
        return
    try:
        _push_subs = json.loads(PUSH_SUBS_FILE.read_text())
        if not isinstance(_push_subs, list):
            _push_subs = []
    except Exception:
        _push_subs = []


def _normalize_demo_account(raw: dict | None) -> dict | None:
    """BeatLine demo account payload (per-user)."""
    if not isinstance(raw, dict):
        return None
    history = raw.get("history")
    if not isinstance(history, list):
        history = []
    history = [h for h in history if isinstance(h, dict)][:DEMO_HISTORY_LIMIT]
    start = raw.get("start")
    balance = raw.get("balance")
    realized = raw.get("realizedPl")
    try:
        start_n = float(start) if start is not None else 1000.0
    except (TypeError, ValueError):
        start_n = 1000.0
    try:
        balance_n = float(balance) if balance is not None else start_n
    except (TypeError, ValueError):
        balance_n = start_n
    try:
        realized_n = float(realized) if realized is not None else 0.0
    except (TypeError, ValueError):
        realized_n = 0.0
    updated = raw.get("updatedAt")
    try:
        updated_n = int(updated) if updated is not None else int(time.time() * 1000)
    except (TypeError, ValueError):
        updated_n = int(time.time() * 1000)
    position = raw.get("position")
    if not isinstance(position, dict):
        position = None
    last_result = raw.get("lastResult")
    if not isinstance(last_result, dict):
        last_result = None
    return {
        "on": bool(raw.get("on")),
        "start": start_n,
        "balance": balance_n,
        "realizedPl": realized_n,
        "position": position,
        "lastResult": last_result,
        "history": history,
        "updatedAt": updated_n,
    }


def _read_account_file(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text())
        return _normalize_demo_account(raw if isinstance(raw, dict) else None)
    except Exception:
        return None


def load_seed_trade_history() -> list[dict]:
    """Aug 4–5 recovered ledger — merge into every account for W/L charts."""
    try:
        if not SEED_TRADE_HISTORY_FILE.is_file():
            return []
        raw = json.loads(SEED_TRADE_HISTORY_FILE.read_text())
        hist = raw.get("history") if isinstance(raw, dict) else None
        if not isinstance(hist, list):
            return []
        return [h for h in hist if isinstance(h, dict)]
    except Exception:
        return []


def with_seed_trade_history(state: dict | None) -> dict | None:
    if not state or not isinstance(state, dict):
        return state
    seed = load_seed_trade_history()
    if not seed:
        return state
    hist = state.get("history") if isinstance(state.get("history"), list) else []
    merged = merge_trade_histories(hist, seed)
    if len(merged) == len(hist):
        return state
    out = dict(state)
    out["history"] = merged
    return out


def load_demo_account(user_id: str | None = None) -> dict | None:
    """Load one user's demo account. Prefer per-user files under accounts/."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
    uid = _normalize_user_id(user_id)
    with _demo_lock:
        if uid:
            state = _read_account_file(_account_path(uid))
        else:
            # Legacy path (no user header): shared file.
            state = _read_account_file(DEMO_ACCOUNT_FILE)
    return with_seed_trade_history(state)


def _trade_history_id(h: dict) -> str:
    if h.get("id"):
        return str(h["id"])
    return "|".join(
        [
            str(h.get("at") or ""),
            str(h.get("kind") or ""),
            str(h.get("side") or ""),
            str(h.get("ticker") or ""),
            str(h.get("pl") if h.get("pl") is not None else ""),
            str(h.get("text") or ""),
        ]
    )


def merge_trade_histories(*lists: list) -> list[dict]:
    """Union trade rows by id so older days survive partial client syncs."""
    by_id: dict[str, dict] = {}
    for lst in lists:
        if not isinstance(lst, list):
            continue
        for h in lst:
            if not isinstance(h, dict):
                continue
            tid = _trade_history_id(h)
            if not tid or tid in by_id:
                continue
            by_id[tid] = h
    merged = list(by_id.values())
    merged.sort(key=lambda h: int(h.get("at") or 0), reverse=True)
    return merged[:DEMO_HISTORY_LIMIT]


def save_demo_account(raw: dict, user_id: str | None = None) -> dict | None:
    normalized = _normalize_demo_account(raw)
    if not normalized:
        return None
    if not normalized.get("updatedAt"):
        normalized["updatedAt"] = int(time.time() * 1000)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
    uid = _normalize_user_id(user_id)
    with _demo_lock:
        if uid:
            path = _account_path(uid)
            prev_hist: list = []
            if path.is_file():
                try:
                    prev = json.loads(path.read_text())
                    if isinstance(prev, dict) and isinstance(prev.get("history"), list):
                        prev_hist = [h for h in prev["history"] if isinstance(h, dict)]
                except Exception:
                    prev_hist = []
            elif not _list_account_ids() and DEMO_ACCOUNT_FILE.is_file():
                # First private-account save can absorb the old shared ledger
                # only when this client is uploading a real book (not a fresh
                # empty friend phone).
                incoming_probe = normalized.get("history") or []
                looks_fresh = (
                    not incoming_probe
                    and not normalized.get("position")
                    and abs(float(normalized.get("realizedPl") or 0)) < 0.01
                    and abs(
                        float(normalized.get("balance") or 0)
                        - float(normalized.get("start") or 1000)
                    )
                    < 0.01
                )
                if not looks_fresh:
                    try:
                        prev = json.loads(DEMO_ACCOUNT_FILE.read_text())
                        if isinstance(prev, dict) and isinstance(
                            prev.get("history"), list
                        ):
                            prev_hist = [
                                h for h in prev["history"] if isinstance(h, dict)
                            ]
                            print(
                                f"[kalshi-btc-target] absorbed legacy ledger into user {uid}"
                            )
                    except Exception:
                        prev_hist = []
            incoming = normalized.get("history") or []
            seed = load_seed_trade_history()
            if not incoming and prev_hist:
                normalized["history"] = merge_trade_histories(
                    prev_hist, seed
                )[:DEMO_HISTORY_LIMIT]
            else:
                normalized["history"] = merge_trade_histories(
                    incoming, prev_hist, seed
                )[:DEMO_HISTORY_LIMIT]
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(normalized, indent=2))
            tmp.replace(path)
            return normalized

        # Legacy shared file for old clients without a user id.
        prev_hist = []
        if DEMO_ACCOUNT_FILE.is_file():
            try:
                prev = json.loads(DEMO_ACCOUNT_FILE.read_text())
                if isinstance(prev, dict) and isinstance(prev.get("history"), list):
                    prev_hist = [h for h in prev["history"] if isinstance(h, dict)]
            except Exception:
                prev_hist = []
        incoming = normalized.get("history") or []
        seed = load_seed_trade_history()
        if not incoming and prev_hist:
            normalized["history"] = merge_trade_histories(
                prev_hist, seed
            )[:DEMO_HISTORY_LIMIT]
        else:
            normalized["history"] = merge_trade_histories(
                incoming, prev_hist, seed
            )[:DEMO_HISTORY_LIMIT]
        tmp = DEMO_ACCOUNT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(normalized, indent=2))
        tmp.replace(DEMO_ACCOUNT_FILE)
    return normalized


def save_push_subs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _push_lock:
        payload = json.dumps(_push_subs, indent=2)
    PUSH_SUBS_FILE.write_text(payload)


def upsert_push_sub(sub: dict) -> None:
    endpoint = (sub or {}).get("endpoint")
    if not endpoint:
        return
    with _push_lock:
        _push_subs[:] = [s for s in _push_subs if s.get("endpoint") != endpoint]
        _push_subs.append(sub)
    save_push_subs()


def remove_push_sub(endpoint: str) -> None:
    if not endpoint:
        return
    with _push_lock:
        _push_subs[:] = [s for s in _push_subs if s.get("endpoint") != endpoint]
    save_push_subs()


def send_web_push(payload: dict) -> int:
    app_key, priv = ensure_vapid_keys()
    if not app_key or not priv:
        return 0
    try:
        from pywebpush import webpush, WebPushException
    except Exception as exc:
        print(f"[kalshi-btc-target] pywebpush missing: {exc}")
        return 0

    body = json.dumps(payload)
    sent = 0
    dead: list[str] = []
    with _push_lock:
        subs = list(_push_subs)
    for sub in subs:
        try:
            webpush(
                subscription_info=sub,
                data=body,
                vapid_private_key=priv,
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=3600,
            )
            sent += 1
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            msg = str(exc)
            if status in (404, 410) or "410" in msg or "404" in msg:
                dead.append(sub.get("endpoint") or "")
            else:
                print(f"[kalshi-btc-target] push failed: {exc}")
    for endpoint in dead:
        remove_push_sub(endpoint)
    return sent


def _usable_ask_cents(ask_pct) -> int | None:
    if ask_pct is None:
        return None
    try:
        n = int(round(float(ask_pct)))
    except (TypeError, ValueError):
        return None
    if n < 2 or n > 98:
        return None
    return n


def _model_prob_above(
    spot: float,
    beat: float,
    secs_left: float,
    settlement_mode: bool,
    settlement_side: str | None,
    settlement_avg: float | None,
) -> float | None:
    if settlement_mode and settlement_side == "above":
        return 0.97
    if settlement_mode and settlement_side == "below":
        return 0.03
    if (
        settlement_mode
        and settlement_avg is not None
        and math.isfinite(settlement_avg)
    ):
        d = float(settlement_avg) - float(beat)
        sigma = max(8.0, abs(float(beat)) * 0.00015)
        return 0.5 * (1.0 + math.erf((d / sigma) / math.sqrt(2.0)))
    t = max(1.0, float(secs_left) or 1.0)
    sigma = max(8.0, abs(float(beat)) * 0.55 * math.sqrt(t / (365.25 * 24 * 3600)))
    return 0.5 * (1.0 + math.erf(((float(spot) - float(beat)) / sigma) / math.sqrt(2.0)))


def _kalshi_taker_fee(contracts: int, price: float) -> float:
    c = max(0, contracts)
    p = min(0.99, max(0.01, price))
    raw = 0.07 * c * p * (1.0 - p)
    return math.ceil(raw * 100 - 1e-9) / 100.0


# Bigger-picture BTC tape bias (off under Green Spike / green-spike).
# Profile note: client BEST_SIDE_PROFILE = "green-spike".
TREND_BIAS_ENABLED = False


def _short_term_trend() -> dict:
    """BTC tape over ~5–10m from 1m candles (mirrors client shortTermTrend)."""
    if not TREND_BIAS_ENABLED:
        return {"bias": "flat", "strength": 0.0, "move5": 0.0, "move10": 0.0}
    try:
        payload = fetch_candles(60, 20)
        candles = payload.get("candles") or []
    except Exception:
        candles = []
    if len(candles) < 4:
        return {"bias": "flat", "strength": 0.0, "move5": 0.0, "move10": 0.0}
    last = float(candles[-1]["close"])
    n5 = min(5, len(candles) - 1)
    n10 = min(10, len(candles) - 1)
    move5 = last - float(candles[-1 - n5]["close"])
    move10 = last - float(candles[-1 - n10]["close"])
    down = max(-move5 / 80.0, -move10 / 140.0, 0.0)
    up = max(move5 / 80.0, move10 / 140.0, 0.0)
    strength = 0.0
    if down > up and down >= 0.35:
        strength = -min(1.0, down)
    elif up > down and up >= 0.35:
        strength = min(1.0, up)
    bias = "down" if strength <= -0.35 else "up" if strength >= 0.35 else "flat"
    return {
        "bias": bias,
        "strength": strength,
        "move5": move5,
        "move10": move10,
    }


_suggest_bankroll_cache = {"balance": None, "at": 0.0}
_SUGGEST_BANKROLL_TTL_SEC = 60.0


def _suggest_bankroll() -> float | None:
    """Cached Kalshi cash for automatic-beat 1% sizing (avoids balance spam)."""
    now = time.time()
    cached = _suggest_bankroll_cache.get("balance")
    at = float(_suggest_bankroll_cache.get("at") or 0.0)
    if cached is not None and now - at < _SUGGEST_BANKROLL_TTL_SEC:
        return float(cached)
    try:
        creds = get_kalshi_credentials()
        if not creds:
            return cached if cached is not None else None
        bal = kalshi_fetch_balance(creds)
        if bal.get("ok") and bal.get("balance") is not None:
            value = float(bal["balance"])
            _suggest_bankroll_cache["balance"] = value
            _suggest_bankroll_cache["at"] = now
            return value
    except Exception:
        pass
    return cached if cached is not None else None


def _green_spike_suggest(
    ask: float, p_win: float, bankroll: float | None = None
) -> int:
    """
    Suggested Best-buy / automatic-beat entry.
    Hard-capped at ~1% of Kalshi bankroll when known; else ≤ $100.
    Small accounts (<$100) still get a $1 floor when balance can cover it —
    int(bank*0.01) used to floor $95 → $0 and block every auto buy.
    Manual buy chips on the client stay independent of this cap.
    """
    cost = ask / 100.0
    edge_amt = p_win - cost
    suggest = 10
    if edge_amt > 0 and cost < 1:
        kelly = edge_amt / max(0.01, 1.0 - cost)
        suggest = int(max(5, min(100, round(100 * kelly * 0.3))))
    suggest = min(100, suggest)
    try:
        bank = float(bankroll) if bankroll is not None else None
    except (TypeError, ValueError):
        bank = None
    if bank is not None and bank > 0:
        risk_cap = int(round(bank * 0.01))
        # Never return $0 when the account can afford a $1 entry.
        if bank >= 1:
            risk_cap = max(1, risk_cap)
        if risk_cap < 1:
            return 0
        suggest = min(suggest, risk_cap)
    return max(0, suggest)


def evaluate_clear_edge(
    data: dict, spot: float | None, *, latched: bool = False
) -> dict | None:
    """Score Best Side and report clear/near-miss (Green Spike / green-spike)."""
    _ = latched  # sticky latch unused under Green Spike
    if spot is None or not math.isfinite(float(spot)):
        return None
    beat = data.get("price_to_beat")
    if beat is None:
        beat = data.get("target")
    if beat is None or not math.isfinite(float(beat)):
        return None

    close_iso = data.get("close_time")
    if not close_iso:
        return None
    try:
        close_dt = datetime.fromisoformat(str(close_iso).replace("Z", "+00:00"))
        secs = max(0.0, (close_dt.timestamp() - time.time()))
    except Exception:
        return None

    above_ask = _usable_ask_cents(data.get("yes_ask_pct"))
    below_ask = _usable_ask_cents(data.get("no_ask_pct"))
    yes = data.get("yes_pct")
    no = data.get("no_pct")

    def _mid_ok(pct) -> bool:
        try:
            n = int(round(float(pct)))
        except (TypeError, ValueError):
            return False
        return 5 <= n <= 95

    # Match client updateRoi: replace locked ~1–2¢ asks with mid % when sane.
    if (
        above_ask is not None
        and above_ask <= 2
        and yes is not None
        and _mid_ok(yes)
    ):
        try:
            above_ask = _usable_ask_cents(max(2, min(98, round(float(yes)))))
        except (TypeError, ValueError):
            pass
    if (
        below_ask is not None
        and below_ask <= 2
        and no is not None
        and _mid_ok(no)
    ):
        try:
            below_ask = _usable_ask_cents(max(2, min(98, round(float(no)))))
        except (TypeError, ValueError):
            pass
    if above_ask is None and yes is not None:
        try:
            above_ask = _usable_ask_cents(max(2, min(98, round(float(yes)))))
        except (TypeError, ValueError):
            above_ask = None
    if below_ask is None and no is not None:
        try:
            below_ask = _usable_ask_cents(max(2, min(98, round(float(no)))))
        except (TypeError, ValueError):
            below_ask = None
    if above_ask is None and below_ask is None:
        return None

    model = _model_prob_above(
        float(spot),
        float(beat),
        secs,
        bool(data.get("settlement_mode")),
        data.get("settlement_side"),
        data.get("settlement_avg"),
    )
    if model is None:
        return None

    scored = []
    for side, ask in (("above", above_ask), ("below", below_ask)):
        if ask is None:
            continue
        p = ask / 100.0
        fee = _kalshi_taker_fee(1, p)
        cost_per = p + fee
        p_win = model if side == "above" else 1.0 - model
        ev = p_win * 1.0 - cost_per
        risk = max(0.04, 1.0 - p_win)
        scored.append(
            {
                "side": side,
                "ask_cents": ask,
                "p_win": p_win,
                "ev": ev,
                "score": ev / risk,
            }
        )
    if not scored:
        return None
    scored.sort(key=lambda x: x["score"], reverse=True)
    best = scored[0]
    if data.get("thin_book"):
        best = {**best, "score": best["score"] - 0.08}

    # Profile Green Spike: pWin ≥ 52% favorites only (August 5 / v9.33).
    reject = None
    if best["p_win"] < 0.52:
        reject = "p_win"
    elif best["ev"] <= 0.01:
        reject = "ev"
    elif best["score"] <= 0.04:
        reject = "score"
    elif secs > 12 * 60 and abs(best["ev"]) < 0.03:
        reject = "early_window"
    clear = reject is None

    ask = float(best["ask_cents"])
    p_win = float(best["p_win"])
    return {
        "side": best["side"],
        "ask_cents": best["ask_cents"],
        "p_win": p_win,
        "ev": best["ev"],
        "score": best["score"],
        "clear": clear,
        "reject": reject,
        "suggest_stake": _green_spike_suggest(ask, p_win, _suggest_bankroll()),
        "profile": "green-spike",
        "secs_left": secs,
        "spot": float(spot),
        "beat": float(beat),
    }


def score_clear_edge(
    data: dict, spot: float | None, *, latched: bool = False
) -> dict | None:
    """Mirror client Best Side clear-edge (profile: Green Spike / green-spike)."""
    evaluated = evaluate_clear_edge(data, spot, latched=latched)
    if not evaluated or not evaluated.get("clear"):
        return None
    return {
        "side": evaluated["side"],
        "ask_cents": evaluated["ask_cents"],
        "p_win": evaluated["p_win"],
        "ev": evaluated["ev"],
        "score": evaluated["score"],
        "suggest_stake": evaluated["suggest_stake"],
        "profile": evaluated["profile"],
    }


def current_clear_edge() -> dict:
    """Live clear-edge snapshot for SW / clients (background tone path)."""
    try:
        data = fetch_target_payload("15m")
    except Exception:
        return {"ok": True, "clear": False, "reason": "target_error"}
    spot = None
    try:
        spot_payload = fetch_spot()
        if spot_payload.get("ok"):
            spot = spot_payload.get("price")
    except Exception:
        spot = None
    beat = data.get("price_to_beat")
    if beat is None:
        beat = data.get("target")
    evaluated = evaluate_clear_edge(data, spot)
    if not evaluated:
        return {
            "ok": True,
            "clear": False,
            "reason": "unscorable",
            "ticker": data.get("ticker"),
            "beat": beat,
            "price_to_beat": beat,
            "spot": spot,
            "profile": "green-spike",
        }
    base = {
        "ok": True,
        "clear": bool(evaluated["clear"]),
        "side": evaluated["side"],
        "ask_cents": evaluated["ask_cents"],
        "p_win": evaluated["p_win"],
        "ev": evaluated["ev"],
        "score": evaluated["score"],
        "suggest_stake": evaluated.get("suggest_stake"),
        "ticker": data.get("ticker"),
        "beat": beat,
        "price_to_beat": beat,
        "close_et": data.get("close_et"),
        "secs_left": evaluated.get("secs_left"),
        "spot": evaluated.get("spot"),
        "profile": "green-spike",
    }
    if evaluated["clear"]:
        return base
    base["reject"] = evaluated.get("reject")
    base["reason"] = "no_clear_edge"
    return base


def push_watcher_loop() -> None:
    """Poll Kalshi and push to phones even when the PWA is backgrounded."""
    global _last_push_ticker, _last_edge_key, _last_edge_at, _last_edge_gone_at
    global _last_edge_ask, _clear_edge_latched, _clear_edge_latch_ticker
    global _edge_confirm_key, _edge_confirm_count
    global _last_auto_trade_key, _last_auto_position
    print("[kalshi-btc-target] background push watcher started")
    while True:
        try:
            data = fetch_target_payload("15m")
            ticker = data.get("ticker")
            beat = data.get("price_to_beat")
            if beat is None:
                beat = data.get("target")
            if (
                ticker
                and _last_push_ticker
                and ticker != _last_push_ticker
                and data.get("source") == "kalshi"
            ):
                # New 15m / TO BEAT window — do NOT push an alert for this
                # trigger. Still reset clear-edge sticky so Best-buy can fire
                # fresh in the new window.
                print(
                    f"[kalshi-btc-target] new 15m target {ticker} "
                    f"beat={beat} (no to-beat alert)"
                )
                _last_edge_key = None
                _last_edge_gone_at = 0.0
                _last_edge_ask = None
                _clear_edge_latched = False
                _clear_edge_latch_ticker = ticker
                _edge_confirm_key = None
                _edge_confirm_count = 0
                # Fresh 15m window — allow a new auto-buy.
                with _auto_trade_lock:
                    _last_auto_trade_key = None
                    _last_auto_position = None
            if ticker:
                _last_push_ticker = ticker

            # Clear-edge Best Side push (same thresholds as the app).
            spot = None
            try:
                spot_payload = fetch_spot()
                if spot_payload.get("ok"):
                    spot = spot_payload.get("price")
            except Exception:
                spot = None
            latched = bool(
                _clear_edge_latched
                and ticker
                and ticker == _clear_edge_latch_ticker
            )
            edge = score_clear_edge(data, spot, latched=latched)
            now = time.time()
            if edge:
                _clear_edge_latched = True
                _clear_edge_latch_ticker = ticker
                sticky = f"{ticker}:{edge['side']}"
                if sticky == _edge_confirm_key:
                    _edge_confirm_count += 1
                else:
                    _edge_confirm_key = sticky
                    _edge_confirm_count = 1
                # Hold one extra poll so fleeting ticks don't notify without a
                # matching in-app Suggested buy.
                confirmed = _edge_confirm_count >= EDGE_CONFIRM_POLLS
                ask = int(edge["ask_cents"])
                cooled = now - _last_edge_at >= EDGE_PUSH_COOLDOWN_SEC
                ask_improved = (
                    sticky == _last_edge_key
                    and _last_edge_ask is not None
                    and (_last_edge_ask - ask) >= 5
                )
                # New window/side: always push. Same side: ask improve, or
                # after full cooldown retry (recovers swallowed deliveries
                # without open-time dump — client dedupes via edgeAt).
                if not confirmed:
                    should_push = False
                elif sticky != _last_edge_key:
                    should_push = True
                elif ask_improved and (now - _last_edge_at) >= 20.0:
                    should_push = True
                elif cooled:
                    should_push = True
                else:
                    should_push = False
                if should_push:
                    n = send_web_push(
                        {
                            "type": "clear_edge",
                            "side": edge["side"],
                            "ask_cents": edge["ask_cents"],
                            "p_win": edge["p_win"],
                            "suggest_stake": edge.get("suggest_stake"),
                            "ticker": ticker,
                            "beat": beat,
                            "price_to_beat": beat,
                            "target": beat,
                        }
                    )
                    print(
                        f"[kalshi-btc-target] clear edge {edge['side']} "
                        f"ask={edge['ask_cents']}¢ pushed={n}"
                    )
                    # Only consume the sticky after a real delivery. If VAPID
                    # / subscribers fail (pushed=0), keep retrying next poll.
                    if n > 0:
                        _last_edge_key = sticky
                        _last_edge_ask = ask
                        _last_edge_at = now
                # Fill immediately on the same confirmed pulse as the alert —
                # do not wait for the phone / foreground JS.
                if confirmed:
                    try:
                        side = edge["side"]
                        if side == "above":
                            opp_bid = data.get("no_bid_pct")
                            same_bid = data.get("yes_bid_pct")
                        else:
                            opp_bid = data.get("yes_bid_pct")
                            same_bid = data.get("no_bid_pct")
                        try_server_auto_trade(
                            ticker=ticker or "",
                            side=side,
                            ask_cents=edge["ask_cents"],
                            suggest_stake=edge.get("suggest_stake"),
                            bid_cents=same_bid,
                            opposite_bid_cents=opp_bid,
                        )
                    except Exception as auto_exc:
                        print(f"[kalshi-btc-target] auto-trade error: {auto_exc}")
                _last_edge_gone_at = 0.0
            else:
                _clear_edge_latched = False
                _edge_confirm_key = None
                _edge_confirm_count = 0
                # Only forget the edge after it has been gone for a while —
                # prevents push loops when the score flickers around threshold.
                if _last_edge_key is not None:
                    if not _last_edge_gone_at:
                        _last_edge_gone_at = now
                    elif now - _last_edge_gone_at >= EDGE_GONE_RESET_SEC:
                        _last_edge_key = None
                        _last_edge_ask = None
                        _last_edge_gone_at = 0.0
        except Exception as exc:
            print(f"[kalshi-btc-target] push watcher error: {exc}")
        time.sleep(PUSH_POLL_SEC)


def _normalize_pem(raw: str) -> str:
    """Normalize pasted Kalshi private keys (RSA or PKCS#8)."""
    import re as _re

    pem = (raw or "").strip()
    pem = pem.replace("\r\n", "\n").replace("\r", "\n")
    pem = pem.replace("\\n", "\n")
    for ch in ("\u201c", "\u201d", "\u2018", "\u2019", "\ufeff"):
        pem = pem.replace(ch, '"' if ch in ("\u201c", "\u201d") else ("'" if ch in ("\u2018", "\u2019") else ""))
    pem = pem.strip().strip('"').strip("'").strip()
    if not pem:
        return ""
    if "BEGIN" not in pem:
        body = "".join(pem.split())
        body = _re.sub(r"[^A-Za-z0-9+/=]", "", body)
        wrapped = "\n".join(body[i : i + 64] for i in range(0, len(body), 64))
        pem = (
            "-----BEGIN PRIVATE KEY-----\n"
            + wrapped
            + "\n-----END PRIVATE KEY-----"
        )
    return pem.strip() + "\n"


def _load_kalshi_creds_file() -> dict:
    if not KALSHI_CREDS_FILE.exists():
        return {}
    try:
        raw = json.loads(KALSHI_CREDS_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _save_kalshi_creds_file(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = KALSHI_CREDS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, KALSHI_CREDS_FILE)
    try:
        os.chmod(KALSHI_CREDS_FILE, 0o600)
    except OSError:
        pass


def get_kalshi_credentials() -> dict | None:
    """Resolve API key id + PEM from env (preferred) or data/kalshi_credentials.json."""
    env_id = (os.environ.get("KALSHI_API_KEY_ID") or "").strip()
    env_pem = _normalize_pem(os.environ.get("KALSHI_PRIVATE_KEY") or "")
    with _kalshi_creds_lock:
        file_creds = _load_kalshi_creds_file()
    file_id = str(file_creds.get("api_key_id") or "").strip()
    file_pem = _normalize_pem(str(file_creds.get("private_key_pem") or ""))
    api_key_id = env_id or file_id
    private_key_pem = env_pem or file_pem
    if not api_key_id or not private_key_pem:
        return None
    return {
        "api_key_id": api_key_id,
        "private_key_pem": private_key_pem,
        "live_enabled": bool(file_creds.get("live_enabled")),
        "auto_trade": bool(file_creds.get("auto_trade")),
        "auto_flip": bool(file_creds.get("auto_flip")),
        "from_env": bool(env_id and env_pem),
        "key_hint": api_key_id[:8] + "…" if len(api_key_id) > 8 else api_key_id,
    }


def set_kalshi_live_enabled(enabled: bool) -> dict:
    with _kalshi_creds_lock:
        data = _load_kalshi_creds_file()
        data["live_enabled"] = bool(enabled)
        data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _save_kalshi_creds_file(data)
    return kalshi_account_status(fetch_balance=True)


def set_kalshi_auto_trade(
    *, auto_trade: bool | None = None, auto_flip: bool | None = None
) -> dict:
    """Persist Auto-trade / Auto-flip so the push watcher can fill in background."""
    with _kalshi_creds_lock:
        data = _load_kalshi_creds_file()
        if auto_trade is not None:
            data["auto_trade"] = bool(auto_trade)
            if not auto_trade:
                data["auto_flip"] = False
        if auto_flip is not None:
            data["auto_flip"] = bool(auto_flip) and bool(
                data.get("auto_trade") if auto_trade is None else auto_trade
            )
        data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _save_kalshi_creds_file(data)
    return kalshi_account_status(fetch_balance=False)


def save_kalshi_credentials(api_key_id: str, private_key_pem: str, live_enabled=None) -> dict:
    api_key_id = (api_key_id or "").strip()
    private_key_pem = _normalize_pem(private_key_pem or "")
    if not api_key_id or not private_key_pem:
        raise ValueError("api_key_id and private_key_pem required")
    # Validate PEM parses before saving.
    _load_private_key(private_key_pem)
    with _kalshi_creds_lock:
        data = _load_kalshi_creds_file()
        data["api_key_id"] = api_key_id
        data["private_key_pem"] = private_key_pem
        if live_enabled is not None:
            data["live_enabled"] = bool(live_enabled)
        data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _save_kalshi_creds_file(data)
    return kalshi_account_status(fetch_balance=True)


def clear_kalshi_credentials() -> dict:
    with _kalshi_creds_lock:
        data = _load_kalshi_creds_file()
        data.pop("api_key_id", None)
        data.pop("private_key_pem", None)
        data["live_enabled"] = False
        data["auto_trade"] = False
        data["auto_flip"] = False
        data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _save_kalshi_creds_file(data)
    return kalshi_account_status(fetch_balance=False)


def _load_private_key(pem: str):
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization

    pem = _normalize_pem(pem)
    data = pem.encode("utf-8")
    try:
        return serialization.load_pem_private_key(
            data, password=None, backend=default_backend()
        )
    except Exception as first:
        if "BEGIN PRIVATE KEY" in pem and "BEGIN RSA PRIVATE KEY" not in pem:
            body = (
                pem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
            )
            body = "".join(body.split())
            wrapped = "\n".join(body[i : i + 64] for i in range(0, len(body), 64))
            alt = (
                "-----BEGIN RSA PRIVATE KEY-----\n"
                + wrapped
                + "\n-----END RSA PRIVATE KEY-----\n"
            )
            try:
                return serialization.load_pem_private_key(
                    alt.encode("utf-8"), password=None, backend=default_backend()
                )
            except Exception:
                pass
        raise ValueError(
            "Could not read private key — paste the full .key / PEM from Kalshi "
            "(include the BEGIN and END lines)"
        ) from first


def _kalshi_sign(private_key, timestamp: str, method: str, path: str) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    path_without_query = path.split("?", 1)[0]
    message = f"{timestamp}{method}{path_without_query}".encode("utf-8")
    signature = private_key.sign(
        message,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )
    return base64.b64encode(signature).decode("utf-8")


def kalshi_authed_request(
    method: str,
    rel_path: str,
    body: dict | None = None,
    creds: dict | None = None,
) -> tuple[int, dict | list | str]:
    """
    Authenticated Kalshi Trade API call.
    rel_path is under /trade-api/v2, e.g. "/portfolio/balance".
    """
    creds = creds or get_kalshi_credentials()
    if not creds:
        return 401, {"error": "Kalshi credentials not configured"}

    method = method.upper()
    rel = rel_path if rel_path.startswith("/") else f"/{rel_path}"
    url = f"{KALSHI_API_BASE}{rel}"
    # Sign the full path from host root (includes /trade-api/v2/...).
    sign_path = urllib.parse.urlparse(url).path
    timestamp = str(int(time.time() * 1000))
    private_key = _load_private_key(creds["private_key_pem"])
    signature = _kalshi_sign(private_key, timestamp, method, sign_path)
    headers = {
        "KALSHI-ACCESS-KEY": creds["api_key_id"],
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "Accept": "application/json",
        "User-Agent": UA,
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            code = resp.getcode()
            try:
                return code, json.loads(raw) if raw else {}
            except Exception:
                return code, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {"error": str(exc)}
        except Exception:
            payload = {"error": raw or str(exc)}
        return exc.code, payload
    except Exception as exc:
        return 502, {"error": str(exc)}


def _kalshi_err_text(err) -> str:
    """Flatten Kalshi error payloads (often nested dicts) to a short string."""
    if err is None:
        return "unknown error"
    if isinstance(err, str):
        return err
    if isinstance(err, (int, float, bool)):
        return str(err)
    if isinstance(err, dict):
        for key in ("message", "error", "detail", "code", "msg"):
            val = err.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
            if isinstance(val, dict):
                nested = _kalshi_err_text(val)
                if nested and nested != "unknown error":
                    return nested
        try:
            return json.dumps(err)[:200]
        except Exception:
            return "Kalshi error"
    return str(err)


def kalshi_fetch_balance(creds: dict | None = None) -> dict:
    code, payload = kalshi_authed_request("GET", "/portfolio/balance", creds=creds)
    if code != 200 or not isinstance(payload, dict):
        err = _kalshi_err_text(
            payload.get("error")
            or payload.get("message")
            or (payload if isinstance(payload, str) else "balance failed")
        )
        return {"ok": False, "error": err, "status": code}
    # balance is in cents
    bal_cents = payload.get("balance")
    try:
        bal_cents = int(bal_cents)
    except (TypeError, ValueError):
        bal_cents = None
    return {
        "ok": True,
        "balance_cents": bal_cents,
        "balance": (bal_cents / 100.0) if bal_cents is not None else None,
        "portfolio_value": payload.get("portfolio_value"),
        "updated_ts": payload.get("updated_ts"),
        "raw": payload,
    }


def kalshi_account_status(fetch_balance: bool = True) -> dict:
    creds = get_kalshi_credentials()
    if not creds:
        return {
            "ok": True,
            "connected": False,
            "live_enabled": False,
            "auto_trade": False,
            "auto_flip": False,
            "server_armed": False,
            "from_env": False,
            "balance": None,
            "key_hint": None,
            "error": None,
            "last_auto_trade_key": _last_auto_trade_key,
            "last_auto_trade_note": _last_auto_trade_note or None,
            "auto_attempt_count": len(_load_auto_trade_log()),
        }
    out = {
        "ok": True,
        "connected": True,
        "live_enabled": bool(creds.get("live_enabled")),
        "auto_trade": bool(creds.get("auto_trade")),
        "auto_flip": bool(creds.get("auto_flip")),
        "server_armed": bool(
            creds.get("live_enabled") and creds.get("auto_trade")
        ),
        "from_env": bool(creds.get("from_env")),
        "key_hint": creds.get("key_hint"),
        "balance": None,
        "balance_cents": None,
        "error": None,
        "authenticated": None,
        "auth_failed": False,
        "last_auto_trade_key": _last_auto_trade_key,
        "last_auto_trade_note": _last_auto_trade_note or None,
        "auto_attempt_count": len(_load_auto_trade_log()),
    }
    if fetch_balance:
        bal = kalshi_fetch_balance(creds)
        if bal.get("ok"):
            out["balance"] = bal.get("balance")
            out["balance_cents"] = bal.get("balance_cents")
            out["authenticated"] = True
        else:
            err = bal.get("error") or "Could not read Kalshi balance"
            out["error"] = err
            out["ok"] = False
            out["authenticated"] = False
            status = bal.get("status")
            err_l = str(err).lower()
            # Keys on disk but Kalshi rejected them — not a live session.
            if (
                status in (401, 403)
                or "authentication" in err_l
                or "unauthorized" in err_l
                or "invalid" in err_l and "key" in err_l
            ):
                out["connected"] = False
                out["live_enabled"] = False
                out["auth_failed"] = True
    else:
        out["authenticated"] = None
    return out


def _auto_contracts_for_stake(ask_cents: int, stake_usd) -> int:
    try:
        ask = int(ask_cents)
        stake = float(stake_usd)
    except (TypeError, ValueError):
        return 0
    if ask < 1 or ask > 99 or stake < 1:
        return 0
    p = ask / 100.0
    return max(1, int(stake // p))


def _usable_bid_cents(value) -> int | None:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    if 1 <= n <= 99:
        return n
    return None


def kalshi_fetch_market_position(ticker: str, creds: dict | None = None) -> dict:
    """
    Read open contracts for a market.
    Returns {ok, side: 'above'|'below'|None, contracts: int, raw}.
    Kalshi net position: >0 YES (Above), <0 NO (Below).
    """
    ticker = (ticker or "").strip()
    if not ticker:
        return {"ok": False, "side": None, "contracts": 0, "error": "missing ticker"}
    creds = creds or get_kalshi_credentials()
    if not creds:
        return {"ok": False, "side": None, "contracts": 0, "error": "not connected"}
    code, payload = kalshi_authed_request(
        "GET",
        f"/portfolio/positions?ticker={urllib.parse.quote(ticker)}&limit=50",
        creds=creds,
    )
    if code not in (200, 201) or not isinstance(payload, dict):
        err = None
        if isinstance(payload, dict):
            err = payload.get("error") or payload.get("message")
        return {
            "ok": False,
            "side": None,
            "contracts": 0,
            "error": err or f"positions failed ({code})",
            "raw": payload,
        }
    positions = payload.get("market_positions") or payload.get("positions") or []
    if not isinstance(positions, list):
        positions = []
    net = 0
    for row in positions:
        if not isinstance(row, dict):
            continue
        if str(row.get("ticker") or "").strip() != ticker:
            continue
        try:
            net = int(round(float(row.get("position") or 0)))
        except (TypeError, ValueError):
            net = 0
        break
    if net > 0:
        return {"ok": True, "side": "above", "contracts": net, "raw": payload}
    if net < 0:
        return {"ok": True, "side": "below", "contracts": abs(net), "raw": payload}
    return {"ok": True, "side": None, "contracts": 0, "raw": payload}


def try_server_auto_trade(
    *,
    ticker: str,
    side: str,
    ask_cents: int,
    suggest_stake=None,
    bid_cents=None,
    opposite_bid_cents=None,
    force: bool = False,
) -> dict:
    """
    Place a live Best Side buy when Auto-trade is armed on the server.
    Uses IOC with a small ask bump so fills land quickly as the book moves.
    If Auto-flip is on and the opposite side is open, sell that first then buy.
    Dedupes per ticker:side; retries failed IOCs after AUTO_TRADE_RETRY_SEC.
    Every outcome is logged so we can verify the bot actually tried.
    """
    global _last_auto_trade_key, _last_auto_trade_at, _last_auto_trade_note
    global _last_auto_trade_attempt_at, _last_auto_position

    def finish(result: dict, *, kind: str) -> dict:
        out = dict(result or {})
        out.setdefault("auto", True)
        note = out.get("note") or out.get("error") or kind
        # Skip noisy poll spam — still keep real tries / blocks / fills.
        if kind not in ("cooldown", "already", "already_long"):
            log_auto_trade_attempt(
                {
                    "kind": kind,
                    "ticker": ticker,
                    "side": side,
                    "ok": bool(out.get("ok")),
                    "skipped": bool(out.get("skipped")),
                    "already": bool(out.get("already")),
                    "flipped": bool(out.get("flipped")),
                    "note": note,
                    "error": out.get("error"),
                    "key": out.get("key"),
                    "limit_ask_cents": out.get("limit_ask_cents"),
                    "fill_count": out.get("fill_count"),
                    "suggest_stake": out.get("suggest_stake"),
                }
            )
        elif note and kind in ("already", "already_long"):
            global _last_auto_trade_note
            _last_auto_trade_note = str(note)
        return out

    ticker = (ticker or "").strip()
    side = (side or "").strip().lower()
    if side in ("yes", "y"):
        side = "above"
    elif side in ("no", "n"):
        side = "below"
    if not ticker or side not in ("above", "below"):
        return finish(
            {"ok": False, "skipped": True, "error": "Need ticker and side"},
            kind="bad_args",
        )

    creds = get_kalshi_credentials()
    if not creds:
        return finish(
            {"ok": False, "skipped": True, "error": "Kalshi not connected"},
            kind="not_connected",
        )
    if not creds.get("live_enabled") and not os.environ.get("KALSHI_LIVE_FORCE"):
        return finish(
            {"ok": False, "skipped": True, "error": "Live Kalshi buys off"},
            kind="live_off",
        )
    if not creds.get("auto_trade") and not force:
        return finish(
            {"ok": False, "skipped": True, "error": "Auto-trade off"},
            kind="auto_off",
        )

    key = f"{ticker}:{side}"
    now = time.time()
    with _auto_trade_lock:
        if _last_auto_trade_key == key:
            return finish(
                {
                    "ok": True,
                    "skipped": True,
                    "already": True,
                    "key": key,
                    "note": _last_auto_trade_note or "already auto-bought",
                },
                kind="already",
            )
        if (
            _last_auto_trade_attempt_at
            and now - _last_auto_trade_attempt_at < AUTO_TRADE_RETRY_SEC
        ):
            return finish(
                {
                    "ok": False,
                    "skipped": True,
                    "error": "auto-trade retry cooldown",
                    "key": key,
                },
                kind="cooldown",
            )
        _last_auto_trade_attempt_at = now

    # Resolve any open position on this ticker (Kalshi truth, then local memory).
    held_side = None
    held_contracts = 0
    pos = kalshi_fetch_market_position(ticker, creds)
    if pos.get("ok") and pos.get("side") and int(pos.get("contracts") or 0) > 0:
        held_side = pos["side"]
        held_contracts = int(pos["contracts"])
    elif (
        isinstance(_last_auto_position, dict)
        and _last_auto_position.get("ticker") == ticker
        and _last_auto_position.get("side") in ("above", "below")
        and int(_last_auto_position.get("contracts") or 0) > 0
    ):
        held_side = _last_auto_position["side"]
        held_contracts = int(_last_auto_position["contracts"])

    if held_side == side and held_contracts > 0:
        with _auto_trade_lock:
            _last_auto_trade_key = key
            _last_auto_trade_note = (
                f"already long {'Above' if side == 'above' else 'Below'} "
                f"({held_contracts} cts)"
            )
        return finish(
            {
                "ok": True,
                "skipped": True,
                "already": True,
                "key": key,
                "note": _last_auto_trade_note,
            },
            kind="already_long",
        )

    flipped = False
    if held_side and held_side != side and held_contracts > 0:
        if not creds.get("auto_flip"):
            note = (
                "skipped · opposite open (enable Auto-flip) — "
                f"holding {'Above' if held_side == 'above' else 'Below'}"
            )
            _last_auto_trade_note = note
            return finish(
                {"ok": False, "skipped": True, "error": note, "key": key},
                kind="need_flip",
            )

        # Close opposite at bid − slip so IOC sells fill.
        opp_bid = _usable_bid_cents(opposite_bid_cents)
        if opp_bid is None:
            opp_bid = _usable_bid_cents(bid_cents)
        if opp_bid is None:
            try:
                ask_i = int(ask_cents)
                opp_bid = max(1, min(99, 100 - ask_i))
            except (TypeError, ValueError):
                opp_bid = None
        if opp_bid is None:
            note = "auto-flip blocked · no live bid to close opposite"
            _last_auto_trade_note = note
            return finish({"ok": False, "error": note, "key": key}, kind="flip_no_bid")

        limit_bid = max(1, opp_bid - AUTO_FILL_SLIP_CENTS)
        print(
            f"[kalshi-btc-target] auto-flip CLOSE {ticker}:{held_side} "
            f"{held_contracts} cts @≥{limit_bid}¢"
        )
        sold = place_kalshi_sell(
            ticker=ticker,
            side=held_side,
            contracts=held_contracts,
            bid_cents=limit_bid,
        )
        if not sold.get("ok") or float(sold.get("fill_count") or 0) <= 0:
            err = (sold and sold.get("error")) or "opposite close did not fill"
            note = f"auto-flip close failed · {err}"
            _last_auto_trade_note = note
            print(f"[kalshi-btc-target] auto-flip CLOSE MISS {ticker}:{held_side} {err}")
            return finish(
                {"ok": False, "error": note, "key": key, "sell": sold},
                kind="flip_close_fail",
            )

        with _auto_trade_lock:
            _last_auto_position = None
            if _last_auto_trade_key and _last_auto_trade_key.startswith(f"{ticker}:"):
                _last_auto_trade_key = None
        flipped = True
        _last_auto_trade_note = (
            f"flipped off {'Above' if held_side == 'above' else 'Below'} · "
            f"opening {'Above' if side == 'above' else 'Below'}"
        )

    try:
        ask = int(ask_cents)
    except (TypeError, ValueError):
        return finish({"ok": False, "error": "Invalid ask"}, kind="bad_ask")
    if ask < 1 or ask > 99:
        return finish({"ok": False, "error": "Ask must be 1–99¢"}, kind="bad_ask")

    limit_ask = min(99, ask + AUTO_FILL_SLIP_CENTS)
    stake = suggest_stake
    try:
        stake = float(stake) if stake is not None else None
    except (TypeError, ValueError):
        stake = None
    if stake is None or stake < 1:
        bal = kalshi_fetch_balance(creds)
        bank = bal.get("balance") if bal.get("ok") else None
        # Prefer live balance for sizing — edge payload can carry stale $0.
        stake = float(_green_spike_suggest(limit_ask, 0.55, bank) or 0)
    if stake < 1:
        bal = kalshi_fetch_balance(creds)
        bank = bal.get("balance") if bal.get("ok") else None
        if bank is not None and float(bank) >= 1:
            stake = 1.0
    if stake < 1:
        note = "auto-trade size $0 (balance too small for $1 entry)"
        _last_auto_trade_note = note
        return finish({"ok": False, "error": note, "key": key}, kind="size_zero")

    contracts = _auto_contracts_for_stake(limit_ask, stake)
    if contracts < 1:
        return finish(
            {"ok": False, "error": "Need at least 1 contract", "key": key},
            kind="no_contracts",
        )

    # Prove we are about to hit Kalshi (not just alerting).
    log_auto_trade_attempt(
        {
            "kind": "sending_buy",
            "ticker": ticker,
            "side": side,
            "ok": None,
            "note": f"sending IOC buy {side} {contracts} cts @≤{limit_ask}¢",
            "key": key,
            "limit_ask_cents": limit_ask,
            "suggest_stake": int(round(stake)),
            "flipped": flipped,
        }
    )

    result = place_kalshi_buy(
        ticker=ticker,
        side=side,
        contracts=contracts,
        ask_cents=limit_ask,
    )
    side_label = "Above" if side == "above" else "Below"
    if result.get("ok"):
        fill_n = int(result.get("fill_count") or contracts)
        with _auto_trade_lock:
            _last_auto_trade_key = key
            _last_auto_trade_at = time.time()
            _last_auto_position = {
                "ticker": ticker,
                "side": side,
                "contracts": fill_n,
            }
            prefix = "flipped · " if flipped else ""
            _last_auto_trade_note = (
                f"{prefix}bought {side_label} ~${int(round(stake))} "
                f"@≤{limit_ask}¢ ({fill_n} cts)"
            )
        result = dict(result)
        result["auto"] = True
        result["flipped"] = flipped
        result["key"] = key
        result["limit_ask_cents"] = limit_ask
        result["suggest_stake"] = int(round(stake))
        result["note"] = _last_auto_trade_note
        print(f"[kalshi-btc-target] auto-trade FILL {key} {_last_auto_trade_note}")
        return finish(result, kind="fill")

    err = result.get("error") or "order failed"
    _last_auto_trade_note = (
        f"{'flip buy' if flipped else 'failed'} {side_label}: {err}"
    )
    print(f"[kalshi-btc-target] auto-trade MISS {key} {err}")
    out = dict(result)
    out["auto"] = True
    out["flipped"] = flipped
    out["key"] = key
    out["limit_ask_cents"] = limit_ask
    out["note"] = _last_auto_trade_note
    return finish(out, kind="miss")


def place_kalshi_buy(
    *,
    ticker: str,
    side: str,
    contracts: int,
    ask_cents: int,
    client_order_id: str | None = None,
) -> dict:
    """
    Place a marketable buy on the current KXBTC15M window.
    side: "above" (YES) or "below" (NO).
    """
    creds = get_kalshi_credentials()
    if not creds:
        return {"ok": False, "error": "Connect your Kalshi API key first"}
    if not creds.get("live_enabled") and not os.environ.get("KALSHI_LIVE_FORCE"):
        return {"ok": False, "error": "Turn on Live Kalshi buys in Options first"}
    ticker = (ticker or "").strip()
    if not ticker:
        return {"ok": False, "error": "Missing market ticker"}
    if side not in ("above", "below"):
        return {"ok": False, "error": "side must be above or below"}
    try:
        contracts = int(contracts)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid contract count"}
    if contracts < 1:
        return {"ok": False, "error": "Need at least 1 contract"}
    try:
        ask_cents = int(ask_cents)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid ask"}
    if ask_cents < 1 or ask_cents > 99:
        return {"ok": False, "error": "Ask must be 1–99¢"}

    client_order_id = (client_order_id or "").strip() or str(uuid.uuid4())
    yes_no = "yes" if side == "above" else "no"
    price_dollars = f"{ask_cents / 100:.4f}"

    # Prefer legacy yes/no order shape (clear for binary markets).
    legacy_body = {
        "ticker": ticker,
        "client_order_id": client_order_id,
        "action": "buy",
        "side": yes_no,
        "count": contracts,
        "type": "limit",
        "time_in_force": "immediate_or_cancel",
    }
    if yes_no == "yes":
        legacy_body["yes_price"] = ask_cents
    else:
        legacy_body["no_price"] = ask_cents

    code, payload = kalshi_authed_request(
        "POST", "/portfolio/orders", body=legacy_body, creds=creds
    )
    used = "legacy"

    # Fall back to V2 event-market book (YES-leg only: bid=buy YES, ask=sell YES≈buy NO).
    if code >= 400:
        if side == "above":
            v2_side = "bid"
            v2_price = price_dollars
        else:
            v2_side = "ask"
            v2_price = f"{(100 - ask_cents) / 100:.4f}"
        v2_body = {
            "ticker": ticker,
            "client_order_id": client_order_id,
            "side": v2_side,
            "count": f"{contracts:.2f}",
            "price": v2_price,
            "time_in_force": "immediate_or_cancel",
            "self_trade_prevention_type": "taker_at_cross",
        }
        code, payload = kalshi_authed_request(
            "POST", "/portfolio/events/orders", body=v2_body, creds=creds
        )
        used = "v2"

    if code not in (200, 201) or not isinstance(payload, dict):
        err = None
        if isinstance(payload, dict):
            err = payload.get("error") or payload.get("message") or payload.get("code")
            details = payload.get("details")
            if details and err:
                err = f"{err}: {details}"
            elif details:
                err = str(details)
        if not err:
            err = payload if isinstance(payload, str) else f"Order failed ({code})"
        return {
            "ok": False,
            "error": err,
            "status": code,
            "api": used,
            "client_order_id": client_order_id,
            "raw": payload,
        }

    order = payload.get("order") if isinstance(payload.get("order"), dict) else payload
    fill_count = order.get("fill_count") or order.get("filled_count") or 0
    try:
        fill_n = float(fill_count)
    except (TypeError, ValueError):
        fill_n = 0.0
    remaining = order.get("remaining_count")
    try:
        rem_n = float(remaining) if remaining is not None else None
    except (TypeError, ValueError):
        rem_n = None

    if fill_n <= 0 and (rem_n is None or rem_n <= 0):
        # IOC with zero fill
        return {
            "ok": False,
            "error": "Order did not fill (ask may have moved) — try again",
            "status": code,
            "api": used,
            "client_order_id": client_order_id,
            "order": order,
            "raw": payload,
        }

    bal = kalshi_fetch_balance(creds)
    return {
        "ok": True,
        "api": used,
        "client_order_id": client_order_id,
        "order_id": order.get("order_id") or order.get("id"),
        "fill_count": fill_n,
        "remaining_count": rem_n,
        "average_fill_price": order.get("average_fill_price")
        or order.get("yes_price")
        or order.get("no_price"),
        "side": side,
        "ticker": ticker,
        "contracts": contracts,
        "ask_cents": ask_cents,
        "balance": bal.get("balance") if bal.get("ok") else None,
        "order": order,
        "raw": payload,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "KalshiBtcTarget/2.0"

    def log_message(self, fmt, *args):
        print(f"[kalshi-btc-target] {self.address_string()} {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        # HEAD must advertise length but not write a body — chat apps often
        # probe share links with HEAD and treat 501 as a dead URL.
        if getattr(self, "_sending_head", False):
            return
        self.wfile.write(body)

    def _send_json(self, code: int, obj: dict):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def do_HEAD(self):
        self._sending_head = True
        try:
            self.do_GET()
        finally:
            self._sending_head = False

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}
        return obj if isinstance(obj, dict) else {}

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_json_body()

        if path == "/api/push/subscribe":
            sub = body.get("subscription") if isinstance(body.get("subscription"), dict) else body
            if not sub.get("endpoint") or not sub.get("keys"):
                self._send_json(400, {"ok": False, "error": "invalid subscription"})
                return
            upsert_push_sub(sub)
            self._send_json(200, {"ok": True, "subscribers": len(_push_subs)})
            return

        if path == "/api/push/unsubscribe":
            endpoint = body.get("endpoint") or ""
            remove_push_sub(endpoint)
            self._send_json(200, {"ok": True, "subscribers": len(_push_subs)})
            return

        if path == "/api/push/test":
            # Audible Best-buy style push — exercises the real clear_edge SW path
            # (type "test" used to hit a silent keepalive and lied about BG).
            n = send_web_push(
                {
                    "type": "clear_edge",
                    "side": body.get("side") or "above",
                    "ask_cents": int(body.get("ask_cents") or body.get("askCents") or 40),
                    "p_win": float(body.get("p_win") or body.get("pWin") or 0.55),
                    "suggest_stake": body.get("suggest_stake")
                    if body.get("suggest_stake") is not None
                    else body.get("suggestStake") or 25,
                    "ticker": body.get("ticker") or "TEST",
                    "beat": body.get("beat"),
                    "price_to_beat": body.get("beat"),
                    "target": body.get("beat"),
                    "close_et": body.get("close_et"),
                }
            )
            self._send_json(200, {"ok": True, "pushed": n})
            return

        if path == "/api/push/link":
            url = str(body.get("url") or "").strip()
            if not url.startswith("https://"):
                self._send_json(400, {"ok": False, "error": "https url required"})
                return
            n = send_web_push({"type": "new_link", "url": url})
            self._send_json(200, {"ok": True, "pushed": n, "url": url})
            return

        if path in ("/api/demo-account", "/api/account"):
            user_id = _normalize_user_id(
                body.get("userId")
                or body.get("user_id")
                or self.headers.get("X-BeatLine-User")
            )
            state = body.get("state") if isinstance(body.get("state"), dict) else body
            if isinstance(state, dict) and not user_id:
                user_id = _normalize_user_id(state.get("userId") or state.get("user_id"))
            if not user_id:
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "error": "userId required — each phone needs its own private account",
                    },
                )
                return
            saved = save_demo_account(state, user_id=user_id)
            if not saved:
                self._send_json(400, {"ok": False, "error": "invalid demo account"})
                return
            self._send_json(200, {"ok": True, "state": saved, "userId": user_id})
            return

        if path == "/api/kalshi/credentials":
            api_key_id = str(body.get("api_key_id") or body.get("apiKeyId") or "").strip()
            private_key_pem = str(
                body.get("private_key_pem")
                or body.get("privateKeyPem")
                or body.get("private_key")
                or body.get("privateKey")
                or ""
            )
            try:
                status = save_kalshi_credentials(api_key_id, private_key_pem)
            except ValueError as exc:
                self._send_json(400, {"ok": False, "error": str(exc), "saved": False})
                return
            except Exception as exc:
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "saved": False,
                        "error": f"Invalid private key format: {exc}",
                    },
                )
                return
            # Always 200 if the PEM was saved — auth_failed is a separate problem.
            status = dict(status or {})
            status["saved"] = True
            self._send_json(200, status)
            return

        if path == "/api/kalshi/disconnect":
            status = clear_kalshi_credentials()
            self._send_json(200, status)
            return

        if path == "/api/kalshi/live":
            enabled = body.get("enabled")
            if enabled is None:
                enabled = body.get("live_enabled") or body.get("liveEnabled")
            if enabled is None:
                self._send_json(400, {"ok": False, "error": "enabled required"})
                return
            if not get_kalshi_credentials():
                self._send_json(
                    400,
                    {"ok": False, "error": "Connect your Kalshi API key first"},
                )
                return
            status = set_kalshi_live_enabled(bool(enabled))
            self._send_json(200 if status.get("ok") else 502, status)
            return

        if path == "/api/kalshi/auto-trade":
            if not get_kalshi_credentials():
                self._send_json(
                    400,
                    {"ok": False, "error": "Connect your Kalshi API key first"},
                )
                return
            auto_trade = body.get("auto_trade")
            if auto_trade is None:
                auto_trade = body.get("autoTrade")
            if auto_trade is None and "enabled" in body:
                auto_trade = body.get("enabled")
            auto_flip = body.get("auto_flip")
            if auto_flip is None:
                auto_flip = body.get("autoFlip")
            if auto_trade is None and auto_flip is None:
                self._send_json(
                    400, {"ok": False, "error": "auto_trade or auto_flip required"}
                )
                return
            status = set_kalshi_auto_trade(
                auto_trade=None if auto_trade is None else bool(auto_trade),
                auto_flip=None if auto_flip is None else bool(auto_flip),
            )
            self._send_json(200, status)
            return

        if path == "/api/kalshi/auto-buy":
            # Foreground / client can trigger the same server fill path.
            result = try_server_auto_trade(
                ticker=str(body.get("ticker") or "").strip(),
                side=str(body.get("side") or "").strip().lower(),
                ask_cents=body.get("ask_cents")
                if body.get("ask_cents") is not None
                else body.get("askCents") or body.get("price_cents") or body.get("price"),
                suggest_stake=body.get("suggest_stake")
                if body.get("suggest_stake") is not None
                else body.get("suggestStake") or body.get("stake"),
                bid_cents=body.get("bid_cents")
                if body.get("bid_cents") is not None
                else body.get("bidCents"),
                opposite_bid_cents=body.get("opposite_bid_cents")
                if body.get("opposite_bid_cents") is not None
                else body.get("oppositeBidCents"),
                force=bool(body.get("force")),
            )
            code = 200 if result.get("ok") or result.get("skipped") else 400
            self._send_json(code, result)
            return

        if path == "/api/kalshi/order":
            side = str(body.get("side") or "").strip().lower()
            if side in ("yes", "y"):
                side = "above"
            elif side in ("no", "n"):
                side = "below"
            action = str(body.get("action") or "buy").strip().lower()
            if action in ("sell", "close", "exit"):
                result = place_kalshi_sell(
                    ticker=str(body.get("ticker") or "").strip(),
                    side=side,
                    contracts=body.get("contracts") or body.get("count"),
                    bid_cents=body.get("bid_cents")
                    if body.get("bid_cents") is not None
                    else body.get("bidCents")
                    or body.get("ask_cents")
                    or body.get("askCents")
                    or body.get("price_cents")
                    or body.get("price"),
                    client_order_id=body.get("client_order_id")
                    or body.get("clientOrderId"),
                )
            else:
                result = place_kalshi_buy(
                    ticker=str(body.get("ticker") or "").strip(),
                    side=side,
                    contracts=body.get("contracts") or body.get("count"),
                    ask_cents=body.get("ask_cents")
                    if body.get("ask_cents") is not None
                    else body.get("askCents") or body.get("price_cents") or body.get("price"),
                    client_order_id=body.get("client_order_id")
                    or body.get("clientOrderId"),
                )
            self._send_json(200 if result.get("ok") else 400, result)
            return

        self._send_json(404, {"ok": False, "error": "not found"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/timeframes":
            self._send_json(
                200,
                {
                    "ok": True,
                    "default": "15m",
                    "timeframes": [
                        {
                            "id": key,
                            "label": cfg["label"],
                            "granularity": cfg["granularity"],
                            "window_sec": cfg["window_sec"],
                        }
                        for key, cfg in TIMEFRAMES.items()
                    ],
                },
            )
            return

        if path in ("/api/target", "/api/kalshi/target"):
            tf = (qs.get("tf") or qs.get("timeframe") or ["15m"])[0].strip().lower()
            self._send_json(200, fetch_target_payload(tf))
            return

        if path in ("/api/spot", "/api/btc/spot", "/api/price"):
            self._send_json(200, fetch_spot())
            return

        if path in ("/api/candles", "/api/btc/candles"):
            tf = (qs.get("tf") or qs.get("timeframe") or [""])[0].strip().lower()
            cfg = TIMEFRAMES.get(tf)
            if cfg:
                gran = cfg["granularity"]
                limit = cfg["candle_limit"]
            else:
                try:
                    gran = int((qs.get("granularity") or ["60"])[0])
                except ValueError:
                    gran = 60
                if gran not in (60, 300, 900, 3600):
                    gran = 60
                try:
                    limit = int((qs.get("limit") or ["300"])[0])
                except ValueError:
                    limit = 300
                limit = max(50, min(limit, 300))
            payload = fetch_candles(gran, limit)
            payload["timeframe"] = tf or None
            self._send_json(200, payload)
            return

        if path == "/api/push/vapid-public":
            app_key, _priv = ensure_vapid_keys()
            self._send_json(
                200,
                {
                    "ok": bool(app_key),
                    "publicKey": app_key,
                    "subscribers": len(_push_subs),
                },
            )
            return

        if path in ("/api/kalshi/account", "/api/kalshi/status"):
            self._send_json(200, kalshi_account_status(fetch_balance=True))
            return

        if path in ("/api/kalshi/auto-status", "/api/kalshi/auto"):
            self._send_json(200, auto_trade_status())
            return

        if path in ("/api/demo-account", "/api/account"):
            user_id = _normalize_user_id(
                (qs.get("userId") or qs.get("user_id") or [None])[0]
                or self.headers.get("X-BeatLine-User")
            )
            if not user_id:
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "error": "userId required — each phone needs its own private account",
                        "has_state": False,
                        "state": None,
                    },
                )
                return
            state = load_demo_account(user_id)
            self._send_json(
                200,
                {
                    "ok": True,
                    "state": state,
                    "has_state": state is not None,
                    "userId": user_id,
                },
            )
            return

        if path == "/api/health":
            accounts = _list_account_ids()
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "kalshi-btc-target",
                    "version": "2.3.5",
                    "best_side_profile": "green-spike",
                    "push": bool(_vapid_app_server_key or VAPID_PUBLIC_RAW.is_file()),
                    "subscribers": len(_push_subs),
                    "demo_account": DEMO_ACCOUNT_FILE.is_file() or len(accounts) > 0,
                    "accounts": len(accounts),
                    "multi_user": True,
                    "auto_trade": auto_trade_status(),
                    "edge_watcher": {
                        "last_key": _last_edge_key,
                        "last_ask": _last_edge_ask,
                        "last_at": _last_edge_at or None,
                        "confirm_key": _edge_confirm_key,
                        "confirm_count": _edge_confirm_count,
                        "confirm_need": EDGE_CONFIRM_POLLS,
                    },
                },
            )
            return

        if path == "/api/accounts":
            # Read-only inventory of demo accounts (ids + sizes). Used to pull
            # full trade history for analysis without the phone's localStorage userId.
            out = []
            for uid in _list_account_ids():
                state = load_demo_account(uid) or {}
                hist = state.get("history") if isinstance(state.get("history"), list) else []
                ats = [t.get("at") for t in hist if isinstance(t, dict) and t.get("at")]
                closed = [
                    t
                    for t in hist
                    if isinstance(t, dict) and t.get("kind") in ("close", "settle")
                ]
                out.append(
                    {
                        "userId": uid,
                        "balance": state.get("balance"),
                        "start": state.get("start"),
                        "history_count": len(hist),
                        "closed_count": len(closed),
                        "first_at": min(ats) if ats else None,
                        "last_at": max(ats) if ats else None,
                        "updatedAt": state.get("updatedAt"),
                    }
                )
            # Legacy single-file account (pre multi-user), if present.
            if DEMO_ACCOUNT_FILE.is_file():
                legacy = load_demo_account(None) or {}
                hist = legacy.get("history") if isinstance(legacy.get("history"), list) else []
                if hist and not any(a.get("history_count") for a in out):
                    ats = [t.get("at") for t in hist if isinstance(t, dict) and t.get("at")]
                    out.append(
                        {
                            "userId": None,
                            "legacy": True,
                            "balance": legacy.get("balance"),
                            "start": legacy.get("start"),
                            "history_count": len(hist),
                            "closed_count": sum(
                                1
                                for t in hist
                                if isinstance(t, dict)
                                and t.get("kind") in ("close", "settle")
                            ),
                            "first_at": min(ats) if ats else None,
                            "last_at": max(ats) if ats else None,
                            "updatedAt": legacy.get("updatedAt"),
                        }
                    )
            self._send_json(200, {"ok": True, "accounts": out, "count": len(out)})
            return

        if path == "/api/accounts/history":
            # Full merged trade history across accounts (chronological).
            merged = []
            seen = set()
            for uid in _list_account_ids():
                state = load_demo_account(uid) or {}
                hist = state.get("history") if isinstance(state.get("history"), list) else []
                for t in hist:
                    if not isinstance(t, dict):
                        continue
                    tid = t.get("id") or f"{t.get('at')}-{t.get('kind')}-{t.get('ticker')}"
                    if tid in seen:
                        continue
                    seen.add(tid)
                    row = dict(t)
                    row["_userId"] = uid
                    merged.append(row)
            if DEMO_ACCOUNT_FILE.is_file():
                legacy = load_demo_account(None) or {}
                hist = legacy.get("history") if isinstance(legacy.get("history"), list) else []
                for t in hist:
                    if not isinstance(t, dict):
                        continue
                    tid = t.get("id") or f"{t.get('at')}-{t.get('kind')}-{t.get('ticker')}"
                    if tid in seen:
                        continue
                    seen.add(tid)
                    row = dict(t)
                    row["_userId"] = None
                    row["_legacy"] = True
                    merged.append(row)
            merged.sort(key=lambda t: t.get("at") or 0)
            self._send_json(
                200,
                {
                    "ok": True,
                    "count": len(merged),
                    "history": merged,
                },
            )
            return

        if path == "/api/clear-edge":
            self._send_json(200, current_clear_edge())
            return

        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        if ".." in rel or rel.startswith("/"):
            self._send_json(400, {"ok": False, "error": "bad path"})
            return
        file_path = (STATIC_DIR / rel).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.is_file():
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        data = file_path.read_bytes()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".user.js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".webmanifest": "application/manifest+json",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(file_path.suffix.lower(), "application/octet-stream")
        # Service worker must not be cached aggressively.
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if rel == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        if getattr(self, "_sending_head", False):
            return
        self.wfile.write(data)


def place_kalshi_sell(
    *,
    ticker: str,
    side: str,
    contracts: int,
    bid_cents: int,
    client_order_id: str | None = None,
) -> dict:
    """
    Sell (close) contracts on the current window at the bid.
    side: "above" (YES) or "below" (NO) — the contracts you hold.
    """
    creds = get_kalshi_credentials()
    if not creds:
        return {"ok": False, "error": "Connect your Kalshi API key first"}
    if not creds.get("live_enabled") and not os.environ.get("KALSHI_LIVE_FORCE"):
        return {"ok": False, "error": "Turn on Live Kalshi buys in Options first"}
    ticker = (ticker or "").strip()
    if not ticker:
        return {"ok": False, "error": "Missing market ticker"}
    if side not in ("above", "below"):
        return {"ok": False, "error": "side must be above or below"}
    try:
        contracts = int(contracts)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid contract count"}
    if contracts < 1:
        return {"ok": False, "error": "Need at least 1 contract"}
    try:
        bid_cents = int(bid_cents)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid bid"}
    if bid_cents < 1 or bid_cents > 99:
        return {"ok": False, "error": "Bid must be 1–99¢"}

    client_order_id = (client_order_id or "").strip() or str(uuid.uuid4())
    yes_no = "yes" if side == "above" else "no"

    legacy_body = {
        "ticker": ticker,
        "client_order_id": client_order_id,
        "action": "sell",
        "side": yes_no,
        "count": contracts,
        "type": "limit",
        "time_in_force": "immediate_or_cancel",
    }
    if yes_no == "yes":
        legacy_body["yes_price"] = bid_cents
    else:
        legacy_body["no_price"] = bid_cents

    code, payload = kalshi_authed_request(
        "POST", "/portfolio/orders", body=legacy_body, creds=creds
    )
    used = "legacy"

    if code >= 400:
        # V2: sell YES = ask, sell NO ≈ bid on YES-leg book
        price_dollars = f"{bid_cents / 100:.4f}"
        if side == "above":
            v2_side = "ask"
            v2_price = price_dollars
        else:
            v2_side = "bid"
            v2_price = f"{(100 - bid_cents) / 100:.4f}"
        v2_body = {
            "ticker": ticker,
            "client_order_id": client_order_id,
            "side": v2_side,
            "count": f"{contracts:.2f}",
            "price": v2_price,
            "time_in_force": "immediate_or_cancel",
            "self_trade_prevention_type": "taker_at_cross",
        }
        code, payload = kalshi_authed_request(
            "POST", "/portfolio/events/orders", body=v2_body, creds=creds
        )
        used = "v2"

    if code not in (200, 201) or not isinstance(payload, dict):
        err = None
        if isinstance(payload, dict):
            err = _kalshi_err_text(
                payload.get("error") or payload.get("message") or payload.get("code")
            )
        if not err:
            err = payload if isinstance(payload, str) else f"Sell failed ({code})"
        return {
            "ok": False,
            "error": err,
            "status": code,
            "api": used,
            "client_order_id": client_order_id,
            "raw": payload,
        }

    order = payload.get("order") if isinstance(payload.get("order"), dict) else payload
    fill_count = order.get("fill_count") or order.get("filled_count") or 0
    try:
        fill_n = float(fill_count)
    except (TypeError, ValueError):
        fill_n = 0.0
    remaining = order.get("remaining_count")
    try:
        rem_n = float(remaining) if remaining is not None else None
    except (TypeError, ValueError):
        rem_n = None
    if fill_n <= 0 and (rem_n is None or rem_n <= 0):
        return {
            "ok": False,
            "error": "Sell did not fill (bid may have moved) — try again",
            "status": code,
            "api": used,
            "client_order_id": client_order_id,
            "order": order,
            "raw": payload,
            "fill_count": 0,
        }
    bal = kalshi_fetch_balance(creds)
    return {
        "ok": True,
        "order_id": order.get("order_id") or order.get("id"),
        "client_order_id": client_order_id,
        "fill_count": fill_n,
        "remaining_count": rem_n,
        "api": used,
        "balance": bal.get("balance") if bal.get("ok") else None,
        "raw": payload,
    }



def main():
    if not STATIC_DIR.is_dir():
        raise SystemExit(f"Missing static dir: {STATIC_DIR}")
    load_push_subs()
    ensure_vapid_keys()
    watcher = threading.Thread(target=push_watcher_loop, name="push-watcher", daemon=True)
    watcher.start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"BeatLine → http://{HOST}:{PORT}/")
    print("Android Chrome → open URL → Add to Home Screen")
    print("Background chime → allow Notifications when prompted")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()