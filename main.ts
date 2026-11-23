// Burst rider: a long-only cbBTC/USDC trend bot for make.fun's
// btc-race-24h-20261123-0511, speaking agent-fun/bars-replay/v1.
//
// The market charges about 26 bps for a full-size round trip (4 bps fee,
// 2 bps slippage and constant-product impact on a ~$590k-deep pool), so the
// bot trades rarely and only into a real move: it goes long at 85% of equity
// when the close sits above its 60-bar EMA and the last 60 bars gained at
// least 15 bps, then rides the burst behind a 120 bps trailing stop, with a
// 200 bps hard stop, a sharp-drop exit on a single bar down 60 bps or more,
// and a 480-bar maximum hold. If it has still not traded by bar 1080 it
// takes one smaller shot (40% of equity, 10 bps of momentum) so a quiet
// window still gets a chance to take part. Everything is deterministic:
// the only inputs are the bars, and the only arithmetic is float64 on the
// closes plus exact integer comparisons on the account's quote units.
//
// Walk-forward evidence (kit dev window, fees/slippage/impact included):
// 6x4h +17.76, 4x6h +16.32, 12x2h +5.17, offset-2h +3.03 USDC, worst
// window -6.51; the full dev window grades at +14.34 USDC over 7 fills
// (4 buys, 3 sells plus the final flatten), win rate 0.5, max drawdown
// 2.23%, 0 rejected orders, and +11.57 USDC with every fee doubled.
// Neighbouring parameters (momentum 10-25 bps, size 80-90%, trail 120-150)
// all stay in the same region, so this is a plateau, not a tuned point.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** EMA span for the trend filter, in bars. */
const EMA_SPAN = 60;
/** Momentum lookback, in bars. */
const MOM_SPAN = 60;
/** 60-bar gain, in bps, that opens a trade. */
const MOM_ENTRY_BPS = 15;
/** Share of equity a normal entry spends, in bps. */
const SIZE_BPS = 8500;
/** Hard stop: the position's value as a share of its cost, in bps below it. */
const STOP_BPS = 200;
/** Trailing stop: the position's value as a share of its peak value, in bps below it. */
const TRAIL_BPS = 120;
/** Sharp-drop exit: one bar's close down this many bps from the bar before. */
const DROP_BPS = 60;
/** Maximum bars to hold one position. */
const MAX_HOLD_BARS = 480;
/** Bar from which the late, smaller entry is allowed when nothing filled yet. */
const LATE_BAR = 1080;
/** Momentum that opens the late entry, in bps. */
const LATE_MOM_BPS = 10;
/** Share of equity the late entry spends, in bps. */
const LATE_SIZE_BPS = 4000;
/** Slippage cap on every order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

/** Closes seen so far, oldest first, in the bar's own raw price units. */
const closes: number[] = [];
/** Closes warming the EMA up, until it holds EMA_SPAN of them. */
const warm: number[] = [];
/** The EMA of the closes, once warmed up. */
let ema: number | null = null;
/** Seq of the bar at whose open the current position was filled, or null. */
let entrySeq: number | null = null;
/** Highest value the current position has reached at a close, in quote units. */
let peakValue = 0n;
/** Filled buys so far: the late entry arms only while this is zero. */
let filledBuys = 0;

function stepEma(close: number): void {
  if (ema !== null) {
    ema += (2 / (EMA_SPAN + 1)) * (close - ema);
    return;
  }
  warm.push(close);
  if (warm.length === EMA_SPAN) ema = warm.reduce((a, x) => a + x, 0) / EMA_SPAN;
}

/** 60-bar momentum at the latest close, in bps, or null before MOM_SPAN bars. */
function momentumBps(): number | null {
  const n = closes.length;
  if (n <= MOM_SPAN) return null;
  const now = closes[n - 1]!;
  const then = closes[n - 1 - MOM_SPAN]!;
  return (now / then - 1) * 10000;
}

/** Whether the latest bar fell at least DROP_BPS below the bar before it. */
function sharpDrop(): boolean {
  const n = closes.length;
  if (n < 2) return false;
  const now = closes[n - 1]!;
  const prev = closes[n - 2]!;
  return (now - prev) * 10000 <= -DROP_BPS * prev;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      stepEma(Number(bar.c));
    }
    if (state.warmingUp) return [];

    // Fold in the fills this batch reports: a buy that filled opens the
    // position (its fill bar starts the hold clock, its value the peak).
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        filledBuys++;
        entrySeq = fill.fill_bar;
        const held = state.positions.get(SYMBOL);
        peakValue = held === undefined ? 0n : state.value(SYMBOL, held.qty);
      }
    }

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
      const stopLine = (held.cost * BigInt(10000 - STOP_BPS)) / 10000n;
      const trailLine = (peakValue * BigInt(10000 - TRAIL_BPS)) / 10000n;
      const heldTooLong = entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS;
      if (value <= stopLine || value <= trailLine || heldTooLong || sharpDrop()) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: enter only above the EMA on a 60-bar gain. Late in the window,
    // with nothing filled yet, a smaller entry on a weaker gain.
    const mom = momentumBps();
    if (ema === null || mom === null || closes[closes.length - 1]! <= ema) return [];
    let threshold = MOM_ENTRY_BPS;
    let sizeBps = SIZE_BPS;
    if (filledBuys === 0 && state.seq >= LATE_BAR) {
      threshold = LATE_MOM_BPS;
      sizeBps = LATE_SIZE_BPS;
    }
    if (mom < threshold) return [];
    let notional = (state.equity * BigInt(sizeBps)) / BPS;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
