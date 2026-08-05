import type { ApiClient } from '../api';
import type {
  VoiceTicket,
  VoiceContext,
  VoiceWsUrlOptions,
  VoiceConnectOptions,
  VoiceRtcOptions,
} from '../../types';
import { buildQueryString } from '../utils';
import {
  resolveContext,
  requireRemoteContext,
  isLocalEnvironment,
  isStudioEnvironment,
  resolveLocalWorkforceItem,
  resolveLocalDeployment,
} from './workforce';

// ── Wire constants ──

/** Subprotocol every timbal voice client announces on the platform dial. */
export const VOICE_SUBPROTOCOL = 'timbal.v1';
/**
 * Subprotocol entry carrying a bearer credential on the upgrade — the same
 * channel the platform auth guard reads when there is no `Authorization`
 * header. Stripped by the platform before the upgrade is forwarded upstream.
 */
export const VOICE_BEARER_SUBPROTOCOL_PREFIX = 'timbal.bearer.';

// ── Routing ──
//
// Same tri-mode fork as call/stream, with preview standing in for studio:
//
//   preview (auto: TIMBAL_STUDIO, overridable) → …/voice/preview  (GET WS / POST RTC)
//   local   (TIMBAL_START_WORKFORCE)           → http://localhost:{port}/voice/{ws,rtc}
//   remote  (default)                          → …/voice/ws | …/voice/rtc
//
// Tickets are platform-only (`…/voice/ticket`) and the SAME ticket opens both
// the deployed and the preview transport — tickets pin workforce + rev, not
// deployment.

function usePreview(opts?: VoiceContext): boolean {
  return opts?.preview ?? isStudioEnvironment();
}

function useLocal(opts?: VoiceContext): boolean {
  return isLocalEnvironment() && !usePreview(opts);
}

/** Base URL of the local `timbal.server` box for this workforce. */
async function localVoiceBase(identifier: string): Promise<string> {
  const item = await resolveLocalWorkforceItem(identifier);
  const key = item.uid ?? item.name ?? item.id;
  const base = key ? resolveLocalDeployment(key) : null;
  if (!base) throw new Error(`Could not resolve local workforce for: ${identifier}`);
  return base;
}

/**
 * Platform endpoint (relative to the API base) for one voice leaf. The
 * workforce identifier goes in the path verbatim — the platform resolves
 * id / uid / name itself, so no list round-trip is needed here.
 */
function platformVoiceEndpoint(
  client: ApiClient,
  identifier: string,
  opts: VoiceContext | undefined,
  leaf: 'ws' | 'rtc' | 'ticket',
): string {
  const { orgId, projectId, rev } = requireRemoteContext(resolveContext(client, opts));
  // Ticket minting has no preview variant — the one endpoint serves both.
  const tail = leaf !== 'ticket' && usePreview(opts) ? 'preview' : leaf;
  return (
    `orgs/${orgId}/projects/${projectId}/workforce/` +
    `${encodeURIComponent(identifier)}/voice/${tail}${buildQueryString({ rev })}`
  );
}

// ── Public functions ──

interface RawVoiceTicket {
  ticket: string;
  expires_at: number;
  ttl_secs: number;
}

/**
 * Mint an ephemeral single-use voice ticket for this workforce + rev.
 *
 * `POST /orgs/{org}/projects/{proj}/workforce/{wf}/voice/ticket?rev={rev}`
 * with the SDK's configured credential (API key or OAuth token — the gate is
 * `ProjectsRunsWrite` either way). The ticket authenticates exactly one
 * WebSocket connect, deployed or preview, within its ~60s TTL.
 *
 * Platform-only: throws in pure-local mode, where there is nothing to
 * authenticate against.
 */
export async function mintVoiceTicket(
  client: ApiClient,
  identifier: string,
  ctx?: VoiceContext,
): Promise<VoiceTicket> {
  if (useLocal(ctx)) {
    throw new Error(
      'Voice tickets are a platform credential — a local timbal.server has no ticket endpoint.',
    );
  }
  const endpoint = platformVoiceEndpoint(client, identifier, ctx, 'ticket');
  const res = await client.post<RawVoiceTicket>(endpoint);
  return {
    ticket: res.data.ticket,
    expiresAt: res.data.expires_at,
    ttlSecs: res.data.ttl_secs,
  };
}

/**
 * Build the voice WebSocket URL for this workforce — no network call, but
 * async because local mode may scan `timbal.yaml` manifests on disk to map
 * the identifier to its port.
 *
 * Hand this (plus a ticket from `mintVoiceTicket`) to a browser and it has
 * everything it needs to dial:
 *
 * ```ts
 * const { ticket } = await wf.voice.ticket();
 * const url = await wf.voice.wsUrl({ ticket });
 * // browser side:
 * new WebSocket(url, ['timbal.v1']);
 * ```
 */
