# Guarded fractional-Kelly utility

The utility in `packages/strategies/src/fractional-kelly.ts` is a reusable,
calculation-only research component. It does not submit orders and the current
maker runtime never invokes it for directional trading.

## Equations

For executable decimal odds \(O\) and independent probability \(p\):

\[
f^* = \frac{pO - 1}{O - 1}.
\]

For a binary contract bought at executable ask \(c\), paying one when the event
occurs:

\[
f^* = \frac{p-c}{1-c}.
\]

A sale at executable bid is represented as a purchase of the complementary
contract: probability \(1-p\), cost \(1-\text{bid}\). Fees and slippage reduce
decimal odds or increase contract cost before the formula is evaluated. The
runtime stake fraction is \(\kappa\max(0,f^*)\), with \(\kappa\le 0.25\).

## Mandatory gates

- Independent theo must be explicitly `AVAILABLE`.
- Calibration metadata must be explicitly `CALIBRATED`.
- `THEO_MODE=market_baseline` always returns
  `DISABLED_NON_INDEPENDENT_THEO` and a null size.
- Non-positive net edge returns zero.
- The executable ask is required for a buy and the executable bid for a sell;
  midpoint is not an accepted input type.
- Fees and slippage are mandatory non-negative inputs.
- Stake is capped by maximum bankroll fraction, selection remaining budget,
  market remaining budget, fixture remaining budget, and portfolio remaining
  worst-case-loss budget. The smallest correlated budget wins.
- A requested fraction above quarter Kelly is capped at `0.25`; full Kelly is
  never a runtime default.

## Units and limitations

`stake` is bankroll at risk. For a binary buy/synthetic complementary sell,
`quantity = stake / effective contract cost`; decimal-odds quantity equals the
stake. This avoids the previous stake-versus-contract-quantity ambiguity.

The function is not a multivariate Kelly optimizer. Market, fixture, and
portfolio caps are conservative external constraints, not a covariance model.
No calibrated independent model is approved in this branch, so a non-null Kelly
result is test/research-only and cannot enable directional trading.
