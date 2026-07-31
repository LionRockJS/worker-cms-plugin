import { beforeEach, describe, expect, it } from 'vitest';
import { CmsApiError, PluginState, clearPluginStateCache } from '../src/index';
import type { CmsApiTransport, CmsRequestMethod, CmsRequestOptions } from '../src/index';

// Host-held plugin state. The behaviours worth pinning are the ones a caller
// would otherwise get subtly wrong: a missing key is null but an unreachable
// host is an error, hits are cached per tenant while misses are not, and a
// write is visible immediately without a round trip.

interface Call {
  method: CmsRequestMethod;
  path: string;
  body?: unknown;
}

function transport(handler: (call: Call) => unknown): CmsApiTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request<T>(method: CmsRequestMethod, path: string, options: CmsRequestOptions = {}): Promise<T> {
      const call = { method, path, body: options.body };
      calls.push(call);
      return handler(call) as T;
    },
  };
}

/** Mirrors the host: values come back as the JSON text that was stored. */
function stored(value: unknown) {
  return { value: JSON.stringify(value) };
}

beforeEach(() => {
  clearPluginStateCache();
});

describe('PluginState', () => {
  it('parses a stored value back to what was written', async () => {
    const connection = { installationId: 42, accountLogin: 'acme' };
    const api = transport(() => stored(connection));
    const state = new PluginState(api, { scope: 'https://cms.example' });

    expect(await state.get('github.connection')).toEqual(connection);
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/state/github.connection' });
  });

  it('returns null for a key the host does not have', async () => {
    const api = transport(() => {
      throw new CmsApiError(404, 'not_found', 'GET', '/state/github.connection');
    });
    const state = new PluginState(api, { scope: 'https://cms.example' });

    expect(await state.get('github.connection')).toBeNull();
  });

  it('throws rather than reporting null when the host is unreachable', async () => {
    // A 503 read as "nothing stored" would make a caller re-run a connect flow
    // that has already completed, so this must not be swallowed.
    const api = transport(() => {
      throw new CmsApiError(503, 'unavailable', 'GET', '/state/github.connection');
    });
    const state = new PluginState(api, { scope: 'https://cms.example' });

    await expect(state.get('github.connection')).rejects.toThrow(CmsApiError);
  });

  it('caches a hit for the tenant that read it', async () => {
    const api = transport(() => stored('connected'));
    const state = new PluginState(api, { scope: 'https://cms.example' });

    await state.get('github.connection');
    await state.get('github.connection');
    expect(api.calls).toHaveLength(1);
  });

  it('never serves one tenant a value cached for another', async () => {
    const api = transport((call) => stored(call.path.includes('github') ? 'first-tenant' : ''));
    const first = new PluginState(api, { scope: 'https://one.example' });
    const second = new PluginState(api, { scope: 'https://two.example' });

    await first.get('github.connection');
    await second.get('github.connection');
    expect(api.calls).toHaveLength(2);
  });

  it('does not cache a miss, so a write from another isolate is seen at once', async () => {
    let present = false;
    const api = transport(() => {
      if (!present) throw new CmsApiError(404, 'not_found');
      return stored('connected');
    });
    const state = new PluginState(api, { scope: 'https://cms.example' });

    expect(await state.get('github.connection')).toBeNull();
    // The OAuth callback ran in another isolate and connected the account.
    present = true;
    expect(await state.get('github.connection')).toBe('connected');
  });

  it('expires a cached hit after the ttl', async () => {
    const api = transport(() => stored('connected'));
    const state = new PluginState(api, { scope: 'https://cms.example', ttlMs: -1 });

    await state.get('github.connection');
    await state.get('github.connection');
    expect(api.calls).toHaveLength(2);
  });

  it('writes through, so a get after a put costs no round trip', async () => {
    const api = transport(() => ({ ok: true }));
    const state = new PluginState(api, { scope: 'https://cms.example' });

    await state.put('github.connection', { installationId: 7 });
    expect(await state.get('github.connection')).toEqual({ installationId: 7 });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: 'PUT', body: { value: { installationId: 7 } } });
  });

  it('drops the cached value on delete', async () => {
    let present = true;
    const api = transport((call) => {
      if (call.method === 'DELETE') {
        present = false;
        return { ok: true };
      }
      if (!present) throw new CmsApiError(404, 'not_found');
      return stored('connected');
    });
    const state = new PluginState(api, { scope: 'https://cms.example' });

    await state.get('github.connection');
    await state.delete('github.connection');
    expect(await state.get('github.connection')).toBeNull();
  });

  it('skips the cache entirely without a tenant scope', async () => {
    const api = transport(() => stored('connected'));
    const state = new PluginState(api);

    await state.get('github.connection');
    await state.get('github.connection');
    expect(api.calls).toHaveLength(2);
  });

  it('lists entries and drops unparseable ones', async () => {
    const api = transport(() => ({
      state: [
        { key: 'github.connection', value: '{"installationId":7}', updated_at: '2026-07-31T00:00:00Z' },
        { key: 'broken', value: 'not json', updated_at: '' },
      ],
    }));
    const state = new PluginState(api, { scope: 'https://cms.example' });

    const entries = await state.list('github.');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'github.connection', value: { installationId: 7 } });
    expect(api.calls[0].path).toBe('/state?prefix=github.');
  });
});
