/**
 * `@timbal-ai/timbal-sdk/voice` — browser client for live voice sessions
 * with a Timbal workforce agent, over WebRTC.
 *
 * Browser-safe by construction: no Node/Bun imports, no `process.env`, no
 * platform credentials. Auth stays on your backend — see
 * {@link VoiceSessionOptions.signal}.
 */
export { VoiceSession } from './session';
export type {
  VoiceSessionOptions,
  VoiceSessionStatus,
  VoiceMode,
  VoiceSignalOffer,
  VoiceUserTranscript,
  VoiceAgentText,
} from './types';
export type {
  VoiceBrowserGlobals,
  VoiceRTCConfiguration,
  VoiceRTCIceServer,
  VoiceRTCSessionDescriptionInit,
} from './webrtc';
