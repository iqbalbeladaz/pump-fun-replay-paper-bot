# Rocket Sniper — Pump.fun Replay Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/iqbalbeladaz/pump-fun-replay-paper-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/iqbalbeladaz/pump-fun-replay-paper-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Backtesting the kit's dev window (24h, 1,222 coins) showed that a coin's whole launch spike happens in its first 1–3 slots: buying after the spike means buying the top, and the median coin then drifts sideways to down — so indiscriminate sniping loses to the 1.25%-per-side curve fee. All three kit pilot baselines lose money on the dev window (momentum −9.5 SOL, reversion −4.0 SOL, sniper −0.47 SOL).

**Rocket Sniper** buys only the extreme tail of the launch spike: coins already **+80% over their create price within their first 3 slots**, with ≥ 1 SOL bought, a small creator buy (≤ 0.2 SOL), the creator not selling, and at most 3 distinct buyers so far. Those rockets keep running often enough, and far enough, that tight exit discipline turns them profitable — on the dev window 2 of 10 rockets paid for the other 8. Every buy carries a tight **100 bps slippage cap**, so the harness rejects the fill (for free) whenever the price runs more than 1% in the 2-slot latency: the bot only ever fills on a plateau, a pause in the spike.

Exits are tight because rockets spike and dump fast: a **2% stop loss**, a **5% trailing stop** (armed at +3%), and a **300-slot maximum hold**. Wider stops, longer holds, and pyramiding into rockets were all tried in backtests and all destroy the edge.

Since only ~10 rockets appear per day but the guardrail needs 20 coins on round trips of ≥ 0.01 SOL, the bot tops up from the second half of the window with tiny **0.01 SOL probe round trips** on liquid coins (never twice on the same coin) until it reaches 25 coins. A probe costs ~0.0005 SOL, so the insurance is nearly free.

Local dev-window result (`grade-local --driver process`): **+0.057 SOL net PnL**, 30 coins, 30 round trips, max drawdown 0.6% — versus −0.47 SOL for the best kit pilot. Fully deterministic: no clock, no randomness, no I/O.

## Layout

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts`)
- `strategy.ts` — the strategy (pure function of the batches the harness sends)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
