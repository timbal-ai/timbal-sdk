import type { ChannelBinding } from './types';
import { telegram } from './adapters/telegram';
import { slack } from './adapters/slack';

export interface ChannelBindingsFromEnvOptions {
  /**
   * Workforce component every env-configured channel talks to. Falls back to
   * the `CHANNELS_WORKFORCE` env var. Required when at least one channel's
   * credentials are present.
   */
  workforce?: string;
  /** Environment source (injectable for tests). @default process.env */
  env?: Record<string, string | undefined>;
}

/**
 * Build channel bindings from environment conventions — the zero-config
 * complement to hand-writing a `ChannelBinding[]`, mirroring how
 * `timbalAuth()` bootstraps from `TIMBAL_*` env. A channel is bound iff its
 * credentials are present:
 *
 * | Channel  | Env vars                                                        |
 * |----------|-----------------------------------------------------------------|
 * | Telegram | `TELEGRAM_BOT_TOKEN` (+ optional `TELEGRAM_SECRET_TOKEN`)       |
 * | Slack    | `SLACK_SIGNING_SECRET` + `SLACK_BOT_TOKEN`                      |
 *
 * All bindings target `CHANNELS_WORKFORCE` (or the `workforce` option).
 * Multiple providers → one component; for per-provider routing, hand-write
 * bindings instead.
 *
 * Returns `[]` when no channel credentials are set. Throws when credentials
 * ARE set but no workforce is resolvable — a silently unbound channel is a
 * much worse failure mode (webhooks 404 with no hint why).
 */
export function channelBindingsFromEnv(
  options: ChannelBindingsFromEnvOptions = {},
): ChannelBinding[] {
  const env = options.env ?? process.env;
  const bindings: ChannelBinding[] = [];
  const workforce = options.workforce || env.CHANNELS_WORKFORCE;

  const requireWorkforce = (provider: string): string => {
    if (!workforce) {
      throw new Error(
        `${provider} channel credentials found in env, but no workforce target. ` +
          `Set CHANNELS_WORKFORCE to the component's id, uid, or name.`,
      );
    }
    return workforce;
  };

  if (env.TELEGRAM_BOT_TOKEN) {
    bindings.push({
      adapter: telegram({
        botToken: env.TELEGRAM_BOT_TOKEN,
        secretToken: env.TELEGRAM_SECRET_TOKEN,
      }),
      workforce: requireWorkforce('telegram'),
    });
  }

  if (env.SLACK_SIGNING_SECRET && env.SLACK_BOT_TOKEN) {
    bindings.push({
      adapter: slack({
        signingSecret: env.SLACK_SIGNING_SECRET,
        botToken: env.SLACK_BOT_TOKEN,
      }),
      workforce: requireWorkforce('slack'),
    });
  }

  return bindings;
}
