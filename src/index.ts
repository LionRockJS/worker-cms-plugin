export {
  allTenants,
  clearTenantCache,
  handleTenantConfig,
  deleteTenant,
  handleTenantEnroll,
  handleTenantRevoke,
  putTenant,
  requireTenant,
  soleTenant,
  tenantById,
  tenantByRef,
  tenantClientEnv,
  tenantRef,
  timingSafeEqualStr,
  type Tenant,
  type TenantConfig,
  type TenantConfigOptions,
  type TenantEnrollEnv,
  type TenantEnrollOptions,
  type TenantEnvVars,
  type TenantRegistryEnv,
} from './tenants';
import { timingSafeEqualStr } from './tenants';

export {
  PluginState,
  clearPluginStateCache,
  pluginState,
  type PluginStateEntry,
  type PluginStateEnv,
  type PluginStateOptions,
} from './state';

export interface CmsClientEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
}

export interface CmsClientOptions {
  cmsUrl?: string;
  pluginSecret?: string;
  pluginId: string;
  fetcher?: typeof fetch;
}

export type CmsRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CmsRequestOptions {
  body?: unknown;
  actingUserId?: number | string;
}

/**
 * Stable structural contract used by optional feature decorators.
 *
 * Feature packages can depend on this shape rather than a CmsClient version.
 */
export interface CmsApiTransport {
  request<T>(method: CmsRequestMethod, path: string, options?: CmsRequestOptions): Promise<T>;
}

export interface CmsPage {
  id: number;
  uuid: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Record<string, unknown>;
  tags?: number[];
}

export interface CmsPageInput {
  id?: number;
  page_type?: string;
  name?: string;
  slug?: string;
  lect?: Record<string, unknown>;
  weight?: number;
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
  page_id?: number | null;
  tags?: number[];
}

export type CmsListPointer =
  | { key: string; value: number | string }
  | { key: string; values: Array<number | string> };

export type CmsPageListSort = 'weight' | 'name' | 'created_at' | 'updated_at' | 'published_at';

export interface CmsPageListGroupBy {
  tag_taxonomy: string;
  include_untagged?: boolean;
}

export interface CmsPageListQuery {
  key: string;
  page_type: string;
  limit: number;
  sort: CmsPageListSort;
  order: 'asc' | 'desc';
  group_by?: CmsPageListGroupBy;
}

export interface CmsPageResourceTag {
  id: number;
  slug: string;
  name: string;
  weight: number;
  taxonomy_slug: string;
  parent_tag: number | null;
  created_at: string;
  updated_at: string;
  lect: Record<string, unknown>;
}

export interface CmsPageResourceGroup {
  tag: CmsPageResourceTag | null;
  pages: CmsPage[];
}

export interface CmsPageResourceCollection {
  pages: CmsPage[];
  groups: CmsPageResourceGroup[];
}

export interface CmsUser {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
}

export class CmsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public method = '',
    public path = '',
    /** Parsed JSON error response body, when the CMS returned one. */
    public detail?: unknown,
  ) {
    const target = method && path ? ` ${method} ${path}` : '';
    super(`CMS API${target} ${status}: ${code}`);
    this.name = 'CmsApiError';
  }
}

export class CmsNotConfiguredError extends Error {
  constructor(message = 'CMS_URL and PLUGIN_SECRET must be set for the plugin to reach the CMS') {
    super(message);
    this.name = 'CmsNotConfiguredError';
  }
}

export class CmsClient implements CmsApiTransport {
  private readonly base: string;
  private readonly secret: string;
  private readonly pluginId: string;
  private readonly fetcher: typeof fetch;

