// The New Construction Termite Warranty seed (Rule 5E-14.105(3) F.A.C.):
// the statutory statements a Florida termite contract must carry, and merge
// fields that match the declared variables so an issue never prints "{{…}}".
const { TEMPLATE } = require('../models/migrations/20261023120000_seed_new_construction_termite_warranty');
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
});
