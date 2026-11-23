// Scalp rider: a long-only cbBTC/USDC scalping bot for make.fun's
// btc-race-24h-20261123-0511, speaking agent-fun/bars-replay/v1.
//
// Built to the boss's explicit spec: do not nurse losses — scalp. Enter
// long at 95% of equity when the analysis says up (close above its 60-bar
// EMA and the last 60 bars gained at least 10 bps). A position is closed
// in full the moment it is up 10% against its cost (take profit) or down
// 5% against its cost (the maximum loss one entry may take). After a
// close the bot waits 10 bars, scans the same signal again and re-enters
// — over and over for the whole race. A 240-bar maximum hold recycles a
// stale position that never reached either line. The race is long only
// (no shorts, no leverage), so "defensive" means cash. A full-size round
// trip costs about 26 bps in fees, slippage and impact, which the 10%
// target and 5% stop are sized far above. Everything is deterministic:
// the only inputs are the bars; arithmetic is float64 on the closes plus
// exact integer comparisons on the account's quote units.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** EMA span for the trend filter, in bars. */
const EMA_SPAN = 60;
/** Momentum lookback, in bars. */
const MOM_SPAN = 60;
/** 60-bar gain, in bps, that opens a trade. */
const MOM_ENTRY_BPS = 10;
/** Share of equity an entry spends, in bps. */
const SIZE_BPS = 9500;
/** Take profit: close in full at this gain over cost, in bps (+10%). */
const TAKE_PROFIT_BPS = 1000;
/** Stop loss: close in full at this loss under cost, in bps (-5% max). */
const STOP_LOSS_BPS = 500;
/** Maximum bars to hold one position before recycling it. */
const MAX_HOLD_BARS = 240;
/** Bars to wait after a close before the next entry. */
const COOLDOWN_BARS = 10;
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
/** Seq of the bar at whose open the last position was closed, or null. */
let exitSeq: number | null = null;

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

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      stepEma(Number(bar.c));
    }
    if (state.warmingUp) return [];

    // Fold in the fills this batch reports: a filled buy opens the
    // position and starts its hold clock; a filled sell closes it and
    // starts the re-entry cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entrySeq = fill.fill_bar;
      } else {
        exitSeq = fill.fill_bar;
        entrySeq = null;
      }
    }

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const takeProfitLine = (held.cost * BigInt(10000 + TAKE_PROFIT_BPS)) / 10000n;
      const stopLossLine = (held.cost * BigInt(10000 - STOP_LOSS_BPS)) / 10000n;
      const heldTooLong = entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS;
      if (value >= takeProfitLine || value <= stopLossLine || heldTooLong) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: respect the post-close cooldown, then re-enter on the same
    // analysis — close above the EMA on a 60-bar gain.
    if (exitSeq !== null && state.seq - exitSeq < COOLDOWN_BARS) return [];
    const mom = momentumBps();
    if (ema === null || mom === null || closes[closes.length - 1]! <= ema) return [];
    if (mom < MOM_ENTRY_BPS) return [];
    let notional = (state.equity * BigInt(SIZE_BPS)) / BPS;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
