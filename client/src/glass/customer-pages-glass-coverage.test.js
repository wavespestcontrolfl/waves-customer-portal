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

describe('customer routes glass coverage', () => {
  it('every customer page component imported by App.jsx mounts useGlassSurface or EstimateGlassTheme', () => {
    const imports = [...APP_SRC.matchAll(/const\s+(\w+)\s*=\s*lazyWithRetry\(\(\)\s*=>\s*import\(['"]\.\/pages\/([^'"]+)['"]\)/g)];
    expect(imports.length).toBeGreaterThan(20);

    const missing = [];
    for (const [, symbol, relPath] of imports) {
      if (relPath.startsWith('admin/') || relPath.startsWith('tech/')) continue;
      if (symbol.startsWith('Admin') || symbol.startsWith('Tech')) continue;
      if (ALLOWLIST.has(symbol)) continue;
      const file = path.join(PAGES_DIR, `${relPath}.jsx`);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (!/useGlassSurface\s*\(|<EstimateGlassTheme\b|useGlassTheme\s*\(/.test(src)) {
        missing.push(`${symbol} (${relPath}.jsx)`);
      }
    }

    expect(missing).toEqual([]);
  });
});
