import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BadgeCheck, BookOpen, Gauge, Pause, Play, Radio, RotateCcw, Shield, ShieldCheck, StepForward, Zap } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DemoState } from "../../../packages/contracts/src/index.js";
import { demoApi } from "./lib/api/client.js";

const fmtPct = (value: number | null | undefined) => value == null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const fmtMoney = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
const fmtNum = (value: number | null | undefined) => value == null ? "-" : value.toFixed(3);

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
  const agentQuery = useQuery({ queryKey: ["agent-status"], queryFn: demoApi.agentStatus, refetchInterval: 1_000, retry: false });
  const decisionsQuery = useQuery({ queryKey: ["decision-book"], queryFn: demoApi.decisionBook, refetchInterval: 1_000, retry: false });
  const fixtureQuery = useQuery({ queryKey: ["current-fixture"], queryFn: demoApi.currentFixture, retry: false });
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
  const kellyLocked = tradingQuery.data?.kellyEnabled === false;
  const isBusy = start.isPending || pause.isPending || resume.isPending || reset.isPending || step.isPending || shock.isPending || speed.isPending || selectReplay.isPending;
  const makerRow = state.marketRows.find((row) => row.status === "LIVE" && row.bid !== null && row.ask !== null) ?? state.marketRows[0];
  const makerAgent = agentQuery.data?.maker;
  const foragerAgent = agentQuery.data?.hawk;
  const sharedRisk = agentQuery.data?.sharedRisk;
  const decisions = decisionsQuery.data?.decisions ?? [];
  const makerAction = makerAgent?.latestAction ?? state.audit.at(-1)?.finalAction ?? "WAITING_FOR_MARKET";
  const makerState = makerAgent?.state ?? tradingQuery.data?.maker ?? (makerRow?.status === "LIVE" ? "PAPER_ENABLED" : "WAITING");
  const freshnessState = state.dataFreshnessMs == null ? "NO DATA" : state.dataFreshnessMs > 5_000 ? "STALE" : "FRESH";
  const foragerReason = foragerAgent?.reasonCodes[0] ?? "AWAITING_SIGNAL";
  const fixtureParticipants = fixtureQuery.data
    ? [fixtureQuery.data.fixture.participant1, fixtureQuery.data.fixture.participant2].sort((left, right) => left.localeCompare(right)).join("–")
    : "Awaiting fixture data";

  return (
    <Shell>
      <header className="status-bar">
        <div className="product-lockup">
          <div className="orchid-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="overline">ORCHID HIVE · MARKET INTELLIGENCE</p>
            <strong>World Cup Market Maker</strong>
          </div>
          <span className={`connection-dot ${backendStatus === "CONNECTED" ? "connected" : ""}`}>{backendStatus}</span>
        </div>
        <Status icon={<Radio size={16} />} label="TxLINE status" value={state.dataMode === "replay" ? "OFF · REPLAY ACTIVE" : txoddsStatus} />
        <Status icon={<Activity size={16} />} label={state.dataMode === "replay" ? "Replay status" : "Live status"} value={state.dataMode === "replay" ? `${state.replayStatus} @ ${state.speed}x` : txoddsStatus} />
        <Status icon={<BadgeCheck size={16} />} label="Agent running" value={state.strategyStatus} />
        <Status icon={<ShieldCheck size={16} />} label="Execution" value="SHADOW ONLY" />
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">AUTONOMOUS TWO-SIDED MARKET INTELLIGENCE</p>
          <h1>World Cup market-consensus market maker</h1>
          <p>A controlled hive of market-making, movement-signal, and portfolio-risk agents. {state.disclaimer}</p>
        </div>
        {state.dataMode === "replay" ? <div className="controls">
          <label>Replay source
            <select value={replaysQuery.data?.selected ?? "built-in"} onChange={(event) => selectReplay.mutate(event.target.value)} disabled={isBusy}>
              {(replaysQuery.data?.options ?? [{ id: "built-in", label: "Built-in deterministic fallback", available: true }]).map((option) => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : " (unavailable)"}</option>)}
            </select>
          </label>
          <button className="primary" onClick={() => start.mutate()} disabled={isBusy}><Play size={16} /> Run Full Demo</button>
          <button onClick={() => pause.mutate()} disabled={isBusy || state.replayStatus !== "RUNNING"}><Pause size={16} /> Pause</button>
          <button onClick={() => resume.mutate()} disabled={isBusy || !["READY", "PAUSED"].includes(state.replayStatus)}><Play size={16} /> Resume</button>
          <button onClick={() => reset.mutate()} disabled={isBusy}><RotateCcw size={16} /> Reset</button>
          <button onClick={() => step.mutate()} disabled={isBusy || state.replayStatus === "COMPLETE"}><StepForward size={16} /> Step</button>
          {[1, 5, 20, 60].map((value) => <button key={value} onClick={() => speed.mutate(value)} disabled={isBusy}>{value}x</button>)}
          <button onClick={() => shock.mutate()} disabled={isBusy}><Zap size={16} /> Inject information shock</button>
        </div> : <div className="controls"><span>Live read-only TxODDS feed; replay controls are disabled.</span></div>}
      </section>
      <div className="safety-badges">
        <strong className="live-badge">{state.dataMode === "txline" ? "LIVE TXLINE INPUT" : "REPLAY INPUT"}</strong>
        <strong>PAPER MARKET MAKING</strong>
        <strong>AUTONOMOUS AGENT</strong>
        <strong>SHADOW EXECUTION</strong>
        <strong className="danger-badge">REAL FUNDS DISABLED</strong>
        <strong className="warning-badge">NOT PROVEN ALPHA</strong>
        <span className={kellyLocked ? "locked" : ""} title={tradingQuery.data?.reasonCodes.join(", ")}>KELLY LOCKED · INDEPENDENT THEO REQUIRED</span>
      </div>

      <section className="agent-grid" aria-label="Agent status">
        <article className="agent-card maker-agent">
          <div className="agent-card-heading">
            <div>
              <p className="agent-kicker">MARKET CONSENSUS · PAPER EXECUTION</p>
              <h2 className="legacy-heading">Maker Agent</h2>
              <h2 aria-hidden="true">Maker Bee</h2>
              <p className="agent-description">Autonomous two-sided market-making agent</p>
            </div>
            <span className="agent-state success">{makerState}</span>
          </div>
          <p className="agent-fixture">{fixtureParticipants} · {fixtureQuery.data?.resultStatus ?? "STATUS PENDING"}</p>
          <dl className="agent-metrics">
            <div><dt>Latest action</dt><dd>{makerAction}</dd></div>
            <div><dt>Bid / Ask</dt><dd>{fmtNum(makerAgent?.bid)} / {fmtNum(makerAgent?.ask)}</dd></div>
            <div><dt>Width</dt><dd>{fmtNum(makerAgent?.width)}</dd></div>
            <div><dt>Size</dt><dd>{fmtNum(makerAgent?.size)}</dd></div>
            <div><dt>Inventory lean</dt><dd>{fmtNum(makerAgent?.inventoryLean)}</dd></div>
            <div><dt>Quote-risk score</dt><dd>{fmtNum(makerAgent?.quoteGuardRiskScore)}</dd></div>
          </dl>
        </article>

        <article className="agent-card forager-agent">
          <div className="agent-card-heading">
            <div>
              <p className="agent-kicker">MOVEMENT SIGNAL · SHADOW ONLY</p>
              <h2>Forager Bee</h2>
              <p className="agent-description">Relative-value and movement-signal agent</p>
            </div>
            <span className="agent-state warning">{foragerAgent?.state ?? "STANDBY"}</span>
          </div>
          <p className="agent-fixture">{fixtureParticipants} · HEURISTIC SIGNAL · NOT PROVEN ALPHA</p>
          <dl className="agent-metrics">
            <div><dt>Latest signal</dt><dd>{foragerAgent?.signalType ?? "NONE"}</dd></div>
            <div><dt>Shadow action</dt><dd>{foragerAgent?.latestAction ?? "NO_TRADE"}</dd></div>
            <div><dt>Signal confidence</dt><dd>{foragerAgent ? fmtPct(foragerAgent.signalConfidence) : "PENDING"}</dd></div>
            <div><dt>Paper position</dt><dd>{fmtNum(foragerAgent?.paperPosition)}</dd></div>
            <div className="metric-span"><dt>Abstention reason</dt><dd>{foragerReason}</dd></div>
          </dl>
        </article>

        <article className="agent-card risk-agent">
          <div className="agent-card-heading">
            <div>
              <p className="agent-kicker">SHARED PORTFOLIO CONTROLS</p>
              <h2>Hive Risk Engine</h2>
              <p className="agent-description">Shared inventory, latency, and portfolio controls</p>
            </div>
            <span className={`agent-state ${state.killSwitch ? "danger" : "success"}`}>{state.killSwitch ? "HALTED" : "ARMED"}</span>
          </div>
          <dl className="agent-metrics risk-metrics">
            <div><dt>Worst-case loss</dt><dd>{fmtMoney(state.risk.worstCaseTerminalPnl)}</dd></div>
            <div><dt>Gross exposure</dt><dd>{fmtNum(sharedRisk?.grossExposure)}</dd></div>
            <div><dt>Drawdown</dt><dd>{fmtMoney(-state.risk.currentDrawdown)}</dd></div>
            <div><dt>Remaining capacity</dt><dd>{fmtNum(sharedRisk?.remainingCapacity)}</dd></div>
            <div><dt>Staleness state</dt><dd>{freshnessState}</dd></div>
            <div><dt>Kill switch</dt><dd>{state.killSwitch ? "ENABLED" : "OFF"}</dd></div>
          </dl>
        </article>
      </section>

      <main className="grid">
        <Panel title="Market & Quote Monitor" className="market-chart-panel" icon={<Activity size={17} />}>
          <div className="panel-heading-copy">
            <span>{state.dataMode === "txline" ? "LIVE" : "REPLAY"} CONSENSUS · FILTERED FAIR VALUE · TWO-SIDED QUOTES</span>
            <strong>{makerRow?.market ?? "Awaiting market"}</strong>
          </div>
          <div className="chart-layout">
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={state.chart} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="#7A3E9D" strokeOpacity={0.15} strokeDasharray="3 5" vertical={false} />
                  <XAxis dataKey="label" stroke="#8f769b" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis domain={[0, 1]} stroke="#8f769b" tickLine={false} axisLine={false} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#2D183A", border: "1px solid #B65FCF", borderRadius: 8, color: "#F5EEFA" }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#6B5475" }} />
                  <Line name="Market" type="monotone" dataKey="marketProbability" stroke="#B65FCF" strokeWidth={2.2} dot={false} />
                  <Line name="Filtered consensus" type="monotone" dataKey="theoProbability" stroke="#7A3E9D" strokeWidth={2} dot={false} />
                  <Line name="Bid" type="monotone" dataKey="bid" stroke="#4FAE80" strokeWidth={1.5} dot={false} />
                  <Line name="Ask" type="monotone" dataKey="ask" stroke="#D89A3D" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <aside className="quote-snapshot" aria-label="Latest quote">
              <div className="quote-pair">
                <div><span>Bid</span><strong>{fmtNum(makerRow?.bid)}</strong></div>
                <div><span>Ask</span><strong>{fmtNum(makerRow?.ask)}</strong></div>
              </div>
              <Metric label="Width" value={fmtNum(makerRow?.width)} />
              <Metric label="Size" value={`${fmtNum(makerRow?.bidSize)} / ${fmtNum(makerRow?.askSize)}`} />
              <Metric label="Inventory lean" value={fmtNum(makerRow?.inventoryLean)} />
              <Metric label="Quote-risk score" value={fmtNum(makerAgent?.quoteGuardRiskScore)} />
              <div className="latest-action"><span>Latest action</span><strong>{makerAction}</strong></div>
              <div className="guard-label"><Gauge size={15} /><span><b>Adaptive Quote Guard</b>Replay-trained market-risk model</span><em>{agentQuery.data?.quoteGuard.status ?? "PENDING"}</em></div>
            </aside>
          </div>
          <div className="markers">{state.chart.filter((point) => point.eventType).slice(-8).map((point) => <span key={`${point.index}-${point.eventType}`}>{point.eventType} #{point.index}</span>)}</div>
        </Panel>

        <Panel title="Market Board" wide className="market-board-panel">
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

        <Panel title="Positions" eyebrow="Positions & P&L">
          {state.positions.length === 0 ? <Empty text="No current inventory. Maker fills appear only after a later observation crosses an active quote." /> : state.positions.map((position) => (
            <div className="metric-row" key={`${position.marketId}-${position.selectionId}`}>
              <span>{position.selectionId}</span><strong>{position.quantity.toFixed(1)} @ {fmtNum(position.averageEntryPrice)}</strong><em>UPL {fmtMoney(position.unrealizedPnl ?? 0)}</em>
            </div>
          ))}
          <div className="position-summary">
            <Metric label="Net P&L" value={fmtMoney(state.performance.netPnl)} />
            <Metric label="Cash" value={state.cash === undefined ? "-" : `$${state.cash.toFixed(2)}`} />
          </div>
        </Panel>

        <Panel title="Risk Sheet" eyebrow="Scenario risk" icon={<Shield size={17} />}>
          <Metric label="Cash" value={state.cash === undefined ? "-" : `$${state.cash.toFixed(2)}`} />
          <Metric label="Fees" value={state.feesPaid === undefined ? "-" : `$${state.feesPaid.toFixed(2)}`} />
          <Metric label="Worst terminal" value={fmtMoney(state.risk.worstCaseTerminalPnl)} />
          <Metric label="Best terminal" value={fmtMoney(state.risk.bestCaseTerminalPnl)} />
          <Metric label="Current drawdown" value={fmtMoney(-state.risk.currentDrawdown)} />
          <Metric label="Risk utilization" value={`${(state.risk.riskBudgetUtilization * 100).toFixed(1)}%`} />
          <Metric label="Fixture / market exposure" value={`${state.risk.fixtureExposure.toFixed(2)} / ${state.risk.marketExposure.toFixed(2)}`} />
          <div className="scenario-list">{state.risk.scenarios.map((scenario) => <div key={scenario.scenario}><span>{scenario.scenario}</span><strong>{fmtMoney(scenario.pnl)}</strong></div>)}</div>
        </Panel>

        <Panel title="Performance" eyebrow="Portfolio telemetry">
          <Metric label="Net P&L" value={fmtMoney(state.performance.netPnl)} />
          <Metric label="Gross P&L" value={fmtMoney(state.performance.grossPnl)} />
          <Metric label="Sharpe" value={state.performance.sharpeRatio === null ? "Too few samples" : state.performance.sharpeRatio.toFixed(2)} />
          <Metric label="Fill rate" value={`${(state.performance.fillRate * 100).toFixed(1)}%`} />
          <Metric label="Maker P&L" value={fmtMoney(state.performance.makerPnl)} />
          <Metric label="Directional P&L" value={`${fmtMoney(state.performance.takerPnl)} (disabled)`} />
        </Panel>

        <Panel title="Maker Fill History" eyebrow="Simulated fills">
          {(state.makerFills ?? []).length === 0 ? <Empty text="Zero fills: no eligible future observation has crossed a resting quote." /> : (state.makerFills ?? []).slice(-10).reverse().map((fill) => (
            <div className="metric-row" key={fill.fillId}><span>{fill.side} {fill.selectionId}</span><strong>{fill.size.toFixed(2)} @ {fill.price.toFixed(3)}</strong><em>{fill.filledAt}</em></div>
          ))}
        </Panel>

        <Panel title="Hive Decision Book" wide icon={<BookOpen size={17} />}>
          <p className="panel-description">Shadow-execution decisions and simulated fills</p>
          <div className="decision-list">
            {decisions.length === 0 ? <Empty text="Decision rows will appear as agent observations arrive." /> : decisions.slice(-12).reverse().map((decision) => (
              <article className="decision-row" key={decision.decisionId}>
                <div className="decision-primary">
                  <time>{new Date(decision.decisionTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <strong>{decision.strategy === "maker" ? "Maker Bee" : "Forager Bee"}</strong>
                  <span className="action-pill">{decision.action}</span>
                  <span>{decision.decisionId}</span>
                </div>
                <dl>
                  <div><dt>Proposed price</dt><dd>{fmtNum(decision.proposedPrice)}</dd></div>
                  <div><dt>Simulated fill</dt><dd>{fmtNum(decision.fillPrice)}</dd></div>
                  <div><dt>Size</dt><dd>{fmtNum(decision.proposedSize)}</dd></div>
                  <div><dt>Status</dt><dd>{decision.status}</dd></div>
                  <div><dt>Reason code</dt><dd>{decision.reasonCodes[0] ?? "NONE"}</dd></div>
                  <div><dt>P&amp;L</dt><dd>{fmtMoney(decision.realizedPnl + decision.unrealizedPnl)}</dd></div>
                </dl>
                <span className="verified-badge"><BadgeCheck size={13} /> NO-LOOKAHEAD {decision.noLookaheadVerificationStatus}</span>
              </article>
            ))}
          </div>
        </Panel>

        <Panel title="Audit Trail" wide eyebrow="Immutable event log">
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
  return <div className="app-shell">{children}<footer>Build {import.meta.env.VITE_APP_VERSION ?? "0.1.0"} | MARKET CONSENSUS BASELINE · NOT PROVEN ALPHA · PAPER ONLY</footer></div>;
}
function Status({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="status-item">{icon}<span>{label}</span><strong>{value}</strong></div>; }
function Panel({ title, children, wide = false, className = "", eyebrow, icon }: { title: string; children: React.ReactNode; wide?: boolean; className?: string; eyebrow?: string; icon?: React.ReactNode }) {
  return <section className={`panel${wide ? " wide" : ""}${className ? ` ${className}` : ""}`}>
    <h2 className="legacy-heading">{title}</h2>
    <div className="panel-title" aria-hidden="true">{icon}<div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2></div></div>
    {children}
  </section>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function Badge({ label, source }: { label: string; source: string }) { return <span className="badge"><b>{source}</b>{label}</span>; }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p>; }
function StateMessage({ title, detail, tone }: { title: string; detail: string; tone?: "danger" }) { return <div className={`state-message ${tone ?? ""}`}><h1>{title}</h1><p>{detail}</p></div>; }
