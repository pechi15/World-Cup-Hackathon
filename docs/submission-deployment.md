# Submission deployment

This repository supports exactly two backend modes. Neither mode can submit a wallet transaction, activate a subscription, or place a real order. The pricing reference is labelled `TXODDS_MARKET_BASELINE`; it is market consensus, not proprietary theo or proven alpha.

## Service 1: guaranteed replay demo

Create a Railway service from branch `codex/market-maker-mvp`. Use the repository Dockerfile and set:

```dotenv
NODE_ENV=production
DATA_MODE=replay
DEMO_MODE=true
THEO_MODE=market_baseline
TRADING_MODE=paper
ENABLE_REAL_EXECUTION=false
ENABLE_WALLET_OPERATIONS=false
ENABLE_TXODDS_ACTIVATION=false
ALLOWED_ORIGINS=https://<your-vercel-domain>
```

Do not set TxODDS credentials on the replay service. Deploy, then verify:

```text
GET https://<replay-service>/health
GET https://<replay-service>/ready
GET https://<replay-service>/api/theo/status
GET https://<replay-service>/api/trading/status
GET https://<replay-service>/api/demo/state
```

`/ready` must return 200 with `ready: true`. Pricing must be `AVAILABLE_BENCHMARK`; maker status must be `PAPER_ENABLED`; directional, Kelly, wallet operations, activation, and real execution must be disabled.

## Service 2: live TxODDS read-only paper maker

Create a second Railway service/environment from the same branch. Keep the token in the Railway backend service variables, not shared variables unless every consuming service is trusted to receive it.

```dotenv
NODE_ENV=production
DATA_MODE=txline
DEMO_MODE=false
THEO_MODE=market_baseline
TRADING_MODE=paper
TXLINE_NETWORK=devnet
TXLINE_API_ORIGIN=https://txline-dev.txodds.com
TXLINE_API_TOKEN=<backend-secret>
SOLANA_RPC_URL=https://api.devnet.solana.com
ENABLE_MARKET_MAKING=true
ENABLE_DIRECTIONAL_TRADING=false
ENABLE_KELLY=false
ENABLE_REAL_EXECUTION=false
ENABLE_WALLET_OPERATIONS=false
ENABLE_TXODDS_ACTIVATION=false
PAPER_EXECUTION_LATENCY_MS=250
PAPER_QUOTE_EXPIRY_MS=5000
MARKET_DATA_STALE_AFTER_MS=10000
MARKET_DATA_MAX_LATENCY_MS=2000
ALLOWED_ORIGINS=https://<your-vercel-domain>
```

Do not configure `TXLINE_GUEST_JWT`. The backend obtains a fresh guest JWT from `POST /auth/guest/start`, keeps it in memory, and renews it once after HTTP 401. The activated API token remains backend-only. There is no replay fallback when `DATA_MODE=txline`.

Verify:

```text
GET https://<live-service>/health
GET https://<live-service>/ready
GET https://<live-service>/api/txodds/status
GET https://<live-service>/api/theo/status
GET https://<live-service>/api/trading/status
GET https://<live-service>/api/quotes
GET https://<live-service>/api/audit
```

The live service is ready only after TxODDS reports `CONNECTED`. A disconnected feed must leave pricing unavailable and quotes empty. If no active fixture or eligible future price crossing exists, zero fills is the correct result.

## Vercel frontend

Deploy the same branch with the repository `vercel.json`. The only runtime variable the frontend receives is:

```dotenv
VITE_API_BASE_URL=https://<one-railway-backend>
```

Never add the API token, guest JWT, RPC credential, wallet path, private key, authorization header, or activation payload to Vercel.

## Paper execution contract

Quotes activate only after `PAPER_EXECUTION_LATENCY_MS`, expire after `PAPER_QUOTE_EXPIRY_MS`, and fill only when a later observation crosses a resting quote. There are no same-tick, random, or hash-probability fills. Connection loss, stale data, excessive latency, sequence gaps, information shocks, drawdown, manual kill, and risk-limit suspension cancel or suppress quotes.
