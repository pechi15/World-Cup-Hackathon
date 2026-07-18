import type { NormalizedEvent } from "../../market-data/src/event-store.js";

export type ReplayStatus = {
  playing: boolean;
  index: number;
  speed: number;
  total: number;
  currentEventTime: string | null;
};

export class ReplayClock {
  private index = 0;
  private playing = false;
  private speed = 1;
  private readonly events: NormalizedEvent[];

  constructor(events: NormalizedEvent[]) {
    this.events = events;
  }

  status(): ReplayStatus {
    const current = this.events[this.index] ?? null;
    return {
      playing: this.playing,
      index: this.index,
      speed: this.speed,
      total: this.events.length,
      currentEventTime: current?.eventTime ?? null,
    };
  }

  reset(): void {
    this.index = 0;
    this.playing = false;
  }

  pause(): void {
    this.playing = false;
  }

  play(): void {
    this.playing = true;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(100, speed));
  }

  step(): NormalizedEvent | null {
    if (this.index >= this.events.length) {
      this.playing = false;
      return null;
    }
    const event = this.events[this.index];
    this.index += 1;
    return event;
  }

  /** Advance as if `wallMs` elapsed at current speed (uses event-time deltas). */
  advance(wallMs: number): NormalizedEvent[] {
    if (!this.playing) return [];
    const budget = wallMs * this.speed;
    const emitted: NormalizedEvent[] = [];
    let used = 0;
    while (this.index < this.events.length) {
      const prev = this.events[this.index - 1];
      const next = this.events[this.index];
      const delta = prev ? Math.max(0, Date.parse(next.eventTime) - Date.parse(prev.eventTime)) : 0;
      if (emitted.length > 0 && used + delta > budget) break;
      const event = this.step();
      if (!event) break;
      emitted.push(event);
      used += delta;
    }
    if (this.index >= this.events.length) this.playing = false;
    return emitted;
  }
}
