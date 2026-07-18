# Demo script — autonomous replay market maker

Record a 3–5 minute video from **replay alone** (no live match required).

## Setup

```powershell
Set-Location "E:\Hackathons\World-Cup-quant"
npm.cmd install
npm.cmd run typecheck
npm.cmd test
$env:THEO_MODE="REPLAY"
npm.cmd run dev:api
```

API: `http://localhost:8787`

Sanitized fixture: `data/samples/txodds/sanitized/replay-fixture.json`  
(`data_mode=REPLAY` — not live TxODDS profitability evidence)

## Walkthrough

1. **Health / config**  
   `GET /health` → `theoMode: PIPELINE_REPLAY`, replay store counts.

2. **Start agent via full replay**  
   `POST /api/replay/run` with `{}`  
   Or step: `POST /api/replay/step` repeatedly.

3. **Show market vs theo**  
   `GET /api/demo/snapshot`  
   Call out: `marketPrice`, `baseline` (benchmark only), `theo` (StateSpace posterior), `uncertainty`.

4. **Show quotes**  
   Fields: `bid`, `ask`, `width`, `inventoryLean`, `directionalLean`, `quoteSize`, `quoteStatus`.

5. **Information shock**  
   Around message index ~8 odds jump. Snapshot / audit should show:
   - innovation spike  
   - `INNOVATION_SHOCK_WIDEN_OR_SUSPEND`  
   - quote suspension or widen  
   - then later steps resume LIVE quotes  

   `GET /api/audit` for full reason codes.

6. **Paper P&amp;L / risk**  
   `GET /api/portfolio`, `GET /api/performance`, `GET /api/risk`  
   Kill switch: `POST /api/kill-switch/enable` then step/quote → disabled.

7. **Closing line for judges**  
   “MarketBaseline is the unchanged normalized TxLINE-shaped market benchmark.
   StateSpace is a research-only latent log-odds filter with uncertainty and
   innovation diagnostics, not proven alpha. The maker/taker loop is autonomous
   on replay; later research milestones are intentionally out of this build.”

## Optional live TxLINE

Credentials stay in `.env.local` (never commit). Live adapter remains gated; demo path is replay until Codex wires production SSE into the same loop.
