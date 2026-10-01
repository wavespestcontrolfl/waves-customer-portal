/**
 * /.well-known/security.txt (RFC 9116) — routes/well-known.js.
 * Static, ungated, text/plain, cacheable for a day, Expires computed per
 * request so it never goes stale.
 */
const express = require('express');
const wellKnown = require('../routes/well-known');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/.well-known', wellKnown);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /.well-known/security.txt', () => {
  test('serves RFC 9116 fields as cacheable plain text', async () => {
    const res = await fetch(`${base}/.well-known/security.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; charset=utf-8/i);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    const body = await res.text();
    const lines = body.trim().split('\n');
    expect(lines).toContain('Contact: mailto:contact@wavespestcontrol.com');
    expect(lines).toContain('Preferred-Languages: en');
    expect(lines).toContain('Canonical: https://portal.wavespestcontrol.com/.well-known/security.txt');
    expect(lines.filter((l) => l.startsWith('Expires: '))).toHaveLength(1);
  });

  test('Expires is an ISO timestamp roughly one year ahead', async () => {
    const body = await (await fetch(`${base}/.well-known/security.txt`)).text();
    const expires = new Date(body.match(/^Expires: (.+)$/m)[1]);
    const days = (expires.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(363);
    expect(days).toBeLessThan(367);
  });

  test('securityTxt(now) is deterministic for a given clock', () => {
    const txt = wellKnown.securityTxt(new Date('2026-09-30T12:00:00.000Z'));
    expect(txt).toContain('Expires: 2027-09-30T12:00:00.000Z');
  });
});
