import { describe, test, expect, mock } from 'bun:test';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { LiveKitVoiceSession } from '../voice/livekit';
import { VoiceEventDecoder } from '../voice/livekit/events';
import { resolveVoiceSessionConnection, type VoiceSessionConnection } from '../voice/connection';

const connection: VoiceSessionConnection = {
  transport: 'livekit',
  url: 'wss://example.test',
  token: 'caller-token',
  room: 'room',
  identity: 'caller',
  sessionId: 'sid',
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const emit = (event: string, ...args: any[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const event = (value: unknown, identity = 'agent-session', topic = 'timbal.events') =>
    emit(RoomEvent.DataReceived, encode(value), { identity }, undefined, topic);
  const mic = {
    isMuted: false,
    stop: mock(() => {}),
    mute: mock(async () => {
      mic.isMuted = true;
    }),
    unmute: mock(async () => {
      mic.isMuted = false;
    }),
  };
  const room = {
    state: ConnectionState.Connected,
    remoteParticipants: new Map([['agent-session', { identity: 'agent-session' }]]),
    on: (event: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return room;
    },
    off: (event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
      return room;
    },
    connect: mock(async (_url: string, _token: string) => {}),
    disconnect: mock(async () => {}),
    startAudio: mock(async () => {}),
    canPlaybackAudio: true,
    localParticipant: {
      publishData: mock(async (_data: Uint8Array, _options: unknown) => {}),
      publishTrack: mock(async (_track: unknown) => {
        event({ type: 'session_started', language: 'en' });
      }),
    },
  };
  const options = {
    connect: mock(async (_signal: AbortSignal) => connection),
    roomFactory: () => room as any,
    microphoneFactory: mock(async () => mic as any),
    startupTimeoutMs: 100,
  };
  return { room, mic, options, event, emit, listeners };
}

describe('LiveKitVoiceSession', () => {
  test('publishes mic, sends hello, and resolves after session_started', async () => {
    const f = fixture();
    const statuses: string[] = [];
    const s = await LiveKitVoiceSession.start({
      ...f.options,
      onStatus: status => statuses.push(status),
    });
    expect(f.room.connect).toHaveBeenCalledWith(connection.url, connection.token);
    expect(f.room.localParticipant.publishTrack).toHaveBeenCalledWith(f.mic);
    expect(statuses).toEqual(['connecting', 'initializing', 'ready']);
    expect(s.info?.language).toBe('en');
    expect(s.sessionId).toBe('sid');
    expect(
      JSON.parse(new TextDecoder().decode(f.room.localParticipant.publishData.mock.calls[0]![0]))
    ).toEqual({});
    s.end();
  });
  test('participant and room connection do not imply readiness; timeout releases resources', async () => {
    const f = fixture();
    f.room.localParticipant.publishTrack.mockImplementation(async () => {
      f.emit(RoomEvent.ParticipantConnected, { identity: 'agent-session' });
    });
    const statuses: string[] = [];
    await expect(
      LiveKitVoiceSession.start({
        ...f.options,
        startupTimeoutMs: 15,
        onStatus: s => statuses.push(s),
      })
    ).rejects.toThrow('did not become ready');
    expect(statuses).toEqual(['connecting', 'initializing', 'error']);
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
    expect(f.room.disconnect).toHaveBeenCalledTimes(1);
  });
  test('startup provider error rejects immediately with its message', async () => {
    const f = fixture();
    f.room.localParticipant.publishTrack.mockImplementation(async () => {
      f.event({ type: 'error', message: 'Unsupported STT language' });
    });
    const error = mock(() => {});
    await expect(LiveKitVoiceSession.start({ ...f.options, onError: error })).rejects.toThrow(
      'Unsupported STT language'
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
  });
  test('permission denial never creates a platform session', async () => {
    const f = fixture();
    f.options.microphoneFactory.mockImplementation(async () => {
      throw new Error('Permission denied');
    });
    await expect(LiveKitVoiceSession.start(f.options)).rejects.toThrow('Permission denied');
    expect(f.options.connect).not.toHaveBeenCalled();
  });
  test('invalid connection and backend HTTP errors stop the microphone', async () => {
    for (const result of [
      { sdp: 'old', type: 'answer' },
      new Response('{"message":"No deployment"}', { status: 409 }),
    ]) {
      const f = fixture();
      await expect(
        LiveKitVoiceSession.start({ ...f.options, connect: async () => result as any })
      ).rejects.toThrow();
      expect(f.mic.stop).toHaveBeenCalledTimes(1);
      expect(f.room.connect).not.toHaveBeenCalled();
    }
  });
  test('ready cannot precede microphone publication', async () => {
    const f = fixture();
    let publish!: () => void;
    f.room.localParticipant.publishTrack.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          publish = resolve;
          f.event({ type: 'session_started' });
        })
    );
    let ready = false;
    const promise = LiveKitVoiceSession.start(f.options).then(s => {
      ready = true;
      return s;
    });
    await tick();
    expect(ready).toBe(false);
    publish();
    const s = await promise;
    expect(s.status).toBe('ready');
    s.end();
  });
  test('only Timbal messages from agent participants are decoded', async () => {
    const f = fixture();
    const transcript = mock(() => {});
    const s = await LiveKitVoiceSession.start({ ...f.options, onUserTranscript: transcript });
    f.event({ type: 'transcript_partial', text: 'ignored' }, 'caller');
    f.event({ type: 'transcript_partial', text: 'ignored' }, 'agent-session', 'lk.transcription');
    expect(transcript).not.toHaveBeenCalled();
    f.event({ type: 'transcript_partial', text: 'hello' });
    f.event({ type: 'transcript_committed', text: 'hello there', replace: true });
    expect(transcript.mock.calls).toEqual([
      [{ text: 'hello', final: false }],
      [{ text: 'hello there', final: true, replace: true }],
    ]);
    expect(s.mode).toBe('thinking');
    s.end();
  });
  test('text completion retains run id, interruptions retain heard text and turn errors remain recoverable', async () => {
    const f = fixture();
    const text = mock(() => {});
    const interrupted = mock(() => {});
    const error = mock(() => {});
    const s = await LiveKitVoiceSession.start({
      ...f.options,
      onAgentText: text,
      onInterrupted: interrupted,
      onError: error,
    });
    f.event({ type: 'agent_text_delta', text: 'Hi' });
    expect(s.mode).toBe('speaking');
    f.event({ type: 'agent_text_done', text: 'Hi!', run_id: 'run1' });
    expect(text.mock.calls).toEqual([
      [{ delta: 'Hi' }],
      [{ done: true, text: 'Hi!', runId: 'run1' }],
    ]);
    f.event({ type: 'interrupted', heard_text: 'Hi' });
    expect(s.mode).toBe('listening');
    expect(interrupted).toHaveBeenCalledWith({ heardText: 'Hi' });
    f.event({ type: 'error', message: 'Retry this turn' });
    expect(s.status).toBe('ready');
    expect(error).toHaveBeenCalledTimes(1);
    s.end();
  });
  test('captures final transcript before normal end; mute, send and end clean up', async () => {
    const f = fixture();
    const transcript = mock(() => {});
    const s = await LiveKitVoiceSession.start({ ...f.options, onTranscript: transcript });
    await s.setMuted(true);
    expect(s.muted).toBe(true);
    expect(s.inputVolume).toBe(0);
    await s.setMuted(false);
    await s.send({ type: 'interaction_answer', interaction_id: 'i', value: 'yes' });
    expect(f.room.localParticipant.publishData.mock.calls.at(-1)![1]).toEqual({
      reliable: true,
      topic: 'timbal.events',
    });
    f.event({ type: 'session_transcript', entries: [{ text: 'Hi' }], started_at: 123 });
    f.event({ type: 'session_ended' });
    s.end();
    expect(transcript).toHaveBeenCalledWith([{ text: 'Hi' }], 123);
    expect(s.status).toBe('ended');
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
    expect([...f.listeners.values()].every(s => s.size === 0)).toBe(true);
    await expect(s.send({})).rejects.toThrow('ended');
  });
  test('reconnect transitions are visible; unexpected disconnect is an error', async () => {
    const f = fixture();
    const s = await LiveKitVoiceSession.start(f.options);
    f.emit(RoomEvent.Reconnecting);
    expect(s.status).toBe('reconnecting');
    f.emit(RoomEvent.Reconnected);
    expect(s.status).toBe('ready');
    f.emit(RoomEvent.Disconnected);
    expect(s.status).toBe('error');
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
  });
  test('full restart participant removal before Reconnecting preserves the call', async () => {
    const f = fixture();
    const errors = mock(() => {});
    const s = await LiveKitVoiceSession.start({ ...f.options, onError: errors });
    const agent = f.room.remoteParticipants.get('agent-session')!;
    // Match LiveKit handleRestarting: delete/emit participants first, then state/event.
    f.room.remoteParticipants.delete(agent.identity);
    f.emit(RoomEvent.ParticipantDisconnected, agent);
    f.room.state = ConnectionState.Reconnecting;
    f.emit(RoomEvent.Reconnecting);
    await tick();
    expect(s.status).toBe('reconnecting');
    expect(f.mic.stop).not.toHaveBeenCalled();
    expect(f.room.disconnect).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    f.room.remoteParticipants.set(agent.identity, agent);
    f.room.state = ConnectionState.Connected;
    f.emit(RoomEvent.Reconnected);
    expect(s.status).toBe('ready');
    s.end();
  });
  test('a real agent departure still fails and cleans up', async () => {
    const f = fixture();
    const errors = mock(() => {});
    const s = await LiveKitVoiceSession.start({ ...f.options, onError: errors });
    f.room.remoteParticipants.delete('agent-session');
    f.emit(RoomEvent.ParticipantDisconnected, { identity: 'agent-session' });
    await tick();
    expect(s.status).toBe('error');
    expect(errors.mock.calls[0]![0].message).toBe('Voice agent disconnected');
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
  });
  test('agent missing from reconnected room snapshot cannot become ready', async () => {
    const f = fixture();
    const s = await LiveKitVoiceSession.start(f.options);
    f.room.remoteParticipants.delete('agent-session');
    f.emit(RoomEvent.ParticipantDisconnected, { identity: 'agent-session' });
    f.room.state = ConnectionState.Reconnecting;
    f.emit(RoomEvent.Reconnecting);
    await tick();
    f.room.state = ConnectionState.Connected;
    f.emit(RoomEvent.Reconnected);
    expect(s.status).toBe('error');
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
  });
  test('signal reconnect and same-turn participant restoration are recoverable', async () => {
    const f = fixture();
    const s = await LiveKitVoiceSession.start(f.options);
    const agent = f.room.remoteParticipants.get('agent-session')!;
    f.room.state = ConnectionState.SignalReconnecting;
    f.emit(RoomEvent.SignalReconnecting);
    f.room.remoteParticipants.delete(agent.identity);
    f.emit(RoomEvent.ParticipantDisconnected, agent);
    await tick();
    expect(s.status).toBe('reconnecting');
    f.room.remoteParticipants.set(agent.identity, agent);
    f.room.state = ConnectionState.Connected;
    f.emit(RoomEvent.Reconnected);
    expect(s.status).toBe('ready');
    // Also cover synchronous room moves that replace participants without a reconnect event.
    f.room.remoteParticipants.delete(agent.identity);
    f.emit(RoomEvent.ParticipantDisconnected, agent);
    f.room.remoteParticipants.set(agent.identity, agent);
    await tick();
    expect(s.status).toBe('ready');
    s.end();
  });
  test('ending before the deferred departure check does not report an error', async () => {
    const f = fixture();
    const errors = mock(() => {});
    const s = await LiveKitVoiceSession.start({ ...f.options, onError: errors });
    f.room.remoteParticipants.delete('agent-session');
    f.emit(RoomEvent.ParticipantDisconnected, { identity: 'agent-session' });
    s.end();
    await tick();
    expect(s.status).toBe('ended');
    expect(errors).not.toHaveBeenCalled();
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
  });
  test('autoplay blocking is recoverable and remote elements are detached', async () => {
    const f = fixture();
    const blocked = mock(() => {});
    const s = await LiveKitVoiceSession.start({ ...f.options, onAudioBlocked: blocked });
    const element = {
      play: mock(async () => {
        throw new Error('NotAllowedError');
      }),
      remove: mock(() => {}),
    };
    const track = {
      kind: 'audio',
      attach: () => element,
      detach: mock(() => [element]),
      setVolume: mock(() => {}),
    };
    f.emit(RoomEvent.TrackSubscribed, track, {}, { identity: 'agent-session' });
    await tick();
    expect(s.audioBlocked).toBe(true);
    expect(blocked).toHaveBeenCalledTimes(1);
    s.setVolume(0.4);
    expect(track.setVolume).toHaveBeenLastCalledWith(0.4);
    await s.resumeAudio();
    expect(s.audioBlocked).toBe(false);
    s.end();
    expect(element.remove).toHaveBeenCalledTimes(1);
  });
  test('already-aborted start does not acquire mic or create backend session', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      LiveKitVoiceSession.start({ ...f.options, signal: controller.signal })
    ).rejects.toThrow('ended');
    expect(f.options.microphoneFactory).not.toHaveBeenCalled();
    expect(f.options.connect).not.toHaveBeenCalled();
  });
  test('aborting pending mic capture releases a late track', async () => {
    const f = fixture();
    const controller = new AbortController();
    let release!: (track: any) => void;
    f.options.microphoneFactory.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const p = LiveKitVoiceSession.start({ ...f.options, signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow('ended');
    release(f.mic);
    await tick();
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
    expect(f.options.connect).not.toHaveBeenCalled();
  });
  test('aborting backend request forwards cancellation and cleans up', async () => {
    const f = fixture();
    const controller = new AbortController();
    let requestSignal!: AbortSignal;
    f.options.connect.mockImplementation(signal => {
      requestSignal = signal;
      return new Promise(() => {});
    });
    const p = LiveKitVoiceSession.start({ ...f.options, signal: controller.signal });
    await tick();
    controller.abort();
    await expect(p).rejects.toThrow('ended');
    expect(requestSignal.aborted).toBe(true);
    expect(f.mic.stop).toHaveBeenCalledTimes(1);
  });
  test('a room connecting after cancellation is disconnected again', async () => {
    const f = fixture();
    const controller = new AbortController();
    let connected!: () => void;
    f.room.connect.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          connected = resolve;
        })
    );
    const p = LiveKitVoiceSession.start({ ...f.options, signal: controller.signal });
    await tick();
    controller.abort();
    await expect(p).rejects.toThrow('ended');
    connected();
    await tick();
    expect(f.room.disconnect).toHaveBeenCalledTimes(2);
    expect(f.room.localParticipant.publishTrack).not.toHaveBeenCalled();
  });
});

