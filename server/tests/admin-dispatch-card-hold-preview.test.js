'use strict';
// GET /admin/dispatch/:serviceId/card-hold — the merged two-rail preview.
// Source contract: a non-"no card" hold verdict (closed-state fee_settled,
// unresolved ownership check, in-flight) must survive every appointment-rail
// answer that carries no evidence of its own — no row, deferred to the hold
// lane, or DARK (no lookup made; Codex #3800 r7 P1). The rails' gates are
// independent, so the dark appointment rail says nothing about the hold.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
const start = src.indexOf("router.get('/:serviceId/card-hold'");
const block = src.slice(start, src.indexOf('router.put(', start));

describe('dispatch card-hold preview — appointment-rail silence keeps the hold verdict', () => {
  test('rail_dark counts as silence alongside no_card and card_hold_lane', () => {
    const m = src.match(/const APPT_RAIL_SILENT_CODES = new Set\(\[([^\]]*)\]\);/);
    expect(m).toBeTruthy();
    const codes = m[1].split(',').map((c) => c.trim().replace(/'/g, '')).filter(Boolean);
    expect(codes.sort()).toEqual(['card_hold_lane', 'no_card', 'rail_dark']);
  });
  test('a held (or in-flight) hold answers outright; otherwise a non-no_card hold verdict wins over appointment-rail silence', () => {
    expect(block).toMatch(/if \(holdPreview\.held\) return res\.json\(holdPreview\);/);
    expect(block).toMatch(/holdPreview\.rule\?\.code !== 'no_card' && APPT_RAIL_SILENT_CODES\.has\(apptPreview\.rule\?\.code\)\)\s*\{\s*return res\.json\(holdPreview\);/);
  });
});
