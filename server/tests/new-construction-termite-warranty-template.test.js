// The New Construction Termite Warranty seed (Rule 5E-14.105(3) F.A.C.):
// the statutory statements a Florida termite contract must carry, and merge
// fields that match the declared variables so an issue never prints "{{…}}".
const { TEMPLATE } = require('../models/migrations/20261023120000_seed_new_construction_termite_warranty');
const { BODY_V2 } = require('../models/migrations/20261023140000_new_construction_termite_warranty_v2');
const { BODY_V3 } = require('../models/migrations/20261023160000_new_construction_termite_warranty_v3');
const { renderDocumentTemplate } = require('../services/document-template-library');

const bodyVars = [...new Set([...TEMPLATE.body.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
const boldLines = TEMPLATE.body.split('\n').filter((line) => /^\*\*.+\*\*$/.test(line.trim()));

describe('new construction termite warranty template', () => {
  test('declares exactly the merge fields its body uses', () => {
    expect([...TEMPLATE.variables].sort()).toEqual(bodyVars);
  });

  test('page 1 states retreatment only, flags exclusions and names the organism, in bold (F.S. 482.227; Rule 5E-14.105(2)(e))', () => {
    const top = boldLines.slice(0, 4).join('\n');
    expect(top).toContain('RETREATMENT ONLY. THIS WARRANTY DOES NOT COVER DAMAGE REPAIR.');
    expect(top).toContain('CONDITIONS, LIMITATIONS AND EXCLUSIONS');
    expect(top).toContain('SUBTERRANEAN TERMITES, INCLUDING FORMOSAN AND ASIAN');
    expect(boldLines).toEqual(expect.arrayContaining(['**CONDITIONS AND LIMITATIONS**', '**EXCLUSIONS**']));
    expect(TEMPLATE.body).not.toMatch(/\b(full|unlimited)\b/i);
  });

  test('carries the new-construction terms: initial date, 30-day issue, renewals through year 5, notice location', () => {
    expect(TEMPLATE.body).toContain('This warranty runs from the initial treatment date, {{treatment.initial_date}}. We issue it within 30 days of that date.');
    expect(TEMPLATE.body).toContain('you may renew each year through year 5; we cannot refuse those renewals');
    expect(TEMPLATE.body).toContain('We posted the treatment notice required by section 482.226(5), Florida Statutes: {{warranty.notice_location}}.');
    expect(TEMPLATE.requires_signature).toBe(true);
  });

  test('renders with every field filled and no merge marker left', () => {
    const context = {};
    for (const key of TEMPLATE.variables) {
      const parts = key.split('.');
      let node = context;
      parts.slice(0, -1).forEach((p) => { node[p] = node[p] || {}; node = node[p]; });
      node[parts[parts.length - 1]] = `<${key}>`;
    }
    const rendered = renderDocumentTemplate({ template: TEMPLATE, version: { title: TEMPLATE.title, body: TEMPLATE.body }, context });
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).not.toContain('{{');
  });

  test('version 2 states the real issue date and an anniversary renewal', () => {
    expect(BODY_V2).toContain('This warranty runs from the initial treatment date, {{treatment.initial_date}}. Issued on {{warranty.issue_date}}.');
    expect(BODY_V2).not.toContain('We issue it within 30 days');
    expect(BODY_V2).toContain('The first renewal is due on {{warranty.renewal_due}}; later renewals are due on the same date each year.');
    const v2Vars = [...new Set([...BODY_V2.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
    expect(v2Vars).toEqual([...TEMPLATE.variables].sort());
  });

  test('version 3 (the active text) labels the lot field once, so "Lot 12, Block C" never prints as "Lot Lot"', () => {
    expect(BODY_V3).toContain('Lot and subdivision: {{project.lot}}');
    expect(BODY_V3).not.toContain('Lot {{project.lot}}');
    expect(BODY_V3.replace('Lot and subdivision: {{project.lot}}', 'Lot {{project.lot}}')).toBe(BODY_V2);
  });
});
