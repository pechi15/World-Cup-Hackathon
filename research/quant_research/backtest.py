"""Deterministic latency/fill backtest, markouts, and execution stress tests."""

from __future__ import annotations

import hashlib
import json
import statistics
from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime, timedelta

from .contracts import (
    BacktestReport,
    EvidenceBinding,
    FillAssumptions,
    LatencyAssumptions,
    MarkoutResult,
    MarketTick,
    MetricResult,
    OrderIntent,
    SimulatedFill,
    StressResult,
    StressScenario,
)


MARKOUT_HORIZONS = (10, 30, 60, 300)


def _assumptions_hash(latency: LatencyAssumptions, fills: FillAssumptions) -> str:
    payload = {
        "latency": latency.model_dump(mode="json"),
        "fills": fills.model_dump(mode="json"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _queue_accepts(order_id: str, queue_fraction: float) -> bool:
    sample = int(hashlib.sha256(order_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return sample <= queue_fraction


def _group_ticks(ticks: Sequence[MarketTick]) -> dict[tuple[str, str], list[MarketTick]]:
    grouped: dict[tuple[str, str], list[MarketTick]] = defaultdict(list)
    for tick in ticks:
        grouped[(tick.fixture_id, tick.selection_id)].append(tick)
    for rows in grouped.values():
        rows.sort(key=lambda row: (row.available_at, row.event_time))
    return grouped


def _first_tick_at_or_after(rows: Sequence[MarketTick], target_time: datetime) -> MarketTick | None:
    return next((row for row in rows if row.available_at >= target_time), None)


def _markout_value(
    fill: SimulatedFill,
    rows: Sequence[MarketTick],
    horizon_seconds: int,
    maximum_lag_seconds: int,
) -> float | None:
    target = fill.fill_time + timedelta(seconds=horizon_seconds)
    future = _first_tick_at_or_after(rows, target)
    if future is None or (future.available_at - target).total_seconds() > maximum_lag_seconds:
        return None
    future_mid = (future.bid + future.ask) / 2.0
    direction = 1.0 if fill.side == "BUY" else -1.0
    return direction * (future_mid - fill.price)


def evaluate_markouts(
    fills: Sequence[SimulatedFill],
    ticks: Sequence[MarketTick],
    horizons: Sequence[int] = MARKOUT_HORIZONS,
    *,
    maximum_lag_seconds: int = 5,
) -> tuple[MarkoutResult, ...]:
    grouped = _group_ticks(ticks)
    results: list[MarkoutResult] = []
    for horizon in horizons:
        values: list[float] = []
        for fill in fills:
            value = _markout_value(
                fill,
                grouped[(fill.fixture_id, fill.selection_id)],
                horizon,
                maximum_lag_seconds,
            )
            if value is not None:
                values.append(value)
        results.append(
            MarkoutResult(
                horizon_seconds=horizon,
                mean_markout=sum(values) / len(values) if values else None,
                median_markout=statistics.median(values) if values else None,
                sample_size=len(values),
            )
        )
    return tuple(results)


def latency_aware_backtest(
    orders: Sequence[OrderIntent],
    ticks: Sequence[MarketTick],
    latency: LatencyAssumptions,
    assumptions: FillAssumptions,
    *,
    experiment_id: str,
    data_snapshot_hash: str,
    binding: EvidenceBinding,
) -> BacktestReport:
    if binding.experiment_id != experiment_id or binding.dataset_hash != data_snapshot_hash:
        raise ValueError("backtest binding identity mismatch")
    grouped = _group_ticks(ticks)
    simulated: list[SimulatedFill] = []
    rejected: list[str] = []
    remaining_liquidity: dict[tuple[str, str, datetime], float] = {}

    for order in sorted(orders, key=lambda value: (value.decision_time, value.order_id)):
        arrival = order.decision_time + timedelta(milliseconds=latency.entry_latency_ms)
        tick = _first_tick_at_or_after(grouped[(order.fixture_id, order.selection_id)], arrival)
        if (
            tick is None
            or tick.available_at <= order.decision_time
            or (tick.available_at - arrival).total_seconds() * 1000 > latency.max_staleness_ms
        ):
            rejected.append(order.order_id)
            continue
        if assumptions.mode == "QUEUE_AWARE" and not _queue_accepts(order.order_id, assumptions.queue_fraction):
            rejected.append(order.order_id)
            continue

        touch_price = tick.ask if order.side == "BUY" else tick.bid
        marketable = touch_price <= order.limit_price if order.side == "BUY" else touch_price >= order.limit_price
        if not marketable:
            rejected.append(order.order_id)
            continue
        slippage = assumptions.slippage_bps / 10_000.0
        execution_price = touch_price + slippage if order.side == "BUY" else touch_price - slippage
        execution_price = min(1.0, max(0.0, execution_price))
        respects_limit = execution_price <= order.limit_price if order.side == "BUY" else execution_price >= order.limit_price
        if not respects_limit:
            rejected.append(order.order_id)
            continue
        liquidity_key = (tick.fixture_id, tick.selection_id, tick.available_at)
        available = remaining_liquidity.setdefault(liquidity_key, tick.available_size)
        quantity = min(order.quantity, available) if assumptions.partial_fills else order.quantity
        if quantity <= 0 or (not assumptions.partial_fills and available < order.quantity):
            rejected.append(order.order_id)
            continue
        remaining_liquidity[liquidity_key] = available - quantity
        fee = execution_price * quantity * assumptions.fee_bps / 10_000.0
        mid = (tick.bid + tick.ask) / 2.0
        spread_cost = abs(touch_price - mid) * quantity
        slippage_cost = abs(execution_price - touch_price) * quantity
        simulated.append(
            SimulatedFill(
                order_id=order.order_id,
                fixture_id=order.fixture_id,
                selection_id=order.selection_id,
                side=order.side,
                decision_time=order.decision_time,
                arrival_time=arrival,
                fill_time=tick.available_at,
                price=execution_price,
                quantity=quantity,
                fee=fee,
                quoted_bid=tick.bid,
                quoted_ask=tick.ask,
                slippage_cost=slippage_cost,
                spread_cost=spread_cost,
                latency_ms=int((tick.available_at - order.decision_time).total_seconds() * 1000),
            )
        )

    markouts = evaluate_markouts(simulated, ticks)
    grouped_ticks = _group_ticks(ticks)
    markout_pnl = sum(
        value * fill.quantity
        for fill in simulated
        if (
            value := _markout_value(
                fill,
                grouped_ticks[(fill.fixture_id, fill.selection_id)],
                60,
                5,
            )
        )
        is not None
    )
    fees = sum(fill.fee for fill in simulated)
    net_markout_after_fees = markout_pnl - fees
    fixture_quantities: dict[str, float] = defaultdict(float)
    for fill in simulated:
        fixture_quantities[fill.fixture_id] += fill.quantity
    total_quantity = sum(fixture_quantities.values())
    concentration = max(fixture_quantities.values(), default=0.0) / total_quantity if total_quantity else 0.0
    metrics = (
        MetricResult(
            name="fill_rate",
            value=len(simulated) / len(orders) if orders else None,
            sample_size=len(orders),
            higher_is_better=True,
        ),
        MetricResult(
            name="net_60s_markout_after_fees",
            value=net_markout_after_fees if any(item.horizon_seconds == 60 and item.sample_size for item in markouts) else None,
            sample_size=len(simulated),
            higher_is_better=True,
            reason_codes=("NOT_SETTLEMENT_PNL", "ACTUAL_FUTURE_OBSERVATIONS_ONLY"),
        ),
        MetricResult(
            name="strategy_fixture_concentration",
            value=concentration,
            sample_size=len(fixture_quantities),
            higher_is_better=False,
        ),
        MetricResult(
            name="total_fees",
            value=fees,
            sample_size=len(simulated),
            higher_is_better=False,
        ),
        MetricResult(
            name="total_spread_cost",
            value=sum(fill.spread_cost for fill in simulated),
            sample_size=len(simulated),
            higher_is_better=False,
        ),
        MetricResult(
            name="total_slippage_cost",
            value=sum(fill.slippage_cost for fill in simulated),
            sample_size=len(simulated),
            higher_is_better=False,
        ),
    )
    return BacktestReport(
        experiment_id=experiment_id,
        data_snapshot_hash=data_snapshot_hash,
        binding=binding,
        fills=tuple(simulated),
        metrics=metrics,
        markouts=markouts,
        rejected_order_ids=tuple(rejected),
        assumptions_hash=_assumptions_hash(latency, assumptions),
    )


def run_stress_suite(
    orders: Sequence[OrderIntent],
    ticks: Sequence[MarketTick],
    latency: LatencyAssumptions,
    fills: FillAssumptions,
    scenarios: Sequence[StressScenario],
    *,
    experiment_id: str,
    data_snapshot_hash: str,
    binding: EvidenceBinding,
) -> tuple[StressResult, ...]:
    results: list[StressResult] = []
    for scenario in scenarios:
        stressed_latency = latency.model_copy(
            update={
                "decision_ms": round(latency.decision_ms * scenario.latency_multiplier),
                "network_ms": round(latency.network_ms * scenario.latency_multiplier),
                "exchange_ms": round(latency.exchange_ms * scenario.latency_multiplier),
                "cancel_ms": round(latency.cancel_ms * scenario.latency_multiplier),
            }
        )
        stressed_fills = fills.model_copy(
            update={
                "slippage_bps": fills.slippage_bps * scenario.slippage_multiplier,
                "queue_fraction": fills.queue_fraction * scenario.fill_probability_multiplier,
            }
        )
        stressed_ticks = [
            tick.model_copy(
                update={
                    "bid": max(0.0, tick.bid - scenario.probability_shock),
                    "ask": min(1.0, tick.ask + scenario.probability_shock),
                }
            )
            for tick in ticks
        ]
        report = latency_aware_backtest(
            orders,
            stressed_ticks,
            stressed_latency,
            stressed_fills,
            experiment_id=experiment_id,
            data_snapshot_hash=data_snapshot_hash,
            binding=binding.model_copy(update={"validation_fold": f"STRESS:{scenario.name}"}),
        )
        passed = len(report.fills) + len(report.rejected_order_ids) == len(orders)
        results.append(
            StressResult(
                experiment_id=experiment_id,
                data_snapshot_hash=data_snapshot_hash,
                binding=binding.model_copy(update={"validation_fold": f"STRESS:{scenario.name}"}),
                scenario=scenario.name,
                pnl=None,
                max_drawdown=None,
                fill_count=len(report.fills),
                passed=passed,
                underlying_return_ids=(),
                reason_codes=(
                    ("NO_SETTLEMENT_PNL_OR_SHARPE",)
                    if passed
                    else ("STRESS_EXECUTION_ACCOUNTING_FAILED", "NO_SETTLEMENT_PNL_OR_SHARPE")
                ),
            )
        )
    return tuple(results)
