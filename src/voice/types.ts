import type {
  VoiceBrowserGlobals,
  VoiceRTCIceServer,
  VoiceRTCSessionDescriptionInit,
} from './webrtc';

/** Lifecycle of a {@link VoiceSession}. One-way street: `connecting` → `connected` → `ended` (or `error`). */
export type VoiceSessionStatus = 'connecting' | 'connected' | 'ended' | 'error';

/**
 * Coarse conversational mode, derived from the server's event stream:
 *
 * - `listening` — session idle or user speaking (`session_started`,
 *   `transcript_partial`, `interrupted`)
 * - `thinking`  — user turn committed / a tool is running
 *   (`transcript_committed`, `agent_status`)
 * - `speaking`  — agent text (and its TTS) is streaming
 *   (`agent_text_delta`, `filler`)
 *
 * Heuristic by design: the server paces TTS playback itself and does not
 * announce playback end, so `speaking` persists until the next user or
 * server signal. Drive precise "is audio coming out" UI off
 * {@link VoiceSession.outputVolume} instead.
 */
export type VoiceMode = 'listening' | 'thinking' | 'speaking';

/** The SDP offer body handed to {@link VoiceSessionOptions.signal}. */
export interface VoiceSignalOffer {
  sdp: string;
  type: 'offer';
  /** Session config overrides (deep-merged server-side over `voice_config`). */
  config?: Record<string, unknown>;
}

/** A user-speech transcript update (STT). */
export interface VoiceUserTranscript {
  text: string;
  /** `false` while the user is still speaking (partial), `true` once committed. */
  final: boolean;
  /** On a final transcript: the server re-heard the previous turn — replace it instead of appending. */
  replace?: boolean;
}

/** Streaming agent reply text (the words being spoken as TTS). */
export interface VoiceAgentText {
  /** Next chunk of the reply. */
  delta?: string;
  /** The reply's text is complete (its TTS may still be playing). */
  done?: boolean;
}

export interface VoiceSessionOptions {
  /**
   * Deliver the SDP offer to the platform and return the answer. This is the
   * auth boundary: implement it as a call to YOUR backend, which relays via
   * `timbal.workforce.get(wf).voice.rtc(offer)` under its own credential —
   * the Timbal key never reaches the browser.
   *
   * Return either the parsed answer (`{ sdp, type }`) or the raw `fetch`
   * `Response` (the session checks `ok` and parses for you).
   *
   * ```ts
   * signal: (offer) => fetch("/api/voice/offer", {
   *   method: "POST",
   *   headers: { "Content-Type": "application/json" },
   *   body: JSON.stringify(offer),
   * })
   * ```
   */
  signal: (
    offer: VoiceSignalOffer,
  ) => Promise<Response | VoiceRTCSessionDescriptionInit | Record<string, unknown>>;

  /** Session config overrides (model, `stt_provider`, `filler`, …) — deep-merged server-side. */
  config?: Record<string, unknown>;

  /** ICE servers. Defaults to Timbal's STUN (`stun:turn.timbal.ai:3478`) — platform answers are relay-only and need the offer to carry srflx candidates. */
  iceServers?: VoiceRTCIceServer[];

  /** Microphone device to capture. Omit for the browser default. */
  inputDeviceId?: string;

  /** Extra `getUserMedia` audio constraints, merged over the defaults (echo cancellation, noise suppression, and auto gain all on — the server's barge-in gates assume browser AEC). */
  audioConstraints?: Record<string, unknown>;

  /** Cap on waiting for ICE gathering before sending the (no-trickle) offer. Default 8000ms. */
  iceGatheringTimeoutMs?: number;

  /** Cap on waiting for the peer connection to reach `connected` after signaling. Default 15000ms. The signaling call itself is not subject to this — put any budget on your own `signal` fetch. */
  connectTimeoutMs?: number;

  // ── Callbacks ──

  onStatus?: (status: VoiceSessionStatus) => void;
  onMode?: (mode: VoiceMode) => void;
  onUserTranscript?: (transcript: VoiceUserTranscript) => void;
  onAgentText?: (text: VoiceAgentText) => void;
  /** Barge-in: the agent was cut off. `heardText` is what was actually spoken aloud before the cut (null when unknown) — rewrite the displayed reply to match. */
  onInterrupted?: (info: { heardText: string | null }) => void;
  /** Autoplay policy blocked agent audio. Show a tap-to-unmute control that calls {@link VoiceSession.resumeAudio}. */
  onAudioBlocked?: () => void;
  onError?: (error: Error) => void;
  /** Every server event, raw (`session_started`, `filler`, `session_transcript`, …). Escape hatch and forward-compat channel. */
  onEvent?: (event: Record<string, unknown>) => void;

  /**
   * Override the browser globals the session resolves (`RTCPeerConnection`,
   * `Audio`, `navigator`, `AudioContext`). For tests and non-browser
   * runtimes with WebRTC polyfills; defaults to `globalThis`.
   */
  globals?: Partial<VoiceBrowserGlobals>;
}
