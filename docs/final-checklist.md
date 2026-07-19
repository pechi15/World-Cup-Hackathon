# Final Submission Checklist

## Product truthfulness

- [ ] Dashboard mode matches the selected source: deterministic replay, recorded TxODDS replay, or live TxODDS.
- [ ] Backend connection state is real and disconnect behavior has been observed.
- [ ] TxODDS adapter state comes from `/health`.
- [ ] Recording, cash, and source timestamps say **Unavailable from API** when not exposed.
- [ ] No market consensus value is labelled “AI Theo.”
- [ ] The state-space filter is described as a transparent benchmark, not proprietary alpha.
- [ ] Directional trading and real execution are visibly disabled.
- [ ] Paper fills require explicit future replay events.

## Demo controls and behavior

- [ ] **Run Full Demo** is the primary action.
- [ ] Start, pause, resume, step, reset, and speed controls work.
- [ ] Information-shock injection is visible and reason-coded.
- [ ] Normal quoting is visible.
- [ ] Width increases during volatility or uncertainty.
- [ ] Inventory lean appears after a fill.
- [ ] Quote suspension and controlled resumption are visible.
- [ ] Position, realized/unrealized P&L, and risk update after a paper fill.
- [ ] Kill-switch state and audit reason codes are readable.

## Visual readiness

- [ ] Review at 1440×900, 100% browser zoom.
- [ ] Review at 1280×720, 90–100% browser zoom.
- [ ] Safety badges, replay controls, market board, and event sequence appear without excessive scrolling.
- [ ] Market-board columns remain usable with local horizontal table scrolling.
- [ ] No clipped labels, overlapping controls, or unreadable chart legends.
- [ ] Capture the five stills listed in `docs/video-shot-list.md`.

## Documentation

- [ ] README renders correctly, including Mermaid.
- [ ] One-sentence, 100-word, and 250-word descriptions are copied from `docs/submission-description.md`.
- [ ] Three-minute narration has been rehearsed against the deployed build.
- [ ] Architecture and limitations match observed behavior.
- [ ] Paper-execution disclaimer appears in README and submission form.

## Verification

Run from the repository root:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npx.cmd playwright test
```

- [ ] TypeScript typecheck passes.
- [ ] Vitest suite passes.
- [ ] Production web build passes.
- [ ] Existing browser demo test passes.
- [ ] Browser console has no uncaught errors during the full replay.

## Security

- [ ] No TxODDS JWT, API token, wallet key, seed phrase, or secret appears in Git.
- [ ] No secret appears in screenshots, narration, terminal history, build logs, or captures.
- [ ] Frontend environment contains only the public API base URL.
- [ ] Production CORS allows only the deployed frontend origin.
- [ ] Public capture files have been reviewed for sensitive headers or metadata.

## Public URL placeholders

- [ ] Public dashboard: **[ADD PUBLIC WEB URL]**
- [ ] API health: **[ADD PUBLIC API `/health` URL]**
- [ ] API readiness: **[ADD PUBLIC API `/ready` URL]**
- [ ] Demo video: **[ADD DEMO VIDEO URL]**
- [ ] Hackathon submission: **[ADD HACKATHON SUBMISSION URL]**
- [ ] Source repository or approved branch: **[ADD SOURCE URL]**

## Git handoff

- [ ] Branch is `cursor/submission-package`.
- [ ] Branch is based on `codex/demo-deployment`.
- [ ] `codex/final-market-maker` was incorporated only if available and conflict-free.
- [ ] Changes are limited to `apps/web/`, `README.md`, `docs/`, and required public assets.
- [ ] No backend, ingestion, authentication, mathematics, execution, risk, deployment, Colab, or research-model file changed.
- [ ] Commit is pushed without merging into a Codex branch.
