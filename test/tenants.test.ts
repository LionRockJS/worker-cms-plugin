import { beforeEach, describe, expect, it } from 'vitest';
import {
  allTenants,
  clearTenantCache,
  requireTenant,
  soleTenant,
  tenantById,
  tenantByRef,
  tenantClientEnv,
  tenantRef,
  timingSafeEqualStr,
  type Tenant,
  type TenantConfig,
} from '../src/tenants';

/** Minimal in-memory KVNamespace stand-in (list + get only). */
function fakeKv(records: Record<string, TenantConfig>): KVNamespace {
  return {
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: Object.keys(records).filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
      cacheStatus: null,
    }),
    get: async (name: string) => records[name] ? JSON.parse(JSON.stringify(records[name])) : null,
  } as unknown as KVNamespace;
}

function request(headers: Record<string, string>): Request {
  return new Request('https://plugin.example.com/__plugin/admin/events', { headers });
}

const CMS1 = 'https://cms1.example.com';
const CMS2 = 'https://cms2.example.com';

const twoTenantEnv = () => ({
  TENANTS: fakeKv({
    [`tenant:${CMS1}`]: { secret: 'secret-one', signKey: 'sign-one', publicBaseUrl: 'https://rsvp1.example.com' },
    [`tenant:${CMS2}`]: { secret: 'secret-two', vars: { EMAIL_FROM: 'events@cms2.example.com' } },
  }),
});

beforeEach(() => clearTenantCache());

describe('tenant registry', () => {
  it('loads tenants from KV with defaults applied', async () => {
    const env = twoTenantEnv();
    const tenants = await allTenants(env);
    expect(tenants.map((tenant) => tenant.id).sort()).toEqual([CMS1, CMS2]);

    const one = await tenantById(env, CMS1);
    expect(one?.cmsUrl).toBe(CMS1);
    expect(one?.signKey).toBe('sign-one');

    const two = await tenantById(env, CMS2);
    expect(two?.signKey).toBe('secret-two'); // defaults to the pairwise secret
  });

  it('synthesizes a fallback tenant from CMS_URL + PLUGIN_SECRET', async () => {
    const env = { CMS_URL: `${CMS1}/`, PLUGIN_SECRET: 'legacy-secret' };
    const sole = await soleTenant(env);
    expect(sole?.id).toBe(CMS1);
    expect(sole?.secret).toBe('legacy-secret');
    expect(sole?.signKey).toBe('legacy-secret');
  });

  it('lets a KV record override the env-fallback tenant with the same id', async () => {
    const env = {
      CMS_URL: CMS1,
      PLUGIN_SECRET: 'legacy-secret',
      TENANTS: fakeKv({ [`tenant:${CMS1}`]: { secret: 'kv-secret' } }),
    };
    expect((await tenantById(env, CMS1))?.secret).toBe('kv-secret');
    expect((await allTenants(env)).length).toBe(1);
  });

  it('resolves tenants by their deterministic ref', async () => {
    const env = twoTenantEnv();
    const ref = await tenantRef(CMS2);
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect((await tenantByRef(env, ref))?.id).toBe(CMS2);
    expect(await tenantByRef(env, 'unknown')).toBeNull();
  });
});

describe('requireTenant', () => {
  it('authenticates the claimed tenant with its own secret', async () => {
    const result = await requireTenant(
      request({ 'x-cms-tenant': CMS1, 'x-plugin-secret': 'secret-one' }),
      twoTenantEnv(),
    );
    expect(result).not.toBeInstanceOf(Response);
    expect((result as Tenant).cmsUrl).toBe(CMS1);
  });

  it("rejects one tenant's secret presented against another tenant", async () => {
    const result = await requireTenant(
      request({ 'x-cms-tenant': CMS1, 'x-plugin-secret': 'secret-two' }),
      twoTenantEnv(),
    );
    expect((result as Response).status).toBe(403);
  });

  it('rejects an unknown claimed tenant', async () => {
    const result = await requireTenant(
      request({ 'x-cms-tenant': 'https://evil.example.com', 'x-plugin-secret': 'secret-one' }),
      twoTenantEnv(),
    );
    expect((result as Response).status).toBe(403);
  });

  it('fails closed when several tenants exist and no tenant header is sent', async () => {
    const result = await requireTenant(request({ 'x-plugin-secret': 'secret-one' }), twoTenantEnv());
    expect((result as Response).status).toBe(403);
  });

  it('accepts a headerless call while exactly one tenant is configured', async () => {
    const env = { CMS_URL: CMS1, PLUGIN_SECRET: 'legacy-secret' };
    const result = await requireTenant(request({ 'x-plugin-secret': 'legacy-secret' }), env);
    expect((result as Tenant).id).toBe(CMS1);
  });

  it('returns 500 when no tenants are configured at all', async () => {
    const result = await requireTenant(request({ 'x-plugin-secret': 'anything' }), {});
    expect((result as Response).status).toBe(500);
  });
});

describe('tenantClientEnv', () => {
  it('overlays connection values, tenant vars, and passes bindings through', async () => {
    const env = twoTenantEnv();
    const tenant = (await tenantById(env, CMS2))!;
    const marker = { binding: true };
    const scoped = tenantClientEnv({ ...env, VIEWS: marker, EMAIL_FROM: 'global@example.com', PUBLIC_BASE_URL: 'https://legacy.example.com' }, tenant);

    expect(scoped.CMS_URL).toBe(CMS2);
    expect(scoped.PLUGIN_SECRET).toBe('secret-two');
    expect(scoped.SIGN_KEY).toBe('secret-two');
    expect(scoped.CMS_TENANT_ID).toBe(CMS2);
    expect(scoped.CMS_TENANT_REF).toBe(tenant.ref);
    expect(scoped.EMAIL_FROM).toBe('events@cms2.example.com'); // tenant var wins
    expect(scoped.PUBLIC_BASE_URL).toBe('https://legacy.example.com'); // env fallback kept
    expect(scoped.VIEWS).toBe(marker);

    const one = (await tenantById(env, CMS1))!;
    const scopedOne = tenantClientEnv({ PUBLIC_BASE_URL: 'https://legacy.example.com' }, one);
    expect(scopedOne.PUBLIC_BASE_URL).toBe('https://rsvp1.example.com'); // tenant value wins
    expect(scopedOne.SIGN_KEY).toBe('sign-one');
  });
});

describe('timingSafeEqualStr', () => {
  it('compares equal and unequal strings', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});
