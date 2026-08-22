# solana-thesis-bot (v1)

Autonomous Solana meme-coin trading bot. Scans live pairs on DexScreener,
runs on-chain safety checks via Helius, generates a structured buy/pass
thesis via an LLM through OpenRouter, and — if the thesis says "hold" —
executes a real swap through Jupiter with real funds.

## How it works

1. **Scan** — pulls candidate pairs from DexScreener (`src/dexscreener.js`).
2. **Filter** — hard on-chain safety gate before anything else runs:
   mint/freeze authority revoked, holder concentration, liquidity floor
   (`src/safetyFilters.js`, `src/rpc.js`). Anything that fails is skipped —
   it never reaches the thesis engine.
3. **Thesis** — surviving candidates get sent to your chosen model via
   OpenRouter, which returns a structured `hold`/`fail` decision with
   reasoning (`src/thesisEngine.js`). Every thesis is logged, not just the
   holds — that's your public "journal."
4. **Execute** — a `hold` decision triggers a real buy via Jupiter
   (`src/jupiter.js`), sized to `MAX_POSITION_SIZE_SOL`.
5. **Manage** — open positions are checked every tick; a position that
   drops past `STOP_LOSS_PERCENT` is sold automatically.
6. **Kill switch** — if today's realized losses hit `MAX_DAILY_LOSS_SOL`,
   the bot stops opening new positions for the rest of the day (existing
   stop-losses still run).

## Setup

```
npm install
cp .env.example .env
```

Fill in `.env`:
- `HELIUS_API_KEY` / `HELIUS_RPC_URL` — from helius.dev
- `WALLET_PRIVATE_KEY` — a **new, dedicated** wallet's base58 secret key.
  Fund it with only what you're prepared to lose. Never reuse a wallet
  that holds anything else.
- `OPENROUTER_API_KEY` — from openrouter.ai. Set `OPENROUTER_MODEL` to
  whichever Claude model you want generating theses.

Run it:
```
npm start
```
This single command starts both the trading loop **and** the API/website
server in one process, so they share the same local data store. Open
`http://localhost:3000` to watch the journal live.

## Before you touch real money

- Test with `MAX_POSITION_SIZE_SOL` set very small (e.g. `0.02`) for at
  least a few days before scaling up.
- Watch `/thesis-log` — read what it's actually deciding and why before
  trusting it unattended.
- The safety filters here are a floor, not a guarantee. Rug patterns
  evolve; don't treat "passed the filters" as "safe."

## Deploying (Railway — one service now)

The bot and API/website run in the same process, so this is **one Railway
service**, not two. Push this repo to GitHub, connect it in Railway, set
the Start Command to `npm start`, add all the env vars from `.env`, and
turn on a public domain under Settings → Networking. That's it — the same
service serves the website and runs the trading loop.

**Important:** never run this as two separate services pointed at the
same wallet — that would mean two bots trading concurrently with the
same funds.

## Data storage

MVP uses flat JSON files under `data/` (positions, thesis log, daily
P&L) so there's nothing extra to provision. Swap `src/positions.js` for
a Postgres-backed version later if you want it — the function
signatures are the only contract the rest of the code depends on.
