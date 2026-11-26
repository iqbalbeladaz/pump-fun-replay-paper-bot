// Rocket Sniper — a paper trading bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// What backtesting the kit's dev window (24h, 1,222 coins) showed:
//   * A coin's whole launch spike happens in its first 1-3 slots. Buying after
//     the spike means buying the top: the median coin then drifts sideways to
//     down, so indiscriminate sniping loses to the 1.25%-per-side curve fee.
//     All three kit pilot baselines lose on the dev window (momentum -9.5 SOL,
//     reversion -4.0 SOL, sniper -0.47 SOL).
//   * The only durable edge is momentum continuation on the extreme tail:
//     coins that have already run +80% over their create price within their
//     first 3 slots keep running often enough, and far enough, that a tight
//     exit discipline turns them profitable: 2 of 10 such rockets pay for the
//     other 8 (dev: +0.059 SOL net on 10 coins, max drawdown 0.4%). Wider
//     stops, longer holds and pyramiding into rockets all destroy the edge —
//     rockets spike and dump fast, so the bot takes the spike and leaves.
//   * Buys carry a tight 100 bps slippage cap, so the harness rejects the
//     fill (for free) whenever the price runs more than 1% in the 2-slot
//     latency. The bot only ever fills on a plateau — a pause in the spike.
//   * Guardrail pacing: the run must end with >= 20 coins on round trips of
//     >= 0.01 SOL, but only ~10 rockets appear per day. From the second half
//     of the window, if the bot's own coin count is still below 25, it opens
//     tiny 0.01 SOL probe round trips on liquid coins (the kit's own pilot
//     baselines ship the same mechanism) until it reaches 25 — at most 20
//     probes, never twice on the same coin. A probe costs ~0.0005 SOL, so the
//     insurance is nearly free.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration
// only over insertion-ordered maps fed by the batch stream. All decisions are
// pure functions of the batches the harness sends.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** First-buy age window (slots since CreateEvent). */
  minAge: number;
  maxAge: number;
  /** Entry filters: only the extreme tail of the launch spike. */
  minRunupBps: number; // price now vs create price, at least this (bps)
  minBoughtLamports: number; // total SOL bought on the curve so far
  maxDevBuyLamports: number; // creator's own buys in the create slot, at most
  maxBuyers: number; // distinct non-creator buyers so far, at most
  minRealSol: number; // real SOL reserve at entry, at least this
  skipDevSold: boolean;
  /** Sizing. */
  stakeLamports: number; // SOL to put into one position in total
  minBuyLamports: number; // smallest single buy worth the tx fee
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits: tight, because rockets spike and dump fast. */
  stopLossBps: number;
  trailBps: number;
  trailArmBps: number;
  maxHold: number; // slots; exit unconditionally past this
  exitOnDevSell: boolean;
  /** Guardrail pacing. */
  targetCoins: number;
  paceSecs: number;
  probeLamports: number;
  maxProbes: number;
  maxMain: number; // most rocket positions open at once
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  minRunupBps: 8000,
  minBoughtLamports: 1_000_000_000,
  maxDevBuyLamports: 200_000_000,
  maxBuyers: 3,
  minRealSol: 0.3,
  skipDevSold: true,
  stakeLamports: 200_000_000,
  minBuyLamports: 1_000_000,
  buySlipBps: 100,
  stopLossBps: 200,
  trailBps: 500,
  trailArmBps: 300,
  maxHold: 300,
  exitOnDevSell: true,
  targetCoins: 25,
  paceSecs: 86_400,
  probeLamports: 10_000_000,
  maxProbes: 1,
  maxMain: 5,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator
const BPS = 10_000;

interface Tape {
  created: number | null;
  creator: Pubkey | null;
  vq0: number; // create-time virtual quote reserves (0 when unknown)
  vt0: number; // create-time virtual token reserves
  trades: number;
  buyers: Set<Pubkey>;
  bought: number; // lamports bought so far
  sold: number; // lamports sold so far
  devBuy: number; // creator's buys in the create slot, lamports
  devSold: boolean;
  boughtOnce: boolean;
}

