/**
 * Deterministic profiling scenario for the planner calendar layout engine.
 *
 * Simulates the Week view render path: for every day of a busy week the
 * planner computes the visible timeline range and lays out events both
 * horizontally (Day view) and vertically (Week view). Each of these calls
 * resolves local hour/minute for every event via `getLocalHourAndMinute`.
 *
 * Usage:
 *   node node_modules/jiti/lib/jiti-cli.mjs scratch/profile-calendar-layout.ts [iterations] [runs]
 *
 * CPU profile (built-in V8 sampling profiler, no extra install):
 *   node --cpu-prof --cpu-prof-dir=profiles node_modules/jiti/lib/jiti-cli.mjs scratch/profile-calendar-layout.ts
 */
import type { CalendarEvent } from '../src/types/domain';
import {
  computeTimelineRange,
  layoutHorizontalEvents,
  layoutVerticalEvents,
} from '../src/features/calendar/layout';

const TIME_ZONE = 'Europe/Bratislava';
const DAYS = 7;
const EVENTS_PER_DAY = 40;
const ITERATIONS = Number(process.argv[2] ?? 10);
const RUNS = Number(process.argv[3] ?? 5);

// Seeded PRNG (mulberry32) so every run lays out exactly the same week.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWeek(): CalendarEvent[][] {
  const random = mulberry32(42);
  const week: CalendarEvent[][] = [];

  for (let day = 0; day < DAYS; day++) {
    const events: CalendarEvent[] = [];
    for (let i = 0; i < EVENTS_PER_DAY; i++) {
      const startMinute = Math.floor(random() * 22 * 60);
      const duration = 15 + Math.floor(random() * 120);
      const start = Date.UTC(2026, 10, 9 + day, 0, startMinute);
      events.push({
        id: `evt-${day}-${i}`,
        user_id: 'user-1',
        title: `Event ${i}`,
        description: null,
        start_time: new Date(start).toISOString(),
        end_time: new Date(start + duration * 60_000).toISOString(),
        color_tag: 'blue',
        goal_id: null,
        project_id: null,
        task_id: null,
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
      } as CalendarEvent);
    }
    week.push(events);
  }

  return week;
}

function renderWeek(week: CalendarEvent[][]): number {
  // Checksum keeps the optimizer from discarding the work.
  let checksum = 0;
  const range = computeTimelineRange(week.flat(), TIME_ZONE);

  for (const dayEvents of week) {
    const horizontal = layoutHorizontalEvents(dayEvents, TIME_ZONE);
    const vertical = layoutVerticalEvents(dayEvents, TIME_ZONE, range);
    checksum += horizontal.totalLanes + horizontal.positionedEvents.length;
    for (const item of vertical) checksum += item.columnIndex + item.totalColumns;
  }

  return checksum;
}

const week = buildWeek();
const callsPerRender = DAYS * EVENTS_PER_DAY * 2 /* range */ + DAYS * EVENTS_PER_DAY * 2 * 3; /* per day: range + horizontal + vertical */

// Warm-up so JIT compilation is not part of the measurement.
for (let i = 0; i < 20; i++) renderWeek(week);

const timings: number[] = [];
let checksum = 0;
for (let run = 0; run < RUNS; run++) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) checksum += renderWeek(week);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  timings.push(elapsedMs);
}

const sorted = [...timings].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const mean = timings.reduce((sum, t) => sum + t, 0) / timings.length;

console.log(`Scenario: ${DAYS} days x ${EVENTS_PER_DAY} events, ${ITERATIONS} week renders per run, ${RUNS} runs (tz ${TIME_ZONE})`);
console.log(`getLocalHourAndMinute calls per week render: ${callsPerRender}`);
console.log(`Runs (ms): ${timings.map((t) => t.toFixed(1)).join(', ')}`);
console.log(`Median: ${median.toFixed(1)} ms per run  |  Mean: ${mean.toFixed(1)} ms per run`);
console.log(`Median per week render: ${((median / ITERATIONS) * 1000).toFixed(1)} µs`);
console.log(`Heap used after run: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`);
console.log(`Checksum: ${checksum}`);