describe('Timbal data decoder', () => {
  test('reassembles generic chunks across UTF-8 boundaries, out of order and with duplicates', () => {
    const decoder = new VoiceEventDecoder();
    const event = { type: 'agent_approval', input: 'مرحبا 中文' };
    const data = Buffer.from(JSON.stringify(event)).toString('base64');
    const pieces = [data.slice(0, 7), data.slice(7)];
    const chunk = (seq: number) =>
      encode({
        type: 'chunk',
        chunk_id: 'one',
        msg_type: event.type,
        seq,
        total: 2,
        data: pieces[seq],
      });
    expect(decoder.decode(chunk(1))).toBeUndefined();
    expect(decoder.decode(chunk(1))).toBeUndefined();
    expect(decoder.decode(chunk(0))).toEqual(event);
  });
  test('reassembles session_transcript entries in order', () => {
    const decoder = new VoiceEventDecoder();
    const chunk = (seq: number) =>
      encode({
        type: 'session_transcript',
        seq,
        total: 2,
        entries: [{ text: String(seq) }],
        started_at: 42,
      });
    expect(decoder.decode(chunk(1))).toBeUndefined();
    expect(decoder.decode(chunk(0))).toEqual({
      type: 'session_transcript',
      entries: [{ text: '0' }, { text: '1' }],
      started_at: 42,
    });
  });
  test('validates sequences, payload and JSON; bounded incomplete assemblies', () => {
    const decoder = new VoiceEventDecoder();
    for (const value of [
      [],
      null,
      { type: 'chunk', seq: -1, total: 2 },
      { type: 'chunk', seq: 0, total: 5000 },
      { type: 'chunk', seq: 0, total: 1, data: 3 },
    ]) {
      expect(() => decoder.decode(encode(value))).toThrow();
    }
    for (let i = 0; i < 16; i++)
      decoder.decode(
        encode({ type: 'chunk', chunk_id: String(i), seq: 0, total: 2, data: 'e30=' })
      );
    expect(() =>
      decoder.decode(
        encode({ type: 'chunk', chunk_id: 'overflow', seq: 0, total: 2, data: 'e30=' })
      )
    ).toThrow('Too many');
    decoder.clear();
    expect(decoder.decode(encode({ type: 'metrics', metrics: {} }))).toEqual({
      type: 'metrics',
      metrics: {},
    });
  });
  test('rejects inconsistent totals and oversized assemblies', () => {
    const d = new VoiceEventDecoder();
    const chunk = (total: number, data = 'a') =>
      encode({ type: 'chunk', chunk_id: 'id', seq: 0, total, data });
    d.decode(chunk(2));
    expect(() => d.decode(chunk(3))).toThrow('Inconsistent');
    expect(() => d.decode(chunk(1, 'x'.repeat(4 * 1024 * 1024)))).toThrow('exceeds');
  });
});

test('connection resolver preserves session header and accepts typed connection without mutation', async () => {
  expect(
    await resolveVoiceSessionConnection(
      new Response(JSON.stringify(connection), {
        headers: { 'x-timbal-voice-session-id': 'header-id' },
      })
    )
  ).toEqual({ ...connection, sessionId: 'header-id' });
  expect(await resolveVoiceSessionConnection(connection)).toEqual(connection);
});
