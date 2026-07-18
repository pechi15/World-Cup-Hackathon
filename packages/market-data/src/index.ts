import type { Fixture, MarketDefinition, MarketSnapshot, TxoddsAdapterStatusSchema } from "../../contracts/src/index.js";
import { z } from "zod";

export type TxoddsAdapterStatus = z.infer<typeof TxoddsAdapterStatusSchema>;

export type TxoddsAdapterConfig = {
  network?: string;
  apiOrigin?: string;
  guestJwt?: string;
  apiToken?: string;
  solanaRpcUrl?: string;
};

export class DisabledTxoddsAdapter {
  readonly status: TxoddsAdapterStatus;

  constructor(private readonly config: TxoddsAdapterConfig = {}) {
    this.status = !config.apiOrigin ? "NOT_CONFIGURED" : !config.guestJwt || !config.apiToken ? "AWAITING_CREDENTIALS" : "CONNECTED";
  }

  getSystemDataStatus() {
    return {
      status: this.status,
      display: this.status === "CONNECTED" ? "Configured" : "Awaiting TxODDS API",
      reasonCodes: this.status === "CONNECTED" ? [] : ["TXODDS_API_NOT_CONNECTED"],
    };
  }

  async discoverFixtures(): Promise<Fixture[]> {
    if (this.status !== "CONNECTED") return [];
    throw new Error("TxODDS fixture discovery is intentionally not implemented until credentials are approved.");
  }

  async discoverMarkets(): Promise<MarketDefinition[]> {
    if (this.status !== "CONNECTED") return [];
    throw new Error("TxODDS market discovery is intentionally not implemented until credentials are approved.");
  }

  async fetchOddsSnapshot(): Promise<MarketSnapshot[]> {
    if (this.status !== "CONNECTED") return [];
    throw new Error("TxODDS odds snapshots are intentionally not implemented until credentials are approved.");
  }
}
