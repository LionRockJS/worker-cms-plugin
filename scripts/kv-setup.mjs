#!/usr/bin/env node
// ============================================================
// Create a KV namespace and write its id into the calling plugin's
// wrangler.toml. Shared across every worker-cms-plugin; a plugin exposes it
// through its own npm scripts, e.g.
//
//   "kv:setup":         "cms-plugin-kv-setup",
//   "kv:setup:preview": "cms-plugin-kv-setup --preview"
//
//   npm run kv:setup                     # production namespace  -> sets `id`
//   npm run kv:setup:preview             # preview namespace     -> sets `preview_id`
//   npm run kv:setup -- --binding=CACHE  # a binding other than the default TENANTS
//   npm run kv:setup -- --title=my-name  # override the account-unique title
//
// `wrangler kv namespace create` only prints the id; this wraps it so the id
// lands in the [[kv_namespaces]] block automatically (uncommenting it if it is
// still the commented template).
//
// The namespace TITLE (unique per Cloudflare account) defaults to
// `<worker name>-<binding>`, so every plugin can bind its own namespace as the
// same shared binding (e.g. TENANTS) without the titles colliding. The
// wrangler.toml acted on is the one in the current working directory, i.e. the
// plugin that invoked the command, not this shared package.
// ============================================================

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';

/**
 * Read the `binding = "X"` value out of a [[kv_namespaces]] block (commented or
 * live) that starts just after `headerIdx`. Returns null if the block has no
 * binding line before it ends.
 */
