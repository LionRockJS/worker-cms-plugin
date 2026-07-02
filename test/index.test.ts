import { describe, expect, it, vi } from 'vitest';
import {
  CmsApiError,
  CmsClient,
  CmsNotConfiguredError,
  adminView,
  attr,
  blocks,
  clientViewResponse,
  compareByWeightThenName,
  items,
  localized,
  notFoundView,
  parseCmsUser,
  pointer,
  redirect,
  requirePluginSecret,
  serveViewAsset,
  type CmsPage,
} from '../src/index';

function page(overrides: Partial<CmsPage>): CmsPage {
  return {
    id: 1,
    uuid: 'uuid',
    page_type: 'event',
    name: 'Page',
    slug: 'page',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '',
    updated_at: '',
    lect: {},
    ...overrides,
  };
}

describe('CmsClient', () => {
  it('calls the default Worker fetch as a global property', async () => {
    let fetchThis: unknown;
    vi.stubGlobal('fetch', function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      fetchThis = this;
      expect(String(input)).toBe('https://cms.test/__cms/pages?page_type=event&limit=1');
      return Promise.resolve(Response.json({ pages: [], total: 0 }));
    } as typeof fetch);

    const cms = new CmsClient({
      cmsUrl: 'https://cms.test',
      pluginSecret: 'shared-secret',
      pluginId: 'events',
    });

    await expect(cms.list('event', { limit: 1 })).resolves.toEqual({ pages: [], total: 0 });
    expect(fetchThis).toBe(globalThis);
  });

  it('sends CMS API requests with plugin headers and a safe fetch binding', async () => {
    let fetchThis: unknown;
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetcher = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      fetchThis = this;
      requestUrl = String(input);
      requestInit = init;
      return Promise.resolve(Response.json({ pages: [], total: 0 }));
    } as typeof fetch;

    const cms = new CmsClient({
      cmsUrl: 'https://cms.test/',
      pluginSecret: 'shared-secret',
      pluginId: 'events',
      fetcher,
    });

    await cms.list('event', {
      parentId: 12,
      pointer: { key: 'mail_list', value: 34 },
      q: 'Ada',
      limit: 20,
      offset: 40,
    });

    expect(fetchThis).toBe(globalThis);
    expect(requestUrl).toBe('https://cms.test/__cms/pages?page_type=event&page_id=12&pointer_key=mail_list&pointer_value=34&q=Ada&limit=20&offset=40');
    expect(requestInit).toMatchObject({
      method: 'GET',
      headers: {
        'x-plugin-secret': 'shared-secret',
        'x-plugin-id': 'events',
      },
    });
  });

  it('serializes multi-value pointer filters for list calls', async () => {
    let requestUrl = '';
    const fetcher = ((input: RequestInfo | URL): Promise<Response> => {
      requestUrl = String(input);
      return Promise.resolve(Response.json({ pages: [], total: 0 }));
    }) as typeof fetch;

    const cms = new CmsClient({
      cmsUrl: 'https://cms.test/',
      pluginSecret: 'shared-secret',
      pluginId: 'events',
      fetcher,
    });

    await cms.list('guest', {
      pointer: { key: 'mail_list', values: [12, 13] },
      q: '陳',
    });

    expect(requestUrl).toBe('https://cms.test/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_values=12%2C13&q=%E9%99%B3');
  });

  it('writes pages and batches through the expected CMS endpoints', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (init?.method === 'DELETE') return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(Response.json({ page: page({ id: 7 }), created: [], errors: [] }));
    }) as typeof fetch;
    const cms = new CmsClient({ cmsUrl: 'https://cms.test', pluginSecret: 'secret', pluginId: 'events', fetcher });

    await cms.get(7);
    await cms.create({ page_type: 'event', name: 'Launch' });
    await cms.update(7, { name: 'Updated' });
    await cms.remove(7);
    await cms.batchCreate([{ name: 'A' }]);
    await cms.batchRemove([1, 2, 3], 2);

    expect(calls.map((call) => `${call.init?.method} ${new URL(call.input).pathname}`)).toEqual([
      'GET /__cms/pages/7',
      'POST /__cms/pages',
      'PUT /__cms/pages/7',
      'DELETE /__cms/pages/7',
      'POST /__cms/pages/batch',
      'DELETE /__cms/pages/batch',
      'DELETE /__cms/pages/batch',
    ]);
    expect(calls[1].init?.body).toBe(JSON.stringify({ page_type: 'event', name: 'Launch' }));
    expect(calls[5].init?.body).toBe(JSON.stringify({ ids: [1, 2] }));
    expect(calls[6].init?.body).toBe(JSON.stringify({ ids: [3] }));
  });

  it('throws typed errors for bad configuration and CMS API failures', async () => {
    expect(() => new CmsClient({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret' }, '')).toThrow(CmsNotConfiguredError);
    expect(() => new CmsClient({ CMS_URL: '', PLUGIN_SECRET: 'secret' }, 'events')).toThrow(CmsNotConfiguredError);

    const cms = new CmsClient({
      cmsUrl: 'https://cms.test',
      pluginSecret: 'secret',
      pluginId: 'events',
      fetcher: (() => Promise.resolve(Response.json({ error: 'bad_page_type' }, { status: 422 }))) as typeof fetch,
    });

    await expect(cms.get(99)).rejects.toMatchObject({
      name: 'CmsApiError',
      status: 422,
      code: 'bad_page_type',
      method: 'GET',
      path: '/pages/99',
    } satisfies Partial<CmsApiError>);
  });
});

describe('lect helpers', () => {
  it('reads scalar, localized, array, block, and pointer values', () => {
    const lect = {
      status: 'confirmed',
      title: { en: 'Hello', fr: 'Bonjour' },
      guests: [{ name: 'Ada' }],
      _blocks: [{ _weight: 2, name: 'B' }, { _weight: 1, name: 'A' }],
      _pointers: { event: 12 },
    };

    expect(attr(lect, 'status')).toBe('confirmed');
    expect(attr(lect, 'missing')).toBe('');
    expect(localized(lect, 'title', 'fr')).toBe('Bonjour');
    expect(localized({ title: { fr: 'Bonjour' } }, 'title')).toBe('Bonjour');
    expect(items(lect, 'guests')).toEqual([{ name: 'Ada' }]);
    expect(blocks(lect).map((block) => block.name)).toEqual(['A', 'B']);
    expect(pointer(lect, 'event')).toBe('12');
  });

  it('sorts pages by finite weight and then name', () => {
    const sorted = [
      page({ name: 'Zulu', weight: Number.NaN }),
      page({ name: 'Beta', weight: 2 }),
      page({ name: 'Alpha', weight: 2 }),
    ].sort(compareByWeightThenName);

    expect(sorted.map((entry) => entry.name)).toEqual(['Alpha', 'Beta', 'Zulu']);
  });
});

describe('view and request helpers', () => {
  it('builds client-render and json-only admin responses', async () => {
    const clientResponse = clientViewResponse('Events', '/templates/events.json', { count: 2 });
    expect(clientResponse.headers.get('x-cms-chrome')).toBe('1');
    expect(clientResponse.headers.get('x-cms-client-view')).toBe('1');
    expect(clientResponse.headers.get('x-cms-view-path')).toBe('/templates/events.json');
    expect(clientResponse.headers.get('x-cms-title')).toBe('Events');
    await expect(clientResponse.json()).resolves.toEqual({ count: 2 });

    const jsonResponse = await adminView({ fetch } as Fetcher, 'Events', 'events', { count: 2 }, true);
    await expect(jsonResponse.json()).resolves.toEqual({ title: 'Events', template: 'events', data: { count: 2 } });

    const missingResponse = await notFoundView({ fetch } as Fetcher, 'Gone', true);
    await expect(missingResponse.json()).resolves.toMatchObject({
      title: 'Not found',
      data: { heading: 'Not found', message: 'Gone' },
    });
  });

  it('parses CMS user headers and validates plugin secrets', async () => {
    expect(parseCmsUser(JSON.stringify({ id: '1', email: 'a@example.com', name: 'Ada', role: 'admin', extra: true }))).toEqual({
      id: '1',
      email: 'a@example.com',
      name: 'Ada',
      role: 'admin',
    });
    expect(parseCmsUser('not-json')).toEqual({});

    const request = new Request('https://plugin.test', { headers: { 'x-plugin-secret': 'secret' } });
    expect(requirePluginSecret(request, 'secret')).toBeNull();
    expect(requirePluginSecret(request, undefined)?.status).toBe(500);
    expect(requirePluginSecret(new Request('https://plugin.test'), 'secret')?.status).toBe(403);
  });

  it('builds no-store redirects', () => {
    const response = redirect('/admin/plugins/events', 303);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/plugins/events');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('serveViewAsset', () => {
  it('serves templates, assets, and bare snippet fallbacks with the right cache headers', async () => {
    const requested: string[] = [];
    const views = {
      async fetch(input: RequestInfo | URL): Promise<Response> {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        requested.push(url.pathname);
        if (url.pathname === '/assets/client-render.js') return new Response('console.log(1)');
        if (url.pathname === '/templates/events.json') return Response.json({ sections: {} });
        if (url.pathname === '/snippets/guest-table.liquid') return new Response('snippet');
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const asset = await serveViewAsset(views, '/assets/client-render.js');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=86400');

    const template = await serveViewAsset(views, '/templates/events.json');
    expect(template.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(template.headers.get('cache-control')).toBe('no-store');

    const snippet = await serveViewAsset(views, '/guest-table.liquid', { bareLiquidSnippets: true });
    expect(await snippet.text()).toBe('snippet');
    expect(snippet.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(snippet.headers.get('cache-control')).toBe('no-store');
    expect(requested).toContain('/guest-table.liquid');
    expect(requested).toContain('/snippets/guest-table.liquid');
  });

  it('rejects invalid or missing view assets', async () => {
    const views = {
      async fetch(): Promise<Response> {
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    expect((await serveViewAsset(views, '../secret')).status).toBe(404);
    expect((await serveViewAsset(views, '/missing.liquid')).status).toBe(404);
  });
});
