import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const safety = require("../scripts/txodds/src/safety.cjs") as {
  DEVNET_RPC: string;
  DEVNET_API_ORIGIN: string;
  DEVNET_PROGRAM_ID: string;
  DEVNET_TXL_MINT: string;
  assertDevnetConfig(config: { rpcUrl: string; apiOrigin: string; programId: string; tokenMint: string }): void;
  maskSecret(value: string): string;
  refuseMainnet(label: string, value: string): void;
};

describe("TxODDS split activation safety", () => {
  it("accepts the approved devnet configuration", () => {
    expect(() =>
      safety.assertDevnetConfig({
        rpcUrl: safety.DEVNET_RPC,
        apiOrigin: safety.DEVNET_API_ORIGIN,
        programId: safety.DEVNET_PROGRAM_ID,
        tokenMint: safety.DEVNET_TXL_MINT,
      }),
    ).not.toThrow();
  });

  it("rejects mainnet network components", () => {
    expect(() => safety.refuseMainnet("rpc", "https://api.mainnet-beta.solana.com")).toThrow(/mainnet/);
    expect(() => safety.refuseMainnet("api", "https://txline.txodds.com")).toThrow(/mainnet/);
  });

  it("masks JWTs, API tokens, and signatures in logs", () => {
    expect(safety.maskSecret("abcdefghijklmnopqrstuvwxyz")).toBe("abcdef...wxyz");
    expect(safety.maskSecret("short")).toBe("<masked>");
  });
});
