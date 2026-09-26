import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  createLocalAudioTrack,
  createAudioAnalyser,
  type AudioCaptureOptions,
  type RoomEventCallbacks,
  type LocalAudioTrack,
  type RemoteAudioTrack,
} from 'livekit-client';
import { resolveVoiceSessionConnection, type VoiceSessionConnection } from '../connection';
import type { VoiceMode, VoiceUserTranscript, VoiceAgentText } from '../types';
import { VoiceEventDecoder, type VoiceEvent } from './events';

export type { VoiceSessionConnection, VoiceEvent };
export type LiveKitVoiceStatus =
  | 'connecting'
  | 'initializing'
  | 'ready'
  | 'reconnecting'
  | 'ended'
  | 'error';
export interface LiveKitVoiceOptions {
  /** Call your authenticated backend, which uses wf.voice.createSession(). */
  connect: (signal: AbortSignal) => Promise<VoiceSessionConnection | Response>;
  /** Abort startup or end an active call (e.g. when a component unmounts). */
  signal?: AbortSignal;
  /** Total startup budget, including microphone, backend, room and agent readiness. Default 120s. */
  startupTimeoutMs?: number;
  audioConstraints?: AudioCaptureOptions;
  onStatus?: (status: LiveKitVoiceStatus) => void;
  onMode?: (mode: VoiceMode) => void;
  onUserTranscript?: (transcript: VoiceUserTranscript) => void;
  onAgentText?: (text: VoiceAgentText & { text?: string; runId?: string | null }) => void;
  onInterrupted?: (info: { heardText: string | null }) => void;
  onTranscript?: (entries: unknown[], startedAt?: number) => void;
  onAudioBlocked?: () => void;
  onError?: (error: Error) => void;
  /** Includes metrics, usage, approvals and interactions without dropping unknown event types. */
  onEvent?: (event: VoiceEvent) => void;
  /** Dependency injection for tests or an application-configured Room. Must be a fresh room. */
  roomFactory?: () => Room;
  /** Optional microphone factory; the session takes ownership and stops the returned track. */
  microphoneFactory?: (options: AudioCaptureOptions) => Promise<LocalAudioTrack>;
}

type Meter = ReturnType<typeof createAudioAnalyser>;
const TOPIC = 'timbal.events';

/** Browser-only LiveKit transport; legacy VoiceSession remains on @timbal-ai/timbal-sdk/voice. */
export class LiveKitVoiceSession {
  status: LiveKitVoiceStatus = 'connecting';
  mode: VoiceMode = 'listening';
  info: VoiceEvent | null = null;
  sessionId?: string;
  audioBlocked = false;
  private room: Room;
  private mic?: LocalAudioTrack;
  private tracks = new Set<RemoteAudioTrack>();
  private inputMeter?: Meter;
  private outputMeter?: Meter;
  private volume = 1;
  private closed = false;
  private published = false;
  private disconnectedAgents = new Set<string>();
  private controller = new AbortController();
  private decoder = new VoiceEventDecoder();
  private resolveReady!: () => void;
  private ready = new Promise<void>(resolve => {
    this.resolveReady = resolve;
  });
  private listeners: Array<() => void> = [];
  private abort = () => {
    this.end();
  };

  private constructor(private opts: LiveKitVoiceOptions) {
    this.room = opts.roomFactory?.() ?? new Room();
  }

  /** Resolves only after microphone publication AND Timbal session_started, not participant presence. */
  static async start(opts: LiveKitVoiceOptions): Promise<LiveKitVoiceSession> {
    const timeout = opts.startupTimeoutMs ?? 120_000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('startupTimeoutMs must be positive');
    const session = new LiveKitVoiceSession(opts);
    const timer = setTimeout(
      () =>
        session.fail(
          new Error(
            `Voice startup timed out while ${session.status}; the agent did not become ready`
          )
        ),
      timeout
    );
    opts.signal?.addEventListener('abort', session.abort, { once: true });
    try {
      if (opts.signal?.aborted) session.end();
      session.assertOpen();
      opts.onStatus?.('connecting');
      await session.open();
      return session;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!session.closed) session.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw this.controller.signal.reason ?? new Error('Voice session ended');
  }

