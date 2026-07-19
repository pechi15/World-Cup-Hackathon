# World Cup paper market maker

Submission-ready autonomous paper market maker centred on a TxODDS market-consensus baseline.

- `PAPER MARKET MAKING`
- `MARKET CONSENSUS BASELINE`
- `NO PROPRIETARY ALPHA`
- `NO REAL EXECUTION`

The state-space component is a market filter only. Maker Bee quotes from market consensus; Forager Bee can act only on explicitly labelled heuristic movement signals through causal paper shadow execution. These signals are not proven alpha. The guarded fractional-Kelly utility remains locked without an independent theo, and wallet, subscription, and real-execution operations are hard-disabled.

## Local replay

Requires Node.js 22.12 or newer.

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173). The source selector exposes the current Argentina–Spain live option only when the backend is actually in TxLINE mode, a committed sanitized England–France historical replay, and the built-in deterministic fallback. Participant labels are derived from fixture data; the future Argentina–Spain sample has no fabricated result.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd exec playwright test
git diff --check
```

## Live read-only mode

The backend acquires and renews its guest JWT automatically. The activated TxODDS API token is backend-only; do not configure it in Vercel or expose it to browser code.

Exact Railway/Vercel variables and smoke tests are in [docs/submission-deployment.md](docs/submission-deployment.md).
