# Video and Screenshot Shot List

## Recording setup

- Record the primary demo at **1440×900** with browser zoom at 100%.
- Verify the laptop fallback at **1280×720** with browser zoom at 90–100%.
- Hide bookmarks, personal tabs, terminals containing environment variables, and all notifications.
- Start with the API and web app already running.
- Reset the replay immediately before recording.
- Keep the pointer still except when selecting a control or identifying a metric.
- Do not show `.env`, tokens, JWTs, wallet files, or raw capture headers.

## Three-minute sequence

### Shot 1 — Safety and operating state, 0:00–0:20

Frame the top of the dashboard. Capture:

- project title and one-line product explanation
- operating mode and fixture
- all five safety badges
- backend, TxODDS adapter, recording, replay, and kill-switch status

### Shot 2 — Provenance and primary action, 0:20–0:45

Open the source selector briefly to show the available deterministic or recorded source. Close it without changing to an unavailable option. Click **Run Full Demo** and hold on replay progress.

### Shot 3 — Market-making board, 0:45–1:20

Pause or step the replay. Keep these columns visible:

- market consensus
- filtered market consensus
- bid and ask
- width
- inventory lean
- bid/ask size
- quote status

Move down just enough to include the event sequence and quote-path legend.

### Shot 4 — Inventory and risk, 1:20–1:45

Advance to the first explicit future-event paper fill. Frame Portfolio & P&L and Risk controls together. Highlight position, realized P&L, unrealized P&L, worst-case liability, exposure, and risk utilization.

### Shot 5 — Shock protection, 1:45–2:15

Return to the controls and click **Inject information shock**. Show its volatility response and audit reason code, then continue to the replay's explicit suspension event. Show:

- quote suspension in the market board after the explicit replay event
- active suspension in the event sequence
- the relevant shock and suspension reason codes
- controlled resumption after the next repricing event

### Shot 6 — Fill and audit evidence, 2:15–2:40

Show the observed future-event fill and risk/P&L update stages. Expand **Recent audit trail** and pause on an entry containing paper-only risk checks and fill result.

### Shot 7 — Architecture and limitations, 2:40–3:00

Cut to the README architecture diagram or the judge architecture document. End on the dashboard safety badges and the paper-execution footer.

## Recommended still screenshots

1. **Hero screenshot — 1440×900:** safety badges, status row, replay controls, market board, and event sequence.
2. **Quote behavior — 1440×900:** widened quotes or active suspension plus the quote-path chart.
3. **Risk evidence — 1280×720:** Portfolio & P&L, Risk controls, and the latest reason-coded audit decision.
4. **Replay provenance — 1280×720:** mode, fixture, TxODDS adapter state, source selector, receive timestamp, and unavailable live fields.
5. **Architecture:** README Mermaid diagram rendered in GitHub or the submission page.

## Capture acceptance checks

- No dashboard text says “AI Theo.”
- Market consensus and filtered market consensus are visibly distinct.
- No unavailable endpoint is represented by invented numbers.
- A paper fill appears only after its explicit replay event.
- Real execution and directional trading are visibly disabled.
- Important text is readable without horizontal page scrolling at both target sizes.
