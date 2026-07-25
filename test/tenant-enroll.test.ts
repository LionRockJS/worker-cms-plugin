import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEnrollThrottle,
  clearTenantCache,
  handleTenantEnroll,
  handleTenantRevoke,
  tenantById,
  type TenantConfig,
} from '../src/tenants';

/** In-memory KVNamespace stand-in supporting get/put/delete/list. */
function fakeKv(records: Record<string, TenantConfig> = {}) {
  const store = new Map<string, string>(
    Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const kv = {
    store,
    list: async ({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor,
      cacheStatus: null,
    }),
    get: async (name: string, type?: string) => {
      const raw = store.get(name);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (name: string, value: string) => { store.set(name, value); },
    delete: async (name: string) => { store.delete(name); },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}

const CMS = 'https://cms.example.com';
const PLUGIN_ID = 'events';
const SECRET = 'a'.repeat(64);
const TICKET = 'b'.repeat(64);

function enrollRequest(body: unknown): Request {
  return new Request('https://plugin.example.com/__plugin/tenants/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A host that hands back the secret for exactly one ticket. */
function hostFetcher(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${CMS}/__cms/tenant/claim`) return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { ticket?: string };
    if (body.ticket !== TICKET) return new Response('forbidden', { status: 403 });
    return Response.json({ tenant: CMS, cms_url: CMS, plugin_id: PLUGIN_ID, secret: SECRET, ...overrides });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearTenantCache();
  __resetEnrollThrottle();
});

describe('handleTenantEnroll', () => {
  it('stores a tenant after the ticket is redeemed at the claimed origin', async () => {
    const env = { TENANTS: fakeKv() };
    const fetcher = hostFetcher();
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET }),
      env,
      { pluginId: PLUGIN_ID, fetcher },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tenant: CMS, rotated: false });
    const tenant = await tenantById(env, CMS);
    expect(tenant?.secret).toBe(SECRET);
    expect(tenant?.cmsUrl).toBe(CMS);
    // The plugin chose the destination, not the caller.
    expect(fetcher).toHaveBeenCalledWith(`${CMS}/__cms/tenant/claim`, expect.objectContaining({ redirect: 'manual' }));
  });

  it('stores nothing when the claimed origin has no matching ticket', async () => {
    const env = { TENANTS: fakeKv() };
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: 'c'.repeat(64) }),
      env,
      { pluginId: PLUGIN_ID, fetcher: hostFetcher() },
    );

    expect(response.status).toBe(403);
    expect(await tenantById(env, CMS)).toBeNull();
  });

  it('never calls a private, loopback, or non-HTTPS origin', async () => {
    const env = { TENANTS: fakeKv() };
    const fetcher = hostFetcher();
    for (const tenant of [
      'http://169.254.169.254',
      'https://10.0.0.5',
      'https://foo.internal',
      'ftp://cms.example.com',
      'https://[::1]',
    ]) {
      const response = await handleTenantEnroll(
        enrollRequest({ tenant, plugin_id: PLUGIN_ID, ticket: TICKET }),
        env,
        { pluginId: PLUGIN_ID, fetcher },
      );
      expect(response.status, tenant).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a claim response that repoints cms_url at another origin', async () => {
    const env = { TENANTS: fakeKv() };
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET }),
      env,
      { pluginId: PLUGIN_ID, fetcher: hostFetcher({ cms_url: 'https://attacker.example.com' }) },
    );

    expect(response.status).toBe(403);
    expect(await tenantById(env, CMS)).toBeNull();
  });

  it('rejects a plugin id that is not ours before making any callback', async () => {
    const fetcher = hostFetcher();
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: 'other', ticket: TICKET }),
      { TENANTS: fakeKv() },
      { pluginId: PLUGIN_ID, fetcher },
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honours an origin allowlist', async () => {
    const fetcher = hostFetcher();
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET }),
      { TENANTS: fakeKv(), TENANT_ENROLL_ORIGINS: 'https://other.example.com' },
      { pluginId: PLUGIN_ID, fetcher },
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rotates an existing tenant while preserving operator-managed fields', async () => {
    const env = {
      TENANTS: fakeKv({
        [`tenant:${CMS}`]: {
          secret: 'old-secret',
          signKey: 'stable-sign-key',
          publicBaseUrl: 'https://rsvp.example.com',
          vars: { EMAIL_FROM: 'events@example.com' },
        },
      }),
    };
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET }),
      env,
      { pluginId: PLUGIN_ID, fetcher: hostFetcher() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rotated: true });
    const tenant = await tenantById(env, CMS);
    expect(tenant?.secret).toBe(SECRET);
    expect(tenant?.signKey).toBe('stable-sign-key');
    expect(tenant?.publicBaseUrl).toBe('https://rsvp.example.com');
    expect(tenant?.vars.EMAIL_FROM).toBe('events@example.com');
  });

  it('refuses new tenants past the configured cap', async () => {
    const env = { TENANTS: fakeKv({ 'tenant:https://a.example.com': { secret: 'x' } }) };
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET }),
      env,
      { pluginId: PLUGIN_ID, fetcher: hostFetcher(), maxTenants: 1 },
    );

    expect(response.status).toBe(409);
    expect(await tenantById(env, CMS)).toBeNull();
  });

  it('refuses an oversized body without calling the host', async () => {
    const fetcher = hostFetcher();
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET, pad: 'x'.repeat(8192) }),
      { TENANTS: fakeKv() },
      { pluginId: PLUGIN_ID, fetcher },
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses enrollment entirely without a TENANTS binding', async () => {
    const response = await handleTenantEnroll(
      enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: TICKET }),
      {},
      { pluginId: PLUGIN_ID, fetcher: hostFetcher() },
    );
    expect(response.status).toBe(501);
  });

  it('throttles the unauthenticated leg', async () => {
    const env = { TENANTS: fakeKv() };
    let last: Response | undefined;
    for (let i = 0; i < 40; i++) {
      last = await handleTenantEnroll(
        enrollRequest({ tenant: CMS, plugin_id: PLUGIN_ID, ticket: 'c'.repeat(64) }),
        env,
        { pluginId: PLUGIN_ID, fetcher: hostFetcher() },
      );
    }
    expect(last?.status).toBe(429);
  });
});

describe('handleTenantRevoke', () => {
  const revokeRequest = (headers: Record<string, string>) => new Request(
    'https://plugin.example.com/__plugin/tenants/revoke',
    { method: 'POST', headers },
  );

  it('deletes only the authenticated tenant', async () => {
    const kv = fakeKv({
      [`tenant:${CMS}`]: { secret: SECRET },
      'tenant:https://other.example.com': { secret: 'other-secret' },
    });
    const env = { TENANTS: kv };

    const response = await handleTenantRevoke(
      revokeRequest({ 'x-cms-tenant': CMS, 'x-plugin-secret': SECRET }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await tenantById(env, CMS)).toBeNull();
    expect(await tenantById(env, 'https://other.example.com')).not.toBeNull();
  });

  it('rejects a wrong secret', async () => {
    const env = { TENANTS: fakeKv({ [`tenant:${CMS}`]: { secret: SECRET } }) };
    const response = await handleTenantRevoke(
      revokeRequest({ 'x-cms-tenant': CMS, 'x-plugin-secret': 'nope' }),
      env,
    );

    expect(response.status).toBe(403);
    expect(await tenantById(env, CMS)).not.toBeNull();
  });

  it('refuses to revoke the env-fallback tenant', async () => {
    const env = { TENANTS: fakeKv(), CMS_URL: CMS, PLUGIN_SECRET: SECRET };
    const response = await handleTenantRevoke(
      revokeRequest({ 'x-cms-tenant': CMS, 'x-plugin-secret': SECRET }),
      env,
    );
    expect(response.status).toBe(409);
  });
});
