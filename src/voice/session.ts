import type {
  VoiceAgentText,
  VoiceMode,
  VoiceSessionOptions,
  VoiceSessionStatus,
  VoiceSignalOffer,
  VoiceUserTranscript,
} from './types';
import type {
  VoiceAnalyserNode,
  VoiceAudioContext,
  VoiceAudioElement,
  VoiceBrowserGlobals,
  VoiceMediaStream,
  VoiceRTCDataChannel,
  VoiceRTCIceServer,
  VoiceRTCPeerConnection,
  VoiceRTCSessionDescriptionInit,
} from './webrtc';

/** Platform STUN. Platform RTC answers are relay-only — the relay only accepts traffic from addresses it saw in the offer, so the offer must carry srflx candidates. */
const DEFAULT_ICE_SERVERS: VoiceRTCIceServer[] = [{ urls: 'stun:turn.timbal.ai:3478' }];
const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 8_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function resolveGlobals(overrides?: Partial<VoiceBrowserGlobals>): VoiceBrowserGlobals {
  const g = { ...(globalThis as unknown as VoiceBrowserGlobals), ...overrides };
  const missing: string[] = [];
  if (!g.RTCPeerConnection) missing.push('RTCPeerConnection');
  if (!g.Audio) missing.push('Audio');
  if (!g.navigator?.mediaDevices?.getUserMedia) missing.push('navigator.mediaDevices.getUserMedia');
  if (missing.length) {
    throw new Error(
      `VoiceSession requires a browser (or WebRTC polyfills via options.globals). Missing: ${missing.join(', ')}. ` +
        'Server-side, use timbal.workforce.get(id).voice from the main SDK entry instead.',
    );
  }
  return g;
}

/**
 * A live voice conversation with a Timbal workforce agent, over WebRTC.
 *
 * `VoiceSession.start(options)` does everything: microphone capture, peer
 * connection, SDP signaling (through YOUR backend via `options.signal` — no
 * Timbal credential in the browser), agent audio playback, and a typed view
 * over the server's event stream (transcripts, agent text, barge-in).
 *
 * ```ts
 * const session = await VoiceSession.start({
 *   signal: (offer) => fetch("/api/voice/offer", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify(offer),
 *   }),
 *   onMode: (m) => setAgentState(m),
 *   onUserTranscript: (t) => showCaption(t),
 *   onAgentText: (t) => t.delta && appendReply(t.delta),
 * });
 * // …
 * session.end();
 * ```
 *
 * TTS arrives as a real audio track — the browser handles decode, jitter and
 * clock, and the server paces its own playback so barge-in truncation is
 * exact. Events ride a WebRTC data channel. There is no audio-frame plumbing
 * in this client at all.
 */
export class VoiceSession {
  /** Current lifecycle status. Transitions surface on `onStatus`. */
  public status: VoiceSessionStatus = 'connecting';
  /** Current conversational mode (heuristic — see {@link VoiceMode}). */
  public mode: VoiceMode = 'listening';
  /** The raw `session_started` payload (model, STT provider, turn detector, ambient …), once received. */
  public info: Record<string, unknown> | null = null;
  /** True when autoplay policy blocked agent audio; call {@link resumeAudio} from a user gesture. */
  public audioBlocked = false;

  private readonly opts: VoiceSessionOptions;
  private readonly g: VoiceBrowserGlobals;
  private pc: VoiceRTCPeerConnection | null = null;
  private dc: VoiceRTCDataChannel | null = null;
  private micStream: VoiceMediaStream | null = null;
  private remoteStream: VoiceMediaStream | null = null;
  private audioEl: VoiceAudioElement | null = null;
  private audioCtx: VoiceAudioContext | null = null;
  private inputAnalyser: VoiceAnalyserNode | null = null;
  private outputAnalyser: VoiceAnalyserNode | null = null;
  private userEnded = false;

  private constructor(opts: VoiceSessionOptions, g: VoiceBrowserGlobals) {
    this.opts = opts;
    this.g = g;
  }

  /** Open a session: mic → peer connection → signaling → live. Resolves once the connection is up (events may still take a moment — the first session loads STT/turn models server-side). */
  static async start(options: VoiceSessionOptions): Promise<VoiceSession> {
    const session = new VoiceSession(options, resolveGlobals(options.globals));
    try {
      await session.connect();
      return session;
    } catch (err) {
      session.teardown();
      session.setStatus('error');
      throw err;
    }
  }

