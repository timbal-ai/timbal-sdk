import type { Project, ProjectChannelSpec } from '../types';
import type { ChannelAdapter, ChannelBinding } from './types';
import { telegram } from './adapters/telegram';
import { slack } from './adapters/slack';
import { whatsapp } from './adapters/whatsapp';
import { teams } from './adapters/teams';

/**
 * Platform-driven channel configuration.
 *
 * Topology (which channels, which workforce) lives on the platform project;
 * credentials live platform-side too (encrypted under the project DEK) and
 * arrive **only** via the service-principal runtime endpoint — never on the
 * project payload, which renders everywhere. Env vars remain a per-provider
 * fallback for local dev, self-hosted, and migration.
 */

/**
 * Drop disabled and malformed entries so downstream code only ever sees
 * actionable specs. Returns `null` when the input isn't an array (older
 * platform / absent field) — callers use that to fall through.
 */
export function filterChannelSpecs(raw: unknown): ProjectChannelSpec[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (spec): spec is ProjectChannelSpec =>
      !!spec &&
      typeof (spec as ProjectChannelSpec).provider === 'string' &&
      !!(spec as ProjectChannelSpec).provider &&
      typeof (spec as ProjectChannelSpec).workforce === 'string' &&
      !!(spec as ProjectChannelSpec).workforce &&
      (spec as ProjectChannelSpec).enabled !== false,
  );
}

/**
 * Pure mapper: platform `Project` → channel specs (topology only), or `null`
 * when the platform response predates the channels feature.
 */
export function channelSpecsFromProject(project: Project): ProjectChannelSpec[] | null {
  return filterChannelSpecs(project.channels);
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
 * Adapter factory for one spec. Credential precedence is **per field**:
 * platform-held `spec.credentials` first (the runtime-endpoint path — no
 * env, no redeploy, supports multiple bots of one provider), then env
 * convention vars. Returns `null` when neither source has the provider's
 * secrets, `'unknown'` for providers this SDK version doesn't ship.
 */
function buildAdapter(
  spec: ProjectChannelSpec,
  env: Record<string, string | undefined>,
): ChannelAdapter | null | 'unknown' {
  const creds = spec.credentials ?? {};
  switch (spec.provider) {
    case 'telegram': {
      const botToken = creds.token || env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return null;
      return telegram({
        botToken,
        secretToken: creds.secret_token || env.TELEGRAM_SECRET_TOKEN,
      });
    }
    case 'slack': {
      const botToken = creds.bot_token || env.SLACK_BOT_TOKEN;
      const signingSecret = creds.signing_secret || env.SLACK_SIGNING_SECRET;
      if (!botToken || !signingSecret) return null;
      return slack({ botToken, signingSecret });
    }
    case 'whatsapp': {
      const accessToken = creds.access_token || env.WHATSAPP_ACCESS_TOKEN;
      const phoneNumberId = creds.phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID;
      const appSecret = creds.app_secret || env.WHATSAPP_APP_SECRET;
      const verifyToken = creds.verify_token || env.WHATSAPP_VERIFY_TOKEN;
      if (!accessToken || !phoneNumberId || !appSecret || !verifyToken) return null;
      return whatsapp({ accessToken, phoneNumberId, appSecret, verifyToken });
    }
    case 'teams': {
      const appId = creds.app_id || env.TEAMS_APP_ID;
      const appPassword = creds.app_password || env.TEAMS_APP_PASSWORD;
      const tenantId = creds.tenant_id || env.TEAMS_TENANT_ID;
      if (!appId || !appPassword) return null;
      return teams({ appId, appPassword, tenantId });
    }
    default:
      return 'unknown';
  }
}

/**
 * Join platform specs with credentials into live bindings. Specs whose
 * provider is unknown to this SDK version, or whose credentials aren't
 * present platform-side or in env, are returned in `skipped` — the caller
 * decides whether that's a log line or an error.
 */
export function materializeChannelBindings(
  specs: ProjectChannelSpec[],
  env: Record<string, string | undefined> = process.env,
): MaterializedBindings {
  const bindings: ChannelBinding[] = [];
  const skipped: SkippedChannelSpec[] = [];

  for (const spec of specs) {
    const adapter = buildAdapter(spec, env);
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
