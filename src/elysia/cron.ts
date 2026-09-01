import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { hasServiceBearer } from './service-auth';

export type TimbalCronMode = 'local' | 'platform';

export type CronIneligibleReason = 'sub_10s_pattern' | 'no_pattern' | 'unsupported_options';

export interface CronJobManifest {
  name: string;
  /** Cron expression, or `null` when the job was scheduled from a date. */
  pattern: string | null;
  timezone: string | null;
  protect: boolean;
  catch: boolean;
  /** `scheduled` = croner timer armed · `paused` · `stopped` (platform mode or user `stop()`). */
  state: 'scheduled' | 'paused' | 'stopped';
  /** A run is in flight right now. */
  busy: boolean;
  next_run: string | null;
  previous_run: string | null;
  /** May the platform dispatcher own this job's clock? */
  platform_eligible: boolean;
  platform_ineligible_reason: CronIneligibleReason | null;
}

export interface CronManifest {
  version: 1;
  mode: TimbalCronMode;
  jobs: CronJobManifest[];
}

export interface TimbalCronOptions {
  /** Timbal client whose service credential authenticates callers. */
  timbal?: Timbal;
  /** Base path. @default '/__timbal/cron' */
  path?: string;
  /** Overrides `TIMBAL_CRON_MODE`. @default 'local' */
  mode?: TimbalCronMode;
  /** Environment to read `TIMBAL_CRON_MODE` from. @default process.env */
  env?: Record<string, string | undefined>;
}

/**
 * Structural subset of a croner `Cron` instance — what `@elysiajs/cron`
 * stores in `store.cron[name]`. Declared here so the SDK needs no dependency
 * on croner.
 */
export interface CronJobLike {
  options: {
    timezone?: string;
    protect?: unknown;
    catch?: unknown;
    maxRuns?: number;
    startAt?: unknown;
    stopAt?: unknown;
    interval?: number;
  };
  fn: unknown;
  getPattern(): string | undefined;
  isRunning(): boolean;
  isStopped(): boolean;
  isBusy(): boolean;
  nextRun(): Date | null;
  previousRun(): Date | null;
  trigger(): Promise<void>;
  stop(): void;
}

export type CronRunOutcome =
  | { status: 'done'; duration_ms: number }
  | { status: 'error'; duration_ms: number; error: string };

const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 60_000;
const MAX_ERROR_CHARS = 500;

/**
 * The platform dispatcher ticks every 10–15 s, so anything that fires more
 * often than every 10 s — or whose seconds field croner would expand to
 * multiple slots per minute — must keep its local timer.
 */
export function classifyCronPattern(pattern: string): CronIneligibleReason | null {
  const trimmed = pattern.trim();
  // `@hourly`, `@daily`, … are minute-or-coarser by definition.
  if (trimmed.startsWith('@')) return null;
  const fields = trimmed.split(/\s+/);
  const seconds = fields[0];
  if (fields.length < 6 || seconds === undefined) return null;
  if (seconds === '*') return 'sub_10s_pattern';
  if (seconds.includes(',') || seconds.includes('-')) return 'sub_10s_pattern';
  const step = /^\*\/(\d+)$/.exec(seconds);
  if (step) return Number(step[1]) < 10 ? 'sub_10s_pattern' : null;
  return null;
}

export function evaluatePlatformEligibility(job: CronJobLike): {
  eligible: boolean;
  reason: CronIneligibleReason | null;
} {
  const pattern = job.getPattern();
  if (!pattern) return { eligible: false, reason: 'no_pattern' };
  const o = job.options;
  // Run-count / window / min-interval semantics live in croner's timer; a
  // platform clock can't honour them, so those jobs stay local. croner
  // normalises defaults to maxRuns=Infinity / interval=0.
  if (
    (o.maxRuns !== undefined && Number.isFinite(o.maxRuns)) ||
    o.startAt ||
    o.stopAt ||
    (o.interval !== undefined && o.interval > 0)
  ) {
    return { eligible: false, reason: 'unsupported_options' };
  }
  const reason = classifyCronPattern(pattern);
  return { eligible: reason === null, reason };
}

export function resolveCronMode(options: TimbalCronOptions = {}): TimbalCronMode {
  if (options.mode) return options.mode;
  const env = options.env ?? process.env;
  return env.TIMBAL_CRON_MODE === 'platform' ? 'platform' : 'local';
}

