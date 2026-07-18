import type { Fixture, MarketDefinition, MarketSnapshot } from "../../contracts/src/index.js";
import type { TxoddsAdapterStatus } from "./index.js";
import type { TxlineDataConfig } from "./config.js";
import { mapFixture, mapOddsUpdateToMarket, mapOddsUpdateToTicks, type TxlineFixtureRow, type TxlineOddsUpdate } from "./mapper.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type TxlineScoreEvent = Record<string, unknown>;

function arrayPayload<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    if (Array.isArray(record.items)) return record.items as T[];
  }
  throw new Error("TXLINE_RESPONSE_NOT_ARRAY");
}

function guestToken(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const token = record.token ?? record.jwt;
    if (typeof token === "string" && token.length > 0) return token;
  }
  throw new Error("TXLINE_GUEST_JWT_INVALID");
}

export function maskSecret(value: string): string {
  if (value.length < 12) return "<masked>";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Read-only TxLINE client. It has no wallet, activation, or transaction path. */
export class TxlineReadOnlyAdapter {
  private guestJwt: string | null = null;
  private connectionStatus: TxoddsAdapterStatus = "DISCONNECTED";
  private reasonCodes: string[] = ["TXODDS_NOT_CONNECTED"];
  private lastConnectedAt: string | null = null;

  constructor(
    private readonly config: TxlineDataConfig,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get status(): TxoddsAdapterStatus {
    return this.connectionStatus;
  }

  getSystemDataStatus() {
    return {
      status: this.connectionStatus,
      display: this.connectionStatus === "CONNECTED" ? "TxLINE devnet live read-only" : "TxLINE devnet unavailable",
      mode: "txline",
      network: this.config.network,
      readOnly: true,
      reasonCodes: [...this.reasonCodes],
      lastConnectedAt: this.lastConnectedAt,
      credentials: { apiToken: "configured", guestJwt: this.guestJwt ? "ephemeral-active" : "ephemeral-pending" },
    };
  }

  async connect(): Promise<void> {
    await this.refreshGuestJwt();
    await this.requestJson("/api/fixtures/snapshot");
  }

  private async refreshGuestJwt(): Promise<void> {
    this.connectionStatus = "DISCONNECTED";
    this.reasonCodes = ["TXODDS_AUTHENTICATING"];
    const response = await this.fetcher(`${this.config.apiOrigin}/auth/guest/start`, { method: "POST" });
    if (!response.ok) {
      this.guestJwt = null;
      this.connectionStatus = "DEGRADED";
      this.reasonCodes = [`GUEST_JWT_HTTP_${response.status}`];
      throw new Error(`TxLINE guest authentication failed (${response.status})`);
    }
    this.guestJwt = guestToken(await response.json());
    this.connectionStatus = "DISCONNECTED";
    this.reasonCodes = ["TXODDS_GUEST_JWT_READY_API_TOKEN_NOT_YET_VERIFIED"];
  }

  private async requestJson(path: string, retryAfterUnauthorized = true): Promise<unknown> {
    if (!this.guestJwt) await this.refreshGuestJwt();
    const response = await this.fetcher(`${this.config.apiOrigin}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.guestJwt}`,
        "X-Api-Token": this.config.apiToken,
      },
    });
    if (response.status === 401 && retryAfterUnauthorized) {
      await this.refreshGuestJwt();
      return this.requestJson(path, false);
    }
    if (!response.ok) {
      this.connectionStatus = response.status === 401 || response.status === 403 ? "DISCONNECTED" : "DEGRADED";
      this.reasonCodes = [`TXLINE_HTTP_${response.status}`];
      throw new Error(`TxLINE read-only request failed (${response.status})`);
    }
    this.connectionStatus = "CONNECTED";
    this.reasonCodes = [];
    this.lastConnectedAt = this.now().toISOString();
    return response.json();
  }

  async fetchFixtureRows(): Promise<TxlineFixtureRow[]> {
    return arrayPayload<TxlineFixtureRow>(await this.requestJson("/api/fixtures/snapshot"));
  }

  async fetchOddsUpdatesForFixture(fixtureId: string): Promise<TxlineOddsUpdate[]> {
    return arrayPayload<TxlineOddsUpdate>(await this.requestJson(`/api/odds/snapshot/${encodeURIComponent(fixtureId)}`));
  }

  async fetchScoreEventsForFixture(fixtureId: string): Promise<TxlineScoreEvent[]> {
    return arrayPayload<TxlineScoreEvent>(await this.requestJson(`/api/scores/snapshot/${encodeURIComponent(fixtureId)}`));
  }

  async discoverFixtures(): Promise<Fixture[]> {
    return (await this.fetchFixtureRows()).map((row) => mapFixture(row, "TXODDS"));
  }

  async discoverMarkets(): Promise<MarketDefinition[]> {
    const fixtures = await this.fetchFixtureRows();
    const markets = new Map<string, MarketDefinition>();
    for (const fixture of fixtures) {
      for (const update of await this.fetchOddsUpdatesForFixture(String(fixture.FixtureId))) {
        const market = mapOddsUpdateToMarket(update, "TXODDS");
        markets.set(market.marketId, market);
      }
    }
    return [...markets.values()];
  }

  async fetchOddsSnapshot(): Promise<MarketSnapshot[]> {
    const fixtures = await this.fetchFixtureRows();
    const snapshots: MarketSnapshot[] = [];
    for (const fixture of fixtures) {
      for (const update of await this.fetchOddsUpdatesForFixture(String(fixture.FixtureId))) {
        const market = mapOddsUpdateToMarket(update, "TXODDS");
        const ticks = mapOddsUpdateToTicks(update, "TXODDS");
        snapshots.push({
          snapshotId: `txline-${update.MessageId ?? update.Ts}-${market.marketId}`,
          marketId: market.marketId,
          prices: ticks.map(({ tickId: _tickId, ...price }) => price),
          timestamp: new Date(update.Ts).toISOString(),
          provenance: { source: "TXODDS", collectedAt: this.now().toISOString() },
        });
      }
    }
    return snapshots;
  }
}
