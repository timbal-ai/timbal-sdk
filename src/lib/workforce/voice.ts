import type { ApiClient } from '../api';
import type {
  VoiceTicket,
  VoiceContext,
  VoiceWsUrlOptions,
  VoiceConnectOptions,
  VoiceRtcOptions,
  VoiceSessionCreateOptions,
  VoiceSessionConnection,
} from '../../types';
import {
  mintVoiceTicket as mintVoiceTicketFn,
  voiceWsUrl as voiceWsUrlFn,
  connectVoice as connectVoiceFn,
  rtcVoice as rtcVoiceFn,
  createVoiceSession,
} from '../functions/voice';

/**
 * Voice surface of a single workforce — reached via
 * `timbal.workforce.get(identifier).voice`.
 *
 * Current platform browsers use {@link createSession} and the optional
 * `@timbal-ai/timbal-sdk/voice/livekit` client. The legacy WebSocket and SDP
 * helpers remain available for compatible servers; platform browser WS/SDP
 * requests are sunset. {@link rtc} remains the raw signaling escape hatch.
 */
export class WorkforceVoice {
  constructor(
    public readonly apiClient: ApiClient,
    public readonly identifier: string,
  ) {}

  /** Create a LiveKit session using the platform's supported browser transport. */
  createSession(opts?: VoiceSessionCreateOptions): Promise<VoiceSessionConnection> {
    return createVoiceSession(this.apiClient, this.identifier, opts);
  }

  /**
   * Mint an ephemeral single-use ticket for opening this workforce's voice
   * WebSocket from a browser.
   *
   * ~60s TTL, exactly one connect, pinned to this workforce + rev (the same
   * ticket opens the deployed and the preview transport). Mint immediately
   * before dialing — and mint a fresh one per retry, a failed connect still
   * burns it.
   *
   * ```ts
   * // API route: vend connect material to your frontend
   * const { ticket } = await wf.voice.ticket();
   * const url = await wf.voice.wsUrl();
   * return { url, ticket }; // browser: new WebSocket(`${url}&ticket=${ticket}`, ['timbal.v1'])
   * ```
   */
  ticket(ctx?: VoiceContext): Promise<VoiceTicket> {
    return mintVoiceTicketFn(this.apiClient, this.identifier, ctx);
  }

  /**
   * Voice WebSocket URL for this workforce (`wss://…/voice/ws?rev=…`, or the
   * preview / local variant). Pass `{ ticket }` to embed one as `?ticket=…`.
   *
   * No network call — the platform resolves id / uid / name from the path
   * itself. Async only because local mode may scan manifests on disk.
   */
  wsUrl(opts?: VoiceWsUrlOptions): Promise<string> {
    return voiceWsUrlFn(this.apiClient, this.identifier, opts);
  }

  /**
   * Dial the voice WebSocket and resolve once it is open.
   *
   * Defaults: bearer-subprotocol auth with the SDK's credential on platform
   * targets, bare dial on local ones. `auth: 'ticket'` mints-and-dials with
   * a single-use ticket instead. The socket comes back with `binaryType`
   * set to `'arraybuffer'`, ready for the voice frame protocol.
   *
   * ```ts
   * const ws = await wf.voice.connect();
   * ws.addEventListener('message', (ev) => { ... });
   * ws.close();
   * ```
   */
  connect(opts?: VoiceConnectOptions): Promise<WebSocket> {
    return connectVoiceFn(this.apiClient, this.identifier, opts);
  }

  /**
   * Relay WebRTC signaling: POST the SDP offer
   * (`{ sdp, type: 'offer', config? }`), return the raw answer `Response`.
   *
   * The intended platform pattern is proxying: your API forwards an
   * end-user's offer under its own credential, the answer goes back to the
   * browser's `setRemoteDescription`, media flows directly. Each accepted
   * offer starts one voice session.
   */
  rtc(offer: Record<string, unknown> | string, opts?: VoiceRtcOptions): Promise<Response> {
    return rtcVoiceFn(this.apiClient, this.identifier, offer, opts);
  }
}
