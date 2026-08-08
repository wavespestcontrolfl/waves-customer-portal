/**
 * Drift guard: the review g.page URLs live canonically in
 * server/config/locations.js (WAVES_LOCATIONS[].googleReviewUrl), but three
 * client surfaces render them from their own literals — they cannot import
 * server config:
 *
 *   - client/src/pages/ReportViewPage.jsx          (customer report review CTA)
 *   - client/src/components/report/ProjectReportEngage.jsx
 *   - client/src/pages/admin/ReviewVelocityEngine.jsx
 *
 * The 2026-08-07 review-system audit flagged the ×4 duplication as drift risk:
 * the values matched that day, but a profile-link change edited in one place
 * would silently strand the others. This suite turns that silent drift into a
 * CI failure by pinning every client literal to the canonical value, keyed by
 * location id.
 *
 * ReviewVelocityEngine also mirrors the outreach template bodies
 * (server/services/review-outreach-templates.js) for its composer preview —
 * same drift mechanics (the winback_ask copy edit of 2026-08-08 landed
 * server-side first and the mirror had to be caught by hand), so the mirror is
 * pinned here too.
 */

const fs = require('fs');
const path = require('path');

const { WAVES_LOCATIONS } = require('../config/locations');
const { OUTREACH_TEMPLATES } = require('../services/review-outreach-templates');

const CLIENT = (rel) => fs.readFileSync(path.join(__dirname, '../../client/src', rel), 'utf8');

// Every `{ key|id: 'x', … reviewUrl: 'y' }` pair in a client locations table.
// key/id always precedes reviewUrl inside a block, and blocks never nest, so
// the lazy match pairs them correctly.
function extractPairs(source) {
  const pairs = {};
  const re = /(?:key|id):\s*['"]([a-z_]+)['"][\s\S]*?reviewUrl:\s*['"](https:\/\/g\.page\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) pairs[m[1]] = m[2];
  return pairs;
}

const CANONICAL = Object.fromEntries(
  WAVES_LOCATIONS.filter((l) => l.googleReviewUrl).map((l) => [l.id, l.googleReviewUrl]),
);

describe('review g.page URL drift guard (audit 2026-08-07)', () => {
  test('canonical set is the 4 offices', () => {
    expect(Object.keys(CANONICAL).sort()).toEqual(['bradenton', 'parrish', 'sarasota', 'venice']);
  });

  test.each([
    ['pages/ReportViewPage.jsx'],
    ['components/report/ProjectReportEngage.jsx'],
    ['pages/admin/ReviewVelocityEngine.jsx'],
  ])('%s review URLs match server/config/locations.js', (rel) => {
    const pairs = extractPairs(CLIENT(rel));
    // Every client entry must be a canonical office with the canonical URL…
    for (const [key, url] of Object.entries(pairs)) {
      expect(CANONICAL[key]).toBeDefined();
      expect({ key, url }).toEqual({ key, url: CANONICAL[key] });
    }
    // …and every office must be present (a dropped office silently falls back
    // to the file's default location).
    expect(Object.keys(pairs).sort()).toEqual(Object.keys(CANONICAL).sort());
  });

  test('no client file carries a g.page review URL outside the canonical set', () => {
    const urls = new Set(Object.values(CANONICAL));
    for (const rel of [
      'pages/ReportViewPage.jsx',
      'components/report/ProjectReportEngage.jsx',
      'pages/admin/ReviewVelocityEngine.jsx',
    ]) {
      const found = CLIENT(rel).match(/https:\/\/g\.page\/r\/[A-Za-z0-9_-]+\/review/g) || [];
      for (const u of found) expect(urls.has(u)).toBe(true);
    }
  });
});

describe('ReviewVelocityEngine outreach-template mirror parity', () => {
  const source = CLIENT('pages/admin/ReviewVelocityEngine.jsx');

  // Cadence-internal template deliberately absent from the composer mirror
  // (codex #3235 r12 P1 — a one-off send would detach it from its series).
  const MIRROR_EXEMPT = new Set(['first_treatment_ask']);

  test('every server template body appears verbatim in the client mirror', () => {
    for (const t of OUTREACH_TEMPLATES) {
      if (MIRROR_EXEMPT.has(t.id)) continue;
      // The mirror stores bodies as double-quoted JS string literals with
      // real \n escapes — JSON.stringify produces the identical form.
      const literal = JSON.stringify(t.body);
      expect({ id: t.id, present: source.includes(literal) })
        .toEqual({ id: t.id, present: true });
    }
  });

  test('the exempt template stays out of the composer mirror', () => {
    for (const id of MIRROR_EXEMPT) {
      expect(source).not.toMatch(new RegExp(`id:\\s*["']${id}["']`));
    }
  });
});
