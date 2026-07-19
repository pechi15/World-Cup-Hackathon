# Submission Description

## Project name

World Cup Consensus Maker

## One-sentence pitch

A latency-aware autonomous World Cup paper market maker that uses TxODDS market consensus, dynamically manages spread and inventory risk, and suspends quoting during stale data or information shocks.

## 100-word description

World Cup Consensus Maker is a latency-aware autonomous paper market maker that converts TxODDS market consensus or deterministic replay events into auditable two-sided quotes. A state-space filter smooths observations and estimates uncertainty; the quote engine then adjusts centre, width, and size for volatility and inventory. Deterministic controls suspend quoting during stale data or information shocks, then resume only after repricing. The dashboard exposes provenance, bid, ask, lean, positions, paper fills, P&L, worst-case liability, kill-switch state, and reason-coded decisions. Directional trading and real execution stay disabled. Replay fills require explicit future events, protecting the demonstration from unrealistic execution assumptions for judges.

## 250-word description

World Cup Consensus Maker demonstrates how an autonomous agent can maintain disciplined two-sided sports market liquidity without claiming proprietary alpha or using real execution. It consumes authorized TxODDS observations when available, or a deterministic replay, and preserves source provenance throughout the pipeline.

Normalized fixture, market, selection, probability, and timestamp data enter a state-space market filter. The filter produces smoothed market consensus and uncertainty for the quote engine. Quotes widen as uncertainty or volatility rises, lean against accumulated inventory, and reduce size as risk grows. Information shocks and stale inputs suspend quoting; controlled resumption follows repricing rather than an arbitrary timer.

The paper execution layer accepts fills only from explicit future replay events, so the demo does not loosen assumptions merely to improve activity. Portfolio accounting updates positions, realized and unrealized P&L, fees, exposure, drawdown, and terminal outcome risk. Every decision records observations, filtered consensus, width components, inventory lean, risk checks, final action, fill result, provenance, and reason codes.

A compact React dashboard keeps Run Full Demo prominent while exposing pause, resume, step, reset, speed control, and manual information-shock injection. It distinguishes replay from live mode, reports backend and TxODDS adapter status, and marks unsupported live telemetry as unavailable instead of fabricating it.

The system is a hackathon MVP: replay results are deterministic, the filter is a transparent benchmark, combination-market risk remains out of scope, and public deployment links require completion. Directional trading, wallet operations, and real execution remain disabled. The result is an inspectable demonstration of latency-aware market-making control behavior.

## Feature list

- Deterministic and recorded-TxODDS replay selection
- Market normalization with explicit provenance
- State-space filtered market consensus and uncertainty
- Adaptive bid, ask, width, inventory lean, and quote size
- Volatility widening and information-shock suspension
- Controlled quote resumption after repricing
- Explicit future-event paper fills
- Position, realized/unrealized P&L, exposure, and liability views
- Kill-switch, risk utilization, quote uptime, and terminal scenarios
- Reason-coded audit trail
- Start, pause, resume, step, reset, speed, and shock controls
- Truthful unavailable states for unsupported live telemetry

## Technical architecture summary

The system is a TypeScript monorepo. Shared Zod contracts define market, quote, portfolio, risk, execution, and demo state. A Node API owns replay state and exposes the existing control endpoints. The state-space filter derives a smoothed consensus and uncertainty estimate; the quote engine applies width, inventory, size, and suspension logic. Paper execution and portfolio modules update positions and P&L only for explicit replay events. A React, React Query, and Recharts dashboard polls validated state and displays operational and audit evidence.

## Limitations statement

This is a paper-execution hackathon MVP, not a production trading system, backtest, profitability claim, or investment recommendation. The built-in fixture is synthetic; recorded TxODDS replay depends on an authorized capture. Live telemetry appears only when the current API supplies it. The filter is a transparent demo benchmark rather than proprietary alpha. Directional trading, wallet operations, and real execution are disabled. Combination-market pricing and correlated risk aggregation remain out of scope, and public URLs must be inserted after deployment.