  private async connect(): Promise<void> {
    const { opts, g } = this;

    this.micStream = await g.navigator!.mediaDevices!.getUserMedia({
      audio: {
        // Always on: the server's barge-in echo gates assume browser AEC is doing its job.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(opts.inputDeviceId && { deviceId: { exact: opts.inputDeviceId } }),
        ...opts.audioConstraints,
      },
    });
    const micTrack = this.micStream.getAudioTracks()[0];
    if (!micTrack) throw new Error('getUserMedia returned a stream with no audio track');

    const pc = new g.RTCPeerConnection({ iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS });
    this.pc = pc;
    pc.addTrack(micTrack, this.micStream);

    // Client-created so the SCTP m-line rides the offer — the server binds
    // to whatever channel the offer carries.
    const dc = pc.createDataChannel('events');
    this.dc = dc;
    dc.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return; // not JSON — ignore
      }
      this.handleServerEvent(msg);
    };

    pc.ontrack = (e) => {
      // TTS as a real track: browser handles decode/jitter/clock; the server
      // paces playback itself so barge-in truncation is exact — no acks.
      this.remoteStream = e.streams[0] ?? null;
      this.outputAnalyser = null; // re-tap on the new stream if meters are in use
      if (!this.audioEl) {
        this.audioEl = new g.Audio();
        this.audioEl.autoplay = true;
      }
      this.audioEl.srcObject = this.remoteStream;
      this.audioEl.play().catch(() => {
        this.audioBlocked = true;
        opts.onAudioBlocked?.();
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === 'connected' && this.status === 'connecting') {
        this.setStatus('connected');
      }
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        if (this.status === 'ended' || this.status === 'error') return;
        if (!this.userEnded && pc.connectionState === 'failed') {
          opts.onError?.(new Error('Voice connection failed'));
        }
        this.teardown();
        this.setStatus('ended');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // One-round-trip, no-trickle signaling: wait (bounded) for ICE gathering
    // so the offer is complete before it ships.
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }

    const offerBody: VoiceSignalOffer = {
      sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
      type: 'offer',
      ...(opts.config && { config: opts.config }),
    };
    const answer = await this.resolveAnswer(await opts.signal(offerBody));
    if (this.userEnded) return; // end() raced the signaling round-trip
    await pc.setRemoteDescription(answer);

    await this.waitConnected(pc, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  }

  /** Accept both shapes from `signal`: a parsed answer object, or the raw `Response`. */
  private async resolveAnswer(result: unknown): Promise<VoiceRTCSessionDescriptionInit> {
    let answer = result as Record<string, unknown> | null;
    if (result && typeof (result as Response).json === 'function' && 'ok' in (result as Response)) {
      const resp = result as Response;
      if (!resp.ok) {
        let detail = `Voice signaling failed (${resp.status}).`;
        try {
          const body = (await resp.json()) as Record<string, unknown>;
          if (typeof body.error === 'string') detail = body.error;
          else if (typeof body.message === 'string') detail = body.message;
        } catch {
          /* non-JSON error body */
        }
        if (resp.status === 501) {
          detail += ' The target timbal lacks WebRTC voice support — needs timbal[voice] >= 2.3.2.';
        }
        throw new Error(detail);
      }
      answer = (await resp.json()) as Record<string, unknown>;
    }
    if (!answer || typeof answer.sdp !== 'string' || typeof answer.type !== 'string') {
      throw new Error('Voice signaling returned an invalid SDP answer (expected { sdp, type })');
    }
    return answer as unknown as VoiceRTCSessionDescriptionInit;
  }

  private waitConnected(pc: VoiceRTCPeerConnection, timeoutMs: number): Promise<void> {
    if (pc.connectionState === 'connected') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Voice connection did not establish within ${timeoutMs}ms`)),
        timeoutMs,
      );
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') {
          clearTimeout(timer);
          resolve();
        } else if (['failed', 'closed'].includes(pc.connectionState)) {
          clearTimeout(timer);
          reject(new Error(`Voice connection ${pc.connectionState} during setup`));
        }
      });
    });
  }

  // ── Server events ──

  private handleServerEvent(msg: Record<string, unknown>): void {
    const { opts } = this;
    opts.onEvent?.(msg);

    switch (msg.type) {
      case 'session_started':
        this.info = msg;
        this.setMode('listening');
        break;
      case 'transcript_partial':
        this.setMode('listening');
        opts.onUserTranscript?.({ text: String(msg.text ?? ''), final: false });
        break;
      case 'transcript_committed':
        this.setMode('thinking');
        opts.onUserTranscript?.({
          text: String(msg.text ?? ''),
          final: true,
          ...(msg.replace ? { replace: true } : {}),
        } as VoiceUserTranscript);
        break;
      case 'agent_status':
        this.setMode('thinking');
        break;
      case 'filler':
        // Spoken latency-masker. Deliberately NOT surfaced as agent text —
        // barge-in rewrites must never fold it into the reply. Riding
        // onEvent above is its only channel.
        this.setMode('speaking');
        break;
      case 'agent_text_delta':
        this.setMode('speaking');
        opts.onAgentText?.({ delta: String(msg.text ?? '') } as VoiceAgentText);
        break;
      case 'agent_text_done':
        opts.onAgentText?.({ done: true });
        break;
      case 'interrupted':
        this.setMode('listening');
        opts.onInterrupted?.({
          heardText: msg.heard_text === undefined || msg.heard_text === null ? null : String(msg.heard_text),
        });
        break;
      case 'error':
        opts.onError?.(new Error(String(msg.message ?? 'voice session error')));
        break;
      case 'session_ended':
        this.teardown();
        this.setStatus('ended');
        break;
      // session_started details, session_transcript, unknown/future types:
      // available via onEvent.
    }
  }

  private setStatus(status: VoiceSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private setMode(mode: VoiceMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.opts.onMode?.(mode);
  }

  // ── Controls ──

  /** Microphone mute. Keeps the track (and the connection) alive — flip freely. */
  get muted(): boolean {
    const track = this.micStream?.getAudioTracks()[0];
    return track ? !track.enabled : true;
  }

  set muted(value: boolean) {
    const track = this.micStream?.getAudioTracks()[0];
    if (track) track.enabled = !value;
  }

  /** Agent audio volume, 0–1. */
  setVolume(volume: number): void {
    if (this.audioEl) this.audioEl.volume = Math.min(1, Math.max(0, volume));
  }

  /**
   * Resume agent audio after an autoplay-policy block ({@link audioBlocked} /
   * `onAudioBlocked`). Must run in a user-gesture handler (click/tap). Also
   * resumes the metering context, so call it before trusting the volume
   * getters on gesture-gated browsers.
   */
  async resumeAudio(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume().catch(() => {});
    }
    if (!this.audioEl) return;
    await this.audioEl.play();
    this.audioBlocked = false;
  }

  /** Microphone level, 0–1 (for VU meters). Lazily taps the mic stream; 0 until audio is flowing or when the runtime lacks `AudioContext`. */
  get inputVolume(): number {
    if (!this.inputAnalyser && this.micStream) {
      this.inputAnalyser = this.tapStream(this.micStream);
    }
    return this.readLevel(this.inputAnalyser);
  }

  /** Agent (TTS) output level, 0–1. Same contract as {@link inputVolume}. */
  get outputVolume(): number {
    if (!this.outputAnalyser && this.remoteStream) {
      this.outputAnalyser = this.tapStream(this.remoteStream);
    }
    return this.readLevel(this.outputAnalyser);
  }

  /**
   * Raw JSON up the event data channel. Escape hatch for protocol messages
   * this client doesn't model; the server ignores types it doesn't know.
   */
  send(event: Record<string, unknown>): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  /** End the session: stops the mic, closes the connection (the per-session server box exits with it), releases audio resources. Idempotent. */
  end(): void {
    if (this.userEnded) return;
    this.userEnded = true;
    this.teardown();
    if (this.status !== 'error') this.setStatus('ended');
  }

  // ── Internals ──

  private tapStream(stream: VoiceMediaStream): VoiceAnalyserNode | null {
    const Ctx = this.g.AudioContext ?? this.g.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      this.audioCtx.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  private readLevel(analyser: VoiceAnalyserNode | null): number {
    if (!analyser || this.audioCtx?.state !== 'running') return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]!;
    return sum / (data.length * 255);
  }

  private teardown(): void {
    if (this.dc) {
      this.dc.onmessage = null;
      try {
        this.dc.close();
      } catch {
        /* already closed */
      }
      this.dc = null;
    }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* already closed */
      }
      this.pc = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    if (this.audioEl) {
      try {
        this.audioEl.pause();
      } catch {
        /* detached element */
      }
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    this.remoteStream = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
