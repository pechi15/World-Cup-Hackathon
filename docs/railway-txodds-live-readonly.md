# Railway TxODDS live read-only configuration

## Root cause of `NOT_CONFIGURED`

The previous API server always instantiated `DisabledTxoddsAdapter`. Its constructor returned `NOT_CONFIGURED` whenever `TXLINE_API_ORIGIN` was absent, regardless of `DATA_MODE`. It also required `TXLINE_GUEST_JWT` as a static environment variable even though guest JWTs are short-lived and should be requested at runtime.

The old server did not read `DATA_MODE` or `DEMO_MODE`, did not connect a live adapter, and selected replay only through `THEO_MODE` plus the presence of a local replay file. Therefore the observed response can identify a missing `TXLINE_API_ORIGIN`, an older deployed branch, or a stale deployment, but it did not reliably describe the intended data mode.

Railway injects service variables directly into `process.env`; dotenv is not required in Railway. Local `.env` or `.env.local` files are not automatically loaded by Node in this repository. For local use, export variables in the shell or use a Node environment-file option. Never commit a credential file.

## Required Railway variables

Use exactly one configuration. Variable names are case-sensitive.

### Replay demo

```text
DATA_MODE=replay
DEMO_MODE=true
ENABLE_REAL_EXECUTION=false
ENABLE_WALLET_OPERATIONS=false
ENABLE_TXODDS_ACTIVATION=false
```

`TXLINE_API_TOKEN`, wallet paths, guest JWTs, and Solana wallet files are not required in replay mode.

### Live read-only devnet

```text
DATA_MODE=txline
DEMO_MODE=false
TXLINE_NETWORK=devnet
TXLINE_API_ORIGIN=https://txline-dev.txodds.com
TXLINE_API_TOKEN=<activated backend-only Railway secret>
SOLANA_RPC_URL=https://api.devnet.solana.com
ENABLE_REAL_EXECUTION=false
ENABLE_WALLET_OPERATIONS=false
ENABLE_TXODDS_ACTIVATION=false
```

Do not configure `TXLINE_GUEST_JWT`: the backend requests a fresh JWT from `POST https://txline-dev.txodds.com/auth/guest/start` during startup and renews it once after a `401`. The activated token remains in `TXLINE_API_TOKEN` and is sent only as the backend `X-Api-Token` request header.

No `ANCHOR_WALLET`, wallet JSON, keypair, signature, transaction ID, activation payload, program ID, or token mint is required by the Railway service. Subscription and token activation are deliberately separate, offline administrative steps.

## Deploy

1. In Railway, select the backend service and confirm its repository branch is `codex/txodds-colab-pipeline` (or the eventual reviewed target branch).
2. Add the variables above to the same Railway environment as the service deployment. Do not add secrets as build arguments or public frontend variables.
3. Set the start command to `npm start` unless the service already invokes that script.
4. Deploy the latest branch commit. In the Railway deployment view, compare the deployed commit with `git rev-parse HEAD`.
5. If the response still has the old two-field `NOT_CONFIGURED` shape, redeploy without cache and verify the service is not pinned to `codex/demo-deployment` or an older commit.

There is no automatic `txline` to replay fallback. A malformed live configuration remains `NOT_CONFIGURED` or `AWAITING_CREDENTIALS`; an authentication or data error becomes `DEGRADED` or `DISCONNECTED`.

## Smoke tests

Replace `$service` with the Railway public backend origin.

```powershell
$service = "https://<service>.up.railway.app"
Invoke-RestMethod "$service/health" | ConvertTo-Json -Depth 10
Invoke-RestMethod "$service/api/config" | ConvertTo-Json -Depth 10
Invoke-RestMethod "$service/api/fixtures" | ConvertTo-Json -Depth 10
Invoke-RestMethod "$service/api/markets" | ConvertTo-Json -Depth 10
```

Expected live health fields after successful authentication:

```json
{
  "ok": true,
  "dataMode": "txline",
  "dataStatus": {
    "status": "CONNECTED",
    "mode": "txline",
    "network": "devnet",
    "readOnly": true,
    "reasonCodes": [],
    "credentials": {
      "apiToken": "configured",
      "guestJwt": "ephemeral-active"
    }
  },
  "theoMode": "NULL"
}
```

The response must never contain the token value, JWT value, `Authorization`, or `X-Api-Token`. `theoMode` remains `NULL` in live mode because this change provides data access, not a live statistical model.

Diagnostic states:

| State | Meaning |
| --- | --- |
| `NOT_CONFIGURED` | Missing/invalid mode, origin, network, RPC, safety flag, or demo flag. Inspect `reasonCodes`. |
| `AWAITING_CREDENTIALS` | The only missing item is `TXLINE_API_TOKEN`. |
| `DISCONNECTED` | Configuration is valid, but startup/authentication is pending or an authorization failure remains after renewal. |
| `DEGRADED` | Guest authentication or a non-authorization data request failed. |
| `CONNECTED` | A fresh guest JWT exists and the latest authenticated request succeeded. |

An open/connected service does not guarantee that a covered fixture is producing updates. Empty fixture, odds, or score results must remain empty rather than being replaced with replay data.
