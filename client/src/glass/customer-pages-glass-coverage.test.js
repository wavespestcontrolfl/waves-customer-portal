// Structural guard: every routed customer page in App.jsx (outside admin/tech,
// redirects, and CardPage which owns its own dark-navy glass card) must mount
// the Liquid Glass scene via useGlassSurface or EstimateGlassTheme.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const APP_SRC = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
const PAGES_DIR = path.join(ROOT, 'src/pages');

// CardPage intentionally renders its own dark navy glass material without
// calling useGlassSurface (see PublicStateCard.jsx).
const ALLOWLIST = new Set(['CardPage']);

function resolvePageFile(relPath) {
  for (const suffix of ['.jsx', '.js', '/index.jsx', '/index.js']) {
    const candidate = path.join(PAGES_DIR, `${relPath}${suffix}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

describe('customer routes glass coverage', () => {
  it('every customer page component imported by App.jsx mounts useGlassSurface or EstimateGlassTheme', () => {
    const lazyImports = [...APP_SRC.matchAll(/const\s+(\w+)\s*=\s*(?:lazyWithRetry|React\.lazy|lazy)\(\(\)\s*=>\s*import\(['"]\.\/pages\/([^'"]+)['"]\)/g)];
    const eagerImports = [...APP_SRC.matchAll(/^import\s+(\w+)\s+from\s+['"]\.\/pages\/([^'"]+)['"];?/gm)];
    const customerPages = [];
    for (const [, symbol, relPath] of [...eagerImports, ...lazyImports]) {
      if (relPath.startsWith('admin/') || relPath.startsWith('tech/')) continue;
      if (symbol.startsWith('Admin') || symbol.startsWith('Tech')) continue;
      customerPages.push([symbol, relPath]);
    }
    expect(customerPages.length).toBeGreaterThan(20);

    const missing = [];
    const unresolved = [];
    for (const [symbol, relPath] of customerPages) {
      if (ALLOWLIST.has(symbol)) continue;
      const file = resolvePageFile(relPath);
      if (!file) {
        unresolved.push(`${symbol} (${relPath})`);
        continue;
      }
      const src = fs.readFileSync(file, 'utf8');
      if (!/useGlassSurface\s*\(|<EstimateGlassTheme\b|useGlassTheme\s*\(/.test(src)) {
        missing.push(`${symbol} (${relPath})`);
      }
    }

    expect(unresolved).toEqual([]);
    expect(missing).toEqual([]);
  });
});
