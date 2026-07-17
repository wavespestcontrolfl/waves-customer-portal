import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');

describe('customer service-worker update contract', () => {
  it('preloads hashed shell assets before storing the replacement HTML', () => {
    expect(source).toContain('async function cacheCompleteShellResponse(shellResponse)');
    expect(source).toContain('async function precacheCompleteShell()');
    expect(source).toContain("new Request(assetUrl, { cache: 'reload' })");
    expect(source).toContain('await Promise.all(assetResponses.map');
    expect(source.indexOf('await Promise.all(assetResponses.map'))
      .toBeLessThan(source.indexOf('await cache.put(OFFLINE_URL, shellResponse)'));
    expect(source).toContain('event.waitUntil(cacheCompleteShellResponse(response.clone()).catch(() => {}))');
    expect(source).not.toContain('cache.put(OFFLINE_URL, clone)');
  });

  it('does not swallow install failure or delete caches outside this app', () => {
    expect(source).toContain('event.waitUntil(precacheCompleteShell().then(() => self.skipWaiting()))');
    expect(source).not.toMatch(/precacheCompleteShell\(\).*catch\(\(\) => \{\}\)/);
    expect(source).toContain('k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME');
  });

  it('constrains notification destinations to the portal origin', () => {
    expect(source).toContain('candidate.origin === self.location.origin');
    expect(source).toContain('data: { url: destination }');
  });
});