  constructor(init: CmsClientEnv, pluginId: string);
  constructor(init: CmsClientOptions);
  constructor(init: CmsClientEnv | CmsClientOptions, pluginId = '') {
    const options = 'pluginId' in init
      ? init
      : { cmsUrl: init.CMS_URL, pluginSecret: init.PLUGIN_SECRET, pluginId };

    if (!options.cmsUrl || !options.pluginSecret) throw new CmsNotConfiguredError();
    if (!options.pluginId) throw new CmsNotConfiguredError('A plugin id is required for the CMS client');

    this.base = options.cmsUrl.replace(/\/+$/, '');
    this.secret = options.pluginSecret;
    this.pluginId = options.pluginId;
    const fetcher = 'fetcher' in options && options.fetcher ? options.fetcher : undefined;
    this.fetcher = fetcher
      ? (input, init) => fetcher.call(globalThis, input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  /** Builds one authenticated request to the host's plugin API. */
  private async call(method: string, path: string, body?: unknown, actingUserId?: number | string): Promise<Response> {
    return this.fetcher(`${this.base}/__cms${path}`, {
      method,
      headers: {
        'x-plugin-secret': this.secret,
        'x-plugin-id': this.pluginId,
        ...(actingUserId !== undefined && actingUserId !== null ? { 'x-acting-user-id': String(actingUserId) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Parses a successful JSON response or throws a structured CmsApiError. */
  private async json<T>(res: Response, method = '', path = ''): Promise<T> {
    if (!res.ok) {
      const failure = await res.text()
        .then((text) => {
          if (!text) return { code: 'error', detail: undefined as unknown };
          try {
            const body = JSON.parse(text) as { error?: unknown };
            const code = typeof body.error === 'string' && body.error ? body.error : 'error';
            return { code, detail: body as unknown };
          } catch {
            return { code: text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'error', detail: undefined as unknown };
          }
        })
        .catch(() => ({ code: 'error', detail: undefined as unknown }));
      throw new CmsApiError(res.status, failure.code, method, path, failure.detail);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Authenticated feature-route transport. Optional feature decorators use
   * this method without needing access to the client's constructor or fields.
   */
  async request<T>(
    method: CmsRequestMethod,
    path: string,
    options: CmsRequestOptions = {},
  ): Promise<T> {
    return this.json(
      await this.call(method, path, options.body, options.actingUserId),
      method,
      path,
    );
  }

  async list(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string; limit?: number; offset?: number } = {},
  ): Promise<{ pages: CmsPage[]; total: number }> {
    const params = new URLSearchParams({ page_type: pageType });
    if (opts.parentId != null) params.set('page_id', String(opts.parentId));
    if (opts.pointer) {
      params.set('pointer_key', opts.pointer.key);
      if ('values' in opts.pointer) {
        params.set('pointer_values', opts.pointer.values.map(String).join(','));
      } else {
        params.set('pointer_value', String(opts.pointer.value));
      }
    }
    if (opts.q) params.set('q', opts.q);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    const path = `/pages?${params.toString()}`;
    return this.json(await this.call('GET', path), 'GET', path);
  }

  async listMany(queries: CmsPageListQuery[]): Promise<{
    pages_by_type: Record<string, CmsPageResourceCollection>;
  }> {
    const path = '/pages/list-batch';
    return this.json(
      await this.call('POST', path, { queries }),
      'POST',
      path,
    );
  }

  async get(id: number): Promise<CmsPage> {
    const path = `/pages/${id}`;
    const { page } = await this.json<{ page: CmsPage }>(await this.call('GET', path), 'GET', path);
    return page;
  }

  async create(input: CmsPageInput): Promise<CmsPage> {
    const { page } = await this.json<{ page: CmsPage }>(await this.call('POST', '/pages', input), 'POST', '/pages');
    return page;
  }

  async update(id: number, input: CmsPageInput): Promise<CmsPage> {
    const path = `/pages/${id}`;
    const { page } = await this.json<{ page: CmsPage }>(await this.call('PUT', path, input), 'PUT', path);
    return page;
  }

  async remove(id: number): Promise<void> {
    const path = `/pages/${id}`;
    await this.json(await this.call('DELETE', path), 'DELETE', path);
  }

  async batchCreate(pages: CmsPageInput[]): Promise<{ created: CmsPage[]; errors: Array<{ index: number; error: string }> }> {
    return this.json(await this.call('POST', '/pages/batch', { pages }), 'POST', '/pages/batch');
  }

  async batchRemove(ids: number[], batchSize = 100): Promise<void> {
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      await this.json(await this.call('DELETE', '/pages/batch', { ids: chunk }), 'DELETE', '/pages/batch');
    }
  }
}

export function compareByWeightThenName(a: CmsPage, b: CmsPage): number {
  const aw = Number(a.weight);
  const bw = Number(b.weight);
  const aWeight = Number.isFinite(aw) ? aw : Number.MAX_SAFE_INTEGER;
  const bWeight = Number.isFinite(bw) ? bw : Number.MAX_SAFE_INTEGER;
  return (aWeight - bWeight) || a.name.localeCompare(b.name);
}

export function attr(lect: Record<string, unknown>, key: string): string {
  const v = lect[key];
  return v == null ? '' : String(v);
}

export function localized(lect: Record<string, unknown>, key: string, lang = 'en'): string {
  const v = lect[key];
  if (v == null) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const map = v as Record<string, unknown>;
    return String(map[lang] ?? Object.values(map)[0] ?? '');
  }
  return String(v);
}

export function items(lect: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const v = lect[key];
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

export function blocks(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  const v = lect._blocks;
  if (!Array.isArray(v)) return [];
  return [...(v as Array<Record<string, unknown>>)].sort(
    (a, b) => (Number(a._weight) || 0) - (Number(b._weight) || 0),
  );
}

export function pointer(lect: Record<string, unknown>, key: string): string {
  const p = lect._pointers;
  if (p && typeof p === 'object') return String((p as Record<string, unknown>)[key] ?? '');
  return '';
}

export async function adminView(
  _views: Fetcher,
  title: string,
  template: string,
  data: Record<string, unknown> = {},
  jsonOnly = false,
): Promise<Response> {
  if (jsonOnly) return Response.json({ title, template, data });
  return clientViewResponse(title, `/templates/${template}.json`, data);
}

export function clientViewResponse(title: string, viewPath: string, data: Record<string, unknown>): Response {
  return Response.json(data, {
    headers: {
      'x-cms-chrome': '1',
      'x-cms-client-view': '1',
      'x-cms-view-path': viewPath,
      'x-cms-title': encodeURIComponent(title),
    },
  });
}

export function notFoundView(views: Fetcher, message = 'Page not found.', jsonOnly = false): Promise<Response> {
  return adminView(views, 'Not found', 'error', { heading: 'Not found', message }, jsonOnly);
}

export function parseCmsUser(header: string | null): CmsUser {
  if (!header) return {};
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      role: typeof parsed.role === 'string' ? parsed.role : undefined,
    };
  } catch {
    return {};
  }
}

export function requirePluginSecret(request: Request, secret: string | undefined): Response | null {
  if (!secret) {
    return new Response('server misconfigured', {
      status: 500,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (!timingSafeEqualStr(request.headers.get('x-plugin-secret') ?? '', secret)) {
    return new Response('forbidden', {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return null;
}

export function redirect(to: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location: to, 'cache-control': 'no-store' },
  });
}

export interface ServeViewAssetOptions {
  /** Supports legacy requests such as /views/guest-table.liquid -> /snippets/guest-table.liquid. */
  bareLiquidSnippets?: boolean;
  assetsCacheControl?: string;
  templatesCacheControl?: string;
}

export async function serveViewAsset(
  views: Fetcher,
  assetPath: string,
  options: ServeViewAssetOptions = {},
): Promise<Response> {
  if (!assetPath.startsWith('/') || assetPath.includes('..')) return new Response('not found', { status: 404 });

  const fallbackAssetPath = options.bareLiquidSnippets
    && assetPath.endsWith('.liquid')
    && assetPath.indexOf('/', 1) === -1
    ? `/snippets${assetPath}`
    : '';

  let response = await views.fetch(new URL(assetPath, 'https://views.local'));
  if (!response.ok && fallbackAssetPath) {
    response = await views.fetch(new URL(fallbackAssetPath, 'https://views.local'));
  }
  if (!response.ok) return new Response('not found', { status: 404 });

  const headers = new Headers(response.headers);
  if (assetPath.endsWith('.js')) {
    headers.set('content-type', 'text/javascript; charset=utf-8');
  } else if (assetPath.endsWith('.json')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  } else if (assetPath.endsWith('.liquid')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }

  if (assetPath.startsWith('/assets/')) {
    headers.set('cache-control', options.assetsCacheControl ?? 'public, max-age=86400');
  } else if (assetPath.endsWith('.json') || assetPath.endsWith('.liquid')) {
    headers.set('cache-control', options.templatesCacheControl ?? 'no-store');
  } else {
    headers.set('cache-control', 'no-store');
  }

  return new Response(response.body, { status: response.status, headers });
}
