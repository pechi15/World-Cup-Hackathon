# Adaptive Quote Guard — sanitized replay artifact

Provenance: `SANITIZED_TXODDS`

Labels: `SANITIZED_TXODDS`, `REPLAY_TRAINED_QUOTE_GUARD`, `NOT_PROVEN_ALPHA`, `PAPER_ONLY`

This lightweight three-component Gaussian mixture is fitted to 12 ordered, sanitized replay observations from `txodds-6f13b98b0936b5b7`. Every feature is computed from information available at or before its row timestamp. The model labels market-risk intensity as `QUIET`, `VOLATILE`, or `SHOCK`; it is not directional and does not change the market quote centre or match probabilities.

The artifact is intended only for paper quote width, paper quote size, suspension, and controlled resumption demonstrations. It contains no Joblib or Parquet runtime requirement and no credentials or access material.

This sample is small and exists for contract and integration testing. It is not proven alpha, does not establish profitability, and is not approved for real execution. `Pct` was not used. Raw decimal `Prices` were converted to implied probability and de-vigged exactly once; documented `StablePrice` would not be de-vigged again.
