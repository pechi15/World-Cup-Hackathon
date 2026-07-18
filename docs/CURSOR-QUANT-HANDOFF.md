# Cursor Quant Handoff Checkpoint

**Created:** 2026-07-18  
**Purpose:** Durable context for a fresh Cursor session. Do not treat this chat as continuing indefinitely.

---

## 1. Exact repository / worktree path

```text
E:\Hackathons\World-Cup-quant
```

Git worktree of `E:\Hackathons\World-Cup` (main checkout).

Related worktrees:

| Path | Branch |
|------|--------|
| `E:\Hackathons\World-Cup` | `codex/txodds-integration` |
| `E:\Hackathons\World-Cup-demo` | `codex/demo-deployment` |
| `E:\Hackathons\World-Cup-quant` | `cursor/quant-agents` |

---

## 2. Current branch and latest commit

- **Branch:** `cursor/quant-agents`
- **HEAD:** `7fc0d02` — *Add split TxODDS devnet activation flow*
- **Working tree:** dirty (implementation + docs uncommitted)
- **Not pushed** (local branch only; no `origin/cursor/quant-agents`)

**Commit policy at checkpoint time:** This handoff was produced on `cursor/quant-agents`, **not** `cursor/quant-research`. Per instructions, **no commit was made** from this checkpoint step. User must review the diff before any commit/push.

---

## 3. Completed work

- TxLINE-shaped **mapper** (odds updates → `MarketDefinition` / ticks)
- Append-only **EventStore** (dedupe + event-time order)
- **ReplayTxoddsAdapter** + sanitized replay fixture (15 updates, shock at ~msg 8)
- **MarketBaseline** de-vig theo (explicitly `BENCHMARK_ONLY` / not proprietary alpha)
- **StateSpaceTheo** + innovation residual → `TheoEstimate` `AVAILABLE`
- Quotes go **LIVE** when theo available (existing `packages/quoting` semantics unchanged in spirit)
- **AutonomousTradingLoop** (observe → theo → maker quote → fractional Kelly → paper → audit)
- **ReplayClock** (step / play / pause / reset / speed)
- API: `/api/replay/*`, `/api/demo/snapshot`, `/api/audit`
- Demo script + architecture / theo / lovable contract updates
- Vitest: **29/29 passing** (22 prior + 7 new)

---

## 4. Partially completed work

- Live TxLINE client (SSE/historical backfill into EventStore) — **not wired**; verify scripts exist under `scripts/txodds` on Codex base
- Double-de-vig guard vs TxLINE **StablePrice** semantics — **documented as required**; test to add in next session
- Dixon–Coles / residual logistic / markout ML — interfaces/stubs only; academic roadmap below
- Phase 2 agents (Perplexity, Colab, multi-agent) — **deferred by design**
- Python `research/` package from earlier main-tree work — **not present** in this worktree
- Champion promotion / walk-forward on real TxODDS — not started

---

## 5. Files created and modified

### Modified

- `apps/api/src/server.ts`
- `docs/architecture.md`
- `docs/lovable-api-contract.md`
- `docs/theo-integration.md`
- `docs/txodds-adapter-todo.md`
- `packages/evaluation/src/index.ts`
- `packages/market-data/src/index.ts`
- `packages/theo/src/index.ts`

### Created (untracked at checkpoint)

- `packages/market-data/src/mapper.ts`
- `packages/market-data/src/event-store.ts`
- `packages/theo/src/types.ts`, `devig.ts`, `market-baseline.ts`, `state-space.ts`, `pipeline.ts`
- `packages/replay/src/index.ts`
- `packages/agent/src/index.ts`
- `packages/evaluation/src/audit.ts`, `markout.ts`
- `tests/replay-theo-loop.test.ts`
- `data/samples/txodds/sanitized/replay-fixture.json`
- `data/samples/txodds/sanitized/DATA_AUDIT.md`
- `docs/demo-script.md`
- Checkpoint docs (this file and siblings below)

---

## 6. Important interfaces and entry points

| Entry | Path |
|-------|------|
| API server | `apps/api/src/server.ts` (`npm run dev:api`) |
| Null theo | `packages/theo/src/index.ts` → `NullTheoProvider` |
| Pipeline theo | `packages/theo/src/pipeline.ts` → Baseline → StateSpace+residual |
| Mapper | `packages/market-data/src/mapper.ts` |
| Event store | `packages/market-data/src/event-store.ts` |
| Replay adapter | `packages/market-data/src/index.ts` → `ReplayTxoddsAdapter` |
| Agent loop | `packages/agent/src/index.ts` |
| Replay clock | `packages/replay/src/index.ts` |
| Quote engine | `packages/quoting/src/index.ts` (do not silently rewrite) |
| Contracts | `packages/contracts/src/index.ts` (`TheoEstimate`, etc.) |
| Sanitized demo data | `data/samples/txodds/sanitized/replay-fixture.json` |
| TxODDS verify scripts | `scripts/txodds/` (base commit; paths may hardcode main workspace) |

