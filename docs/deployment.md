# Deployment

The public demo deploys without TxODDS secrets.

Railway backend variables:

```text
NODE_ENV=production
DATA_MODE=replay
DEMO_MODE=true
THEO_MODE=market_baseline
TRADING_MODE=paper
EXECUTION_MODE=shadow
ENABLE_MARKET_MAKING=true
ENABLE_DIRECTIONAL_TRADING=false
ENABLE_KELLY=false
ENABLE_REAL_EXECUTION=false
ENABLE_WALLET_OPERATIONS=false
ENABLE_TXODDS_ACTIVATION=false
ALLOWED_ORIGINS=<Vercel frontend origin>
```

Vercel frontend variable:

```text
VITE_API_BASE_URL=<Railway backend URL>
```

Do not put TxODDS JWTs, API tokens, wallet files, or activation secrets in Vercel.

Manual deployment sequence:

1. Authenticate Railway and Vercel CLIs or use their browser dashboards.
2. Deploy Railway backend from this branch.
3. Set `VITE_API_BASE_URL` in Vercel.
4. Deploy Vercel frontend.
5. Set `ALLOWED_ORIGINS` in Railway to the Vercel URL.
6. Redeploy backend and verify `/health` and `/ready`.
