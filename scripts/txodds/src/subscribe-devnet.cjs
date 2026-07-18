const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const { PublicKey, Transaction, SystemProgram } = require("@solana/web3.js");
const {
  DEVNET_RPC,
  DEVNET_API_ORIGIN,
  DEVNET_PROGRAM_ID,
  DEVNET_TXL_MINT,
  assertDevnetConfig,
} = require("./safety.cjs");

const SERVICE_LEVEL = 1;
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = [];

async function retryGetAccount(connection, address) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await getAccount(connection, address, "confirmed", TOKEN_2022_PROGRAM_ID);
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Token account lookup failed");
}

async function main() {
  assertDevnetConfig({
    rpcUrl: process.env.ANCHOR_PROVIDER_URL,
    apiOrigin: DEVNET_API_ORIGIN,
    programId: DEVNET_PROGRAM_ID,
    tokenMint: process.env.TOKEN_MINT_ADDRESS,
  });

  if (process.env.APPROVE_TXODDS_DEVNET_SUBSCRIPTION !== "YES") {
    throw new Error("Subscription approval missing");
  }

  const repoRoot = process.env.TXODDS_OFFICIAL_REPO;
  const statePath = process.env.TXODDS_SUBSCRIPTION_STATE_PATH;
  if (!repoRoot) throw new Error("TXODDS_OFFICIAL_REPO is not set");
  if (!statePath) throw new Error("TXODDS_SUBSCRIPTION_STATE_PATH is not set");

  const idlPath = path.join(repoRoot, "examples", "devnet", "idl", "txoracle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(idl, provider);
  if (program.programId.toBase58() !== DEVNET_PROGRAM_ID) {
    throw new Error(`Loaded IDL program ${program.programId.toBase58()} does not match expected devnet program`);
  }

  const connection = provider.connection;
  const publicKey = provider.wallet.publicKey;
  const tokenMint = new PublicKey(DEVNET_TXL_MINT);
  const balanceLamports = await connection.getBalance(publicKey, "confirmed");
  if (balanceLamports <= 0) throw new Error("Wallet has zero devnet SOL");

  const userTokenAccountAddress = getAssociatedTokenAddressSync(
    tokenMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const accountInfo = await connection.getAccountInfo(userTokenAccountAddress, "confirmed");
  if (!accountInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        publicKey,
        userTokenAccountAddress,
        publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  }

  const userTokenAccount = await retryGetAccount(connection, userTokenAccountAddress);
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], program.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    tokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const matrix = await program.account.pricingMatrix.fetch(pricingMatrixPda);
  const row = matrix.rows.find((item) => Number(item.rowId) === SERVICE_LEVEL);
  if (!row) throw new Error(`Service level ${SERVICE_LEVEL} not found in pricing matrix`);
  if (Number(row.pricePerWeekToken) !== 0) throw new Error(`Service level ${SERVICE_LEVEL} is not free`);

  console.log("Submitting TxODDS free-tier devnet subscription...");
  console.log(`Public wallet address: ${publicKey.toBase58()}`);
  console.log(`Service level: ${SERVICE_LEVEL}`);
  console.log(`Duration weeks: ${DURATION_WEEKS}`);
  console.log(`Selected leagues: ${JSON.stringify(SELECTED_LEAGUES)}`);

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL, DURATION_WEEKS)
    .accounts({
      user: publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint,
      userTokenAccount: userTokenAccount.address,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });

  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature: txSig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  const state = {
    network: "devnet",
    rpcUrl: DEVNET_RPC,
    apiOrigin: DEVNET_API_ORIGIN,
    publicWalletAddress: publicKey.toBase58(),
    transactionSignature: txSig,
    serviceLevel: SERVICE_LEVEL,
    durationWeeks: DURATION_WEEKS,
    selectedLeagues: SELECTED_LEAGUES,
    confirmationTimestamp: new Date().toISOString(),
    programId: DEVNET_PROGRAM_ID,
    tokenMint: DEVNET_TXL_MINT,
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  console.log(`Subscription transaction confirmed: ${txSig}`);
  console.log(`Non-secret subscription state saved: ${statePath}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
