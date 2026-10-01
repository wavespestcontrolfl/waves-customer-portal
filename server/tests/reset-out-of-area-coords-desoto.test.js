/**
 * Codex r2 P2: the reset sweep prefilters customers with SQL that mirrors the
 * service-area box numerically. DeSoto coordinates sit INSIDE the coarse box,
 * so the SQL must also select the DeSoto rectangle or the sweep never sees
 * them. The script needs a live Postgres, so the query text and its parameters
 * are pinned structurally, and the JS predicate behaviorally.
 */
const fs = require('fs');
const path = require('path');
const { DESOTO_EXCLUSION, isInServiceAreaBox } = require('../services/service-area');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ops', 'agents', 'reset-out-of-area-coords.js'), 'utf8');

describe('reset-out-of-area-coords includes the DeSoto exclusion', () => {
  test('SQL prefilter selects rows inside the DeSoto rectangle and binds its numbers', () => {
    expect(src).toContain('AND NOT (c.latitude BETWEEN $6 AND $7 AND c.longitude BETWEEN $8 AND $9)');
    expect(src).toContain('DESOTO_EXCLUSION.latMin, DESOTO_EXCLUSION.latMax, DESOTO_EXCLUSION.lngMin, DESOTO_EXCLUSION.lngMax');
    expect(src).toContain('c.zip');
    expect(src).toContain('isInServiceAreaBox(r.latitude, r.longitude, { zip: r.zip })');
  });

  test('the JS filter resets Arcadia coordinates but keeps a served-ZIP row in the sliver', () => {
    expect(isInServiceAreaBox(27.2159, -81.8584, { zip: '34266' })).toBe(false);
    expect(isInServiceAreaBox(27.2159, -81.8584, { zip: '34240' })).toBe(true);
    expect(DESOTO_EXCLUSION.latMin).toBeLessThan(27.2159);
  });

  test('the write re-checks the ZIP the decision used (Codex r4 P2)', () => {
    expect(src).toContain('AND zip IS NOT DISTINCT FROM $4');
    expect(src).toContain('[r.id, r.latitude, r.longitude, r.zip]');
  });

  test('the declared scope and audit reason name the DeSoto exclusion (Codex r4 P2)', () => {
    expect(src).toContain('inside the DeSoto exclusion rectangle');
    expect(src).toContain("'inside the DeSoto exclusion with no served ZIP (DeSoto not served); re-geocode through the #3802 guard'");
    expect(src).not.toMatch(/Anything inside the box is\n\/\/ left alone/);
    const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'ops', 'agents', 'README.md'), 'utf8');
    expect(readme).toContain('Other pins inside the box are never touched.');
  });
});
