# World Cup paper market maker

Submission-ready autonomous paper market maker centred on a TxODDS market-consensus baseline.

- `PAPER MARKET MAKING`
- `MARKET CONSENSUS BASELINE`
- `NO PROPRIETARY ALPHA`
- `NO REAL EXECUTION`

The state-space component is a market filter only. Directional actions are always `NO_ACTION`. The guarded fractional-Kelly utility is available but locked in market-baseline mode, so Kelly size remains null. Wallet and subscription operations are hard-disabled.

## Local replay

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173). The deterministic replay uses conservative future-observation crossing; zero fills is reported honestly when no eligible observation crosses a resting quote. Use the replay selector to switch to the committed sanitized historical TxODDS recording.

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
