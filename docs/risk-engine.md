# Risk Engine

The risk engine is deterministic and auditable.

## Mark-To-Market Shock Risk

Given current and shocked prices, it calculates:

- Position P&L change
- Position value
- Exposure
- Portfolio P&L change

Probability shocks preserve probability constraints for mutually exclusive markets.

## Terminal Outcome Risk

For match markets, the engine evaluates these terminal score scenarios:

```text
0-0, 1-0, 0-1, 1-1, 2-0, 0-2, 2-1, 1-2, 2-2, 3-0, 0-3, 3-1, 1-3, 3-2, 2-3
```

The payoff matrix supports match result, moneyline-style winner, handicap, totals, team totals, and both-teams-to-score settlement.

Expected P&L remains `null` unless an approved probability distribution is supplied.

## Limits

Supported limits include:

- Maximum position per selection
- Maximum exposure per market
- Maximum exposure per fixture
- Maximum exposure per team
- Maximum worst-case loss
- Maximum daily drawdown
- Maximum order size
- Maximum quote width
- Minimum data freshness
- Kill switch
- Quote suspension
- Directional-trading suspension
