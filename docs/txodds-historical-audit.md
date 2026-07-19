# TxODDS historical data audit

Dataset: `txodds-history-ba9e78270c411c86`

Generated from authenticated, read-only TxLINE devnet responses. Raw values are preserved in the ignored local export.

Probe scope: UTC epoch days `20647` through `20653`, interval `0`, using the
official snapshot, time-bucket update, fixture update, and fixture historical
endpoints. Two earlier 30-day attempts exceeded bounded command time and
produced no export; this document therefore makes no claim about unprobed days.

| Metric | Value |
|---|---:|
| Fixtures found | 10 |
| Completed fixtures | 0 |
| Competitions | Friendlies, World Cup |
| Teams | 1144, 1225, 1489, 1519, 1634, 2431, 3021, 45856, Argentina, Australia, Brazil, Gibraltar, India, Liechtenstein, New Zealand, Spain |
| Earliest source timestamp | 2026-07-10T21:19:31.797Z |
| Latest source timestamp | 2026-07-19T06:32:03.247Z |
| Odds updates | 18528 |
| Score updates | 322 |
| Final-state records | 0 |
| Fixtures with final scores | 0 |
| Missing-data rate | 10.5795% |
| Duplicate rate | 0.1273% |
| Out-of-order rate | 0.3597% |

Rates are computed over the preserved arrival sequence. Duplicate identity is
the canonical hash of the raw event (independent of the endpoint through which
it was observed). Out-of-order means a source timestamp decreased within the
same endpoint and fixture/market stream; this avoids misclassifying the
deliberate newest-to-oldest day probe as disorder. Missing-data rate is the proportion of absent required
odds cells (`FixtureId`, `Ts`, `SuperOddsType`, `MarketPeriod`, `PriceNames`,
`Prices`); optional fields such as `StablePrice` and `Pct` are not counted as
missing.

The 18,528 odds and 322 score counts are raw returned records, before
deduplication. This is deliberate: the ignored export preserves every response
and its endpoint provenance.

## Markets

| SuperOddsType | MarketParameters | MarketPeriod | Selections |
|---|---|---|---|
| 1X2_PARTICIPANT_RESULT |  | half=1 | part1, draw, part2 |
| 1X2_PARTICIPANT_RESULT |  |  | part1, draw, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-0.25 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-0.25 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-0.5 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-0.5 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-0.75 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-0.75 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-1.25 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-1.25 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-1.5 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-1.75 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-1 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-1 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-2.25 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-2.5 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-2.75 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=-2 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.25 | et,half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.25 | et | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.25 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.25 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.5 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.5 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0.75 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0 | et,half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0 | et | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0 | half=1 | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0 | penalties | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=0 |  | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=1.5 | penalties | part1, part2 |
| ASIANHANDICAP_PARTICIPANT_GOALS | line=1 |  | part1, part2 |
| OVERUNDER_PARTICIPANT_GOALS | line=0.5 | et,half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.5 | et | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.5 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.75 | et,half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.75 | et | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.75 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=0.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1.25 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1.25 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1.5 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1.75 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=1 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2.25 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2.25 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2.5 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2.75 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2 | half=1 | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=2 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=3.25 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=3.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=3.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=3 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=4.25 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=4.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=4.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=4 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=5.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=5.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=6.25 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=6.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=6.75 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=6 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=7.5 |  | over, under |
| OVERUNDER_PARTICIPANT_GOALS | line=9.5 |  | over, under |

## Future markout availability

| Horizon | Observations with a future mark |
|---|---:|
| 10s | 17972 |
| 30s | 17354 |
| 60s | 16612 |
| 300s | 12532 |

## Actual API retention limitations

Observed epoch-day range with returned data: 20644 to 20653. Probed: 20647 to 20653. Observed data range is subscription/API evidence only; empty responses do not prove permanent deletion and unprobed dates are not claimed as retained.

The source-time range is wider than the time-bucket probe because snapshot and
fixture endpoints returned older records. No `/api/scores/historical/{fixtureId}`
call returned a final-state row for the ten discovered fixtures. Consequently:

- settled-outcome coverage is zero;
- Brier/log-loss outcome evaluation and Dixon–Coles validation are not possible;
- score updates show feed activity but must not be treated as final scores;
- the earliest returned timestamp is evidence of availability, not proof of a
  stable ten-day retention SLA;
- `Pct` remains audit-only because its semantics have not been independently
  verified.

## StablePrice representation found

Authenticated historical consensus rows identify the bookmaker as
`TXLineStablePriceDemargined`. Those records store de-margined decimal odds as
integer milliodds in raw `Prices` (`3276` means `3.276`) and percentage-looking
strings in raw `Pct`; the `StablePrice` property itself is absent. Normalization
therefore decodes milliodds, derives implied probabilities, performs numerical
mass cleanup only, and reports `DOUBLE_DEVIG_SKIPPED`. Raw values remain
unchanged and `Pct` is not selected.
