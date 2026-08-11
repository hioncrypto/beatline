# BeatLine

Standalone Android PWA for Kalshi’s **15-minute BTC Price to beat** (`KXBTC15M`).

This is its own product — **not** part of any Coinbase / momentum-scanner dashboard.

Chart + live spot use CF Benchmarks **BRTI**. Target, odds, countdown, and settlement come from Kalshi.

## How to use

1. **Read the window** — Price to beat, Live now, vs beat, and Time left.
2. **Chart** — Dashed **TO BEAT** is the Price to beat. 1m / 5m / 15m change candle size only.
3. **Odds & Best Side** — Above/Below market chance; Best Side scores the edge.
4. **Buy / add** — Buy Above, Best, or Buy Below → slide to confirm.
5. **Demo & alerts** — ⋮ Options for paper bankroll; bell for target / clear-edge alerts.

## Run locally

```bash
pip install -r requirements.txt
python3 server.py
```

Open `http://localhost:8765/` → on Android Chrome: **Add to Home Screen**.

## Hosting (stop the link from expiring)

Cursor tunnels die when the agent dies. Deploy once:

- **Render (free):** https://render.com/deploy?repo=https://github.com/hioncrypto/beatline  
  → permanent `*.onrender.com` URL. Details: [`DEPLOY.md`](./DEPLOY.md)
- **Fly.io / Docker / VPS:** see [`DEPLOY.md`](./DEPLOY.md)

## Demo account

Balance + trade history sync to `data/demo_account.json` on the server. Use ⋮ → **Export backup**.

## Live Kalshi buys (optional)

BeatLine can place **real** Above/Below buys on your Kalshi account when you slide to confirm.

1. On Kalshi: **Account & security → API Keys → Create Key** (save Key ID + `.key` file).
2. In BeatLine ⋮ Options → **My Kalshi account** → paste Key ID + private key → **Save & connect**.
3. Turn on **Live Kalshi buys**.
4. Buy Above / Best / Below → slide to confirm → order hits your Kalshi balance (IOC at the live ask).

Or set server env vars (Render): `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY` (PEM, use `\n` for newlines). Credentials file is `data/kalshi_credentials.json` (gitignored).

**Demo mode and Live buys are separate** — live mode turns demo off so you don’t double-count.

## Optional

Chrome / Firefox TradingView overlay lives under [`extras/tradingview-extension/`](./extras/tradingview-extension/) (desktop). The Android PWA is the main app.
