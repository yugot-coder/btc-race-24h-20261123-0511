// Scalp rider v2: a long-only cbBTC/USDC scalping bot for make.fun's
// btc-race-24h-20261123-0511, speaking agent-fun/bars-replay/v1.
//
// The boss's spec, extended: scalp with a hard take profit and a hard
// stop, re-enter on the analysis, and after a stop-out buy the deeper
// dip. Enter long at 100% of equity (the race's maximum — the rules ban
// leverage and shorts outright, so full equity is the largest size that
// exists here) when the close sits above its 60-bar EMA and the last 60
// bars gained at least 10 bps. A position closes in full at +10% over
// its cost (take profit) or at -5% under its cost (the maximum loss one
// entry may take). After a take profit or a max-hold exit the bot waits
// 10 bars and re-enters on the same signal. After a STOP-OUT it arms a
// dip entry instead: the moment the close falls 10% below the price at
// which the stop hit, it buys back in at full size immediately, signal
// or no signal — and if that entry stops out too, the new stop price
// becomes the next dip reference. A 240-bar maximum hold recycles a
// stale position that reached neither line. A full-size round trip
// costs about 26 bps in fees, slippage and impact, far below the 10%
// target and the 5% stop. Everything is deterministic: the only inputs
// are the bars; arithmetic is float64 on the closes plus exact integer
// comparisons on the account's quote units.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** EMA span for the trend filter, in bars. */
const EMA_SPAN = 60;
/** Momentum lookback, in bars. */
const MOM_SPAN = 60;
/** 60-bar gain, in bps, that opens a trade. */
const MOM_ENTRY_BPS = 10;
/** Share of equity an entry spends, in bps — the race maximum. */
const SIZE_BPS = 10000;
/** Take profit: close in full at this gain over cost, in bps (+10%). */
const TAKE_PROFIT_BPS = 1000;
/** Stop loss: close in full at this loss under cost, in bps (-5% max). */
const STOP_LOSS_BPS = 500;
/** After a stop-out, re-enter when the close falls this far below the stop price, in bps (-10%). */
const DIP_ENTRY_BPS = 1000;
/** Maximum bars to hold one position before recycling it. */
const MAX_HOLD_BARS = 240;
/** Bars to wait after a non-stop close before the next signal entry. */
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
/** Close at which the last stop-out was decided, or null when no dip is armed. */
let stopPrice: number | null = null;

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

/** A full-size buy at the current equity, or null when it cannot be placed. */
function fullSizeBuy(state: BarsState): BuyInput | null {
  let notional = (state.equity * BigInt(SIZE_BPS)) / BPS;
  const room = state.weightRoom(SYMBOL);
  if (notional > room) notional = room;
  if (notional > state.cash) notional = state.cash;
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
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
    // position, starts its hold clock and disarms the dip entry; a
    // filled sell closes it and starts the re-entry cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entrySeq = fill.fill_bar;
        stopPrice = null;
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
        // A stop-out arms the dip entry at this bar's close; the other
        // exits leave stopPrice alone (it is null unless a stop set it).
        if (value <= stopLossLine) stopPrice = closes[closes.length - 1]!;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat with a dip armed: the close 10% under the stop price buys
    // back in at once, ahead of cooldown and signal alike.
    if (stopPrice !== null) {
      const dipLine = (stopPrice * (10000 - DIP_ENTRY_BPS)) / 10000;
      if (closes[closes.length - 1]! <= dipLine) {
        const buy = fullSizeBuy(state);
        if (buy !== null) return [buy];
      }
    }

    // Flat: respect the post-close cooldown, then re-enter on the same
    // analysis — close above the EMA on a 60-bar gain.
    if (exitSeq !== null && state.seq - exitSeq < COOLDOWN_BARS) return [];
    const mom = momentumBps();
    if (ema === null || mom === null || closes[closes.length - 1]! <= ema) return [];
    if (mom < MOM_ENTRY_BPS) return [];
    const buy = fullSizeBuy(state);
    return buy === null ? [] : [buy];
  },
});
