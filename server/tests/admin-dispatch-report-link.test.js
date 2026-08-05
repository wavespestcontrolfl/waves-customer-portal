// ensureSmsContainsReportLink guards the bare service_complete SMS path:
// it must guarantee the report link appears exactly once. The 2026-08-03
// production failure: the rendered body held the SHORT link scheme-stripped
// (portal links are delivered without https:// per the SMS allowlist rule)
// while the passed link had https://, so includes() missed; the fallback
// regex consumed only the legacy /report/<32-hex> path, replaced the bare
// domain, and left the old path dangling — the customer received
// a doubled-path URL (slug fabricated here — never commit a real short code).

const { _test } = require('../routes/admin-dispatch');
const { ensureSmsContainsReportLink } = _test;

const SHORT = 'https://portal.wavespestcontrol.com/l/report-fake1';
const SHORT_SCHEMELESS = 'portal.wavespestcontrol.com/l/report-fake1';
const LEGACY = `https://portal.wavespestcontrol.com/report/${'a'.repeat(32)}`;

describe('ensureSmsContainsReportLink', () => {
  test('body already contains the exact link → unchanged', () => {
    const body = `Hello Alex! Your service report is ready: ${SHORT}`;
    expect(ensureSmsContainsReportLink(body, SHORT)).toBe(body);
  });

  test('body contains the link SCHEME-STRIPPED → unchanged (the 08-03 doubling case)', () => {
    const body = `Hello Alex! Your service report is ready: ${SHORT_SCHEMELESS}`;
    const out = ensureSmsContainsReportLink(body, SHORT);
    expect(out).toBe(body);
    expect(out).not.toContain('/l/report-fake1/l/report-fake1');
  });

  test('body has a STALE short link → whole link replaced, no dangling path', () => {
    const body = 'Report ready: portal.wavespestcontrol.com/l/report-old12';
    const out = ensureSmsContainsReportLink(body, SHORT);
    expect(out).toBe(`Report ready: ${SHORT}`);
    expect(out.match(/\/l\//g)).toHaveLength(1);
  });

  test('mixed-case schemeless link still counts as present → unchanged', () => {
    const body = 'Your report: Portal.WavesPestControl.com/l/report-fake1';
    expect(ensureSmsContainsReportLink(body, SHORT)).toBe(body);
  });

  test('LONGER stale slug is not a prefix-match for the link → replaced whole', () => {
    // includes() would treat …/l/report-fake1extra as containing
    // …/l/report-fake1 and skip; the boundary lookahead forces the
    // replacement path, which must swallow the entire longer slug.
    const body = 'Report ready: portal.wavespestcontrol.com/l/report-fake1extra';
    const out = ensureSmsContainsReportLink(body, SHORT);
    expect(out).toBe(`Report ready: ${SHORT}`);
    expect(out.match(/\/l\//g)).toHaveLength(1);
  });

  test('body has a legacy /report/<32-hex> link → whole link replaced', () => {
    const body = `Report ready: ${LEGACY}`;
    const out = ensureSmsContainsReportLink(body, SHORT);
    expect(out).toBe(`Report ready: ${SHORT}`);
  });

  test('body has only the bare portal domain → domain replaced with full link', () => {
    const body = 'See your report at portal.wavespestcontrol.com today';
    const out = ensureSmsContainsReportLink(body, SHORT);
    expect(out).toBe(`See your report at ${SHORT} today`);
  });

  test('body has no portal reference → link appended on its own line', () => {
    const body = 'Hello Alex! Your service is complete.';
    expect(ensureSmsContainsReportLink(body, SHORT)).toBe(`${body}\n${SHORT}`);
  });

  test('empty body or empty link → returns trimmed body unchanged', () => {
    expect(ensureSmsContainsReportLink('', SHORT)).toBe('');
    expect(ensureSmsContainsReportLink('Hello', '')).toBe('Hello');
  });
});
