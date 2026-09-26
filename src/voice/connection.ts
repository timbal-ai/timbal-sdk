/** Connection material minted by Timbal. Contains only a short-lived caller token. */
export interface VoiceSessionConnection {
  transport: 'livekit';
  url: string;
  token: string;
  room: string;
  identity: string;
  /** Available when the platform returns x-timbal-voice-session-id. */
  sessionId?: string;
}

/** Shared by the server helper and the credential-free browser entry point. */
export async function resolveVoiceSessionConnection(
  result: Response | VoiceSessionConnection
): Promise<VoiceSessionConnection> {
  let value: unknown = result;
  let sessionId: string | undefined;
  if (typeof (result as Response).json === 'function') {
    const response = result as Response;
    if (!response.ok) {
      let message = `Voice session creation failed (${response.status})`;
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (typeof body.message === 'string') message = body.message;
        else if (typeof body.error === 'string') message = body.error;
      } catch {
        /* Keep HTTP status for non-JSON errors. */
      }
      throw new Error(message);
    }
    sessionId = response.headers.get('x-timbal-voice-session-id') ?? undefined;
    value = await response.json();
  }
  const body = value as Partial<VoiceSessionConnection> | null;
  if (
    !body ||
    body.transport !== 'livekit' ||
    !['url', 'token', 'room', 'identity'].every(
      key =>
        typeof (body as Record<string, unknown>)[key] === 'string' &&
        (body as Record<string, unknown>)[key] !== ''
    )
  ) {
    throw new Error(
      'Invalid voice connection: expected LiveKit transport, url, token, room and identity'
    );
  }
  return {
    transport: 'livekit',
    url: body.url as string,
    token: body.token as string,
    room: body.room as string,
    identity: body.identity as string,
    ...((sessionId ?? body.sessionId) ? { sessionId: sessionId ?? body.sessionId } : {}),
  };
}
