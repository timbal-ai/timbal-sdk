import type { Project, ProjectChannelSpec } from '../types';
import type { ChannelAdapter, ChannelBinding } from './types';
import { telegram } from './adapters/telegram';
import { slack } from './adapters/slack';

/**
 * Platform-driven channel configuration — the same pattern as
 * `ProjectAuthConfig`: the platform project carries the *topology* (which
 * channels are enabled and which workforce component each talks to, i.e.
 * the dropdown), while **credentials stay out of it** and are supplied by
 * the runtime environment. A bot token in a project settings payload would
 * leak through every surface that renders project config; env (and later
 * the integrations credential vault) is the secrets' home.
 */

/**
 * Pure mapper: platform `Project` → channel specs, or `null` when the
 * platform response predates the channels feature (consumers fall back to
 * env conventions). Disabled and malformed entries are dropped here so
 * downstream code only ever sees actionable specs.
 */
export function channelSpecsFromProject(project: Project): ProjectChannelSpec[] | null {
  const raw = project.channels;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (spec): spec is ProjectChannelSpec =>
      !!spec &&
      typeof spec.provider === 'string' &&
      !!spec.provider &&
      typeof spec.workforce === 'string' &&
      !!spec.workforce &&
      spec.enabled !== false,
  );
}

/** A spec that couldn't be materialized into a live binding, and why. */
export interface SkippedChannelSpec {
  spec: ProjectChannelSpec;
  reason: 'missing-credentials' | 'unknown-provider';
}

export interface MaterializedBindings {
  bindings: ChannelBinding[];
  skipped: SkippedChannelSpec[];
}

/**
 * Adapter factories per provider, reading credentials from env. Returns
 * `null` when the env is missing that provider's secrets — the spec is then
 * reported as skipped rather than mounting a webhook that can't
 * authenticate or reply.
 */
function buildAdapter(
  provider: string,
  env: Record<string, string | undefined>,
): ChannelAdapter | null | 'unknown' {
  switch (provider) {
    case 'telegram':
      return env.TELEGRAM_BOT_TOKEN
        ? telegram({
            botToken: env.TELEGRAM_BOT_TOKEN,
            secretToken: env.TELEGRAM_SECRET_TOKEN,
          })
        : null;
    case 'slack':
      return env.SLACK_SIGNING_SECRET && env.SLACK_BOT_TOKEN
        ? slack({
            signingSecret: env.SLACK_SIGNING_SECRET,
            botToken: env.SLACK_BOT_TOKEN,
          })
        : null;
    default:
      return 'unknown';
  }
}

/**
 * Join platform specs (topology) with env credentials into live bindings.
 * Specs whose provider is unknown to this SDK version, or whose credentials
 * aren't present in the environment, are returned in `skipped` — the caller
 * decides whether that's a log line or an error.
 */
export function materializeChannelBindings(
  specs: ProjectChannelSpec[],
  env: Record<string, string | undefined> = process.env,
): MaterializedBindings {
  const bindings: ChannelBinding[] = [];
  const skipped: SkippedChannelSpec[] = [];

  for (const spec of specs) {
    const adapter = buildAdapter(spec.provider, env);
    if (adapter === 'unknown') {
      skipped.push({ spec, reason: 'unknown-provider' });
    } else if (adapter === null) {
      skipped.push({ spec, reason: 'missing-credentials' });
    } else {
      bindings.push({ adapter, workforce: spec.workforce });
    }
  }
  return { bindings, skipped };
}
