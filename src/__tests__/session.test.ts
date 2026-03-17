import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getSession } from '../lib/functions/session';
import { Timbal } from '../lib/timbal';
import { TimbalApiError } from '../lib/api';

const mockSessionResponse = {
  session: {
    user_id: 1,
    user_name: 'David Berges Llado',
    user_email: 'dberges@timbal.ai',
    user_photo_url: null,
    user_phone: null,
    user_lang: 'ca',
    access_level: 'superadmin',
  },
};

describe('getSession', () => {
  const mockApiClient = {
    get: mock(() => Promise.resolve({ data: mockSessionResponse })),
  } as any;

  beforeEach(() => {
    mockApiClient.get.mockClear();
  });

  test('should call /me and return session', async () => {
    const session = await getSession(mockApiClient);

    expect(mockApiClient.get).toHaveBeenCalledWith('me');
    expect(session.user_id).toBe('1');
    expect(session.user_email).toBe('dberges@timbal.ai');
    expect(session.access_level).toBe('superadmin');
  });

  test('should return full session object', async () => {
    const session = await getSession(mockApiClient);

    expect(session).toEqual({
      user_id: '1',
      user_name: 'David Berges Llado',
      user_email: 'dberges@timbal.ai',
      user_photo_url: null,
      user_phone: null,
      user_lang: 'ca',
      access_level: 'superadmin',
    });
  });

  test('should coerce numeric user_id to string', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      data: {
        session: {
          user_id: 42,
          user_name: 'Test User',
          user_email: 'test@example.com',
          user_photo_url: null,
          user_phone: null,
          user_lang: 'en',
          access_level: 'admin',
        },
      },
    });

    const session = await getSession(mockApiClient);
    expect(session.user_id).toBe('42');
    expect(typeof session.user_id).toBe('string');
  });

  test('should propagate auth errors', async () => {
    mockApiClient.get.mockRejectedValueOnce(
      new TimbalApiError('Unauthorized', 401, 'AUTH_ERROR')
    );

    await expect(getSession(mockApiClient)).rejects.toThrow('Unauthorized');
  });
});

describe('Timbal.getSession', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSessionResponse),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should get session through Timbal class', async () => {
    const timbal = new Timbal({ token: 'test-key', baseUrl: 'https://api.test.com' });
    const session = await timbal.getSession();

    expect(session.user_email).toBe('dberges@timbal.ai');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/me');
  });

  test('should work with scoped client via .as()', async () => {
    const timbal = new Timbal({ baseUrl: 'https://api.test.com' });
    const client = timbal.as('user-token');
    const session = await client.getSession();

    expect(session.user_id).toBe('1');
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer user-token');
  });

  test('should throw when no auth provided', async () => {
    const orig = process.env.TIMBAL_API_KEY;
    delete process.env.TIMBAL_API_KEY;
    try {
      const timbal = new Timbal({ baseUrl: 'https://api.test.com' });
      await expect(timbal.getSession()).rejects.toThrow('Authentication required');
    } finally {
      if (orig !== undefined) process.env.TIMBAL_API_KEY = orig;
    }
  });
});
