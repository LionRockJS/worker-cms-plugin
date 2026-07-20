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
```

It uncomments the commented `[[kv_namespaces]]` template if present, matches an
existing block by binding, and otherwise appends a new block — so a plugin with
several KV namespaces can run it once per binding without clobbering the others.
Re-running is idempotent.
