const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const axios = require("axios");
const nacl = require("tweetnacl");
const {
  DEVNET_RPC,
  DEVNET_API_ORIGIN,
  DEVNET_PROGRAM_ID,
  DEVNET_TXL_MINT,
  assertDevnetConfig,
  maskSecret,
  sanitizedAxiosError,
} = require("./safety.cjs");

async function main() {
  assertDevnetConfig({
    rpcUrl: process.env.ANCHOR_PROVIDER_URL,
    apiOrigin: DEVNET_API_ORIGIN,
    programId: DEVNET_PROGRAM_ID,
    tokenMint: process.env.TOKEN_MINT_ADDRESS,
  });

  const statePath = process.env.TXODDS_SUBSCRIPTION_STATE_PATH;
  const envPath = process.env.TXODDS_ENV_LOCAL_PATH;
  if (!statePath) throw new Error("TXODDS_SUBSCRIPTION_STATE_PATH is not set");
  if (!envPath) throw new Error("TXODDS_ENV_LOCAL_PATH is not set");
  if (!fs.existsSync(statePath)) throw new Error(`Subscription state not found: ${statePath}`);

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.network !== "devnet") throw new Error("Subscription state is not devnet");
  if (state.programId !== DEVNET_PROGRAM_ID) throw new Error("Subscription state program ID mismatch");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const publicKey = provider.wallet.publicKey.toBase58();
  if (state.publicWalletAddress !== publicKey) {
    throw new Error("Configured wallet does not match subscription state wallet");
  }

  const guestResponse = await axios.post(`${DEVNET_API_ORIGIN}/auth/guest/start`);
  const jwt = guestResponse.data && (guestResponse.data.token || guestResponse.data.jwt || guestResponse.data);
  if (!jwt || typeof jwt !== "string") throw new Error("Guest JWT response did not contain a token");

  const selectedLeagues = Array.isArray(state.selectedLeagues) ? state.selectedLeagues : [];
  const messageString = `${state.transactionSignature}:${selectedLeagues.join(",")}:${jwt}`;

  console.log("TxODDS API activation preflight");
  console.log(`Public wallet address: ${publicKey}`);
  console.log(`Network: devnet`);
  console.log(`Subscription transaction: ${state.transactionSignature}`);
  console.log(`Selected leagues: ${JSON.stringify(selectedLeagues)}`);
  console.log(`Guest JWT: ${maskSecret(jwt)}`);
  console.log("Activation message shape: <txSig>:<comma-separated leagues>:<guest JWT>");
  console.log("For the standard free bundle, the signed message contains an empty leagues segment.");

  if (process.env.APPROVE_TXODDS_API_ACTIVATION_SIGNATURE !== "YES") {
    console.error("Activation signature approval missing. No signing or token activation was performed.");
    process.exit(10);
  }

  let signatureBytes;
  if (typeof provider.wallet.signMessage === "function") {
    signatureBytes = await provider.wallet.signMessage(new TextEncoder().encode(messageString));
  } else if (provider.wallet.payer && provider.wallet.payer.secretKey) {
    signatureBytes = nacl.sign.detached(new TextEncoder().encode(messageString), provider.wallet.payer.secretKey);
  } else {
    throw new Error("Wallet cannot sign activation messages in this environment");
  }

  const walletSignature = Buffer.from(signatureBytes).toString("base64");
  let activationResponse;
  try {
    activationResponse = await axios.post(
      `${DEVNET_API_ORIGIN}/api/token/activate`,
      {
        txSig: state.transactionSignature,
        walletSignature,
        leagues: selectedLeagues,
      },
      {
        headers: { Authorization: `Bearer ${jwt}` },
      },
    );
  } catch (error) {
    console.error("Activation request failed:", sanitizedAxiosError(error));
    process.exit(1);
  }

  const apiToken = activationResponse.data && (activationResponse.data.token || activationResponse.data.apiToken || activationResponse.data);
  if (!apiToken || typeof apiToken !== "string") throw new Error("Activation response did not contain an API token");

  const envText = [
    "TXLINE_NETWORK=devnet",
    `TXLINE_API_ORIGIN=${DEVNET_API_ORIGIN}`,
    `TXLINE_GUEST_JWT=${jwt}`,
    `TXLINE_API_TOKEN=${apiToken}`,
    `SOLANA_RPC_URL=${DEVNET_RPC}`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, envText, "utf8");
  console.log(`Credentials stored in ${envPath}`);
  console.log(`Stored guest JWT: ${maskSecret(jwt)}`);
  console.log(`Stored API token: ${maskSecret(apiToken)}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
