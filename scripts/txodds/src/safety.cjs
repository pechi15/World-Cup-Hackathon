const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_API_ORIGIN = "https://txline-dev.txodds.com";
const DEVNET_PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const DEVNET_TXL_MINT = "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG";

function refuseMainnet(label, value) {
  const text = String(value || "");
  if (/mainnet|mainnet-beta|txline\.txodds\.com|9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA|Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL/i.test(text)) {
    throw new Error(`${label} contains a mainnet value`);
  }
}

function assertDevnetConfig(config) {
  refuseMainnet("rpcUrl", config.rpcUrl);
  refuseMainnet("apiOrigin", config.apiOrigin);
  refuseMainnet("programId", config.programId);
  refuseMainnet("tokenMint", config.tokenMint);
  if (config.rpcUrl !== DEVNET_RPC) throw new Error(`Unexpected RPC: ${config.rpcUrl}`);
  if (config.apiOrigin !== DEVNET_API_ORIGIN) throw new Error(`Unexpected API origin: ${config.apiOrigin}`);
  if (config.programId !== DEVNET_PROGRAM_ID) throw new Error(`Unexpected program ID: ${config.programId}`);
  if (config.tokenMint !== DEVNET_TXL_MINT) throw new Error(`Unexpected TxL mint: ${config.tokenMint}`);
}

function maskSecret(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 12) return "<masked>";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function sanitizedAxiosError(error) {
  if (!error || !error.response) return error && error.message ? error.message : String(error);
  return {
    status: error.response.status,
    statusText: error.response.statusText,
    data: error.response.data,
  };
}

module.exports = {
  DEVNET_RPC,
  DEVNET_API_ORIGIN,
  DEVNET_PROGRAM_ID,
  DEVNET_TXL_MINT,
  assertDevnetConfig,
  maskSecret,
  refuseMainnet,
  sanitizedAxiosError,
};
