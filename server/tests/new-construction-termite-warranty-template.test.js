// The New Construction Termite Warranty seed (Rule 5E-14.105(3) F.A.C.):
// the statutory statements a Florida termite contract must carry, and merge
// fields that match the declared variables so an issue never prints "{{…}}".
const { TEMPLATE } = require('../models/migrations/20261023120000_seed_new_construction_termite_warranty');
const { BODY_V2 } = require('../models/migrations/20261023140000_new_construction_termite_warranty_v2');
const { BODY_V3 } = require('../models/migrations/20261023160000_new_construction_termite_warranty_v3');
const { BODY_V4 } = require('../models/migrations/20261023180000_new_construction_termite_warranty_v4');
const { BODY_V5 } = require('../models/migrations/20261023200000_new_construction_termite_warranty_v5');
const { BODY_V6, VARIABLES_V6 } = require('../models/migrations/20261023220000_new_construction_termite_warranty_v6');
const v7 = require('../models/migrations/20261023240000_new_construction_termite_warranty_v7');
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

  test('version 3 labels the lot field once, so "Lot 12, Block C" never prints as "Lot Lot"', () => {
    expect(BODY_V3).toContain('Lot and subdivision: {{project.lot}}');
    expect(BODY_V3).not.toContain('Lot {{project.lot}}');
    expect(BODY_V3.replace('Lot and subdivision: {{project.lot}}', 'Lot {{project.lot}}')).toBe(BODY_V2);
  });

  test('version 4 drops "Issued on" and dates only Waves\' own signature', () => {
    expect(BODY_V4).not.toContain('Issued on');
    expect(BODY_V4).toContain('{{issuer.title}}, on {{warranty.issue_date}}.');
    expect(BODY_V4).toContain('This warranty runs from the initial treatment date, {{treatment.initial_date}}.');
    const v4Vars = [...new Set([...BODY_V4.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
    expect(v4Vars).toEqual([...TEMPLATE.variables].sort());
  });

  test('version 5 ties the section 6 renewal promise to the section 4 renewal right', () => {
    expect(BODY_V5).not.toContain('Pay the fee by the due date and coverage continues for one more year.');
    expect(BODY_V5).toContain('When you have the right to renew (section 4), paying the fee by the due date continues coverage for one more year.');
    expect(BODY_V5).toContain('When renewal is at our option, the renewal notice says whether we offer it');
    expect(BODY_V5).toContain('{{issuer.title}}, on {{warranty.issue_date}}.');
  });

  test('version 6 prints the configured FDACS license, and declares every variable it uses', () => {
    expect(BODY_V6).not.toContain('JB351547');
    expect(BODY_V6).toContain('FDACS License {{issuer.license}}');
    expect(BODY_V6.replace('{{issuer.license}}', 'JB351547')).toBe(BODY_V5);
    const v6Vars = [...new Set([...BODY_V6.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
    expect(v6Vars).toEqual([...VARIABLES_V6].sort());
  });

  test('the active text is property-neutral, so a commercial or multi-unit building reads true', () => {
    expect(v7.BODY_V7).not.toMatch(/\bhome\b|homebuyer/i);
    expect(v7.BODY_V7).toContain('This warranty goes with the property. If the property is sold,');
    expect(v7.BODY_V7).toContain('before the building is occupied');
    expect(v7.BODY_V7).toContain('FDACS License {{issuer.license}}');
  });

  test('the property-neutral migration takes the next free version number and finds its own row by body', async () => {
    const calls = [];
    const rows = { template: { id: 't1', template_key: TEMPLATE.template_key }, mine: null, max: 9 };
    const knex = (table) => {
      const q = {
        _where: {},
        where(arg) { Object.assign(q._where, arg); return q; },
        forUpdate() { calls.push(`lock:${table}`); return q; },
        max() { return q; },
        first: async () => {
          if (table === 'document_templates') return rows.template;
          if (q._where.body) return rows.mine;
          return { n: rows.max };
        },
        insert(row) { calls.push(`insert:${row.version_number}`); return { returning: async () => [{ id: 'v-new', ...row }] }; },
        update: async (patch) => { calls.push(`active:${patch.active_version_id}`); return 1; },
      };
      return q;
    };
    knex.fn = { now: () => 'now()' };
    await v7.up(knex);
    expect(calls).toEqual(['lock:document_templates', 'insert:10', 'active:v-new']);
    calls.length = 0;
    rows.mine = { id: 'v-existing' };
    await v7.up(knex);
    expect(calls).toEqual(['lock:document_templates', 'active:v-existing']);
  });

  test('version 9 swaps only the section 3 paragraph and three conditions for method fields', () => {
    const { BODY_V8 } = require('../models/migrations/20261024211000_new_construction_warranty_start_date');
    const { BODY_V9, VARIABLES_V9 } = require('../models/migrations/20261024230000_new_construction_warranty_methods');
    const v9Vars = [...new Set([...BODY_V9.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
    expect(v9Vars).toEqual([...VARIABLES_V9].sort());
    const changed = BODY_V9.split('\n').filter((line, i) => line !== BODY_V8.split('\n')[i]);
    expect(changed).toEqual(['{{treatment.description}}', '- {{conditions.first}}', '- {{conditions.second}}', '- {{conditions.third}}']);
    expect(BODY_V9.split('\n')).toHaveLength(BODY_V8.split('\n').length);
    expect(BODY_V9).toContain('**COVERS: SUBTERRANEAN TERMITES, INCLUDING FORMOSAN AND ASIAN SUBTERRANEAN TERMITES.');
  });

  test('the version 9 migration takes the next free number, and its rollback restores version 8 only while 9 is active', async () => {
    const v9 = require('../models/migrations/20261024230000_new_construction_warranty_methods');
    const calls = [];
    const rows = { mine: null, previous: { id: 'v8' }, active: 'v9', issued: null };
    const knex = (table) => {
      const q = {
        _where: {},
        where(arg) { Object.assign(q._where, arg); return q; },
        forUpdate() { return q; },
        max() { return q; },
        first: async () => {
          if (table === 'document_templates') return { id: 't1', template_key: TEMPLATE.template_key };
          if (table === 'customer_contracts') return rows.issued;
          if (q._where.body === v9.BODY_V9) return rows.mine;
          if (q._where.body) return rows.previous;
          return { n: 11 };
        },
        insert(row) { calls.push(`insert:${row.version_number}`); return { returning: async () => [{ id: 'v9', ...row }] }; },
        update: async (patch) => {
          if (q._where.active_version_id && q._where.active_version_id !== rows.active) return 0;
          calls.push(`active:${patch.active_version_id}`);
          return 1;
        },
        del: async () => { calls.push('delete'); return 1; },
      };
      return q;
    };
    knex.fn = { now: () => 'now()' };
    await v9.up(knex);
    expect(calls).toEqual(['insert:12', 'active:v9']);
    calls.length = 0;
    rows.mine = { id: 'v9' };
    await v9.down(knex);
    expect(calls).toEqual(['active:v8', 'delete']);
    calls.length = 0;
    rows.issued = { id: 'contract-1' };
    await v9.down(knex);
    expect(calls).toEqual(['active:v8']);
    calls.length = 0;
    rows.active = 'v10';
    await v9.down(knex);
    expect(calls).toEqual([]);
  });

  test('the metadata migration makes a reused row an active, customer-facing, signed service agreement', async () => {
    const meta = require('../models/migrations/20261023260000_new_construction_termite_warranty_metadata');
    const updates = [];
    const row = { id: 't1', status: 'inactive', audience: 'staff', requires_signature: false, document_type: 'notice', category: 'other' };
    const knex = () => ({ where() { return this; }, first: async () => row, update: async (patch) => { updates.push(patch); return 1; } });
    knex.fn = { now: () => 'now()' };
    await meta.up(knex);
    expect(updates).toEqual([{ ...meta.REQUIRED, updated_at: 'now()' }]);
    expect(meta.REQUIRED).toMatchObject({ status: 'active', audience: 'customer', requires_signature: true });
    updates.length = 0;
    Object.assign(row, meta.REQUIRED);
    await meta.up(knex);
    expect(updates).toEqual([]);
  });
});
