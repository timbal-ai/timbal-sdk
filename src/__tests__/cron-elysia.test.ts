import { describe, test, expect, afterEach, spyOn, type Mock } from 'bun:test';
import { Elysia } from 'elysia';
import { cron } from '@elysiajs/cron';
import { timbalAuth } from '../elysia';
import {
  timbalCron,
  classifyCronPattern,
  type CronManifest,
  type CronJobLike,
} from '../elysia/cron';
import type { Timbal } from '../lib/timbal';

const timbal = {
  apiClient: { getConfig: () => ({ orgId: 'o', projectId: 'p', token: 'svc-secret' }) },
} as unknown as Timbal;

const YEARLY = '0 0 1 1 *';

const apps: Elysia[] = [];
let logSpy: Mock<typeof console.log> | undefined;

afterEach(() => {
  for (const app of apps) {
    for (const job of Object.values((app.store?.cron ?? {}) as Record<string, CronJobLike>)) {
      job.stop();
    }
  }
  apps.length = 0;
  logSpy?.mockRestore();
  logSpy = undefined;
});

function captureLogs() {
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  return () => logSpy!.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[timbal-cron]'));
}

function track<T extends Elysia>(app: T): T {
  apps.push(app);
  return app;
}

/** `token: null` → no Authorization header at all. */
const get = (app: Elysia, token: string | null = 'svc-secret') =>
  app.handle(
    new Request('https://x.test/__timbal/cron', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  );

const trigger = (app: Elysia, name: string, wait?: number, token: string | null = 'svc-secret') =>
  app.handle(
    new Request(
      `https://x.test/__timbal/cron/${encodeURIComponent(name)}/trigger${wait !== undefined ? `?wait=${wait}` : ''}`,
      { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} }
    )
  );

const manifest = async (app: Elysia) => (await get(app)).json() as Promise<CronManifest>;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('classifyCronPattern', () => {
  test.each([
    ['0 0 * * *', null],
    ['*/5 * * * *', null],
    ['@daily', null],
    ['*/30 * * * * *', null],
    ['*/10 * * * * *', null],
    ['0 * * * * *', null],
    ['30 */5 * * * *', null],
    ['*/5 * * * * *', 'sub_10s_pattern'],
    ['*/9 * * * * *', 'sub_10s_pattern'],
    ['* * * * * *', 'sub_10s_pattern'],
    ['0,30 * * * * *', 'sub_10s_pattern'],
    ['0-59/10 * * * * *', 'sub_10s_pattern'],
  ] as const)('%s → %p', (pattern, reason) => {
    expect(classifyCronPattern(pattern)).toBe(reason);
  });
});

describe('GET /__timbal/cron', () => {
  test('401 without the service bearer', async () => {
    const app = track(new Elysia().use(timbalCron({ timbal })));
    expect((await get(app, null)).status).toBe(401);
    expect((await get(app, 'nope')).status).toBe(401);
    expect((await trigger(app, 'x', undefined, null)).status).toBe(401);
  });

  test('empty manifest when no cron plugin is mounted', async () => {
    const app = track(new Elysia().use(timbalCron({ timbal })));
    expect(await manifest(app)).toEqual({ version: 1, mode: 'local', jobs: [] });
  });

  test('describes jobs mounted after the plugin, with eligibility', async () => {
    const app = track(
      new Elysia()
        .use(timbalCron({ timbal }))
        .use(
          cron({ name: 'daily', pattern: '0 0 * * *', timezone: 'Europe/Madrid', run: () => {} })
        )
        .use(
          cron({
            name: 'fast',
            pattern: '*/5 * * * * *',
            protect: true,
            catch: true,
            run: () => {},
          })
        )
        .use(
          cron({
            name: 'once',
            pattern: new Date(Date.now() + 3_600_000).toISOString(),
            run: () => {},
          })
        )
        .use(cron({ name: 'capped', pattern: '0 0 * * *', maxRuns: 3, run: () => {} }))
    );
    const m = await manifest(app);
    expect(m.version).toBe(1);
    expect(m.mode).toBe('local');
    const byName = Object.fromEntries(m.jobs.map(j => [j.name, j]));

    expect(byName.daily).toMatchObject({
      pattern: '0 0 * * *',
      timezone: 'Europe/Madrid',
      protect: false,
      catch: false,
      state: 'scheduled',
      busy: false,
      platform_eligible: true,
      platform_ineligible_reason: null,
    });
    expect(typeof byName.daily!.next_run).toBe('string');
    expect(byName.daily!.previous_run).toBeNull();

    expect(byName.fast).toMatchObject({
      protect: true,
      catch: true,
      platform_eligible: false,
      platform_ineligible_reason: 'sub_10s_pattern',
    });
    expect(byName.once).toMatchObject({
      pattern: null,
      platform_eligible: false,
      platform_ineligible_reason: 'no_pattern',
    });
    expect(byName.capped).toMatchObject({
      platform_eligible: false,
      platform_ineligible_reason: 'unsupported_options',
    });
  });
});

