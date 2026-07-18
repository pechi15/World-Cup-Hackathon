# Research artifacts

This directory documents the output contract; generated runs must be written to
a run-specific directory and should not overwrite another run.

Required files:

- `run-metadata.json`
- `experiment-spec.yaml`
- `feature-manifest.json`
- `dataset-manifest.json`
- `fold-results.parquet`
- `predictions.parquet`
- `calibration-report.json`
- `execution-report.json`
- `markout-report.json`
- `stress-tests.json`
- `critic-review.json`
- `promotion-decision.json`
- `model-card.md`
- `checksums.json`

The runtime also writes `model.bin` and `artifact-metadata.json`. Every file
except `checksums.json` is covered by SHA-256 in that checksum ledger.

Artifacts are offline challenger evidence. They do not modify the production
TheoProvider, risk limits, wallets, Solana state, deployment, or frontend.
