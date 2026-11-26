// Tiny Bot (final): strict oversold-dip scalper on hourly Solana bars.
//
// Hello — how it works: the harness sends one batch of hourly bars at a
// time, and this bot answers each batch with the orders it wants filled at
// the next bar's open. Every bar is folded into per-symbol indicators
// (EMA13, RSI14, 12h return) and the bot only ever holds long positions,
// sized small, with a quick take-profit and a tight stop, so a falling
// market leaves it mostly in cash.
//
// Version history, all measured with grade-local --driver process on the
// dev window (buy-and-hold baseline: -$869.34, best house baseline
// MACD-CCI: -$20.22):
//   v1 trend+momentum, 65 trades: -$159.35. v2 stricter trend, 37: -$197.09.
//   v3 dip-only strict, 2 trades: -$8.50 (guardrail missed). v4 dip+momentum,
//   121 trades: -$333.02. v5 loose dip, 76 trades: -$283.25. v6 RSI<35,
//   10 trades: -$48.23. v7 quicker exits, 10 trades: +$10.26. v8, 10 trades:
//   +$38.80. v9, 10 trades: +$48.14 — but only ~5 trades over a 72-bar
//   final window, below the 8-trade guardrail. v11 RSI<42, 42 trades:
//   +$22.94 but negative at 2x fees. This final version (v10's rule) is
//   the best balance: +$43.25 net, 20 trades in dev (~11 over a 72-bar
//   final window), 60% win rate, max drawdown 0.66%, still positive at
//   2x fees.
//
// Strategy, per symbol, decided on a bar's close:
//   * DIP BUY — RSI14 under 40, the bar closed up (close above open and
//     above the previous close), close above EMA13 (the short trend is
//     not broken), 12h return above -8% (not a freefall). Stake 20% of
//     equity; at most 5 open positions.
//   * EXITS, whole position — take-profit +1.0% over cost, stop-loss
//     -1.2% under cost, RSI over 55, or age over 5 bars.
//   * A 3-bar cool-down after every sell, so a whipsawed symbol is not
//     bought straight back.
//   * Buys are capped by the 25% weight cap, the cash left in this
//     reply, and the 1 USDC minimum notional. Sells go first in a reply,
//     then buys in universe order, at most 16 orders per bar. Slippage
//     is capped at 100 bps.
//
// Determinism: float64 arithmetic on + - * / only, no clock, no
// environment, no randomness, no network. The same batch of bars always
// produces the same orders.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SLOW_BARS = 13;
const RSI_BARS = 14;
const MAX_SLIPPAGE_BPS = 100;
const MAX_POSITIONS = 5;
const COOLDOWN_BARS = 3;
const DIP_STAKE_BPS = 2000; // 20% of equity per dip buy
const TAKE_PROFIT_NUM = 101n;
const TAKE_PROFIT_DEN = 100n;
const STOP_LOSS_NUM = 988n;
const STOP_LOSS_DEN = 1000n;
const MAX_HOLD_BARS = 5;

interface Series {
  closes: number[];
  slow: number | null;
  gains: number[];
  losses: number[];
  prevClose: number | null;
}

interface Held {
  ageBars: number;
}

const series = new Map<string, Series>();
const held = new Map<string, Held>();
const lastExitSeq = new Map<string, number>();

const mean = (xs: readonly number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;
const emaStep = (last: number, x: number, bars: number): number => (x - last) * (2 / (bars + 1)) + last;

function rsiOf(s: Series): number | null {
  if (s.gains.length < RSI_BARS) return null;
  const avgGain = mean(s.gains.slice(-RSI_BARS));
  const avgLoss = mean(s.losses.slice(-RSI_BARS));
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Fold one bar into its symbol's indicators; returns its dip state. */
function push(bar: Bar): { aboveTrend: boolean; rsi: number | null; ret12: number | null; closedUp: boolean } {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { closes: [], slow: null, gains: [], losses: [], prevClose: null };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  const o = Number(bar.o);
  const closedUp = c > o && (s.prevClose === null || c > s.prevClose);
  if (s.prevClose !== null) {
    const change = c - s.prevClose;
    s.gains.push(change > 0 ? change : 0);
    s.losses.push(change < 0 ? -change : 0);
    if (s.gains.length > RSI_BARS) s.gains.shift();
    if (s.losses.length > RSI_BARS) s.losses.shift();
  }
  s.prevClose = c;
  s.closes.push(c);
  if (s.closes.length > 24) s.closes.shift();
  if (s.slow === null) {
    if (s.closes.length >= SLOW_BARS) s.slow = mean(s.closes.slice(0, SLOW_BARS));
  } else {
    s.slow = emaStep(s.slow, c, SLOW_BARS);
  }
  const value = rsiOf(s);
  const ret12 = s.closes.length >= 13 ? (c - s.closes[s.closes.length - 13]) / s.closes[s.closes.length - 13] : null;
  const aboveTrend = s.slow !== null && c > s.slow;
  return { aboveTrend, rsi: value, ret12, closedUp };
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') held.set(f.symbol, { ageBars: 0 });
      if (f.side === 'sell' && f.status === 'filled') {
        held.delete(f.symbol);
        lastExitSeq.set(f.symbol, state.seq);
      }
    }
    const info = new Map<string, { aboveTrend: boolean; rsi: number | null; ret12: number | null; closedUp: boolean }>();
    for (const bar of batch.bars) info.set(bar.symbol, push(bar));
    for (const h of held.values()) h.ageBars += 1;

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const buys: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      const d = info.get(symbol);
      if (d === undefined) continue;
      const pos = state.positions.get(symbol);
      if (pos !== undefined) {
        const value = state.value(symbol, pos.qty);
        const age = held.get(symbol) !== undefined ? held.get(symbol)!.ageBars : 0;
        const takeProfit = value * TAKE_PROFIT_DEN >= pos.cost * TAKE_PROFIT_NUM;
        const stopLoss = value * STOP_LOSS_DEN <= pos.cost * STOP_LOSS_NUM;
        const fading = d.rsi !== null && d.rsi > 55;
        const stale = age >= MAX_HOLD_BARS;
        if (takeProfit || stopLoss || fading || stale) {
          sells.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }
      if (state.warmingUp) continue;
      if (d.rsi === null || d.ret12 === null) continue;
      const lastExit = lastExitSeq.get(symbol);
      if (lastExit !== undefined && state.seq - lastExit < COOLDOWN_BARS) continue;
      const dipBuy = d.rsi < 40 && d.closedUp && d.aboveTrend && d.ret12 > -0.08;
      if (dipBuy) buys.push(symbol);
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = MAX_POSITIONS - (state.positions.size - sells.length);
    let cash = state.cash;
    for (const symbol of buys) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = (BigInt(DIP_STAKE_BPS) * state.equity) / BPS;
      if (slice > byWeight) slice = byWeight;
      if (slice > cash) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room -= 1;
    }
    return orders;
  },
});
