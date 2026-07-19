import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  Clock3,
  Database,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Shield,
  StepForward,
  Zap,
} from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DemoState } from "../../../packages/contracts/src/index";
import { demoApi } from "./lib/api/client";

const fmtPct = (value: number | null) => value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const fmtMoney = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
const fmtNum = (value: number | null) => value === null ? "—" : value.toFixed(3);
const fmtTime = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Unavailable";

export function App() {
  const queryClient = useQueryClient();
  const stateQuery = useQuery({
    queryKey: ["demo-state"],
    queryFn: demoApi.state,
    refetchInterval: 800,
    retry: 1,
  });
  const replaysQuery = useQuery({ queryKey: ["demo-replays"], queryFn: demoApi.replays, retry: 1 });
  const healthQuery = useQuery({ queryKey: ["system-health"], queryFn: demoApi.health, refetchInterval: 5_000, retry: false });
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
  if (stateQuery.isError) return <Shell><StateMessage title="Backend disconnected" detail={`${stateQuery.error.message}. Start the API, then refresh this page.`} tone="danger" /></Shell>;
  const state = stateQuery.data!;
  const fixture = state.marketRows[0]?.fixture ?? "Unavailable from demo API";
  const isLive = state.dataSource === "TXODDS_LIVE" || state.dataMode === "txline";
  const isRecorded = state.dataSource === "RECORDED_TXODDS";
  const modeLabel = isLive ? "LIVE TXODDS" : isRecorded ? "RECORDED TXODDS REPLAY" : "DETERMINISTIC REPLAY";
  const realizedPnl = state.positions.reduce((total, position) => total + position.realizedPnl, 0);
  const unrealizedPnl = state.positions.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0);
  const liability = Math.max(0, -state.risk.worstCaseTerminalPnl);
  const progress = Math.min(100, (state.currentIndex / Math.max(1, state.totalEvents)) * 100);
  const latestAudit = state.audit.at(-1);
  const txoddsStatus = healthQuery.data?.dataStatus.status ?? (healthQuery.isError ? "UNAVAILABLE" : "CHECKING");
  const recordingStatus = isLive ? "Unavailable from API" : isRecorded ? "Stopped · capture loaded" : "Stopped · replay mode";
  const isBusy = start.isPending || pause.isPending || resume.isPending || reset.isPending || step.isPending || shock.isPending || speed.isPending;

  return (
    <Shell>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">World Cup Quantitative Trading Demo · Control room</p>
          <h1>Latency-aware paper market maker</h1>
          <p>TxODDS market consensus is filtered, quoted, inventory-adjusted and risk-gated in a deterministic, auditable demo.</p>
        </div>
        <div className="hero-mode">
          <span>Operating mode</span>
          <strong>{modeLabel}</strong>
          <small>{fixture}</small>
        </div>
      </section>

      <div className="safety-badges" aria-label="Demo safety statements">
        <strong>PAPER MARKET MAKING</strong>
        <strong>TXODDS MARKET CONSENSUS</strong>
        <strong>NOT PROPRIETARY ALPHA</strong>
        <strong>DIRECTIONAL TRADING DISABLED</strong>
        <strong>REAL EXECUTION DISABLED</strong>
      </div>

      <header className="status-bar">
        <Status icon={<Database size={16} />} label="Data mode" value={modeLabel} tone={isLive ? "live" : "neutral"} />
        <Status icon={<BadgeCheck size={16} />} label="Backend" value="CONNECTED" tone="good" />
        <Status icon={<Radio size={16} />} label="TxODDS adapter" value={txoddsStatus} tone={txoddsStatus === "CONNECTED" ? "good" : "warn"} />
        <Status icon={<Activity size={16} />} label="Recording" value={recordingStatus} />
        <Status icon={<Play size={16} />} label="Replay" value={`${state.replayStatus} · ${state.speed}x`} tone={state.replayStatus === "RUNNING" ? "good" : "neutral"} />
        <Status icon={<AlertTriangle size={16} />} label="Kill switch" value={state.killSwitch ? "ENGAGED" : "ARMED · OFF"} tone={state.killSwitch ? "danger" : "good"} />
      </header>

      <section className="demo-console">
        <div className="control-lead">
          <span className="section-kicker">Replay control</span>
          <strong>{state.currentIndex} / {state.totalEvents} events</strong>
          <div className="progress-track" aria-label={`Replay ${progress.toFixed(0)} percent complete`}><span style={{ width: `${progress}%` }} /></div>
        </div>
        <div className="controls">
          <label className="replay-select">
            <span>Source</span>
            <select
              value={replaysQuery.data?.selected ?? "built-in"}
              onChange={(event) => selectReplay.mutate(event.target.value)}
              aria-label="Replay source"
              disabled={isBusy}
            >
              {(replaysQuery.data?.options ?? [{ id: "built-in", label: "Built-in deterministic replay", available: true }]).map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : " (unavailable)"}</option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => start.mutate()} disabled={isBusy}><Play size={16} /><span className="button-copy"><strong>Run Full Demo</strong><small>Start from reset</small></span></button>
          <button onClick={() => pause.mutate()} disabled={isBusy || state.replayStatus !== "RUNNING"}><Pause size={15} /> Pause</button>
          <button onClick={() => resume.mutate()} disabled={isBusy || !["READY", "PAUSED"].includes(state.replayStatus)}><Play size={15} /> Resume</button>
          <button onClick={() => step.mutate()} disabled={isBusy || state.replayStatus === "COMPLETE"}><StepForward size={15} /> Step</button>
          <button onClick={() => reset.mutate()} disabled={isBusy}><RotateCcw size={15} /> Reset</button>
          <label className="speed-select">
            <span>Speed</span>
            <select value={state.speed} onChange={(event) => speed.mutate(Number(event.target.value))} aria-label="Replay speed" disabled={isBusy}>
              {[1, 5, 20, 60].map((value) => <option value={value} key={value}>{value}x</option>)}
            </select>
          </label>
          <button className="shock" onClick={() => shock.mutate()} disabled={isBusy}><Zap size={15} /> Inject information shock</button>
        </div>
      </section>

      <main className="grid">
        <Panel title="Market Board · Quotes" subtitle="Consensus probabilities and paper quotes" wide>
          <div className="table-wrap market-table">
            <table>
              <thead><tr><th>Market</th><th>Selection</th><th>Market consensus</th><th>Filtered consensus</th><th>Bid</th><th>Ask</th><th>Width</th><th>Inventory lean</th><th>Bid / ask size</th><th>Status</th></tr></thead>
              <tbody>{state.marketRows.map((row) => (
                <tr key={`${row.marketId}-${row.selectionId}`} className={row.status === "QUOTE_SUSPENDED" ? "suspended-row" : ""}>
                  <td><strong>{row.market}</strong><small>{row.fixture}</small></td>
                  <td>{row.selection}</td>
                  <td>{fmtPct(row.marketProbability)}</td>
                  <td><span className="consensus-value">{fmtPct(row.theoProbability)}</span><small>{provenanceLabel(row.provenance.source)}</small></td>
                  <td className="quote-value">{fmtNum(row.bid)}</td>
                  <td className="quote-value">{fmtNum(row.ask)}</td>
                  <td>{fmtNum(row.width)}</td>
                  <td className={Math.abs(row.inventoryLean) > 0 ? "lean-active" : ""}>{row.inventoryLean.toFixed(3)}</td>
                  <td>{fmtNum(row.bidSize)} / {fmtNum(row.askSize)}</td>
                  <td><StateBadge value={row.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Demo event sequence" subtitle="Observed replay behavior" wide>
          <div className="event-sequence">
            <ReplayStage label="Normal quoting" detail="Consensus-centred bid/ask" done={state.audit.length > 0} active={state.marketRows.some((row) => row.status === "LIVE")} />
            <ReplayStage label="Volatility widening" detail="Uncertainty expands width" done={hasEvent(state, ["SHARP_MOVEMENT", "GOAL", "INFO_SHOCK"])} />
            <ReplayStage label="Inventory lean" detail="Quotes move against inventory" done={state.marketRows.some((row) => Math.abs(row.inventoryLean) > 0)} />
            <ReplayStage label="Quote suspension" detail="Replay safety event" done={hasEvent(state, ["QUOTE_SUSPENSION"])} active={state.marketRows.some((row) => row.status === "QUOTE_SUSPENDED")} />
            <ReplayStage label="Controlled resumption" detail="Quoting after repricing" done={hasEvent(state, ["QUOTE_RESUMPTION"])} />
            <ReplayStage label="Future-event fill" detail="Paper-only fill assumption" done={state.audit.some((event) => event.fillResult === "FILLED_PAPER")} />
            <ReplayStage label="Risk / P&L update" detail="Portfolio marked after fill" done={state.positions.length > 0} />
          </div>
        </Panel>

        <Panel title="Consensus & quote path" subtitle="Probability scale · latest 120 events" span={2}>
          {state.chart.length === 0 ? <Empty text="Start or step the replay to draw the quote path." /> : (
            <ResponsiveContainer width="100%" height={238}>
              <LineChart data={state.chart} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis domain={[0, 1]} tick={{ fontSize: 11 }} /><Tooltip /><Legend />
                <Line name="Market consensus" type="monotone" dataKey="marketProbability" stroke="#2563eb" dot={false} strokeWidth={2} />
                <Line name="Filtered consensus" type="monotone" dataKey="theoProbability" stroke="#0f766e" dot={false} strokeWidth={2} />
                <Line name="Bid" type="monotone" dataKey="bid" stroke="#64748b" dot={false} />
                <Line name="Ask" type="monotone" dataKey="ask" stroke="#b45309" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
          <div className="event-markers">{state.chart.filter((point) => point.eventType).slice(-6).map((point) => <span key={`${point.index}-${point.eventType}`}>{friendlyEvent(point.eventType!)} · #{point.index}</span>)}</div>
        </Panel>

        <Panel title="Live data status" subtitle={isLive ? "Current TxODDS feed" : "Live fields remain separate from replay"}>
          <Metric label="Connection" value={txoddsStatus} />
          <Metric label="Fixture" value={fixture} compact />
          <Metric label="Latest source timestamp" value="Unavailable from API" muted />
          <Metric label="Latest receive timestamp" value={fmtTime(state.lastMarketUpdate)} />
          <Metric label="Data age" value={state.dataFreshnessMs === null ? "Unavailable" : `${state.dataFreshnessMs} ms`} />
          <Metric label="Events received" value={String(state.currentIndex)} />
          <Metric label="Recording" value={recordingStatus} compact />
        </Panel>

        <Panel title="Portfolio & P&L" subtitle="Paper ledger">
          <div className="metric-grid">
            <Metric label="Position" value={state.positions.length ? `${state.positions.reduce((sum, item) => sum + Math.abs(item.quantity), 0).toFixed(1)} gross` : "Flat"} />
            <Metric label="Cash" value="Unavailable from demo API" muted compact />
            <Metric label="Realized P&L" value={fmtMoney(realizedPnl)} />
            <Metric label="Unrealized P&L" value={fmtMoney(unrealizedPnl)} />
            <Metric label="Net P&L" value={fmtMoney(state.performance.netPnl)} />
            <Metric label="Worst-case liability" value={`$${liability.toFixed(2)}`} />
          </div>
          <div className="position-list">
            {state.positions.length === 0 ? <Empty text="No paper fills yet." /> : state.positions.slice(0, 4).map((position) => (
              <div className="position-row" key={`${position.marketId}-${position.selectionId}`}>
                <span>{position.selectionId}</span>
                <strong>{position.quantity.toFixed(1)} @ {fmtNum(position.averageEntryPrice)}</strong>
                <em>{fmtMoney(position.unrealizedPnl ?? 0)} UPL</em>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Risk Sheet · Controls" subtitle="Deterministic paper limits">
          <Metric label="Kill switch" value={state.killSwitch ? "ENGAGED" : "ARMED · OFF"} />
          <Metric label="Worst terminal P&L" value={fmtMoney(state.risk.worstCaseTerminalPnl)} />
          <Metric label="Fixture exposure" value={`$${state.risk.fixtureExposure.toFixed(2)}`} />
          <Metric label="Risk utilization" value={`${(state.risk.riskBudgetUtilization * 100).toFixed(1)}%`} />
          <Metric label="Quote uptime" value={`${(state.performance.quoteUptime * 100).toFixed(1)}%`} />
          <div className="risk-meter"><span style={{ width: `${state.risk.riskBudgetUtilization * 100}%` }} /></div>
        </Panel>

        <Panel title="Audit Trail · Reason codes" subtitle="Latest decision and paper-execution evidence" wide>
          {latestAudit ? (
            <div className="audit-focus">
              <div>
                <span className="section-kicker">Latest action · event #{latestAudit.replayIndex}</span>
                <strong>{friendlyEvent(latestAudit.finalAction)}</strong>
                <p>{latestAudit.marketObservation} · Filtered consensus {fmtPct(latestAudit.theo)} · Width {fmtNum(latestAudit.width)} · Inventory lean {latestAudit.inventoryLean.toFixed(3)}</p>
              </div>
              <div className="code-list">
                {[...latestAudit.riskChecks, ...latestAudit.reasonCodes].map((code, index) => <span key={`${code}-${index}`}>{code}</span>)}
              </div>
              <div className="audit-result">
                <span>Paper fill</span><strong>{latestAudit.fillResult}</strong>
                <span>Final action</span><strong>{latestAudit.finalAction}</strong>
              </div>
            </div>
          ) : <Empty text="Start the replay to populate auditable reason codes." />}
          <details>
            <summary>Recent decisions ({state.audit.length})</summary>
            <div className="audit-list">{state.audit.slice(-12).reverse().map((event) => (
              <article key={event.auditId}>
                <strong>#{event.replayIndex} {friendlyEvent(event.finalAction)}</strong>
                <span>{event.marketObservation} · Filtered {fmtNum(event.theo)} · Width {fmtNum(event.width)}</span>
                <em>{event.riskChecks.join(" · ")} · {event.reasonCodes.join(" · ")}</em>
              </article>
            ))}</div>
          </details>
        </Panel>
      </main>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell">{children}<footer><Shield size={13} /> Build {import.meta.env.VITE_APP_VERSION ?? "0.1.0"} · Paper execution only · No wallet or real order routing</footer></div>;
}

function Status({ icon, label, value, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; tone?: "neutral" | "good" | "warn" | "danger" | "live" }) {
  return <div className={`status-item ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ title, subtitle, children, wide = false, span }: { title: string; subtitle?: string; children: React.ReactNode; wide?: boolean; span?: number }) {
  return <section className={`panel ${wide ? "wide" : ""} ${span === 2 ? "span-two" : ""}`}><div className="panel-heading"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{children}</section>;
}

function Metric({ label, value, muted = false, compact = false }: { label: string; value: string; muted?: boolean; compact?: boolean }) {
  return <div className={`metric ${muted ? "muted" : ""} ${compact ? "compact" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function StateBadge({ value }: { value: string }) {
  const tone = value === "LIVE" ? "good" : value.includes("SUSPENDED") || value.includes("DISABLED") ? "danger" : "neutral";
  return <span className={`state-badge ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

function ReplayStage({ label, detail, done, active = false }: { label: string; detail: string; done: boolean; active?: boolean }) {
  return <div className={`replay-stage ${done ? "done" : ""} ${active ? "active" : ""}`}><span>{done ? <BadgeCheck size={15} /> : <Clock3 size={15} />}</span><strong>{label}</strong><small>{active ? "Active now" : done ? "Observed" : "Upcoming"} · {detail}</small></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function StateMessage({ title, detail, tone }: { title: string; detail: string; tone?: "danger" }) {
  return <div className={`state-message ${tone ?? ""}`}><Activity size={22} /><h1>{title}</h1><p>{detail}</p></div>;
}

function hasEvent(state: DemoState, events: string[]) {
  return state.chart.some((point) => point.eventType && events.includes(point.eventType))
    || state.audit.some((event) => events.includes(event.finalAction));
}

function provenanceLabel(source: string) {
  if (source === "MARKET_BASELINE") return "STATE-SPACE MARKET FILTER";
  if (source === "BENCHMARK_THEO") return "BENCHMARK_THEO · FILTER";
  return source.replaceAll("_", " ");
}

function friendlyEvent(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}
