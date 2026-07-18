# TxODDS live market-baseline paper demo

This mode is a temporary, explicitly non-proprietary benchmark for testing
live market-making mechanics. It consumes TxODDS devnet market consensus and
may centre maker-only paper quotes. It is not independent alpha, cannot create
directional edge, cannot use Kelly sizing, and has no real-execution path.

The guaranteed replay service remains on its existing branch and variables.
Deploy this mode as a separate Railway backend service from
`codex/live-market-baseline-demo`.

## Railway variables

```text
NODE_ENV=production
DATA_MODE=txline
DEMO_MODE=false
THEO_MODE=market_baseline
TRADING_MODE=paper
ENABLE_MARKET_MAKING=true
ENABLE_DIRECTIONAL_TRADING=false
ENABLE_KELLY=false
ENABLE_REAL_EXECUTION=false
ENABLE_WALLET_OPERATIONS=false
ENABLE_TXODDS_ACTIVATION=false
TXLINE_NETWORK=devnet
TXLINE_API_ORIGIN=https://txline-dev.txodds.com
TXLINE_API_TOKEN=<sealed backend service secret>
SOLANA_RPC_URL=https://api.devnet.solana.com
```

Optional conservative paper-mechanics parameters:

```text
PAPER_EXECUTION_LATENCY_MS=250
PAPER_QUOTE_EXPIRY_MS=5000
MARKET_DATA_STALE_AFTER_MS=10000
MARKET_INFORMATION_SHOCK_Z=4
TXLINE_REFRESH_INTERVAL_MS=15000
```

Do not set `TXLINE_GUEST_JWT`; the backend obtains an ephemeral guest JWT and
renews it once after a 401. Do not add a wallet, keypair, signing material,
activation payload, or transaction configuration. The service rejects startup
if `ENABLE_REAL_EXECUTION=true` while market-baseline mode is selected.

## Probability semantics

The normalized observation preserves raw `Prices`, `StablePrice`, and `Pct`.
Selection is deterministic:

1. `StablePrice`, when present, is treated as already de-margined TxODDS
   consensus and receives only bounded numerical sum cleanup. It is never
   de-vigged again.
2. Otherwise raw decimal `Prices` are converted to implied probabilities and
   proportionally de-vigged exactly once.
3. `Pct` is retained for audit but is never selected because its semantics are
   not verified.

Every benchmark estimate reports `AVAILABLE_BENCHMARK`,
`TXODDS_MARKET_BASELINE`, `market-baseline-v1`, and
`independentAlpha=false`. Audit events retain the selected probability field.

## Paper execution model

`CONSERVATIVE_CROSS_ONLY` creates resting maker quotes after a live normalized
observation. A quote cannot fill on its source event. Its earliest executable
time is the decision/receive time plus configured execution latency. Only a
later available observation that crosses the bid or ask may create a paper
fill. Fees, optional slippage, expiration, replacement cancellation, stale-data
cancellation, sequence-gap suspension, connection-loss cancellation, and
standardized information-shock suspension are recorded. No crossing event
means zero fills.

Directional decisions always return `NO_ACTION`, `estimatedEdge=null`, and
`NON_INDEPENDENT_MARKET_BASELINE`. Kelly size is always null. Environment
variables cannot override these restrictions.

## Status and smoke tests

```text
GET /health
GET /ready
GET /api/txodds/status
GET /api/theo/status
GET /api/trading/status
GET /api/quotes
GET /api/audit
```

After a connected snapshot containing at least one usable market observation:

- TxODDS: `CONNECTED`
- Theo: `AVAILABLE_BENCHMARK`, `TXODDS_MARKET_BASELINE`, `NOT_PROVEN_ALPHA`
- Maker: `PAPER_ENABLED`
- Directional: `DISABLED_NON_INDEPENDENT_THEO`
- Kelly: `DISABLED_NON_INDEPENDENT_THEO`
- Real execution: `DISABLED`

Until a usable live observation arrives, theo and maker status remain
unavailable even when authentication is connected. The API never substitutes
replay or synthetic probabilities in `DATA_MODE=txline`.

This repository contains only the backend API, so UI-facing wording is exposed
through status/config labels: “TxODDS connected”, “Market benchmark”, “Paper
maker only”, “No proprietary theo”, “Directional trading disabled”, and “Not
proven alpha”. A frontend must not relabel the value as “AI Theo”.

## Five-minute sanitized recording

Set the same variables locally and run:

```powershell
npm.cmd run record:live-baseline
```

The default duration is 300000 ms. Output is written beneath ignored
`.local/live-market-baseline/<recording-id>/`:

- `recording.jsonl`: connection, fixture, snapshot/SSE, score, normalized
  market, paper quote, cancellation, fill, position, P&L, and risk events.
- `sanitized-replay.json`: credential-free replay input with source and receive
  timestamps, message IDs, raw safe fields, and normalized provenance.
- `manifest.json`: duration and event counts.

The recorder recursively removes API tokens, JWTs, authorization headers,
wallet fields, signatures, private keys, and activation data before writing.

## Build verification

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
git diff --check
```

Railway may continue using `npm start`; `npm run build` is the equivalent clean
TypeScript production compilation check for this repository, which has no
Dockerfile.