function summarizeError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message || err.name : typeof err === 'string' ? err : String(err);
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  return (firstLine || 'Error').slice(0, MAX_ERROR_CHARS);
}

function logRun(name: string, outcome: CronRunOutcome): void {
  let line = `[timbal-cron] name=${name} status=${outcome.status} duration_ms=${outcome.duration_ms}`;
  if (outcome.status === 'error') line += ` error=${JSON.stringify(outcome.error)}`;
  // stdout is the contract: the platform's log tee parses this line.
  // eslint-disable-next-line no-console
  console.log(line);
}

/**
 * Per-job hook slot. `claim` is set by the trigger handler immediately before
 * `job.trigger()`; croner invokes `fn` synchronously inside `trigger()`, so the
 * wrapper's prologue consumes the claim before any other run can start.
 * Scheduled runs find no claim and only log.
 */
interface JobHooks {
  claim?: (outcome: CronRunOutcome) => void;
}

const instrumented = new WeakMap<CronJobLike, JobHooks>();

/**
 * Wrap the job's `fn` so every run — scheduled or triggered — emits one
 * structured stdout line and reports its outcome. Wrapping `fn` rather than
 * relying on `trigger()` rejecting matters because croner swallows errors
 * when `catch` is set (verified against croner 6.0.7).
 */
function instrument(name: string, job: CronJobLike): JobHooks | null {
  const existing = instrumented.get(job);
  if (existing) return existing;
  const original = job.fn;
  if (typeof original !== 'function') return null;

  const hooks: JobHooks = {};
  job.fn = async function (this: unknown, ...args: unknown[]) {
    const claim = hooks.claim;
    hooks.claim = undefined;
    const start = Date.now();
    try {
      await original.apply(this, args);
    } catch (err) {
      const outcome: CronRunOutcome = {
        status: 'error',
        duration_ms: Date.now() - start,
        error: summarizeError(err),
      };
      logRun(name, outcome);
      claim?.(outcome);
      throw err;
    }
    const outcome: CronRunOutcome = { status: 'done', duration_ms: Date.now() - start };
    logRun(name, outcome);
    claim?.(outcome);
  };
  instrumented.set(job, hooks);
  return hooks;
}

function readJobs(store: unknown): Record<string, CronJobLike> {
  const cron = (store as { cron?: unknown } | undefined)?.cron;
  if (!cron || typeof cron !== 'object') return {};
  const jobs: Record<string, CronJobLike> = {};
  for (const [name, job] of Object.entries(cron as Record<string, unknown>)) {
    if (job && typeof (job as CronJobLike).trigger === 'function') jobs[name] = job as CronJobLike;
  }
  return jobs;
}

function describeJob(name: string, job: CronJobLike): CronJobManifest {
  const { eligible, reason } = evaluatePlatformEligibility(job);
  return {
    name,
    pattern: job.getPattern() ?? null,
    timezone: job.options.timezone ?? null,
    protect: Boolean(job.options.protect),
    catch: Boolean(job.options.catch),
    state: job.isStopped() ? 'stopped' : job.isRunning() ? 'scheduled' : 'paused',
    busy: job.isBusy(),
    next_run: job.nextRun()?.toISOString() ?? null,
    previous_run: job.previousRun()?.toISOString() ?? null,
    platform_eligible: eligible,
    platform_ineligible_reason: reason,
  };
}

/**
 * Instrument every registered job and, in platform mode, hand eligible jobs'
 * clocks to the platform by stopping their local timers (they remain
 * triggerable). Idempotent; runs on server start and lazily on each request
 * because users mount `cron()` after `timbalAuth()`.
 */
function prepare(store: unknown, mode: TimbalCronMode): Record<string, CronJobLike> {
  const jobs = readJobs(store);
  for (const [name, job] of Object.entries(jobs)) {
    instrument(name, job);
    if (mode === 'platform' && !job.isStopped() && evaluatePlatformEligibility(job).eligible) {
      job.stop();
    }
  }
  return jobs;
}

function parseWait(raw: unknown): number {
  const n = typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.floor(n), 0), MAX_WAIT_MS);
}

const json = (status: number, body: unknown) => Response.json(body, { status });

