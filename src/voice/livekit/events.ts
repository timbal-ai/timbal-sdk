/** Timbal reliable-data messages, independent of LiveKit's transcription protocol. */
export type VoiceEvent = Record<string, unknown> & { type: string };

interface Assembly {
  total: number;
  pieces: Map<number, VoiceEvent>;
  size: number;
  created: number;
}

/** Bounded, per-session reassembly for both Timbal chunk formats. */
export class VoiceEventDecoder {
  private pending = new Map<string, Assembly>();
  clear(): void {
    this.pending.clear();
  }

  decode(bytes: Uint8Array): VoiceEvent | undefined {
    const event: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!event || typeof event !== 'object' || typeof (event as VoiceEvent).type !== 'string') {
      throw new Error('Invalid Timbal voice event');
    }
    const msg = event as VoiceEvent;
    if (msg.type !== 'chunk' && !(msg.type === 'session_transcript' && 'seq' in msg)) return msg;
    const { seq, total } = msg;
    if (
      !Number.isInteger(seq) ||
      !Number.isInteger(total) ||
      (seq as number) < 0 ||
      (total as number) < 1 ||
      (total as number) > 1024 ||
      (seq as number) >= (total as number)
    ) {
      throw new Error('Invalid voice chunk sequence');
    }
    if (
      msg.type === 'chunk'
        ? typeof msg.chunk_id !== 'string' || typeof msg.data !== 'string'
        : !Array.isArray(msg.entries)
    ) {
      throw new Error('Invalid voice chunk payload');
    }
    for (const [key, item] of this.pending) {
      if (Date.now() - item.created > 30_000) this.pending.delete(key);
    }
    const key = msg.type === 'chunk' ? `chunk:${msg.chunk_id}` : 'transcript';
    let assembly = this.pending.get(key);
    if (!assembly) {
      if (this.pending.size >= 16) throw new Error('Too many incomplete voice messages');
      assembly = { total: total as number, pieces: new Map(), size: 0, created: Date.now() };
      this.pending.set(key, assembly);
    }
    if (assembly.total !== total) {
      this.pending.delete(key);
      throw new Error('Inconsistent voice chunk count');
    }
    if (!assembly.pieces.has(seq as number)) {
      assembly.size += bytes.byteLength;
      if (assembly.size > 4 * 1024 * 1024) {
        this.pending.delete(key);
        throw new Error('Voice message exceeds reassembly limit');
      }
      assembly.pieces.set(seq as number, msg);
    }
    if (assembly.pieces.size !== total) return;
    this.pending.delete(key);
    const pieces = Array.from(
      { length: total as number },
      (_, i) => assembly.pieces.get(i) as VoiceEvent
    );
    if (msg.type === 'session_transcript') {
      return {
        type: msg.type,
        started_at: pieces[0]?.started_at,
        entries: pieces.flatMap(p => p.entries as unknown[]),
      };
    }
    const binary = globalThis.atob(pieces.map(p => p.data as string).join(''));
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)))
    );
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      typeof (decoded as VoiceEvent).type !== 'string' ||
      (decoded as VoiceEvent).type === 'chunk'
    )
      throw new Error('Invalid reassembled voice event');
    return decoded as VoiceEvent;
  }
}
