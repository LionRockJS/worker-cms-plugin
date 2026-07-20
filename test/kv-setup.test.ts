import { describe, expect, it } from 'vitest';
// The script is plain Node ESM; import its pure helpers for testing.
import { parseBinding, parseNamespaceId, setKvNamespaceId } from '../scripts/kv-setup.mjs';

const ID = 'abcdef0123456789abcdef0123456789';
const ID2 = '00000000000000000000000000000000';

const TEMPLATE = [
  'name = "my-plugin"',
  '',
  '# [[kv_namespaces]]',
  '# binding = "TENANTS"',
  '# id = "REPLACE_WITH_ID_FROM_npm_run_kv_setup"',
  '# preview_id = "REPLACE_WITH_ID_FROM_npm_run_kv_setup_preview"',
].join('\n');

describe('parseNamespaceId', () => {
  it('reads the toml id shape', () => {
    expect(parseNamespaceId(`id = "${ID}"`, false)).toBe(ID);
  });
  it('reads the json id shape', () => {
    expect(parseNamespaceId(`{ "id": "${ID}" }`, false)).toBe(ID);
  });
  it('picks preview_id when preview is requested', () => {
    expect(parseNamespaceId(`id = "${ID}"\npreview_id = "${ID2}"`, true)).toBe(ID2);
  });
  it('does not mistake preview_id for id', () => {
    expect(parseNamespaceId(`preview_id = "${ID2}"`, false)).toBe(ID2); // bare-hex fallback
    expect(parseNamespaceId(`preview_id = "${ID2}"\nid = "${ID}"`, false)).toBe(ID);
  });
  it('returns null when no id present', () => {
    expect(parseNamespaceId('nothing here', false)).toBeNull();
  });
});

describe('parseBinding', () => {
  it('defaults to TENANTS', () => {
    expect(parseBinding([])).toBe('TENANTS');
    expect(parseBinding(['--preview'])).toBe('TENANTS');
  });
  it('reads --binding=NAME', () => {
    expect(parseBinding(['--binding=CACHE'])).toBe('CACHE');
  });
  it('reads --binding NAME', () => {
    expect(parseBinding(['--binding', 'SESSIONS'])).toBe('SESSIONS');
  });
});

describe('setKvNamespaceId', () => {
  it('uncomments the template block and sets the id', () => {
    const out = setKvNamespaceId(TEMPLATE, 'id', ID, 'TENANTS');
    expect(out).toContain('[[kv_namespaces]]\nbinding = "TENANTS"');
    expect(out).toContain(`id = "${ID}"`);
    expect(out).not.toContain('# [[kv_namespaces]]');
    // preview_id line left untouched.
    expect(out).toContain('# preview_id = "REPLACE_WITH_ID_FROM_npm_run_kv_setup_preview"');
  });

  it('sets preview_id without disturbing an existing id', () => {
    const live = ['[[kv_namespaces]]', 'binding = "TENANTS"', `id = "${ID}"`].join('\n');
    const out = setKvNamespaceId(live, 'preview_id', ID2, 'TENANTS');
    expect(out).toContain(`id = "${ID}"`);
    expect(out).toContain(`preview_id = "${ID2}"`);
  });

  it('adopts the template block for a non-default binding', () => {
    const out = setKvNamespaceId(TEMPLATE, 'id', ID, 'CACHE');
    expect(out).toContain('binding = "CACHE"');
    expect(out).toContain(`id = "${ID}"`);
  });

  it('re-running is idempotent (overwrites the same id)', () => {
    const once = setKvNamespaceId(TEMPLATE, 'id', ID, 'TENANTS');
    const twice = setKvNamespaceId(once, 'id', ID2, 'TENANTS');
    expect(twice).toContain(`id = "${ID2}"`);
    expect(twice).not.toContain(`id = "${ID}"`);
    expect((twice.match(/\[\[kv_namespaces\]\]/g) ?? []).length).toBe(1);
  });

  it('appends a second block rather than clobbering a live one for a different binding', () => {
    const live = ['[[kv_namespaces]]', 'binding = "TENANTS"', `id = "${ID}"`].join('\n');
    const out = setKvNamespaceId(live, 'id', ID2, 'CACHE');
    expect(out).toContain('binding = "TENANTS"');
    expect(out).toContain('binding = "CACHE"');
    expect(out).toContain(`id = "${ID}"`); // original untouched
    expect(out).toContain(`id = "${ID2}"`);
    expect((out.match(/\[\[kv_namespaces\]\]/g) ?? []).length).toBe(2);
  });

  it('appends a block when the file has none', () => {
    const out = setKvNamespaceId('name = "my-plugin"\n', 'id', ID, 'TENANTS');
    expect(out).toContain('[[kv_namespaces]]');
    expect(out).toContain('binding = "TENANTS"');
    expect(out).toContain(`id = "${ID}"`);
  });
});
