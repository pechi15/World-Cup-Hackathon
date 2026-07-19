# Three-Minute Demo Narration

## 0:00–0:20 — Problem and product

“Fast sports markets require more than a price prediction. A market maker must continuously set both sides, control inventory, react to latency and information shocks, and explain every decision. World Cup Consensus Maker is a latency-aware autonomous paper market maker built around those controls. Real execution and directional trading are disabled.”

On screen: hold the dashboard overview long enough to show the five safety badges, replay mode, connected backend, TxODDS adapter state, recording state, and kill switch.

## 0:20–0:45 — TxODDS and replay provenance

“The system treats TxODDS as market consensus, never as proprietary alpha. For a reliable judging demo, it can run a deterministic replay or load an authorized recorded TxODDS capture. Source provenance stays attached throughout the pipeline. Live-only fields are shown only when the existing API supplies them; otherwise the dashboard says unavailable rather than fabricating data.”

On screen: open the replay-source selector, then leave it on the available source. Click **Run Full Demo**.

## 0:45–1:20 — Quote centre, width, and size

“Each observation is normalized, then passed through a state-space market filter. The filtered consensus and uncertainty define the quote centre and contribute to width. Here the board shows raw market consensus, filtered consensus, bid, ask, width, and bid/ask size. During normal conditions the system quotes both sides. As uncertainty or volatility increases, the spread widens and size remains risk-aware.”

On screen: point to the market board and quote-path chart. Use **Pause** and **Step** if needed to make the values readable.

## 1:20–1:45 — Inventory lean and risk sheet

“After an explicit future replay event creates a paper fill, inventory changes. The quote centre leans against that inventory rather than accumulating one-way exposure. Position, realized and unrealized P&L, worst-case liability, fixture exposure, risk utilization, quote uptime, and kill-switch state update from the same backend state.”

On screen: use 20x or 60x speed to reach a paper fill, then pause on Portfolio & P&L and Risk controls.

## 1:45–2:15 — Information shock and suspension

“Now I’ll inject an information shock and show the resulting volatility response and reason code. Separately, the deterministic replay reaches an explicit quote-suspension safety event: the system removes quotes, records the decision, and waits for the controlled repricing and resumption event. These are backend-driven states, not visual effects.”

On screen: click **Inject information shock** and show its audit entry. Continue the replay to the explicit **Quote suspension** event, show the suspended market row, then continue until **Controlled resumption** is observed.

## 2:15–2:40 — Paper fill, P&L, and audit log

“Execution is paper-only, and fills are not generated just to make the demo look active. They require explicit future events in the replay. When one occurs, positions and P&L update, terminal risk is recalculated, and the audit records the observation, filtered consensus, width, inventory lean, risk checks, final action, fill result, and provenance.”

On screen: show **Future-event fill** and **Risk / P&L update** as observed, then expand the recent audit trail.

## 2:40–3:00 — Architecture and limitations

“The architecture flows from TxODDS or replay through market normalization, a state-space market filter, quote generation, inventory and risk controls, paper execution, and the dashboard audit trail. This is a deterministic hackathon MVP, not a profitability claim. The filter is a transparent benchmark, unsupported live telemetry remains unavailable, and real execution, wallets, and directional trading stay disabled.”

On screen: finish on the architecture diagram in the README or `docs/architecture-for-judges.md`, then return to the safety badges.

## Presenter fallback

If the replay finishes too quickly, click **Reset**, select **5x**, and use **Pause** and **Step** around the shock and fill events. If live or recorded TxODDS is unavailable, keep the built-in replay selected and explicitly state that no live data is being shown.
