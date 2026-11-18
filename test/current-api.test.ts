import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CmsApiError,
  CmsClient,
  type CmsPage,
  type CmsPageWithTags,
} from '../src/index';

function testClient(fetcher: typeof fetch) {
  return new CmsClient({
    cmsUrl: 'https://cms.test',
    pluginId: 'events',
    pluginSecret: 'test-secret',
    fetcher,
  });
}

describe('CMS file API', () => {
  it('uploads bytes and preserves download and HEAD responses', async () => {
    const bytes = Uint8Array.of(0, 255, 5);
    const key = 'themes/a + b/圖.bin';
    const download = new Response(bytes, { headers: { etag: '"file-etag"' } });
    const metadata = new Response(null, { headers: { etag: '"file-etag"' } });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, key, size: 3 }))
      .mockResolvedValueOnce(download)
      .mockResolvedValueOnce(metadata);
    const cms = testClient(fetcher);

    await expect(cms.uploadFile(key, bytes, 'application/octet-stream')).resolves.toEqual({ ok: true, key, size: 3 });
    const response = await cms.downloadFile(key);
    expect(response).toBe(download);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(await cms.headFile(key)).toBe(metadata);
    expect(metadata.body).toBeNull();

    const requests = fetcher.mock.calls.map(([url, init]) => new Request(url, init));
    expect(requests.map(request => request.method)).toEqual(['PUT', 'GET', 'HEAD']);
    for (const request of requests) {
      expect(new URL(request.url).pathname).toBe('/__cms/files');
      expect(new URL(request.url).searchParams.get('key')).toBe(key);
      expect(request.headers.get('x-plugin-id')).toBe('events');
      expect(request.headers.get('x-plugin-secret')).toBe('test-secret');
    }
    expect(requests[0].headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await requests[0].arrayBuffer())).toEqual(bytes);
  });

  it('passes pagination cursors through and preserves typed errors for file reads', async () => {
    const page = { objects: [], delimited_prefixes: ['themes/nested/'], truncated: true, cursor: 'next' };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json({ error: 'file_storage_not_approved' }, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const cms = testClient(fetcher);

    await expect(cms.listFiles({ prefix: 'themes/nested/', delimiter: '/', limit: 2, cursor: 'a+/=' })).resolves.toEqual(page);
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(Object.fromEntries(params)).toEqual({ prefix: 'themes/nested/', delimiter: '/', limit: '2', cursor: 'a+/=' });
    await expect(cms.downloadFile('themes/example')).rejects.toMatchObject({
      name: 'CmsApiError', status: 403, code: 'file_storage_not_approved', method: 'GET',
    });
    await expect(cms.headFile('themes/missing')).rejects.toBeInstanceOf(CmsApiError);
  });
});

describe('current CMS page helpers', () => {
  it('keeps legacy page types and supports typed projections and overlays', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ pages: [], total: -1, limit: 50, offset: 0 }));
    const cms = testClient(fetcher);

    const legacyList = await cms.list('event');
    expectTypeOf(legacyList.pages).toEqualTypeOf<CmsPage[]>();
    const projected = await cms.list('event', {
      field: { key: 'status', values: ['draft', 'sent'] },
      range: { key: 'weight', from: 0, to: 3 },
      fields: ['id', 'name'],
      ids: [17, 19],
      slugs: ['spring'],
      includeLiveStatus: true,
      count: false,
    });
    expectTypeOf(projected.pages).toEqualTypeOf<Array<Partial<CmsPage>>>();
    expect(projected.total).toBe(-1);
    const params = new URL(String(fetcher.mock.calls[1][0])).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      page_type: 'event', field_key: 'status', field_values: 'draft,sent', range_key: 'weight',
      range_from: '0', range_to: '3', ids: '17,19', slugs: 'spring', fields: 'id,name',
      include_live_status: '1', count: '0',
    });

    const tagged = await cms.list('event', { includeTags: true });
    expectTypeOf(tagged.pages).toEqualTypeOf<CmsPageWithTags[]>();
    expect(new URL(String(fetcher.mock.calls[2][0])).searchParams.get('include_tags')).toBe('1');
  });

  it('preserves indexed outcomes, resume cursors, and acting-user attribution', async () => {
    const update = { updated: [], count: 0, errors: [{ index: 0, error: 'not_found' }] };
    const duplicate = { count: 1000, done: false, next_cursor: 7 };
    const publish = { published: [], count: 0, errors: [{ index: 0, id: 7, error: 'publish_failed', failed_targets: ['webhook'] }] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(update))
      .mockResolvedValueOnce(Response.json(duplicate))
      .mockResolvedValueOnce(Response.json(publish));
    const cms = testClient(fetcher);

    await expect(cms.batchUpdatePages([{ id: 7, lect: { status: 'draft' } }], 42)).resolves.toEqual(update);
    const selector = { source_page_type: 'guest', source_page_id: 5, target_page_id: 6, cursor: 2 };
    await expect(cms.duplicatePages(selector)).resolves.toEqual(duplicate);
    await expect(cms.publishPages([7])).resolves.toEqual(publish);

    const requests = fetcher.mock.calls.map(([url, init]) => new Request(url, init));
    expect(requests.map(request => request.method + ' ' + new URL(request.url).pathname)).toEqual([
      'PATCH /__cms/pages/batch', 'POST /__cms/pages/duplicate', 'POST /__cms/pages/publish',
    ]);
    expect(requests[0].headers.get('x-acting-user-id')).toBe('42');
    await expect(requests[1].json()).resolves.toEqual(selector);
    await expect(requests[2].json()).resolves.toEqual({ ids: [7] });
  });
});
