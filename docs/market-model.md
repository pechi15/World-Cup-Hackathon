# Market Model

Markets are not assumed to be binary. Every market has a definition, parameters, selections, settlement rules, status, timestamps, and provenance.

Implemented MVP settlement logic:

- Binary yes/no
- Three-way match result
- Two-way match winner, with draws excluded
- Handicap
- Totals
- Team totals
- Both teams to score
- Tournament winner

Schema-only market families:

- Reach round
- Stage of elimination
- Group winner
- Group qualification
- Continental winner
- Unbeaten champion
- Golden Boot or top goalscorer
- Player to score
- Most assists
- Player awards
- Team top scorer
- Team tournament performance
- Combination markets

Combination markets are intentionally suspended for automated pricing and risk aggregation until correlated settlement rules are explicit.

Synthetic and replay records must never be labelled live. Runtime sample records use `TEST_FIXTURE` or `SYNTHETIC` provenance.
