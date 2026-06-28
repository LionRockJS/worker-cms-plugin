# worker-cms-plugin

Shared TypeScript helpers for 0xCMS Worker plugins.

This package intentionally contains only plugin-side contract code: the CMS
write-back client, neutral `lect` readers, admin/client-view response helpers,
secret checks, redirects, and view asset serving. It does not render Liquid
templates; plugin templates are exposed so Worker CMS can deliver them to the
client. Plugin business logic belongs in each plugin Worker.
