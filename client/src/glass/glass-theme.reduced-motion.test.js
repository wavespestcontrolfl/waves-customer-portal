// Reduce Motion on glass pages (motion audit 2026-11-02, M03/M04/M07): inline
// transitions such as the lawn score ring and bars kept moving and scrolling
// stayed smooth, because the sheet's reduce rule reached only [data-glass]
// surfaces. Guards the page-wide rule that stops both.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/glass/glass-theme.css'), 'utf8');

function reduceBlocks(text) {
  const blocks = [];
  const opener = '@media (prefers-reduced-motion: reduce) {';
  let at = text.indexOf(opener);
  while (at !== -1) {
    let depth = 0;
    let end = at + opener.length - 1;
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1;
      if (text[end] === '}') { depth -= 1; if (depth === 0) break; }
    }
    blocks.push(text.slice(at, end + 1));
    at = text.indexOf(opener, end);
  }
  return blocks;
}

describe('glass theme under Reduce Motion', () => {
  const pageWide = reduceBlocks(css).find((block) => block.includes('transition-duration'));

  it('ends every transition on a glass page at once, delays included', () => {
    expect(pageWide).toBeDefined();
    expect(pageWide).toMatch(/html\[data-glass-theme\] \*,\s*html\[data-glass-theme\] \*::before,\s*html\[data-glass-theme\] \*::after \{/);
    expect(pageWide).toMatch(/transition-duration: 0\.01ms !important;/);
    expect(pageWide).toMatch(/transition-delay: 0s !important;/);
  });

  it('turns the sheet-wide smooth scrolling off', () => {
    expect(css).toMatch(/html\[data-glass-theme\] \{[^}]*scroll-behavior: smooth;/);
    expect(pageWide).toMatch(/html\[data-glass-theme\],\s*html\[data-glass-theme\] \* \{\s*scroll-behavior: auto !important;/);
  });
});