describe('POST /__timbal/cron/:name/trigger', () => {
  test('unknown job → 404', async () => {
    const app = track(new Elysia().use(timbalCron({ timbal })));
    const res = await trigger(app, 'ghost');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_job' });
  });

  test('run resolves → 200 done + stdout line', async () => {
    const lines = captureLogs();
    let runs = 0;
    const app = track(
      new Elysia().use(timbalCron({ timbal })).use(
        cron({
          name: 'ok',
          pattern: YEARLY,
          run: async () => {
            await sleep(15);
            runs += 1;
          },
        })
      )
    );
    const res = await trigger(app, 'ok');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('done');
    expect(body.duration_ms).toBeGreaterThanOrEqual(10);
    expect(runs).toBe(1);
    expect(lines()).toEqual([
      expect.stringMatching(/^\[timbal-cron\] name=ok status=done duration_ms=\d+$/),
    ]);

    const m = await manifest(app);
    expect(typeof m.jobs[0]!.previous_run).toBe('string');
  });

  test('run rejects with catch unset → 500 error, no unhandled rejection', async () => {
    const lines = captureLogs();
    const app = track(
      new Elysia().use(timbalCron({ timbal })).use(
        cron({
          name: 'boom',
          pattern: YEARLY,
          run: async () => {
            throw new Error('first line\nstack-ish second line');
          },
        })
      )
    );
    const res = await trigger(app, 'boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 'error',
      duration_ms: expect.any(Number),
      error: 'first line',
    });
    expect(lines()).toEqual([
      expect.stringMatching(
        /^\[timbal-cron\] name=boom status=error duration_ms=\d+ error="first line"$/
      ),
    ]);
  });

  test('run rejects with catch: true (croner swallows) → still 500 error', async () => {
    const app = track(
      new Elysia().use(timbalCron({ timbal })).use(
        cron({
          name: 'swallowed',
          pattern: YEARLY,
          catch: true,
          run: async () => {
            throw new Error('x'.repeat(600));
          },
        })
      )
    );
    const res = await trigger(app, 'swallowed');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toHaveLength(500);
  });

  test('catch callback still runs after instrumentation', async () => {
    const caught: unknown[] = [];
    const app = track(
      new Elysia().use(timbalCron({ timbal })).use(
        cron({
          name: 'cb',
          pattern: YEARLY,
          catch: e => caught.push(e),
          run: () => {
            throw new Error('nope');
          },
        })
      )
    );
    expect((await trigger(app, 'cb')).status).toBe(500);
    expect(caught).toHaveLength(1);
  });

  test('still running after wait → 202, completion line arrives later', async () => {
    const lines = captureLogs();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const app = track(
      new Elysia()
        .use(timbalCron({ timbal }))
        .use(cron({ name: 'slow', pattern: YEARLY, protect: true, run: () => gate }))
    );
    const res = await trigger(app, 'slow', 20);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'running', waited_ms: 20 });
    expect(lines()).toEqual([]);

    // Second trigger while the first is in flight and protect is set → busy.
    const busy = await trigger(app, 'slow', 0);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ status: 'busy' });
    expect((await manifest(app)).jobs[0]!.busy).toBe(true);

    release();
    await sleep(5);
    expect(lines()).toEqual([expect.stringMatching(/name=slow status=done/)]);
    expect((await manifest(app)).jobs[0]!.busy).toBe(false);
  });

  test('without protect, concurrent triggers are allowed and tracked separately', async () => {
    let n = 0;
    const app = track(
      new Elysia().use(timbalCron({ timbal })).use(
        cron({
          name: 'par',
          pattern: YEARLY,
          run: async () => {
            const me = ++n;
            await sleep(me === 1 ? 30 : 5);
            if (me === 2) throw new Error('second failed');
          },
        })
      )
    );
    const [a, b] = await Promise.all([trigger(app, 'par'), trigger(app, 'par')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(500);
    expect((await b.json()).error).toBe('second failed');
  });

  test('wait is clamped to 0–60000 and defaults on garbage', async () => {
    const app = track(
      new Elysia()
        .use(timbalCron({ timbal }))
        .use(cron({ name: 'w', pattern: YEARLY, run: () => sleep(15) }))
    );
    expect(await (await trigger(app, 'w', 0)).json()).toEqual({ status: 'running', waited_ms: 0 });
    await sleep(20);
    const res = await app.handle(
      new Request('https://x.test/__timbal/cron/w/trigger?wait=abc', {
        method: 'POST',
        headers: { authorization: 'Bearer svc-secret' },
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('modes', () => {
  test('local mode leaves every timer running', async () => {
    const app = track(
      new Elysia()
        .use(timbalCron({ timbal, env: {} }))
        .use(cron({ name: 'a', pattern: YEARLY, run: () => {} }))
        .use(cron({ name: 'b', pattern: '*/5 * * * * *', run: () => {} }))
    );
    const m = await manifest(app);
    expect(m.mode).toBe('local');
    expect(m.jobs.map(j => j.state)).toEqual(['scheduled', 'scheduled']);
  });

  test('platform mode (env) stops eligible jobs, keeps ineligible ones, still triggers', async () => {
    let ran = 0;
    const app = track(
      new Elysia()
        .use(timbalCron({ timbal, env: { TIMBAL_CRON_MODE: 'platform' } }))
        .use(cron({ name: 'eligible', pattern: YEARLY, run: () => void ran++ }))
        .use(cron({ name: 'fast', pattern: '*/5 * * * * *', run: () => {} }))
    );
    const m = await manifest(app);
    expect(m.mode).toBe('platform');
    const byName = Object.fromEntries(m.jobs.map(j => [j.name, j.state]));
    expect(byName).toEqual({ eligible: 'stopped', fast: 'scheduled' });

    expect((await trigger(app, 'eligible')).status).toBe(200);
    expect(ran).toBe(1);
  });

  test('onStart prepares jobs (platform mode) and logs a summary', async () => {
    const lines = captureLogs();
    const app = track(
      new Elysia()
        .use(timbalCron({ timbal, mode: 'platform' }))
        .use(cron({ name: 'nightly', pattern: '0 3 * * *', run: () => {} }))
        .use(cron({ name: 'tick', pattern: '* * * * * *', run: () => {} }))
    );
    app.listen(0);
    try {
      expect(lines()).toEqual(['[timbal-cron] mode=platform jobs=2 stopped=1 names=nightly,tick']);
      expect((app.store.cron as Record<string, CronJobLike>).nightly!.isStopped()).toBe(true);
      expect((app.store.cron as Record<string, CronJobLike>).tick!.isStopped()).toBe(false);
    } finally {
      await app.stop();
    }
  });
});

describe('timbalAuth integration', () => {
  const withKey = async (fn: () => Promise<void>) => {
    const prev = process.env.TIMBAL_API_KEY;
    process.env.TIMBAL_API_KEY = 'svc-secret';
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.TIMBAL_API_KEY;
      else process.env.TIMBAL_API_KEY = prev;
    }
  };

  test('mounted by default; explicit .use(timbalCron()) dedupes; cron:false opts out', () =>
    withKey(async () => {
      const app = track(
        new Elysia()
          .use(timbalAuth())
          .use(timbalCron())
          .use(cron({ name: 'j', pattern: YEARLY, run: () => {} }))
      );
      expect(app.routes.filter(r => r.path === '/__timbal/cron').length).toBe(1);
      expect(app.routes.filter(r => r.path === '/__timbal/cron/:name/trigger').length).toBe(1);

      // Ingress gate exempts /__timbal/ — no user token needed, service bearer is.
      const m = await manifest(app);
      expect(m.jobs.map(j => j.name)).toEqual(['j']);
      expect((await get(app, null)).status).toBe(401);

      const off = track(new Elysia().use(timbalAuth({ cron: false })));
      expect(off.routes.some(r => r.path.startsWith('/__timbal/cron'))).toBe(false);
    }));
});