  /** Abort pending work immediately; late-created resources are released by their acquisition handlers. */
  private async step<T>(work: Promise<T>): Promise<T> {
    if (this.closed) {
      void work.catch(() => {});
      this.assertOpen();
    }
    const signal = this.controller.signal;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('Voice session ended'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private async open(): Promise<void> {
    const { room, opts } = this;
    this.listen(
      RoomEvent.DataReceived,
      (
        bytes: Uint8Array,
        participant: { identity: string } | undefined,
        _kind: unknown,
        topic: string | undefined
      ) => {
        if (topic !== TOPIC || !participant?.identity.startsWith('agent-') || this.closed) return;
        try {
          const event = this.decoder.decode(bytes);
          if (event) this.handleEvent(event);
        } catch (error) {
          opts.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    );
    this.listen(RoomEvent.TrackSubscribed, (remoteTrack, _publication, participant) => {
      const track = remoteTrack as RemoteAudioTrack;
      if (
        track.kind !== Track.Kind.Audio ||
        !participant.identity.startsWith('agent-') ||
        this.closed
      )
        return;
      this.tracks.add(track);
      track.setVolume(this.volume);
      const element = track.attach();
      element.play().catch(() => {
        if (!this.closed) {
          this.audioBlocked = true;
          opts.onAudioBlocked?.();
        }
      });
    });
    this.listen(RoomEvent.TrackUnsubscribed, remoteTrack => {
      const track = remoteTrack as RemoteAudioTrack;
      if (this.tracks.delete(track)) {
        track.detach().forEach(element => element.remove());
        void this.outputMeter?.cleanup().catch(() => {});
        this.outputMeter = undefined;
      }
    });
    this.listen(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.audioBlocked = !room.canPlaybackAudio;
      if (this.audioBlocked) opts.onAudioBlocked?.();
    });
    this.listen(RoomEvent.Reconnecting, () => this.setStatus('reconnecting'));
    this.listen(RoomEvent.SignalReconnecting, () => this.setStatus('reconnecting'));
    this.listen(RoomEvent.Reconnected, () => {
      // LiveKit has applied the new room snapshot before emitting Reconnected.
      if (this.checkDisconnectedAgents())
        this.setStatus(this.info && this.published ? 'ready' : 'initializing');
    });
    this.listen(RoomEvent.Disconnected, () => {
      if (!this.closed) this.fail(new Error('Voice room disconnected'));
    });
    this.listen(RoomEvent.ParticipantDisconnected, (participant: { identity: string }) => {
      if (!participant.identity.startsWith('agent-') || this.closed) return;
      this.disconnectedAgents.add(participant.identity);
      // A full restart removes participants synchronously BEFORE changing room
      // state and emitting Reconnecting. Decide after that transition finishes.
      queueMicrotask(() => {
        if (
          this.closed ||
          this.status === 'reconnecting' ||
          room.state === ConnectionState.Reconnecting ||
          room.state === ConnectionState.SignalReconnecting
        )
          return;
        this.checkDisconnectedAgents();
      });
    });

    // Ask for mic permission before creating a billable platform session.
    this.mic = await this.step(
      (opts.microphoneFactory ?? createLocalAudioTrack)({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...opts.audioConstraints,
      }).then(track => {
        if (this.closed) track.stop();
        return track;
      })
    );
    const connection = await this.step(
      opts.connect(this.controller.signal).then(resolveVoiceSessionConnection)
    );
    this.sessionId = connection.sessionId;
    await this.step(
      room.connect(connection.url, connection.token).then(() => {
        if (this.closed) void room.disconnect();
      })
    );
    this.setStatus('initializing');
    await this.step(
      room.localParticipant.publishData(new Uint8Array(new TextEncoder().encode('{}')), {
        reliable: true,
        topic: TOPIC,
      })
    );
    await this.step(room.localParticipant.publishTrack(this.mic));
    this.published = true;
    // LiveKit reports autoplay failure separately; it must not make an otherwise ready session fail.
    void this.resumeAudio().catch(() => {});
    this.checkReady();
    await this.step(this.ready);
    this.assertOpen();
  }

  private listen<E extends keyof RoomEventCallbacks>(
    event: E,
    callback: RoomEventCallbacks[E]
  ): void {
    this.room.on(event, callback);
    this.listeners.push(() => this.room.off(event, callback));
  }

  private checkDisconnectedAgents(): boolean {
    if (this.closed) return false;
    for (const identity of this.disconnectedAgents) {
      if (!this.room.remoteParticipants.has(identity)) {
        this.fail(new Error('Voice agent disconnected'));
        return false;
      }
    }
    this.disconnectedAgents.clear();
    return true;
  }

  private checkReady(): void {
    if (this.info && this.published && !this.closed) {
      this.setStatus('ready');
      this.resolveReady();
    }
  }

  private handleEvent(event: VoiceEvent): void {
    this.opts.onEvent?.(event);
    switch (event.type) {
      case 'session_started':
        this.info = event;
        this.checkReady();
        break;
      case 'transcript_partial':
      case 'transcript_committed':
        this.setMode(event.type === 'transcript_partial' ? 'listening' : 'thinking');
        this.opts.onUserTranscript?.({
          text: String(event.text ?? ''),
          final: event.type === 'transcript_committed',
          ...(event.replace ? { replace: true } : {}),
        });
        break;
      case 'agent_status':
        this.setMode('thinking');
        break;
      case 'filler':
        this.setMode('speaking');
        break;
      case 'agent_text_delta':
        this.setMode('speaking');
        this.opts.onAgentText?.({ delta: String(event.text ?? '') });
        break;
      case 'agent_text_done':
        this.opts.onAgentText?.({
          done: true,
          text: String(event.text ?? ''),
          runId: typeof event.run_id === 'string' ? event.run_id : null,
        });
        break;
      case 'interrupted':
        this.setMode('listening');
        this.opts.onInterrupted?.({
          heardText: typeof event.heard_text === 'string' ? event.heard_text : null,
        });
        break;
      case 'session_transcript':
        this.opts.onTranscript?.(
          Array.isArray(event.entries) ? event.entries : [],
          typeof event.started_at === 'number' ? event.started_at : undefined
        );
        break;
      case 'error': {
        const error = new Error(String(event.message ?? 'Voice session error'));
        // Framework errors have no fatality flag. Startup errors fail startup;
        // later turn errors remain recoverable and are surfaced to the caller.
        if (!this.info || !this.published) this.fail(error);
        else this.opts.onError?.(error);
        break;
      }
      case 'session_ended':
        this.end();
        break;
    }
  }

  private setStatus(status: LiveKitVoiceStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.opts.onStatus?.(status);
    }
  }
  private setMode(mode: VoiceMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.opts.onMode?.(mode);
    }
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    this.setStatus('error');
    this.opts.onError?.(error);
  }

  get muted(): boolean {
    return this.mic?.isMuted ?? false;
  }
  async setMuted(muted: boolean): Promise<void> {
    this.assertOpen();
    if (muted) await this.mic?.mute();
    else await this.mic?.unmute();
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) throw new Error('Volume must be finite');
    this.volume = Math.max(0, Math.min(1, volume));
    this.tracks.forEach(track => track.setVolume(this.volume));
  }
  async resumeAudio(): Promise<void> {
    this.assertOpen();
    try {
      await this.room.startAudio();
      this.audioBlocked = !this.room.canPlaybackAudio;
    } catch (error) {
      this.audioBlocked = true;
      this.opts.onAudioBlocked?.();
      throw error;
    }
  }
  /** Lazy browser audio analysers. Zero when muted, closed or unavailable. */
  get inputVolume(): number {
    if (!this.mic || this.closed || this.muted) return 0;
    try {
      this.inputMeter ??= createAudioAnalyser(this.mic);
      return this.inputMeter.calculateVolume();
    } catch {
      return 0;
    }
  }
  get outputVolume(): number {
    const track = this.tracks.values().next().value;
    if (!track || this.closed) return 0;
    try {
      this.outputMeter ??= createAudioAnalyser(track);
      return this.outputMeter.calculateVolume();
    } catch {
      return 0;
    }
  }
  /** Send Timbal protocol controls (e.g. interaction answers) over reliable data. */
  async send(event: Record<string, unknown>): Promise<void> {
    this.assertOpen();
    await this.room.localParticipant.publishData(
      new Uint8Array(new TextEncoder().encode(JSON.stringify(event))),
      { reliable: true, topic: TOPIC }
    );
  }
  end(): void {
    if (this.closed) return;
    this.close(new Error('Voice session ended'));
    this.setStatus('ended');
  }
  private close(reason: Error): void {
    this.closed = true;
    this.controller.abort(reason);
    this.opts.signal?.removeEventListener('abort', this.abort);
    this.listeners.splice(0).forEach(remove => remove());
    this.mic?.stop();
    void this.inputMeter?.cleanup().catch(() => {});
    void this.outputMeter?.cleanup().catch(() => {});
    this.tracks.forEach(track => track.detach().forEach(element => element.remove()));
    this.tracks.clear();
    this.disconnectedAgents.clear();
    this.decoder.clear();
    void this.room.disconnect().catch(() => {});
  }
}
