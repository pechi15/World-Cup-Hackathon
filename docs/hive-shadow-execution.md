# Hive shadow-execution backend

The backend preserves the existing `maker` and `hawk` identifiers and API routes while adding stable presentation fields for the flower-and-hive UI.

- **Maker Bee** supplies and manages simulated two-sided liquidity. It places, replaces, widens, reduces, cancels, suspends, and resumes paper quotes.
- **Forager Bee** is the existing Hawk strategy presented as a relative-value and market-movement signal agent. It monitors TxLINE observations and may record a fixed-size paper-only movement decision when its causal heuristic passes.
- **Hive Risk Engine** governs both agents through shared fixture, market, inventory, worst-case-loss, drawdown, latency, stale-data, sequence-gap, and manual controls.
- **Hive Decision Book** records every hypothetical action, its causal cutoff, latency eligibility, later fill (if any), costs, P&L, provenance, and no-lookahead verification.
- **Adaptive Quote Guard** can change Maker Bee width, size, suspension, and controlled resumption only. It cannot change the quote centre, directional edge, Kelly sizing, or execution mode.

`TRADING_MODE=paper` and `EXECUTION_MODE=shadow` are equivalent safety declarations here. Shadow execution is enabled; real execution, wallets, real funds, Kelly sizing without independent theo, mainnet, and subscription activation are disabled.

The replay strategy ID remains `hawk` and its label remains `REPLAY_HAWK_HEURISTIC`. It is `PAPER_ONLY` and `NOT_PROVEN_ALPHA`; it is not described as arbitrage. A recorded signal cannot fill on its source event. It becomes eligible after configured latency and uses only the first later executable market event. Final score data is prohibited from features and is admitted only for settlement after a final score event arrives.
