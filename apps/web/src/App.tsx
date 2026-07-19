import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, BadgeCheck, Pause, Play, RotateCcw, Shield, StepForward, Zap } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DemoState } from "../../../packages/contracts/src/index";
import { demoApi } from "./lib/api/client";

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

  if (stateQuery.isLoading) return <Shell><StateMessage title="Loading demo" detail="Connecting to the replay backend." /></Shell>;
  if (stateQuery.isError) return <Shell><StateMessage title="Backend disconnected" detail={stateQuery.error.message} tone="danger" /></Shell>;
  const state = stateQuery.data!;

  return (
    <Shell>
      <header className="status-bar">
        <Status icon={<BadgeCheck size={17} />} label="Data mode" value={state.dataMode.toUpperCase()} />
        <Status icon={<Activity size={17} />} label="Data source" value={state.dataSource} />
        <Status icon={<Shield size={17} />} label="Backend" value={state.backendStatus} />
        <Status icon={<Play size={17} />} label={state.dataMode === "replay" ? "Replay" : "Live paper"} value={state.dataMode === "replay" ? `${state.replayStatus} @ ${state.speed}x` : state.strategyStatus} />
        <Status icon={<Zap size={17} />} label="Pricing" value={state.theoProvider} />
        <Status icon={<AlertTriangle size={17} />} label="Kill switch" value={state.killSwitch ? "Enabled" : "Off"} />
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">PAPER MARKET MAKING · NO REAL EXECUTION</p>
          <h1>World Cup market-consensus market maker</h1>
          <p>{state.disclaimer}</p>
        </div>
        {state.dataMode === "replay" ? <div className="controls">
          <button className="primary" onClick={() => start.mutate()}><Play size={16} /> Run Full Demo</button>
          <button onClick={() => pause.mutate()}><Pause size={16} /> Pause</button>
          <button onClick={() => resume.mutate()}><Play size={16} /> Resume</button>
          <button onClick={() => reset.mutate()}><RotateCcw size={16} /> Reset</button>
          <button onClick={() => step.mutate()}><StepForward size={16} /> Step</button>
          {[1, 5, 20, 60].map((value) => <button key={value} onClick={() => speed.mutate(value)}>{value}x</button>)}
          <button onClick={() => shock.mutate()}><Zap size={16} /> Inject information shock</button>
        </div> : <div className="controls"><span>Live read-only TxODDS feed; replay controls are disabled.</span></div>}
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
  return <div className="app-shell">{children}<footer>Build {import.meta.env.VITE_APP_VERSION ?? "0.1.0"} | MARKET CONSENSUS BASELINE · NOT PROVEN ALPHA · PAPER ONLY</footer></div>;
}
function Status({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="status-item">{icon}<span>{label}</span><strong>{value}</strong></div>; }
function Panel({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) { return <section className={wide ? "panel wide" : "panel"}><h2>{title}</h2>{children}</section>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function Badge({ label, source }: { label: string; source: string }) { return <span className="badge"><b>{source}</b>{label}</span>; }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p>; }
function StateMessage({ title, detail, tone }: { title: string; detail: string; tone?: "danger" }) { return <div className={`state-message ${tone ?? ""}`}><h1>{title}</h1><p>{detail}</p></div>; }
