import type { ChannelBinding } from './types';
import { telegram } from './adapters/telegram';
import { slack } from './adapters/slack';
import { whatsapp } from './adapters/whatsapp';
import { teams } from './adapters/teams';
import { teamsCredentialOptions } from './adapters/teams-auth';

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
 * | WhatsApp | `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` +          |
 * |          | `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`                 |
 * | Teams    | `TEAMS_APP_ID` + a credential: `TEAMS_APP_PASSWORD`, and/or     |
 * |          | `TEAMS_CERTIFICATE_PRIVATE_KEY` (+ `TEAMS_CERTIFICATE` or       |
 * |          | `TEAMS_CERTIFICATE_THUMBPRINT_SHA256`), or                      |
 * |          | `TEAMS_FEDERATED_TOKEN_FILE` (+ optional `TEAMS_TENANT_ID` for  |
 * |          | single-tenant app registrations)                                |
 *
 * Teams personal-chat file downloads need the certificate or federated
 * credential once Microsoft removes `tempauth` from file URLs (March 1,
 * 2027); a client secret can't get the token they then require.
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

  if (
    env.WHATSAPP_ACCESS_TOKEN &&
    env.WHATSAPP_PHONE_NUMBER_ID &&
    env.WHATSAPP_APP_SECRET &&
    env.WHATSAPP_VERIFY_TOKEN
  ) {
    bindings.push({
      adapter: whatsapp({
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        appSecret: env.WHATSAPP_APP_SECRET,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        expectedPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      }),
      workforce: requireWorkforce('whatsapp'),
    });
  }

  const teamsCredentials = teamsCredentialOptions({
    certificatePrivateKey: env.TEAMS_CERTIFICATE_PRIVATE_KEY,
    certificate: env.TEAMS_CERTIFICATE,
    certificateThumbprintSha256: env.TEAMS_CERTIFICATE_THUMBPRINT_SHA256,
    federatedTokenFile: env.TEAMS_FEDERATED_TOKEN_FILE,
  });
  if (
    env.TEAMS_APP_ID &&
    (env.TEAMS_APP_PASSWORD || teamsCredentials.certificate || teamsCredentials.federatedToken)
  ) {
    bindings.push({
      adapter: teams({
        appId: env.TEAMS_APP_ID,
        appPassword: env.TEAMS_APP_PASSWORD || undefined,
        tenantId: env.TEAMS_TENANT_ID,
        ...teamsCredentials,
      }),
      workforce: requireWorkforce('teams'),
    });
  }

  return bindings;
}
