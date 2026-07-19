import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BadgeCheck, BookOpen, Bot, Gauge, Pause, Play, Radio, RotateCcw, ShieldCheck, StepForward, WalletCards, Zap } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DemoState } from "../../../packages/contracts/src/index.js";
import { demoApi } from "./lib/api/client.js";

const fmtPct = (value: number | null | undefined) => value == null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const fmtMoney = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
const fmtNum = (value: number | null | undefined) => value == null ? "-" : value.toFixed(3);
const fmtTime = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Awaiting event";

export function App() {
  const queryClient = useQueryClient();
  const stateQuery = useQuery({
    queryKey: ["demo-state"],
    queryFn: demoApi.state,
    refetchInterval: 800,
    retry: 1,
  });
  const healthQuery = useQuery({ queryKey: ["system-health"], queryFn: demoApi.health, refetchInterval: 5_000, retry: false });
  const tradingQuery = useQuery({ queryKey: ["trading-status"], queryFn: demoApi.tradingStatus, refetchInterval: 5_000, retry: false });
  const hiveApiAvailable = tradingQuery.data?.decisionBookEnabled === true;
  const makerQuery = useQuery({ queryKey: ["maker-agent"], queryFn: demoApi.makerStatus, refetchInterval: 1_000, retry: false, enabled: hiveApiAvailable });
  const hawkQuery = useQuery({ queryKey: ["hawk-agent"], queryFn: demoApi.hawkStatus, refetchInterval: 1_000, retry: false, enabled: hiveApiAvailable });
  const decisionQuery = useQuery({ queryKey: ["decision-book"], queryFn: demoApi.decisionBook, refetchInterval: 1_000, retry: false, enabled: hiveApiAvailable });
  const fixtureQuery = useQuery({ queryKey: ["current-fixture"], queryFn: demoApi.currentFixture, refetchInterval: 30_000, retry: false, enabled: hiveApiAvailable });
  const replaysQuery = useQuery({ queryKey: ["demo-replays"], queryFn: demoApi.replays, retry: 1 });
  const action = (fn: () => Promise<DemoState>) => useMutation({
    mutationFn: fn,
    onSuccess: (state) => queryClient.setQueryData(["demo-state"], state),
  });
  const start = action(demoApi.start);
  const pause = action(demoApi.pause);
  const resume = action(demoApi.resume);
  const reset = action(demoApi.reset);
  const step = action(demoApi.step);
  const shock = action(demoApi.injectShock);
  const speed = useMutation({
    mutationFn: demoApi.speed,
    onSuccess: (state) => queryClient.setQueryData(["demo-state"], state),
  });
  const selectReplay = useMutation({
    mutationFn: demoApi.selectReplay,
    onSuccess: (state, replayId) => {
      queryClient.setQueryData(["demo-state"], state);
      queryClient.setQueryData(["demo-replays"], (current: typeof replaysQuery.data) => current ? { ...current, selected: replayId } : current);
    },
  });

  if (stateQuery.isLoading) return <Shell><StateMessage title="Loading demo" detail="Connecting to the replay backend." /></Shell>;
  if (stateQuery.isError) return <Shell><StateMessage title="Backend disconnected" detail={stateQuery.error.message} tone="danger" /></Shell>;
  const state = stateQuery.data!;
  const backendStatus = healthQuery.isError ? "DISCONNECTED" : healthQuery.data ? "CONNECTED" : "CHECKING";
  const txoddsStatus = healthQuery.data?.dataStatus.status ?? "UNAVAILABLE";
  const isBusy = start.isPending || pause.isPending || resume.isPending || reset.isPending || step.isPending || shock.isPending || speed.isPending || selectReplay.isPending;
  const makerRow = state.marketRows.find((row) => row.status === "LIVE" && row.bid !== null && row.ask !== null) ?? state.marketRows[0];
  const makerAction = state.audit.at(-1)?.finalAction ?? "WAITING_FOR_MARKET";
  const makerState = makerQuery.data?.state ?? tradingQuery.data?.maker ?? (makerRow?.status === "LIVE" ? "QUOTING" : "WAITING");
  const hawkState = hawkQuery.data?.state ?? tradingQuery.data?.hawk ?? tradingQuery.data?.directional ?? "MONITORING";
  const latestDecision = decisionQuery.data?.decisions.at(-1);
  const latestPosition = state.positions.at(-1);
  const fixture = fixtureQuery.data?.fixture;
  const fixtureLabel = fixture?.participant1 && fixture.participant2
    ? `${fixture.participant1} vs ${fixture.participant2}`
    : "Spain vs Argentina";
  const agentRunning = backendStatus === "CONNECTED" && tradingQuery.data?.agentAutonomous !== false ? "RUNNING" : backendStatus;
  const executionMode = tradingQuery.data?.executionMode ?? makerQuery.data?.executionMode ?? "SHADOW";
  const txlineConnection = txoddsStatus === "CONNECTED" ? "CONNECTED" : fixtureQuery.data ? "SNAPSHOT READY" : txoddsStatus;
  const foragerAction = hawkQuery.data?.latestAction ?? tradingQuery.data?.directionalAction ?? "NO_TRADE";
  const riskHealthy = !state.killSwitch && !Object.values(tradingQuery.data?.sharedRisk?.killSwitches ?? {}).some(Boolean);

  return (
    <Shell>
      <header className="demo-masthead">
        <div className="brand-lockup">
          <div className="hive-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><p>ORCHID HIVE</p><h1>World Cup agent desk</h1><h2 className="sr-only">World Cup market-consensus market maker</h2></div>
        </div>
        <div className="demo-promise"><strong>3-MINUTE LIVE DEMO</strong><span>Market input → autonomous decision → shadow portfolio</span></div>
        <div className="safety-lockup"><span>PAPER MARKET MAKING</span><span>SHADOW EXECUTION</span><span>REAL FUNDS DISABLED</span></div>
      </header>

      <section className="judge-strip status-bar" aria-label="Demo status at a glance">
        <span className="sr-only">{state.replayStatus} @ {state.speed}x</span>
        <Spotlight icon={<Radio size={18} />} label="LIVE TXLINE INPUT" value={txlineConnection} tone="live" detail={txoddsStatus === "CONNECTED" ? "Authenticated read-only feed" : state.dataSource} />
        <Spotlight icon={<BadgeCheck size={18} />} label="CURRENT FIXTURE" value={fixtureLabel} detail={fixture?.gameState ?? "PRE-MATCH"} />
        <Spotlight icon={<Bot size={18} />} label="AUTONOMOUS AGENT" value={agentRunning} tone="live" detail="Decision loop active" />
        <Spotlight icon={<Activity size={18} />} label="STRATEGY" value="Maker Bee + Forager Bee" detail="Two agents · one risk engine" />
        <Spotlight icon={<ShieldCheck size={18} />} label="EXECUTION" value={executionMode} tone="safe" detail="No external orders" />
      </section>

      <section className="agent-grid" aria-label="Agent status">
        <article className="agent-card maker-agent">
          <h2 className="sr-only">Maker Agent</h2>
          <div className="agent-card-heading">
            <div className="agent-icon maker"><Activity size={18} /></div>
            <div><p className="agent-kicker">AUTONOMOUS MARKET MAKER · PAPER EXECUTION</p><h2>Maker Bee</h2></div>
            <span className="agent-state live">{makerState}</span>
          </div>
          <p className="agent-fixture">Supplies and manages simulated two-sided liquidity.</p>
          <dl className="agent-metrics">
            <div><dt>Latest action</dt><dd>{makerQuery.data?.latestAction ?? makerAction}</dd></div>
            <div><dt>Bid / Ask</dt><dd>{fmtNum(makerQuery.data?.bid ?? makerRow?.bid)} / {fmtNum(makerQuery.data?.ask ?? makerRow?.ask)}</dd></div>
            <div><dt>Size</dt><dd>{fmtNum(makerQuery.data?.size ?? makerRow?.bidSize)}</dd></div>
            <div><dt>Inventory lean</dt><dd>{fmtNum(makerQuery.data?.inventoryLean ?? makerRow?.inventoryLean)}</dd></div>
          </dl>
        </article>

        <article className="agent-card forager-agent">
          <div className="agent-card-heading">
            <div className="agent-icon forager"><Zap size={18} /></div>
            <div><p className="agent-kicker">RELATIVE-VALUE SCOUT</p><h2>Forager Bee</h2></div>
            <span className="agent-state watch">{hawkState}</span>
          </div>
          <p className="agent-fixture">Searches for movement and relative-value signals.</p>
          <dl className="agent-metrics">
            <div><dt>Action</dt><dd>{foragerAction}</dd></div>
            <div><dt>Signal</dt><dd>{hawkQuery.data?.signalType ?? "MONITORING"}</dd></div>
            <div><dt>Paper position</dt><dd>{fmtNum(hawkQuery.data?.paperPosition ?? 0)}</dd></div>
          </dl>
        </article>

        <article className="agent-card risk-agent">
          <div className="agent-card-heading">
            <div className="agent-icon risk"><ShieldCheck size={18} /></div>
            <div><p className="agent-kicker">SHARED LIMITS & CONTROLS</p><h2>Hive Risk Engine</h2></div>
            <span className={`agent-state ${riskHealthy ? "live" : "halt"}`}>{riskHealthy ? "ARMED" : "HALTED"}</span>
          </div>
          <p className="agent-fixture">Governs inventory, latency, exposure, drawdown, and kill switches.</p>
          <dl className="agent-metrics">
            <div><dt>Risk used</dt><dd>{(state.risk.riskBudgetUtilization * 100).toFixed(1)}%</dd></div>
            <div><dt>Exposure</dt><dd>{state.risk.fixtureExposure.toFixed(2)}</dd></div>
            <div><dt>Kill switch</dt><dd>{state.killSwitch ? "ON" : "OFF"}</dd></div>
          </dl>
        </article>
      </section>

      <section className="snapshot-grid" aria-label="Latest decision and portfolio state">
        <Snapshot icon={<BookOpen size={17} />} label="LATEST DECISION" value={latestDecision?.action ?? makerAction} detail={`${latestDecision?.strategy?.toUpperCase() ?? "MAKER"} · ${fmtTime(latestDecision?.decisionTime ?? state.lastMarketUpdate)}`} badge={latestDecision?.noLookaheadVerificationStatus ?? "NO-LOOKAHEAD"} />
        <Snapshot icon={<Activity size={17} />} label="LATEST QUOTE" value={`${fmtNum(makerQuery.data?.bid ?? makerRow?.bid)} / ${fmtNum(makerQuery.data?.ask ?? makerRow?.ask)}`} detail={`Bid / Ask · width ${fmtNum(makerQuery.data?.width ?? makerRow?.width)}`} />
        <Snapshot icon={<WalletCards size={17} />} label="LATEST POSITION" value={latestPosition ? `${latestPosition.quantity.toFixed(2)} PAPER` : "FLAT"} detail={latestPosition?.selectionId ?? "No open paper inventory"} />
        <Snapshot icon={<Gauge size={17} />} label="P&L" value={fmtMoney(state.performance.netPnl)} detail={`Maker ${fmtMoney(state.performance.makerPnl)} · Fees $${(state.feesPaid ?? 0).toFixed(2)}`} tone={state.performance.netPnl >= 0 ? "positive" : "negative"} />
        <Snapshot icon={<ShieldCheck size={17} />} label="RISK" value={`${(state.risk.riskBudgetUtilization * 100).toFixed(1)}% USED`} detail={`Worst case ${fmtMoney(state.risk.worstCaseTerminalPnl)}`} tone={riskHealthy ? "positive" : "negative"} />
      </section>

      <section className="demo-controls" aria-label="Demo controls">
        <div className="control-context"><span>{state.dataMode === "replay" ? "HISTORICAL REPLAY" : "LIVE INPUT"}</span><strong>{state.dataMode === "replay" ? `${state.replayStatus} · ${state.speed}x` : txoddsStatus}</strong></div>
        {state.dataMode === "replay" ? <div className="controls">
          <label>Replay source
            <select value={replaysQuery.data?.selected ?? "built-in"} onChange={(event) => selectReplay.mutate(event.target.value)} disabled={isBusy}>
              {(replaysQuery.data?.options ?? [{ id: "built-in", label: "Built-in deterministic replay", available: true }]).map((option) => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : " (unavailable)"}</option>)}
            </select>
          </label>
          <button className="primary" onClick={() => start.mutate()} disabled={isBusy}><Play size={15} /> Run Full Demo</button>
          <button onClick={() => pause.mutate()} disabled={isBusy || state.replayStatus !== "RUNNING"}><Pause size={15} /> Pause</button>
          <button onClick={() => resume.mutate()} disabled={isBusy || !["READY", "PAUSED"].includes(state.replayStatus)}><Play size={15} /> Resume</button>
          <button onClick={() => reset.mutate()} disabled={isBusy}><RotateCcw size={15} /> Reset</button>
          <button onClick={() => step.mutate()} disabled={isBusy || state.replayStatus === "COMPLETE"}><StepForward size={15} /> Step</button>
          {[1, 5, 20, 60].map((value) => <button className="speed" key={value} onClick={() => speed.mutate(value)} disabled={isBusy}>{value}x</button>)}
          <button aria-label="Inject information shock" onClick={() => shock.mutate()} disabled={isBusy}><Zap size={15} /> Shock</button>
        </div> : <p>Live read-only TxLINE feed. Replay controls are disabled.</p>}
      </section>

      <main className="grid">
        <Panel title="Market Board" wide>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Market</th><th>Selection</th><th>Consensus</th><th>Filtered</th><th>Uncertainty</th><th>Innovation Z</th><th>Bid</th><th>Ask</th><th>Width</th><th>Inventory lean</th><th>Size</th><th>Status</th></tr></thead>
              <tbody>{state.marketRows.map((row) => (
                <tr key={`${row.marketId}-${row.selectionId}`}>
                  <td>{row.market}</td><td>{row.selection}</td><td>{fmtPct(row.marketProbability)}</td><td><Badge label={fmtPct(row.filteredConsensus ?? row.theoProbability)} source={row.provenance.source} /></td>
                  <td>{fmtNum(row.uncertainty)}</td><td>{fmtNum(row.standardizedInnovation)}</td><td>{fmtNum(row.bid)}</td><td>{fmtNum(row.ask)}</td><td>{fmtNum(row.width)}</td>
                  <td>{row.inventoryLean.toFixed(3)}</td><td>{fmtNum(row.bidSize)} / {fmtNum(row.askSize)}</td><td title={row.reasonCodes.join(", ")}>{row.status}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Price Chart" wide>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={state.chart}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" /><YAxis domain={[0, 1]} /><Tooltip /><Legend />
              <Line type="monotone" dataKey="marketProbability" stroke="#2563eb" dot={false} />
              <Line name="Filtered consensus" type="monotone" dataKey="theoProbability" stroke="#0f766e" dot={false} />
              <Line type="monotone" dataKey="bid" stroke="#64748b" dot={false} />
              <Line type="monotone" dataKey="ask" stroke="#b45309" dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="markers">{state.chart.filter((point) => point.eventType).slice(-8).map((point) => <span key={`${point.index}-${point.eventType}`}>{point.eventType} #{point.index}</span>)}</div>
        </Panel>

        <Panel title="Positions">
          {state.positions.length === 0 ? <Empty text="No current inventory. Maker fills appear only after a later observation crosses an active quote." /> : state.positions.map((position) => (
            <div className="metric-row" key={`${position.marketId}-${position.selectionId}`}>
              <span>{position.selectionId}</span><strong>{position.quantity.toFixed(1)} @ {fmtNum(position.averageEntryPrice)}</strong><em>UPL {fmtMoney(position.unrealizedPnl ?? 0)}</em>
            </div>
          ))}
        </Panel>

        <Panel title="Risk Sheet">
          <Metric label="Cash" value={state.cash === undefined ? "-" : `$${state.cash.toFixed(2)}`} />
          <Metric label="Fees" value={state.feesPaid === undefined ? "-" : `$${state.feesPaid.toFixed(2)}`} />
          <Metric label="Worst terminal" value={fmtMoney(state.risk.worstCaseTerminalPnl)} />
          <Metric label="Best terminal" value={fmtMoney(state.risk.bestCaseTerminalPnl)} />
          <Metric label="Current drawdown" value={fmtMoney(-state.risk.currentDrawdown)} />
          <Metric label="Risk utilization" value={`${(state.risk.riskBudgetUtilization * 100).toFixed(1)}%`} />
          <Metric label="Fixture / market exposure" value={`${state.risk.fixtureExposure.toFixed(2)} / ${state.risk.marketExposure.toFixed(2)}`} />
          <div className="scenario-list">{state.risk.scenarios.map((scenario) => <div key={scenario.scenario}><span>{scenario.scenario}</span><strong>{fmtMoney(scenario.pnl)}</strong></div>)}</div>
        </Panel>

        <Panel title="Performance">
          <Metric label="Net P&L" value={fmtMoney(state.performance.netPnl)} />
          <Metric label="Gross P&L" value={fmtMoney(state.performance.grossPnl)} />
          <Metric label="Sharpe" value={state.performance.sharpeRatio === null ? "Too few samples" : state.performance.sharpeRatio.toFixed(2)} />
          <Metric label="Fill rate" value={`${(state.performance.fillRate * 100).toFixed(1)}%`} />
          <Metric label="Maker P&L" value={fmtMoney(state.performance.makerPnl)} />
          <Metric label="Directional P&L" value={`${fmtMoney(state.performance.takerPnl)} (disabled)`} />
        </Panel>

        <Panel title="Maker Fill History">
          {(state.makerFills ?? []).length === 0 ? <Empty text="Zero fills: no eligible future observation has crossed a resting quote." /> : (state.makerFills ?? []).slice(-10).reverse().map((fill) => (
            <div className="metric-row" key={fill.fillId}><span>{fill.side} {fill.selectionId}</span><strong>{fill.size.toFixed(2)} @ {fill.price.toFixed(3)}</strong><em>{fill.filledAt}</em></div>
          ))}
        </Panel>

        <Panel title="Audit Trail" wide>
          <div className="audit-list">{state.audit.slice(-18).reverse().map((event) => (
            <article key={event.auditId}>
              <strong>#{event.replayIndex} {event.finalAction}</strong>
              <span>{event.marketObservation} | Filtered {fmtNum(event.theo)} | Edge {fmtNum(event.edge)} (locked null) | Width {fmtNum(event.width)}</span>
              <em>{event.riskChecks.join(", ")} | {event.reasonCodes.join(", ")}</em>
            </article>
          ))}</div>
        </Panel>
      </main>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell">{children}<footer>Build {import.meta.env.VITE_APP_VERSION ?? "0.1.0"} · MARKET CONSENSUS BASELINE · SHADOW EXECUTION · NOT PROVEN ALPHA</footer></div>;
}
function Spotlight({ icon, label, value, detail, tone = "" }: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: "" | "live" | "safe" }) {
  return <article className={`spotlight ${tone}`}><div className="spotlight-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}
function Snapshot({ icon, label, value, detail, badge, tone = "" }: { icon: React.ReactNode; label: string; value: string; detail: string; badge?: string; tone?: "" | "positive" | "negative" }) {
  return <article className={`snapshot ${tone}`}><div className="snapshot-heading">{icon}<span>{label}</span>{badge && <em>{badge}</em>}</div><strong>{value}</strong><small>{detail}</small></article>;
}
function Panel({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) { return <section className={wide ? "panel wide" : "panel"}><h2>{title}</h2>{children}</section>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function Badge({ label, source }: { label: string; source: string }) { return <span className="badge"><b>{source}</b>{label}</span>; }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p>; }
function StateMessage({ title, detail, tone }: { title: string; detail: string; tone?: "danger" }) { return <div className={`state-message ${tone ?? ""}`}><h1>{title}</h1><p>{detail}</p></div>; }