async function triggerJob(name: string, job: CronJobLike, waitMs: number): Promise<Response> {
  // croner's `trigger()` bypasses `protect`; enforce it here so the platform
  // never double-runs a job the user asked to serialize.
  if (job.options.protect && job.isBusy()) return json(409, { status: 'busy' });

  const hooks = instrument(name, job);
  let claimed: Promise<CronRunOutcome> | undefined;
  if (hooks) {
    claimed = new Promise<CronRunOutcome>(resolve => {
      hooks.claim = resolve;
    });
  }
  const start = Date.now();
  const run = job.trigger();
  if (hooks && hooks.claim) {
    // fn was not entered synchronously (non-croner implementation) — the
    // claim would never resolve, so time the promise itself instead.
    hooks.claim = undefined;
    claimed = undefined;
  }
  const outcome: Promise<CronRunOutcome> =
    claimed ??
    run.then(
      () => ({ status: 'done', duration_ms: Date.now() - start }),
      err => ({ status: 'error', duration_ms: Date.now() - start, error: summarizeError(err) })
    );
  // Rejection (catch unset) is already captured by the wrapper.
  run.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(r => {
    timer = setTimeout(() => r('timeout'), waitMs);
  });
  try {
    const result = await Promise.race([outcome, timeout]);
    if (result === 'timeout') return json(202, { status: 'running', waited_ms: waitMs });
    return json(result.status === 'done' ? 200 : 500, result);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exposes `@elysiajs/cron` jobs to the platform so scheduling can move out of
 * the process (idle-sleep, visibility, single-fire across hosts) with zero
 * user-code change — users keep writing `cron({ name, pattern, run })`.
 *
 * Routes (both require `Authorization: Bearer <project service credential>`,
 * the same check as `/__timbal/config/refresh`; 401 otherwise):
 *
 * - `GET  /__timbal/cron` → {@link CronManifest}
 * - `POST /__timbal/cron/:name/trigger?wait=20000`
 *   - 200 `{ status: 'done', duration_ms }`
 *   - 500 `{ status: 'error', duration_ms, error }` (first line, ≤500 chars)
 *   - 202 `{ status: 'running', waited_ms }` — still running after `wait`
 *     (0–60000, default 20000); completion arrives as a stdout line
 *   - 409 `{ status: 'busy' }` — `protect` set and a run is in flight
 *   - 404 `{ error: 'unknown_job' }`
 *
 * Every run (scheduled or triggered) also prints
 * `[timbal-cron] name=… status=done|error duration_ms=… [error="…"]`.
 *
 * Mode (`TIMBAL_CRON_MODE`, default `local`): `platform` stops the local timer
 * of every platform-eligible job on start; the platform dispatcher then fires
 * them via the trigger route. Ineligible jobs (sub-10 s seconds field, date
 * schedules, `maxRuns`/`startAt`/`stopAt`/`interval`) keep running locally
 * and say so in the manifest.
 *
 * Mounted by `timbalAuth()` by default; use standalone when the host skips
 * auth.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timbalCron(options: TimbalCronOptions = {}): any {
  const timbal = options.timbal ?? new Timbal();
  const path = options.path ?? '/__timbal/cron';
  const mode = resolveCronMode(options);

  return (
    new Elysia({ name: `timbal-cron:${path}` })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onStart((app: any) => {
        const jobs = Object.entries(prepare(app.store, mode));
        if (jobs.length === 0) return;
        const names = jobs.map(([name]) => name);
        const stopped = jobs.filter(([, job]) => job.isStopped()).length;
        // eslint-disable-next-line no-console
        console.log(
          `[timbal-cron] mode=${mode} jobs=${names.length} stopped=${stopped} names=${names.join(',')}`
        );
      })
      .get(
        path,
        ({ request, store }: { request: Request; store: unknown }) => {
          if (!hasServiceBearer(request, timbal)) {
            return new Response('Unauthorized', { status: 401 });
          }
          const jobs = prepare(store, mode);
          const manifest: CronManifest = {
            version: 1,
            mode,
            jobs: Object.entries(jobs).map(([name, job]) => describeJob(name, job)),
          };
          return json(200, manifest);
        },
        { detail: { hide: true } }
      )
      .post(
        `${path}/:name/trigger`,
        ({
          request,
          store,
          params,
          query,
        }: {
          request: Request;
          store: unknown;
          params: { name: string };
          query: Record<string, string | undefined>;
        }) => {
          if (!hasServiceBearer(request, timbal)) {
            return new Response('Unauthorized', { status: 401 });
          }
          const jobs = prepare(store, mode);
          const job = jobs[params.name];
          if (!job) return json(404, { error: 'unknown_job' });
          return triggerJob(params.name, job, parseWait(query.wait));
        },
        { detail: { hide: true } }
      )
  );
}
