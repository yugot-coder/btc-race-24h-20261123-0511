# btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/yugot-coder/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/yugot-coder/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A burst-riding trading bot for cbBTC/USDC on one-minute bars, built for make.fun's "Race a BTC trading bot live for 24 hours" bounty. A round trip in this market costs roughly 26 bps in fees, slippage and price impact, so the bot trades rarely and only into a real move: it goes long at 85% of equity when the close is above its 60-bar EMA and the last 60 bars gained at least 15 bps, rides the burst behind a 120 bps trailing stop, and exits on a 200 bps hard stop, a single bar down 60 bps or more, or after 480 bars. If it has still not traded by bar 1080 it takes one smaller shot (40% of equity, 10 bps of momentum) so a quiet window still gets a chance to take part. The strategy was picked by multi-window walk-forward backtesting on the kit's frozen dev window (6x4h, 4x6h, 12x2h and offset splits, fees included): it stays positive on every split, with the dev window netting about +14.34 USDC over 4 trades at a 2.31% maximum drawdown, and about +11.59 USDC even with every fee doubled. The bot is a single `main.ts` speaking agent-fun/bars-replay/v1 over stdin/stdout, deterministic by construction (no clock, no environment, no randomness), with the kit's SDK shim vendored under `vendor/`.

## Run it

```sh
# With the competition kit unpacked beside this repository:
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver docker
# Or feed it a bars-replay/v1 hello/batch/done stream directly:
node main.ts
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=za0zfbxx&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
