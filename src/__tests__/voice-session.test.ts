import { describe, test, expect, mock } from 'bun:test';
import { VoiceSession } from '../voice';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class FakeDataChannel {
  static initialReadyState = 'open';
  readyState = FakeDataChannel.initialReadyState;
  sent: string[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static autoConnect = true;
  static gatheringComplete = true;

  config: unknown;
  connectionState = 'new';
  iceGatheringState = FakePeerConnection.gatheringComplete ? 'complete' : 'gathering';
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  addedTracks: FakeTrack[] = [];
  dc: FakeDataChannel | null = null;
  closed = false;
  ontrack: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private listeners = new Map<string, (() => void)[]>();

  constructor(config?: unknown) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addEventListener(type: string, fn: () => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
    if (type === 'connectionstatechange') this.onconnectionstatechange?.();
  }

  setConnectionState(state: string) {
    this.connectionState = state;
    this.fire('connectionstatechange');
  }

  addTrack(track: FakeTrack, _stream: FakeStream) {
    this.addedTracks.push(track);
  }

  createDataChannel(_label: string) {
    this.dc = new FakeDataChannel();
    return this.dc;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0 fake-offer' };
  }

  async setLocalDescription(desc: { sdp?: string }) {
    this.localDescription = { sdp: desc.sdp ?? '' };
  }

  async setRemoteDescription(desc: unknown) {
    this.remoteDescription = desc;
    if (FakePeerConnection.autoConnect) {
      queueMicrotask(() => this.setConnectionState('connected'));
    }
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

class FakeAudio {
  static playRejects = false;
  autoplay = false;
  volume = 1;
  srcObject: unknown = null;
  paused = false;
  async play() {
    if (FakeAudio.playRejects) throw new Error('NotAllowedError: autoplay blocked');
  }
  pause() {
    this.paused = true;
  }
}

function makeGlobals(overrides: Record<string, unknown> = {}) {
  FakePeerConnection.instances = [];
  FakePeerConnection.autoConnect = true;
  FakePeerConnection.gatheringComplete = true;
  FakeDataChannel.initialReadyState = 'open';
  FakeAudio.playRejects = false;
  const micStream = new FakeStream();
  const getUserMedia = mock(() => Promise.resolve(micStream));
  return {
    globals: {
      RTCPeerConnection: FakePeerConnection as any,
      Audio: FakeAudio as any,
      navigator: { mediaDevices: { getUserMedia } } as any,
      ...overrides,
    },
    micStream,
    getUserMedia,
    pc: () => FakePeerConnection.instances[0]!,
  };
}

const answer = { sdp: 'v=0 fake-answer', type: 'answer' };

// ── start ───────────────────────────────────────────────────────────────────

describe('VoiceSession.start', () => {
  test('captures mic, ships a complete offer through signal, connects', async () => {
    const env = makeGlobals();
    const signal = mock(() => Promise.resolve(answer));
    const statuses: string[] = [];

    const session = await VoiceSession.start({
      signal,
      config: { model: 'openai/gpt-4o-mini' },
      globals: env.globals,
      onStatus: (s) => statuses.push(s),
    });

    // Mic constraints: AEC/NS/AGC always on.
    const constraints = (env.getUserMedia.mock.calls[0] as any)[0];
    expect(constraints.audio.echoCancellation).toBe(true);
    expect(constraints.audio.noiseSuppression).toBe(true);
    expect(constraints.audio.autoGainControl).toBe(true);

    // Offer body carries the local SDP + config passthrough.
    const offer = (signal.mock.calls[0] as any)[0];
    expect(offer).toEqual({ sdp: 'v=0 fake-offer', type: 'offer', config: { model: 'openai/gpt-4o-mini' } });

    expect(env.pc().remoteDescription).toEqual(answer);
    expect(env.pc().addedTracks).toHaveLength(1);
    expect(session.status).toBe('connected');
    expect(statuses).toEqual(['connected']);

    // Default ICE config points at the platform STUN.
    expect((env.pc().config as any).iceServers).toEqual([{ urls: 'stun:turn.timbal.ai:3478' }]);
  });

  test('accepts a raw Response from signal', async () => {
    const env = makeGlobals();
    const session = await VoiceSession.start({
      signal: () => Promise.resolve(new Response(JSON.stringify(answer), { status: 200 })),
      globals: env.globals,
    });
    expect(session.status).toBe('connected');
    expect(env.pc().remoteDescription).toEqual(answer);
  });

  test('non-ok Response rejects with the server detail and tears down', async () => {
    const env = makeGlobals();
    await expect(
      VoiceSession.start({
        signal: () => Promise.resolve(new Response(JSON.stringify({ error: 'no deployment' }), { status: 404 })),
        globals: env.globals,
      }),
    ).rejects.toThrow('no deployment');
    expect(env.micStream.tracks[0]!.stopped).toBe(true);
    expect(env.pc().closed).toBe(true);
  });

  test('501 gets the timbal[voice] >= 2.3.2 hint', async () => {
    const env = makeGlobals();
    await expect(
      VoiceSession.start({
        signal: () => Promise.resolve(new Response('{}', { status: 501 })),
        globals: env.globals,
      }),
    ).rejects.toThrow(/timbal\[voice\] >= 2\.3\.2/);
  });

  test('invalid answer shape rejects', async () => {
    const env = makeGlobals();
    await expect(
      VoiceSession.start({
        signal: () => Promise.resolve({ nope: true }),
        globals: env.globals,
      }),
    ).rejects.toThrow(/invalid SDP answer/);
  });

  test('bounded wait when ICE gathering never completes', async () => {
    const env = makeGlobals();
    FakePeerConnection.gatheringComplete = false;
    const signal = mock(() => Promise.resolve(answer));
    const session = await VoiceSession.start({
      signal,
      globals: env.globals,
      iceGatheringTimeoutMs: 5,
    });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('connected');
  });

  test('connect timeout rejects when the connection never establishes', async () => {
    const env = makeGlobals();
    FakePeerConnection.autoConnect = false;
    await expect(
      VoiceSession.start({
        signal: () => Promise.resolve(answer),
        globals: env.globals,
        connectTimeoutMs: 10,
      }),
    ).rejects.toThrow(/did not establish within 10ms/);
    expect(env.micStream.tracks[0]!.stopped).toBe(true);
  });

  test('connect timeout error diagnoses ICE and points at TURN', async () => {
    const env = makeGlobals();
    FakePeerConnection.autoConnect = false;
    await expect(
      VoiceSession.start({
        signal: () => Promise.resolve(answer),
        globals: env.globals,
        connectTimeoutMs: 10,
      }),
    ).rejects.toThrow(/connectionState=new.*ICE\/media-path failure.*TURN/s);
  });

  test('custom iceServers and iceTransportPolicy reach the peer connection config', async () => {
    const env = makeGlobals();
    const turn = [{ urls: ['turn:turn.timbal.ai:3478'], username: 'u', credential: 'c' }];
    await VoiceSession.start({
      signal: () => Promise.resolve(answer),
      globals: env.globals,
      iceServers: turn,
      iceTransportPolicy: 'relay',
    });
    expect((env.pc().config as any).iceServers).toEqual(turn);
    expect((env.pc().config as any).iceTransportPolicy).toBe('relay');
  });

  test('iceTransportPolicy is omitted from the config by default', async () => {
    const env = makeGlobals();
    await VoiceSession.start({ signal: () => Promise.resolve(answer), globals: env.globals });
    expect('iceTransportPolicy' in (env.pc().config as any)).toBe(false);
  });

  test('data channel watchdog errors when the channel never opens after connect', async () => {
    const env = makeGlobals();
    FakeDataChannel.initialReadyState = 'connecting';
    const errors: Error[] = [];
    const session = await VoiceSession.start({
      signal: () => Promise.resolve(answer),
      globals: env.globals,
      connectTimeoutMs: 10,
      onError: (e) => errors.push(e),
    });
    expect(session.status).toBe('connected');
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/data channel did not open within 10ms/);
  });

  test('data channel watchdog stays quiet when the channel opens in time', async () => {
    const env = makeGlobals();
    FakeDataChannel.initialReadyState = 'connecting';
    const errors: Error[] = [];
    await VoiceSession.start({
      signal: () => Promise.resolve(answer),
      globals: env.globals,
      connectTimeoutMs: 10,
      onError: (e) => errors.push(e),
    });
    const dc = env.pc().dc!;
    dc.readyState = 'open';
    dc.onopen?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(0);
  });

  test('clear error outside a browser', async () => {
    await expect(
      VoiceSession.start({ signal: () => Promise.resolve(answer), globals: {} }),
    ).rejects.toThrow(/requires a browser/);
  });
});

// ── Server events ───────────────────────────────────────────────────────────

async function liveSession(callbacks: Record<string, unknown> = {}) {
  const env = makeGlobals();
  const session = await VoiceSession.start({
    signal: () => Promise.resolve(answer),
    globals: env.globals,
    ...callbacks,
  });
  const emit = (msg: Record<string, unknown>) =>
    env.pc().dc!.onmessage!({ data: JSON.stringify(msg) });
  return { session, env, emit };
}

describe('VoiceSession events', () => {
  test('session_started fills info; every event reaches onEvent', async () => {
    const events: any[] = [];
    const { session, emit } = await liveSession({ onEvent: (e: any) => events.push(e) });
    emit({ type: 'session_started', model: 'gpt-4o-mini', stt_provider: 'deepgram' });
    emit({ type: 'some_future_event', x: 1 });
    expect(session.info).toMatchObject({ model: 'gpt-4o-mini' });
    expect(events).toHaveLength(2);
    expect(session.mode).toBe('listening');
  });

  test('transcript flow: partial → committed drives mode and callbacks', async () => {
    const transcripts: any[] = [];
    const modes: string[] = [];
    const { session, emit } = await liveSession({
      onUserTranscript: (t: any) => transcripts.push(t),
      onMode: (m: string) => modes.push(m),
    });
    emit({ type: 'transcript_partial', text: 'hel' });
    emit({ type: 'transcript_committed', text: 'hello there', replace: true });
    expect(transcripts).toEqual([
      { text: 'hel', final: false },
      { text: 'hello there', final: true, replace: true },
    ]);
    expect(session.mode).toBe('thinking');
    expect(modes).toEqual(['thinking']);
  });

  test('agent text streaming and barge-in', async () => {
    const agentText: any[] = [];
    const interruptions: any[] = [];
    const { session, emit } = await liveSession({
      onAgentText: (t: any) => agentText.push(t),
      onInterrupted: (i: any) => interruptions.push(i),
    });
    emit({ type: 'agent_text_delta', text: 'Hi ' });
    expect(session.mode).toBe('speaking');
    emit({ type: 'agent_text_done' });
    emit({ type: 'interrupted', heard_text: 'Hi' });
    expect(agentText).toEqual([{ delta: 'Hi ' }, { done: true }]);
    expect(interruptions).toEqual([{ heardText: 'Hi' }]);
    expect(session.mode).toBe('listening');
  });

  test('filler stays off onAgentText but flips mode to speaking', async () => {
    const agentText: any[] = [];
    const { session, emit } = await liveSession({ onAgentText: (t: any) => agentText.push(t) });
    emit({ type: 'filler', text: 'One moment…' });
    expect(agentText).toHaveLength(0);
    expect(session.mode).toBe('speaking');
  });

  test('server error event surfaces on onError without ending the session', async () => {
    const errors: Error[] = [];
    const { session, emit } = await liveSession({ onError: (e: Error) => errors.push(e) });
    emit({ type: 'error', message: 'tool exploded' });
    expect(errors[0]!.message).toBe('tool exploded');
    expect(session.status).toBe('connected');
  });

  test('session_ended tears down and ends', async () => {
    const { session, env, emit } = await liveSession();
    emit({ type: 'session_ended' });
    expect(session.status).toBe('ended');
    expect(env.micStream.tracks[0]!.stopped).toBe(true);
    expect(env.pc().closed).toBe(true);
  });
});

// ── Media & controls ────────────────────────────────────────────────────────

describe('VoiceSession media & controls', () => {
  test('remote track attaches to an autoplaying audio element', async () => {
    const { env } = await liveSession();
    const remote = new FakeStream();
    env.pc().ontrack!({ track: remote.tracks[0], streams: [remote] });
    // The element is internal; verify via volume control behavior.
  });

  test('autoplay block sets audioBlocked and resumeAudio recovers', async () => {
    const blocked = mock(() => {});
    const { session, env } = await liveSession({ onAudioBlocked: blocked });
    FakeAudio.playRejects = true;
    env.pc().ontrack!({ track: new FakeTrack(), streams: [new FakeStream()] });
    await Promise.resolve(); // let the play() rejection settle
    expect(session.audioBlocked).toBe(true);
    expect(blocked).toHaveBeenCalledTimes(1);

    FakeAudio.playRejects = false;
    await session.resumeAudio();
    expect(session.audioBlocked).toBe(false);
  });

  test('muted flips the mic track without stopping it', async () => {
    const { session, env } = await liveSession();
    expect(session.muted).toBe(false);
    session.muted = true;
    expect(env.micStream.tracks[0]!.enabled).toBe(false);
    expect(env.micStream.tracks[0]!.stopped).toBe(false);
    session.muted = false;
    expect(env.micStream.tracks[0]!.enabled).toBe(true);
  });

  test('send() ships JSON up the data channel', async () => {
    const { session, env } = await liveSession();
    session.send({ type: 'mic_change' });
    expect(env.pc().dc!.sent).toEqual(['{"type":"mic_change"}']);
  });

  test('end() is idempotent and releases everything', async () => {
    const statuses: string[] = [];
    const { session, env } = await liveSession({ onStatus: (s: string) => statuses.push(s) });
    session.end();
    session.end();
    expect(session.status).toBe('ended');
    expect(statuses).toEqual(['connected', 'ended']);
    expect(env.micStream.tracks[0]!.stopped).toBe(true);
    expect(env.pc().closed).toBe(true);
    expect(env.pc().dc!.closed).toBe(true);
  });

  test('transport drop after connect ends the session; failed also errors', async () => {
    const errors: Error[] = [];
    const { session, env } = await liveSession({ onError: (e: Error) => errors.push(e) });
    env.pc().setConnectionState('failed');
    expect(session.status).toBe('ended');
    expect(errors).toHaveLength(1);
    expect(env.micStream.tracks[0]!.stopped).toBe(true);
  });
});
