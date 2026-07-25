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

const MANIFEST = { id: 'events', name: 'Events', version: '1.0.0', autoTenant: true };

if (path === '/__plugin/tenants/enroll') {
  return handleTenantEnroll(request, env, { pluginId: 'events' });
}
if (path === '/__plugin/tenants/revoke') {
  return handleTenantRevoke(request, env, { pluginId: 'events' });
}
```

Both routes must sit **outside** the plugin's own `requireTenant`/secret gate —
enrollment is what obtains the secret. The manifest's `autoTenant` flag only
tells the CMS to show its Connect button; wiring the route is the actual opt-in,
and neither grants anything by itself.

How a request is authenticated with no secret in it:

1. The CMS POSTs `{tenant, plugin_id, ticket}`. Nothing is stored yet.
2. The plugin calls `POST {tenant}/__cms/tenant/claim` to redeem the ticket —
   **the plugin picks the destination**, so claiming to be someone else's CMS
   just asks that CMS for a ticket it never issued. Only this response, over a
   connection the plugin opened, carries the secret.
3. The record is written to `tenant:<origin>`. Re-enrollment rotates the secret
   and `cmsUrl` while preserving operator-managed `signKey`, `publicBaseUrl`,
   and `vars`.

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
