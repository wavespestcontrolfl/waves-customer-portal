const { _test } = require('../routes/integrations-backlink-worker');
const { sanitizeReportBody } = _test;

describe('integrations-backlink-worker /report body sanitization', () => {
  test('strips runner-internal cited_homepage + location (and unknown keys) from external reports', () => {
    // An authenticated Hermes report must NOT be able to set cited_homepage — it switches the
    // verifier's canonical target to the homepage, letting a misreported row be promoted off
    // an unrelated homepage backlink. location likewise steers the citation de-dupe.
    const out = sanitizeReportBody({
      prospect_id: 'p1', outcome: 'placed', live_url: 'https://x.com/biz', pending: true,
      cited_homepage: true, location: 'sarasota', some_unknown_field: 'x',
    });
    expect(out).toEqual({ prospect_id: 'p1', outcome: 'placed', live_url: 'https://x.com/biz', pending: true });
    expect(out.cited_homepage).toBeUndefined();
    expect(out.location).toBeUndefined();
    expect(out.some_unknown_field).toBeUndefined();
  });

  test('preserves every documented external field (incl. lease_token + drafted fields)', () => {
    const full = {
      prospect_id: 'p1', outcome: 'drafted', lease_token: '2026-06-22T00:00:00.000Z',
      live_url: 'https://x.com/biz', claimed_anchor: 'Waves Pest Control', evidence_url: 'evi/x.png',
      cost: 0, notes: 'n', pending: false,
      outreach_to_email: 'editor@blog.com', outreach_subject: 'Guest post', outreach_body: 'Hi',
    };
    expect(sanitizeReportBody(full)).toEqual(full);
  });

  test('tolerates null/empty bodies', () => {
    expect(sanitizeReportBody()).toEqual({});
    expect(sanitizeReportBody(null)).toEqual({});
    expect(sanitizeReportBody({})).toEqual({});
  });

  test('the allowlist does not contain the runner-internal flags', () => {
    expect(_test.ALLOWED_REPORT_FIELDS).not.toContain('cited_homepage');
    expect(_test.ALLOWED_REPORT_FIELDS).not.toContain('location');
  });
});
