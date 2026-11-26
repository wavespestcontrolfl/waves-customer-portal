// Owner pick 2026-11-25 ("standard"): the bed bug heat prep email signs off "— The Waves Team" like every other guide.
const fs = require('fs');
const mig = require('../models/migrations/20261125230002_prep_bed_bug_heat_signoff');

const seedSource = fs.readFileSync(require.resolve('../models/migrations/20261102190000_seed_prep_bed_bug_heat'), 'utf8');
const approvedSource = fs.readFileSync(require.resolve('../models/migrations/20260924000002_prep_guide_content_v3_codex_r1'), 'utf8');

function fakeKnex(db) {
  const knex = (table) => {
    let rows = db[table];
    const q = {
      where: (cond) => { rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereNot: (cond) => { rows = rows.filter((r) => !Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      forUpdate: () => q,
      orderBy: (col, dir) => { rows = [...rows].sort((a, b) => (dir === 'desc' ? b[col] - a[col] : a[col] - b[col])); return q; },
      first: async () => rows[0],
      insert: (row) => ({ returning: async () => { const r = { id: `v${db[table].length + 1}`, ...row }; db[table].push(r); return [r]; } }),
      update: async (patch) => { rows.forEach((r) => Object.assign(r, patch)); return rows.length; },
    };
    return q;
  };
  knex.schema = { hasTable: async () => true };
  return knex;
}

function seedDb(signature, textBody = null) {
  return {
    email_templates: [{ id: 't1', template_key: 'prep.bed_bug_heat', active_version_id: 'v1', last_published_by: 'staff-1' }],
    email_template_versions: [{
      id: 'v1', template_id: 't1', version_number: 1, status: 'active', subject: 'Prep', preview_text: 'p',
      blocks: JSON.stringify([{ type: 'paragraph', content: 'Office edit kept.' }, { type: 'signature', content: signature }]),
      text_body: textBody,
      validation_snapshot: JSON.stringify({ ok: true }),
    }],
  };
}

describe('prep.bed_bug_heat signature migration', () => {
  test('the old sign-off is the seeded text and the new one is the approved prep sign-off', () => {
    expect(seedSource).toContain(JSON.stringify(mig.OLD_SIGNATURE).slice(1, -1));
    expect(approvedSource).toContain(`const SIGNATURE = '${mig.NEW_SIGNATURE}';`);
  });

  test('the seeded sign-off becomes a new active version; other blocks stay; a second run changes nothing', async () => {
    const db = seedDb(mig.OLD_SIGNATURE);
    await mig.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(2);
    const next = db.email_template_versions[1];
    expect(next).toMatchObject({ version_number: 2, status: 'active', subject: 'Prep' });
    expect(JSON.parse(next.blocks)).toEqual([{ type: 'paragraph', content: 'Office edit kept.' }, { type: 'signature', content: mig.NEW_SIGNATURE }]);
    expect(db.email_template_versions[0].status).toBe('archived');
    expect(db.email_templates[0].active_version_id).toBe(next.id);
    await mig.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(2);
  });

  test('an office-chosen sign-off is left alone', async () => {
    const db = seedDb('— Adam and the Waves crew');
    await mig.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(1);
    expect(db.email_templates[0].active_version_id).toBe('v1');
  });

  test('a plain-text body with the seeded sign-off is swapped too; the edits around it stay', async () => {
    const db = seedDb(mig.OLD_SIGNATURE, `Office intro.\n\n${mig.OLD_SIGNATURE}\n\nP.S. kept`);
    await mig.up(fakeKnex(db));
    const active = db.email_template_versions.find((v) => v.id === db.email_templates[0].active_version_id);
    expect(active.text_body).toBe(`Office intro.\n\n${mig.NEW_SIGNATURE}\n\nP.S. kept`);
    expect(active.text_body).not.toContain('599-3489');
    expect(JSON.parse(active.blocks)[1]).toEqual({ type: 'signature', content: mig.NEW_SIGNATURE });
    expect(db.email_template_versions.filter((v) => v.status === 'active')).toHaveLength(1);
    expect(db.email_templates[0].last_published_by).toBeNull();
    await mig.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(2);
  });

  test('standard blocks but a seeded plain-text sign-off: only text_body changes', async () => {
    const db = seedDb(mig.NEW_SIGNATURE, `Hi.\n${mig.OLD_SIGNATURE}`);
    await mig.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(2);
    expect(db.email_template_versions[1].text_body).toBe(`Hi.\n${mig.NEW_SIGNATURE}`);
  });
});