**Theo mode:** If sanitized replay loads → `PIPELINE_REPLAY`. Set `THEO_MODE=null` to force NullTheo.

---

## 7. Test commands and latest results

```powershell
Set-Location "E:\Hackathons\World-Cup-quant"
npm.cmd install
npx.cmd tsc --noEmit
npx.cmd vitest run
```

**Latest (2026-07-18 checkpoint):**

```text
Test Files  3 passed (3)
Tests       29 passed (29)
```

---

## 8. Known errors / risks

- `move_agent_to_root` fails for local-only branches (no remote ref) — open worktree window manually
- PowerShell `Set-Content` wrote UTF-8 BOM once; sanitized JSON was rewritten without BOM
- Live `DisabledTxoddsAdapter` still throws on discover/fetch when “CONNECTED”
- Accidental **double de-vig** of TxLINE StablePrice is a methodology hazard (see TxLINE warning below)
- Uncommitted work can be lost if worktree is removed without commit
- Main tree `codex/txodds-integration` does not contain these quant-agent changes

---

## 9. Data currently available

| Dataset | Location | Notes |
|---------|----------|-------|
| Sanitized replay | `data/samples/txodds/sanitized/` | 1 fixture, 15 1X2 updates, synthetic shock |
| Verification summary | `data/samples/txodds/verification-summary.json` | Shapes only; ~48 historical updates in first probe |
| Credentials | `.env.local` (gitignored) | Devnet JWT/token — never commit |

---

## 10. TxODDS / TxLINE data warning (mandatory)

**The initial ~48 TxODDS historical updates are integration / schema validation data only.**

They are **not** sufficient evidence of alpha, edge, or live profitability.

Official TxLINE docs: **StablePrice** already includes consensus aggregation, de-margining, stale-line filtering, and outlier filtering.

Therefore:

- Do **not** blindly de-vig StablePrice a second time
- Inspect `Prices` vs `Pct` semantics from authenticated samples before choosing the market probability field
- Preserve raw values in the event store
- Add a unit test that fails if StablePrice-like inputs are de-vigged again
- Treat TxLINE consensus as **market**, not proprietary alpha

Sanitized replay currently uses decimal `Prices` → implied → proportional de-vig (appropriate for raw book prices in the sanitized file, **not** proven correct for StablePrice).

---

## 11. Decisions already made

1. Prioritize replayable maker/taker loop over Colab / Perplexity / multi-agent
2. MarketBaseline = benchmark only (`BENCHMARK_ONLY`)
3. Default research theo = state-space + small innovation residual
4. No full Kelly by default (fractional 0.10 in loop)
5. No `APPROVED_FOR_LIVE_FUNDS`; paper / replay only
6. Do not rewrite Codex quoting/risk formulas without agreement
7. Phase 2 research agents only after MVP demo loop is reliable
8. Academic milestone order fixed (see methodology doc)

---

## 12. Decisions still open

1. Which TxLINE field is the canonical market probability (`Prices`, `Pct`, StablePrice, etc.)?
2. Should live SSE land in this branch or wait for Codex adapter?
3. Commit strategy: commit on `cursor/quant-agents` vs cherry-pick / merge to `cursor/quant-research`?
4. Residual logistic training gate: minimum N fixtures / updates?
5. Frontend (Lovable) ownership and demo video recording schedule?

---

## 13. Recommended next coding milestone

**Milestone 1 (academic priority):** Harden state-space benchmark theo + uncertainty  
+ TxLINE StablePrice / `Pct` semantics inspection  
+ **unit test preventing double de-vig**  
+ optional authenticated historical harvest into append-only store (still no alpha claims)

Then Milestone 2: Dixon–Coles prior (only with enough match outcomes).

---

## 14. Exact first prompt for a fresh Cursor session

```text
Open worktree E:\Hackathons\World-Cup-quant on branch cursor/quant-agents.

Read docs/CURSOR-QUANT-HANDOFF.md, docs/academic-quant-methodology.md, docs/model-validation-and-risk.md, research/experiment-roadmap.md, and research/strategy-registry.yaml first.

Do not invent alpha from synthetic/sanitized replay. The ~48 TxODDS updates are integration data only. TxLINE StablePrice is already de-margined — do not double de-vig; inspect Prices vs Pct; add a regression test.

Continue Milestone 1 only: harden StateSpaceTheo uncertainty, document which TxLINE field is market probability, preserve raw values, and add double-de-vig prevention tests. Run npx vitest run and npx tsc --noEmit. Do not start Colab, Perplexity, or multi-agent work. Ask before committing or pushing.
```

---

## Related checkpoint files

- `docs/academic-quant-methodology.md`
- `docs/model-validation-and-risk.md`
- `research/references.bib`
- `research/strategy-registry.yaml`
- `research/experiment-roadmap.md`
