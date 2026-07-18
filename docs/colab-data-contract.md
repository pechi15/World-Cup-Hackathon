# Colab research data contract

Run the deterministic export from the repository root:

```powershell
npm run export:colab-data
```

Replay mode reads the sanitized capture configured by `REPLAY_FIXTURE_PATH` or the repository sample. Live mode makes read-only devnet snapshot calls using backend environment variables. `COLAB_EXPORT_INPUT` can point to a sanitized capture file. Output is written under the ignored directory `.local/colab-export/<dataset-id>/`.

## Bundle files

| File | Purpose |
| --- | --- |
| `fixtures.jsonl` | Fixture identity, teams, competition, scheduled start, source, and provenance. |
| `markets.jsonl` | Actual observed markets, parameters, selections, and settlement rules. |
| `market_events.jsonl` | One normalized, availability-timed probability row per selection and source event. |
| `score_events.jsonl` | Sanitized score/status events with source and receive timestamps. |
| `settlements.jsonl` | Selection payouts derived only from explicit settlements or observable final score events. |
| `markout_observations.jsonl` | Actual future observations at 10/30/60/300-second horizons, or explicit null missing rows. |
| `data_quality.jsonl` | Dataset and row-quality flags, including duplicate removal and missing outcomes. |
| `raw_events.jsonl` | Append-only sanitized TxLINE-shaped odds payloads with raw `Prices`, `Pct`, and `StablePrice` preserved. |
| `prediction_observations.jsonl` | Exact projection accepted by `quant_research.contracts.PredictionObservation`; contains only settled rows. |
| `dataset-schema.json`, `schemas/*.json` | Table names and mandatory columns. |
| `data-dictionary.json` | Machine-readable field meanings. |
| `research-dataset-manifest.json` | Exact `quant_research.contracts.DatasetManifest` projection. |
| `dataset-manifest.json` | Export provenance, per-file hashes/counts, Git commit, timestamp, network, and markout horizons. |
| `dataset-hash.txt` | SHA-256 of canonical table filenames and JSONL bytes. |
| `jsonl_to_parquet.py` | Colab conversion helper using PyArrow and Zstandard compression. |

The dataset hash excludes export time and manifest metadata, so identical normalized data produces the same hash. JSON objects are key-sorted and rows are deterministically ordered before hashing.

## Core prediction columns

`market_events.jsonl` is the source-level prediction table and supports:

| Column | Type/unit | Null behavior |
| --- | --- | --- |
| `fixture_id` | UTF-8 identifier | Never null. |
| `market_id` | UTF-8 stable market key | Never null. |
| `selection_id` | UTF-8 mapped selection key | Never null. |
| `event_time` | RFC3339 UTC | Source-assigned time; never null. |
| `receive_time` | RFC3339 UTC | Backend receipt/capture time; never earlier than `event_time`. |
| `available_at` | RFC3339 UTC | Earliest research availability; equals `receive_time` for source events. |
| `decision_time` | RFC3339 UTC | Null in source-only exports. A research/runtime decision must populate it later and cannot precede `available_at`. |
| `market_probability` | Decimal probability `[0,1]` | Never null for accepted market rows. |
| `source` | `REPLAY` or `TXODDS` | `REPLAY` for the sanitized fixture; `TXODDS` only for authenticated devnet responses. |
| `provenance` | JSON object | Never null; records data mode, source network, bookmaker identity, and probability-selection reasons. |

`prediction_observations.jsonl` deliberately contains only the exact fields accepted by Cursor's frozen Pydantic `PredictionObservation`: `observation_id`, `fixture_id`, `event_time`, `available_at`, `decision_time`, `target_available_at`, `probability`, `baseline_probability`, `outcome`, and nullable `strategy_return`. Market and selection identifiers remain in `market_events.jsonl` and join through `observation_id`; this avoids adding forbidden fields to the Pydantic object.

## Timestamp and target availability rules

- Every timestamp is RFC3339 UTC with millisecond precision.
- `event_time <= receive_time == available_at` for source events.
- A markout target is usable only when a real later event has `event_time >= event_time + horizon` and was received no earlier than the source observation.
- Missing horizons have `future_probability`, `markout`, `observed_event_time`, and `target_available_at` set to null with `status=MISSING_FUTURE_OBSERVATION`.
- A settlement target becomes available at the final score event's receive time, not its source event time.
- Pydantic prediction rows require `event_time <= available_at <= decision_time < target_available_at`; the exporter emits them only when that chronology and a binary `0/1` outcome are available.

## Probability and TxLINE field semantics

- `StablePrice`: documented TxLINE consensus probability. It is already de-margined. The exporter performs only bounded numerical normalization and never a second de-vig.
- `Prices`: raw decimal bookmaker odds. When `StablePrice` is absent, values are converted to implied probabilities and proportionally de-vigged exactly once across the observed selection set.
- `Pct`: preserved unchanged under `raw_fields`. Its semantics have not been verified from authenticated samples, so it is never selected as `market_probability`.
- `probability_field` and `demargining_status` state which rule was applied. No odds field is silently relabelled.

## Settlement rules

Final score derivation requires an event with `action=game_finalised` or both `statusId=100` and `period=100`, plus observable home and away scores. The existing deterministic market settlement package maps supported result, handicap, totals, team-total, and both-teams-to-score markets. Unsupported markets remain unsettled. Push payouts are retained in `settlements.jsonl` but are not converted into binary Pydantic prediction outcomes.

## Pydantic manifest compatibility

`research-dataset-manifest.json` uses Cursor's `DatasetManifest` fields without extras:

- `data_mode=SANITIZED_TXODDS`
- `source_type=TXODDS_REPLAY`
- 64-character `content_hash`
- nonnegative record/fixture counts
- `sanitized=true`
- `generator=null`

This conservative mode prevents a sanitized export from being mislabeled as `REAL_HISTORICAL` evidence. The exporter does not modify research models, governance, promotion gates, or agent providers.

## Secret boundary

The sanitizer recursively removes keys containing token, JWT, authorization, secret/private key, wallet, signature, keypair, or activation semantics. It also rejects residual bearer values. API tokens, JWTs, headers, wallet addresses/paths, signatures, private keys, and activation payloads are never bundle fields.

## Known limitations

- The committed replay fixture has odds only: score and settlement tables are empty, so Pydantic prediction rows are empty.
- Snapshot export provides only observations returned at capture time; it does not manufacture historical depth.
- The 300-second markout is commonly null in the short sample.
- Authenticated `Pct` semantics remain unverified.
- Market coverage is whatever TxLINE actually returns; the exporter does not fabricate unobserved World Cup markets.
- JSONL is the canonical format. Parquet requires PyArrow in Colab and is derived, not hash-authoritative.
