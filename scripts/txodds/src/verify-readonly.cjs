const fs = require("fs");
const path = require("path");
const { DEVNET_API_ORIGIN, maskSecret } = require("./safety.cjs");

const workspace = "E:\\Hackathons\\World-Cup";
const envPath = path.join(workspace, ".env.local");
const sampleDir = path.join(workspace, "data", "samples", "txodds");
const samplePath = path.join(sampleDir, "verification-summary.json");

function loadEnvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function sampleShape(value, depth = 0) {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      firstShape: value.length ? sampleShape(value[0], depth + 1) : null,
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).slice(0, 30).map(([key, child]) => [key, sampleShape(child, depth + 1)]);
    return { type: "object", keys: Object.keys(value).slice(0, 50), fields: Object.fromEntries(entries) };
  }
  return value === null ? "null" : typeof value;
}

async function requestJson(endpoint, jwt, apiToken) {
  const response = await fetch(`${DEVNET_API_ORIGIN}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { nonJsonBodyLength: text.length };
  }
  return {
    endpoint,
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    shape: sampleShape(data),
    count: Array.isArray(data) ? data.length : null,
    firstFixtureId: Array.isArray(data) && data[0] ? data[0].FixtureId ?? data[0].fixtureId ?? data[0].id ?? null : null,
  };
}

async function requestGuestJwt() {
  const response = await fetch(`${DEVNET_API_ORIGIN}/auth/guest/start`, { method: "POST" });
  const data = await response.json();
  const token = data.token || data.jwt || data;
  if (!response.ok || typeof token !== "string") throw new Error(`Guest auth failed with status ${response.status}`);
  return token;
}

async function testSse(jwt, apiToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${DEVNET_API_ORIGIN}/api/odds/stream`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": apiToken,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
    clearTimeout(timer);
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore cancellation errors after confirming the stream opened.
      }
    }
    return {
      endpoint: "/api/odds/stream",
      opened: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      endpoint: "/api/odds/stream",
      opened: false,
      status: null,
      error: error && error.name === "AbortError" ? "TIMEOUT_BEFORE_HEADERS" : error.message,
    };
  }
}

async function main() {
  const env = loadEnvFile(envPath);
  if (env.TXLINE_NETWORK !== "devnet") throw new Error("TXLINE_NETWORK is not devnet");
  if (env.TXLINE_API_ORIGIN !== DEVNET_API_ORIGIN) throw new Error("TXLINE_API_ORIGIN is not devnet");
  if (!env.TXLINE_GUEST_JWT || !env.TXLINE_API_TOKEN) throw new Error("Missing TxLINE credentials in .env.local");

  console.log("TxODDS read-only verification");
  console.log(`API origin: ${env.TXLINE_API_ORIGIN}`);
  console.log(`Stored guest JWT: ${maskSecret(env.TXLINE_GUEST_JWT)}`);
  console.log(`Stored API token: ${maskSecret(env.TXLINE_API_TOKEN)}`);

  const freshJwt = await requestGuestJwt();
  console.log(`Fresh guest JWT acquired: ${maskSecret(freshJwt)}`);

  const endpoints = [
    "/api/fixtures/snapshot",
    "/api/fixtures/snapshot?competitionId=72&startEpochDay=20624",
    "/api/odds/snapshot/17588320",
    `/api/odds/snapshot/17588320?asOf=${Date.now()}`,
  ];

  const now = new Date();
  const epochDay = Math.floor(now.getTime() / 86400000);
  endpoints.push(`/api/odds/updates/${epochDay}/${now.getUTCHours()}/0`);

  const requests = [];
  for (const endpoint of endpoints) {
    try {
      requests.push(await requestJson(endpoint, env.TXLINE_GUEST_JWT, env.TXLINE_API_TOKEN));
    } catch (error) {
      requests.push({ endpoint, ok: false, status: null, error: error.message });
    }
  }

  const renewalProbe = await requestJson("/api/fixtures/snapshot?competitionId=72&startEpochDay=20624", freshJwt, env.TXLINE_API_TOKEN);
  const sse = await testSse(env.TXLINE_GUEST_JWT, env.TXLINE_API_TOKEN);

  const summary = {
    generatedAt: new Date().toISOString(),
    apiOrigin: env.TXLINE_API_ORIGIN,
    credentials: {
      guestJwt: "<redacted>",
      renewedGuestJwt: "<redacted>",
      apiToken: "<redacted>",
      apiTokenReusedForRenewalProbe: true,
    },
    requests,
    renewalProbe,
    sse,
  };

  fs.mkdirSync(sampleDir, { recursive: true });
  fs.writeFileSync(samplePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    guestAuthentication: "succeeded",
    authenticatedRequestSucceeded: requests.some((item) => item.ok),
    fixturesRequest: requests.find((item) => item.endpoint.startsWith("/api/fixtures/snapshot")),
    oddsSnapshot: requests.find((item) => item.endpoint.startsWith("/api/odds/snapshot/17588320")),
    historicalOdds: requests.find((item) => item.endpoint.startsWith("/api/odds/updates/")),
    sse,
    renewalProbe: {
      ok: renewalProbe.ok,
      status: renewalProbe.status,
      apiTokenReused: true,
    },
    sanitizedSummarySaved: samplePath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
