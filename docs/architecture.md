# Architecture

This backend is a paper-only World Cup prediction-market trading core. It is designed to start without TxODDS credentials and to avoid fake production theory prices.

## Boundaries

- Market data: fixtures, markets, prices, ticks, timestamps, and sequence IDs. Current data is `TEST_FIXTURE` or `SYNTHETIC`; future live data comes from TxODDS TxLINE.
- Theo: proprietary probabilities and uncertainty. Current runtime provider is `NullTheoProvider`, which returns `AWAITING_TXODDS_API`.
- Market making: quote width, lean, and height calculations. Production quotes are disabled when theo is unavailable.
- Directional strategies: strategy interface and no-action fallback. No market-price-only opinions are generated.
- Portfolio: cash, reserved cash, positions, fills, realized/unrealized P&L, and maker/taker attribution.
- Risk: deterministic limits, mark-to-market shock risk, and terminal payoff matrices.
- Execution: paper-only orders, fills, rejections, cancellation, expiry, and deterministic replay hooks.
- Evaluation: performance snapshots for maker and directional attribution.

## Selected Structure

```text
apps/api
packages/contracts
packages/market-model
packages/market-data
packages/theo
packages/quoting
packages/strategies
packages/portfolio
packages/risk
packages/execution
packages/evaluation
docs
data/samples
scripts
```

The API uses Node's built-in HTTP server to keep the first backend small and inspectable. Shared contracts use TypeScript and Zod.
