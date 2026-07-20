// Type declarations for the pure helpers exported by kv-setup.mjs (imported by
// tests). The CLI entry point has no exported types.

/** Write `key = "<id>"` into the [[kv_namespaces]] block for `binding`. */
export function setKvNamespaceId(text: string, key: string, id: string, binding?: string): string;

/** Extract a 32-hex KV namespace id from `wrangler kv namespace create` output. */
export function parseNamespaceId(output: string, preview: boolean): string | null;

/** Read `--binding=NAME` / `--binding NAME` from argv, defaulting to TENANTS. */
export function parseBinding(argv: string[]): string;