export async function voiceWsUrl(
  client: ApiClient,
  identifier: string,
  opts?: VoiceWsUrlOptions,
): Promise<string> {
  if (useLocal(opts)) {
    const base = await localVoiceBase(identifier);
    return `${base.replace(/^http/i, 'ws')}/voice/ws`;
  }
  const endpoint = platformVoiceEndpoint(client, identifier, opts, 'ws');
  const base = client.getConfig().baseUrl.replace(/\/+$/, '').replace(/^http/i, 'ws');
  const ticket = opts?.ticket ? `&ticket=${encodeURIComponent(opts.ticket)}` : '';
  return `${base}/${endpoint}${ticket}`;
}

/** Resolve when the socket opens; reject (and close it) on error/close/timeout. */
function waitOpen(ws: WebSocket, url: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    ws.addEventListener('open', () => settle(resolve), { once: true });
    // The error event carries nothing useful cross-runtime; the close that
    // follows has the code/reason. Listen to both, first rejection wins.
    ws.addEventListener(
      'error',
      () => settle(() => reject(new Error(`Voice WebSocket connect failed: ${url}`))),
      { once: true },
    );
    ws.addEventListener(
      'close',
      (ev) =>
        settle(() =>
          reject(
            new Error(
              `Voice WebSocket closed before opening (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`,
            ),
          ),
        ),
      { once: true },
    );
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Voice WebSocket did not open within ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

/**
 * Open the voice WebSocket for this workforce and resolve once it is live.
 *
 * Transport-level only: the resolved socket speaks the timbal voice wire
 * protocol (binary audio frames + JSON events, `binaryType` preset to
 * `'arraybuffer'`); this SDK does not interpret it.
 *
 * Auth (platform targets) defaults to the `timbal.bearer.<token>`
 * subprotocol with the SDK's configured credential. Pass `auth: 'ticket'`
 * to mint-and-dial with a single-use ticket instead (or supply a pre-minted
 * one via `ticket`). Local targets dial bare.
 */
export async function connectVoice(
  client: ApiClient,
  identifier: string,
  opts: VoiceConnectOptions = {},
): Promise<WebSocket> {
  const local = useLocal(opts);
  const auth = opts.auth ?? (opts.ticket ? 'ticket' : local ? 'none' : 'bearer');

  let ticket: string | undefined;
  if (!local && auth === 'ticket') {
    ticket = opts.ticket ?? (await mintVoiceTicket(client, identifier, opts)).ticket;
  }

  const url = await voiceWsUrl(client, identifier, { ...opts, ticket });

  const protocols: string[] = [];
  if (!local) {
    protocols.push(VOICE_SUBPROTOCOL);
    if (auth === 'bearer') {
      const token = client.getConfig().token;
      if (!token) {
        throw new Error(
          "Voice connect with auth 'bearer' requires a configured token. Provide one or use auth: 'ticket'.",
        );
      }
      protocols.push(`${VOICE_BEARER_SUBPROTOCOL_PREFIX}${token}`);
    }
  }
  if (opts.protocols) protocols.push(...opts.protocols);

  const ws = new WebSocket(url, protocols.length ? protocols : undefined);
  ws.binaryType = 'arraybuffer';
  await waitOpen(ws, url, opts.timeoutMs);
  return ws;
}

/**
 * WebRTC signaling: POST an SDP offer, get the answer `Response` back.
 *
 * The offer is the JSON the timbal voice runtime expects —
 * `{ sdp, type: 'offer', config? }` — passed as an object (JSON-encoded for
 * you) or a pre-encoded string. Returns the raw `Response`; the caller
 * checks `ok` and parses the answer (`await resp.json()` →
 * `{ sdp, type: 'answer' }` for `setRemoteDescription`).
 *
 * Server-side proxying is the intended platform use: your API forwards an
 * end-user's offer under its own credential without exposing the Timbal
 * key. Note the box's lifetime is the session — each accepted offer spawns
 * one; don't fire spurious ones.
 */
export async function rtcVoice(
  client: ApiClient,
  identifier: string,
  offer: Record<string, unknown> | string,
  opts: VoiceRtcOptions = {},
): Promise<Response> {
  const body = typeof offer === 'string' ? offer : JSON.stringify(offer);
  const contentType = typeof offer === 'string' ? (opts.contentType ?? 'application/json') : 'application/json';
  const signal =
    opts.signal ?? (opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined);

  if (useLocal(opts)) {
    const base = await localVoiceBase(identifier);
    return fetch(`${base}/voice/rtc`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      ...(signal && { signal }),
    });
  }

  const endpoint = platformVoiceEndpoint(client, identifier, opts, 'rtc');
  return client.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    ...(signal && { signal }),
  });
}
