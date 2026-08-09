# worker-cms-plugin

Shared TypeScript helpers for 0xCMS Worker plugins.

This package intentionally contains only plugin-side contract code: the CMS
write-back client, neutral `lect` readers, admin/client-view response helpers,
secret checks, redirects, and view asset serving. It does not render Liquid
templates; plugin templates are exposed so Worker CMS can deliver them to the
client. Plugin business logic belongs in each plugin Worker.

## `cms-plugin-kv-setup` (bin)

Installing this package also gives a plugin a `cms-plugin-kv-setup` command that
creates a KV namespace and writes its id into the plugin's own `wrangler.toml`
(the one in the current working directory). Wire it into the plugin's scripts:

```json
"kv:setup":         "cms-plugin-kv-setup",
"kv:setup:preview": "cms-plugin-kv-setup --preview"
```

```sh
npm run kv:setup                     # production namespace -> sets `id`
npm run kv:setup:preview             # preview namespace    -> sets `preview_id`
npm run kv:setup -- --binding=CACHE  # a binding other than the default TENANTS
npm run kv:setup -- --title=my-name  # override the account-unique title
```

The namespace **title** (unique per Cloudflare account) defaults to
`<worker name>-<binding>` — e.g. `worker-cms-plugin-events-TENANTS` — so every
plugin can bind its own namespace as the same shared `TENANTS` binding without
the titles colliding (`wrangler` does not prefix the worker name, so a bare
`TENANTS` title collides across plugins). The **binding** written into
`wrangler.toml` is separate and stays whatever `--binding` says.

It uncomments the commented `[[kv_namespaces]]` template if present, matches an
existing block by binding, and otherwise appends a new block — so a plugin with
several KV namespaces can run it once per binding without clobbering the others.

## Tenant auto-enrollment

Connecting a CMS normally means an operator hand-writing a `tenant:<origin>`
record into the plugin's `TENANTS` KV. `handleTenantEnroll()` lets the host do it
instead, without ever exposing the plugin to "anyone can become a tenant":

```ts
import { handleTenantEnroll, handleTenantRevoke, requireTenant } from '@lionrockjs/worker-cms-plugin';

const MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  autoTenant: true,
  tenantVars: ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_SECRET'],
};

if (path === '/__plugin/tenants/enroll') {
  return handleTenantEnroll(request, env, { pluginId: MANIFEST.id });
}
if (path === '/__plugin/tenants/revoke') {
  return handleTenantRevoke(request, env, { pluginId: MANIFEST.id });
}
```

Both routes must sit **outside** the plugin's own `requireTenant`/secret gate —
enrollment is what obtains the secret. The manifest's `autoTenant` flag only
tells the CMS to show its Connect button; wiring the route is the actual opt-in,
and neither grants anything by itself.

How a request is authenticated with no secret in it:

1. The CMS POSTs `{tenant, plugin_id, ticket}` and, when the manifest declares
   them, a `tenant_vars` list containing variable names only. Nothing is stored
   yet.
2. The plugin calls `POST {tenant}/__cms/tenant/claim` to redeem the ticket —
   **the plugin picks the destination**, so claiming to be someone else's CMS
   just asks that CMS for a ticket it never issued. Only this response, over a
   connection the plugin opened, carries the secret.
3. The record is written to `tenant:<origin>`. Re-enrollment rotates the secret
   and `cmsUrl` while preserving operator-managed `signKey`, `publicBaseUrl`,
   and `vars`.

`tenantVars` is an optional manifest/handler declaration for plugin environment
variable names that should be copied into a newly enrolled record's `vars`.
When the request comes from the CMS, the host's validated manifest declaration
is sent as `tenant_vars`, so the handler does not need to duplicate the list.
The handler may still pass `tenantVars` for a fixed declaration or a caller
outside the CMS. Only non-empty string values are copied, and existing tenant
values win during rotation. This is useful for deployment-wide defaults such as
GitHub App identity values, while still allowing a tenant-specific KV override.
Connection fields such as `CMS_URL` and `PLUGIN_SECRET` are reserved and
ignored.

### Authenticated tenant variable configuration

Plugins that expose editable per-tenant variables can mount the shared handler
at `/__plugin/tenants/config`:

```ts
import { handleTenantConfig } from '@lionrockjs/worker-cms-plugin';

if (path === '/__plugin/tenants/config') {
  return handleTenantConfig(request, env, {
    tenantVars: MANIFEST.tenantVars,
  });
}
```

The endpoint requires both `x-cms-tenant` and the matching `x-plugin-secret`
for the same KV tenant record. `GET` returns only the declared variables:

```json
{ "ok": true, "tenant": "https://cms.example.com", "vars": { "EMAIL_FROM": "" } }
```

`PUT` accepts a partial update in the form `{ "vars": { "EMAIL_FROM":
"events@example.com", "SIGN_KEY": null } }`. `null` (and the CMS form's blank
value) removes a variable. Undeclared variables and connection fields are never
changed, and the endpoint refuses the legacy `CMS_URL`/`PLUGIN_SECRET`
fallback because it has no KV record to edit.

Guards on the unauthenticated leg: the callback target must be a public HTTPS
origin (loopback allowed for development), redirects are not followed, the call
is time-boxed, a `cms_url` on another origin is refused, and a best-effort
per-isolate throttle bounds the rate. Options tighten it further:

| option / env | default | effect |
| --- | --- | --- |
| `pluginId` | — | required; a mismatched `plugin_id` is refused before any callback |
| `allowOrigins` / `TENANT_ENROLL_ORIGINS` | none | hard allowlist of CMS origins |
| `allowNew` | `true` | `false` freezes the tenant set but still accepts rotations |
| `allowRotate` | `true` | `false` refuses re-enrollment of a known tenant |
| `maxTenants` | `100` | cap on KV tenant records |

`handleTenantRevoke()` is authenticated by the pairwise secret via
`requireTenant`, so a tenant can only ever delete its own record.

Note the registry's 60-second per-isolate cache: a freshly enrolled tenant may
see transient 403s, and after a rotation the previous secret keeps working on
isolates that have not refreshed yet. Plan rotations with that lag in mind — the
old credential is not instantly dead everywhere.
