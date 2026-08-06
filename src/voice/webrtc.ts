/**
 * Structural typings for the browser APIs the voice client touches.
 *
 * The package compiles with `lib: ["ESNext"]` (no DOM — adding it breaks the
 * Bun-typed server code on BlobPart/BufferSource generics), so the WebRTC
 * and media surfaces are declared here as minimal structural interfaces and
 * resolved off `globalThis` at runtime. Real browser objects satisfy them;
 * `VoiceSession.start` feature-detects and throws a clear error elsewhere.
 */

export interface VoiceRTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface VoiceRTCSessionDescriptionInit {
  type: string;
  sdp?: string;
}

export interface VoiceRTCDataChannel {
  readonly readyState: string;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface VoiceMediaStreamTrack {
  readonly kind: string;
  enabled: boolean;
  stop(): void;
}

export interface VoiceMediaStream {
  getTracks(): VoiceMediaStreamTrack[];
  getAudioTracks(): VoiceMediaStreamTrack[];
}

export interface VoiceRTCTrackEvent {
  readonly track: VoiceMediaStreamTrack;
  readonly streams: readonly VoiceMediaStream[];
}

export interface VoiceRTCPeerConnection {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly localDescription: { sdp: string } | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((ev: VoiceRTCTrackEvent) => void) | null;
  addEventListener(type: string, listener: () => void): void;
  addTrack(track: VoiceMediaStreamTrack, stream: VoiceMediaStream): unknown;
  createDataChannel(label: string): VoiceRTCDataChannel;
  createOffer(): Promise<VoiceRTCSessionDescriptionInit>;
  setLocalDescription(desc: VoiceRTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: VoiceRTCSessionDescriptionInit): Promise<void>;
  close(): void;
}

export interface VoiceAudioElement {
  autoplay: boolean;
  volume: number;
  srcObject: VoiceMediaStream | null;
  play(): Promise<void>;
  pause(): void;
}

export interface VoiceAnalyserNode {
  fftSize: number;
  readonly frequencyBinCount: number;
  getByteFrequencyData(array: Uint8Array): void;
}

export interface VoiceAudioContext {
  readonly state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createAnalyser(): VoiceAnalyserNode;
  createMediaStreamSource(stream: VoiceMediaStream): { connect(node: VoiceAnalyserNode): void };
}

/** The browser globals `VoiceSession` resolves off `globalThis` (overridable via `VoiceSessionOptions.globals`). */
export interface VoiceBrowserGlobals {
  RTCPeerConnection: new (config?: { iceServers?: VoiceRTCIceServer[] }) => VoiceRTCPeerConnection;
  Audio: new () => VoiceAudioElement;
  AudioContext?: new () => VoiceAudioContext;
  webkitAudioContext?: new () => VoiceAudioContext;
  navigator?: {
    mediaDevices?: {
      getUserMedia(constraints: { audio: Record<string, unknown> }): Promise<VoiceMediaStream>;
    };
  };
}
