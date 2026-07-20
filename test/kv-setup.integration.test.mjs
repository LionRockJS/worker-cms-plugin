import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Regression guard for the bin's "run only when invoked directly" check: the
// script ships as the cms-plugin-kv-setup bin, so npm runs it through a symlink
// in node_modules/.bin. main() must still fire (and write wrangler.toml) even
// though process.argv[1] is then the symlink, not the real file.
//
// Written as .mjs on purpose: it exercises Node built-ins, and the package
// types only against @cloudflare/workers-types -- vitest runs .mjs, tsc skips it.

const SCRIPT = fileURLToPath(new URL('../scripts/kv-setup.mjs', import.meta.url));
const FAKE_ID = 'c7965ff4318b499da74e623613af5584';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kv-setup-'));
  // Fake `wrangler` on PATH: prints the success output the real one emits.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const wrangler = join(bin, 'wrangler');
  // Record the args wrangler was called with, then print the success output.
  writeFileSync(
    wrangler,
    `#!/bin/sh\necho "$@" > "${join(dir, 'args.txt')}"\ncat <<'EOF'\n[[kv_namespaces]]\nbinding = "TENANTS"\nid = "${FAKE_ID}"\nEOF\n`,
  );
  chmodSync(wrangler, 0o755);
  // Commented template, like a fresh plugin's wrangler.toml, with a worker name.
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "worker-cms-plugin-demo"\n\n# [[kv_namespaces]]\n# binding = "TENANTS"\n# id = "REPLACE"\n');
  // Symlink standing in for node_modules/.bin/cms-plugin-kv-setup.
  symlinkSync(SCRIPT, join(dir, 'kv-link.mjs'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kv-setup bin (invoked via symlink)', () => {
  it('runs main() and writes the id into the cwd wrangler.toml', () => {
    const res = spawnSync(process.execPath, [join(dir, 'kv-link.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
    });
    expect(res.status).toBe(0);
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain(`id = "${FAKE_ID}"`);
    expect(toml).toContain('binding = "TENANTS"'); // binding unchanged
    expect(toml).not.toContain('# [[kv_namespaces]]');
    // Created under the account-unique <worker name>-<binding> title.
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').trim();
    expect(args).toBe('kv namespace create worker-cms-plugin-demo-TENANTS');
  });
});