function blockBinding(lines, headerIdx) {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const body = lines[i].replace(/^\s*#\s?/, '').trim();
    if (body === '' || /^\[/.test(body)) return null; // end of block / next section
    const m = body.match(/^binding\s*=\s*"([^"]*)"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Write `key = "<id>"` into the [[kv_namespaces]] block for `binding` in a
 * wrangler.toml string. Picks the block whose binding already matches; failing
 * that, adopts the commented template placeholder; failing that, appends a fresh
 * block -- so a plugin that already has a live block for a *different* binding
 * gains a second block rather than having the first clobbered. Uncomments the
 * chosen block if it is still commented. Pure -- returns the new text. Exported
 * for tests.
 */
export function setKvNamespaceId(text, key, id, binding = 'TENANTS') {
  const lines = text.split('\n');
  const uncomment = (line) => line.replace(/^(\s*)#\s?/, '$1');

  const headers = [];
  lines.forEach((l, i) => {
    if (/^\s*#?\s*\[\[kv_namespaces\]\]/.test(l)) headers.push(i);
  });

  // Prefer a block already bound to `binding`; otherwise adopt a commented
  // template block (one whose binding is absent or still the REPLACE_* / <name>
  // placeholder). A live block for a different binding is left untouched.
  const isTemplate = (b) => b == null || /REPLACE|placeholder|your[-_]|^\s*$/i.test(b) || b === binding;
  let headerIdx = headers.find((i) => blockBinding(lines, i) === binding);
  if (headerIdx === undefined) {
    headerIdx = headers.find((i) => /^\s*#/.test(lines[i]) && isTemplate(blockBinding(lines, i)));
  }

  if (headerIdx === undefined) {
    if (lines[lines.length - 1]?.trim() !== '') lines.push('');
    lines.push('[[kv_namespaces]]', `binding = "${binding}"`, `${key} = "${id}"`);
    return lines.join('\n');
  }

  lines[headerIdx] = uncomment(lines[headerIdx]);
  let bindingFound = false;
  let keyFound = false;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const body = lines[i].replace(/^\s*#\s?/, '').trim();
    if (body === '' || /^\[/.test(body)) break; // end of block / next section
    if (/^binding\s*=/.test(body)) {
      lines[i] = uncomment(lines[i]).replace(/=\s*"[^"]*"/, `= "${binding}"`);
      bindingFound = true;
    } else if (new RegExp(`^${key}\\s*=`).test(body)) {
      lines[i] = `${key} = "${id}"`;
      keyFound = true;
    } // leave the sibling id/preview_id line as-is
  }
  const insert = [];
  if (!bindingFound) insert.push(`binding = "${binding}"`);
  if (!keyFound) insert.push(`${key} = "${id}"`);
  if (insert.length) lines.splice(headerIdx + 1, 0, ...insert);
  return lines.join('\n');
}

/**
 * Extract a KV namespace id from `wrangler kv namespace create` output. Handles
 * both toml (`id = "..."`) and json (`"id": "..."`) shapes; falls back to any
 * bare 32-hex id. The negative lookbehind keeps the non-preview match off
 * `preview_id`.
 */
export function parseNamespaceId(output, preview) {
  const labelled = preview
    ? /preview_id["']?\s*[:=]\s*["']([0-9a-f]{32})["']/i
    : /(?<![a-z_])id["']?\s*[:=]\s*["']([0-9a-f]{32})["']/i;
  return output.match(labelled)?.[1] ?? output.match(/\b[0-9a-f]{32}\b/i)?.[0] ?? null;
}

/** Read `--binding=NAME` / `--binding NAME` from argv, defaulting to TENANTS. */
export function parseBinding(argv) {
  const eq = argv.find((a) => a.startsWith('--binding='));
  if (eq) return eq.slice('--binding='.length) || 'TENANTS';
  const flagIdx = argv.indexOf('--binding');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  return 'TENANTS';
}

/** Read the worker `name = "..."` from a wrangler.toml string, or null. */
export function workerName(text) {
  return text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/**
 * The account-unique namespace TITLE to create. `--title=NAME` wins; otherwise
 * `<worker name>-<binding>` (the fleet convention -- wrangler does not prefix the
 * worker name, so a bare "TENANTS" title collides across plugins), falling back
 * to `<fallback>-<binding>` when wrangler.toml has no name. The title only has to
 * be unique per Cloudflare account; the binding wired into wrangler.toml is
 * separate, so every plugin can still bind its namespace as "TENANTS".
 */
export function deriveTitle(argv, wranglerText, binding, fallback) {
  const eq = argv.find((a) => a.startsWith('--title='));
  if (eq) return eq.slice('--title='.length) || `${fallback}-${binding}`;
  const idx = argv.indexOf('--title');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return `${workerName(wranglerText) ?? fallback}-${binding}`;
}

function main() {
  const preview = process.argv.includes('--preview');
  const key = preview ? 'preview_id' : 'id';
  const argv = process.argv.slice(2);
  const binding = parseBinding(argv);
  // Act on the calling plugin's wrangler.toml, not this shared package's.
  const wranglerPath = resolve(process.cwd(), 'wrangler.toml');
  let tomlText = '';
  try { tomlText = readFileSync(wranglerPath, 'utf8'); } catch { /* created below */ }
  // The namespace title must be unique per Cloudflare account; the binding it is
  // wired to in wrangler.toml stays the shared name (e.g. TENANTS).
  const title = deriveTitle(argv, tomlText, binding, basename(process.cwd()));

  // 1. Create the namespace under its unique title.
  const args = ['kv', 'namespace', 'create', title, ...(preview ? ['--preview'] : [])];
  console.log(`$ wrangler ${args.join(' ')}\n`);
  const res = spawnSync('wrangler', args, { encoding: 'utf8' });
  process.stdout.write(res.stdout ?? '');
  process.stderr.write(res.stderr ?? '');
  if (res.status !== 0) {
    console.error('\nwrangler kv namespace create failed.');
    process.exit(res.status ?? 1);
  }

  // 2. Read the id back out of wrangler's output.
  const id = parseNamespaceId(`${res.stdout ?? ''}\n${res.stderr ?? ''}`, preview);
  if (!id) {
    console.error(`\nCould not read the namespace id from wrangler's output -- set ${key} in wrangler.toml by hand.`);
    process.exit(1);
  }

  // 3. Write it into the [[kv_namespaces]] block, uncommenting the template.
  writeFileSync(wranglerPath, setKvNamespaceId(tomlText, key, id, binding));
  console.log(`\nwrangler.toml updated: [[kv_namespaces]] binding = "${binding}", ${key} = "${id}"`);
  console.log(`Namespace title: ${title}${preview ? ' (preview)' : ''}`);
  console.log(preview
    ? '\nPreview namespace ready for `wrangler dev`.'
    : '\nProduction namespace ready. Run `npm run deploy` when the plugin is ready.');
}

// Run only when invoked directly; importing (tests) just gets the pure helpers.
// argv[1] may be a symlink (this ships as the `cms-plugin-kv-setup` bin, so npm
// runs it through node_modules/.bin), whereas import.meta.url is the real path --
// resolve both to real paths before comparing, or main() never fires via the bin.
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return real(entry) === real(fileURLToPath(import.meta.url));
}
if (isDirectRun()) main();