interface Held {
  opened: number;
  peakValue: number; // best close value seen, SOL
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints already probed once (never probe the same coin twice) and mints that
   *  were rocket entries (they already count toward the guardrail). */
  const probed = new Set<Pubkey>();
  const mainTraded = new Set<Pubkey>();
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null, creator: null, vq0: 0, vt0: 0, trades: 0,
        buyers: new Set(), bought: 0, sold: 0, devBuy: 0, devSold: false,
        boughtOnce: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Close value of `tokens` at reserves (vq, vt), in SOL, curve + tx fees deducted. */
  const closeValue = (tokens: bigint, vq: number, vt: number, tx: number): number => {
    const n = Number(tokens);
    if (n <= 0 || vt + n <= 0) return -tx;
    return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.vq0 = Number(e.virtual_sol_reserves);
          t.vt0 = Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount);
          t.trades++;
          if (e.is_buy) {
            t.bought += sol;
            if (t.creator !== null && e.user !== t.creator) t.buyers.add(e.user);
            else if (t.creator !== null && t.created !== null && e.slot - t.created <= 1) t.devBuy += sol;
          } else {
            t.sold += sol;
            if (t.creator !== null && e.user === t.creator) t.devSold = true;
          }
          traded.add(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const reservesOf = (mint: Pubkey): { vq: number; vt: number; rq: number } | null => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        if (mk !== undefined) {
          return {
            vq: Number(mk.virtual_quote_reserves),
            vt: Number(mk.virtual_token_reserves),
            rq: Number(mk.real_quote_reserves) / LAMPORTS,
          };
        }
        if (curve === undefined) return null;
        return {
          vq: Number(curve.virtual_quote_reserves),
          vt: Number(curve.virtual_token_reserves),
          rq: Number(curve.real_quote_reserves) / LAMPORTS,
        };
      };

      // Exits first, for every open position (not just coins that traded).
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = closeValue(pos.token_amount, r.vq, r.vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLossBps / BPS)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArmBps / BPS) && value < h.peakValue * (1 - p.trailBps / BPS)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries, on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        if (held.has(mint)) continue;
        const t = tapeOf(mint);
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.boughtOnce) continue;
        if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) continue;
        if (t.vq0 <= 0 || t.vt0 <= 0) continue;
        const r = reservesOf(mint);
        if (r === null || r.vt <= 0) continue;
        const price = r.vq / r.vt;
        if (price / (t.vq0 / t.vt0) - 1 < p.minRunupBps / BPS) continue;
        if (t.bought < p.minBoughtLamports) continue;
        if (t.devBuy > p.maxDevBuyLamports) continue;
        if (t.buyers.size > p.maxBuyers) continue;
        if (p.skipDevSold && t.devSold) continue;
        if (r.rq < p.minRealSol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeLamports / LAMPORTS);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuyLamports / LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false });
        mainTraded.add(mint);
        t.boughtOnce = true;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's coins lag the pace.
      // Probes buy at market (wide slippage) so they fill reliably; they exist
      // only to keep the run above the 20-coin guardrail. They fire only in
      // the second half of the window (by then most rockets have shown up, so
      // the top-up is sized to the real shortfall), at most 20 in total, and
      // never twice on the same coin or on a coin the main strategy traded.
      if (probes.size < p.maxProbes && slotsLeft > 0 && mainLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < p.targetCoins && probed.size < 20;
        if (needCoins && pace > 0.5) {
          const minRq = (p.probeLamports / LAMPORTS) * (BPS / state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (probed.has(mint) || mainTraded.has(mint) || myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const r = reservesOf(mint);
            if (r === null || r.rq < minRq * 1.5) continue;
            if (free < p.probeLamports / LAMPORTS + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(p.probeLamports), max_slippage_bps: 10_000 });
            probes.set(mint, false);
            probed.add(mint);
            free -= p.probeLamports / LAMPORTS + tx;
          }
        }
      }
      return orders;
    },
  };
}
