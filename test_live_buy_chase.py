#!/usr/bin/env python3
"""Unit tests for manual live-buy ask-jump chase (+3 / +8 / +18)."""
from __future__ import annotations

import server
from server import (
    LIVE_BUY_CHASE_SLIPS,
    is_ask_jump_miss,
    live_buy_chase_limit,
    place_kalshi_buy_chasing,
)


def main() -> int:
    assert LIVE_BUY_CHASE_SLIPS == (3, 8, 18), LIVE_BUY_CHASE_SLIPS

    assert live_buy_chase_limit(50, None, 3) == 53
    assert live_buy_chase_limit(50, 50, 8) == 58
    assert live_buy_chase_limit(50, 55, 3) == 58
    assert live_buy_chase_limit(50, 70, 18) == 88
    assert live_buy_chase_limit(90, 95, 18) == 99
    assert live_buy_chase_limit(1, None, 3) == 4
    assert live_buy_chase_limit("bad", None, 3) == 4

    assert is_ask_jump_miss(
        {"ok": False, "error": "Order did not fill (ask may have moved) — try again"}
    )
    assert is_ask_jump_miss({"ok": False, "error": "ask may have moved"})
    assert not is_ask_jump_miss({"ok": True, "fill_count": 4})
    assert not is_ask_jump_miss({"ok": False, "error": "Connect your Kalshi API key first"})
    assert not is_ask_jump_miss({"ok": False, "error": "Need at least 1 contract"})
    assert not is_ask_jump_miss(None)

    calls = []

    def fake_buy(**kwargs):
        calls.append(kwargs)
        if len(calls) < 4:
            return {
                "ok": False,
                "error": "Order did not fill (ask may have moved) — try again",
                "fill_count": 0,
            }
        return {"ok": True, "fill_count": 2, "ask_cents": kwargs["ask_cents"]}

    orig_buy = server.place_kalshi_buy
    orig_ask = server._fresh_side_ask_cents
    server.place_kalshi_buy = fake_buy
    server._fresh_side_ask_cents = lambda ticker, side: 52
    try:
        out = place_kalshi_buy_chasing(
            ticker="KXBTC-15M",
            side="above",
            contracts=4,
            ask_cents=50,
            stake_usd=2,
        )
    finally:
        server.place_kalshi_buy = orig_buy
        server._fresh_side_ask_cents = orig_ask

    assert len(calls) == 4, calls
    assert calls[0]["ask_cents"] == 50
    assert calls[1]["ask_cents"] == 55  # max(50, 52) + 3
    assert calls[2]["ask_cents"] == 60  # max(50, 52) + 8
    assert calls[3]["ask_cents"] == 70  # max(50, 52) + 18
    assert out.get("ok") is True
    assert out.get("chase_slip_cents") == 18
    assert out.get("chase_attempts") == 4

    print("OK live-buy chase helpers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
