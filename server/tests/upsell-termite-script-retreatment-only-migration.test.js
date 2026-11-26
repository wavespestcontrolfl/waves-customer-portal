// Owner ruling 2026-11-25: the staff upsell_termite script no longer quotes a $500K repair guarantee.
const fs = require('fs');
const mig = require('../models/migrations/20261125220000_upsell_termite_script_retreatment_only');

const seedSource = fs.readFileSync(require.resolve('../models/migrations/20260401000026_service_protocols'), 'utf8');

function fakeKnex(rows) {
  const knex = (table) => {
    expect(table).toBe('communication_scripts');
    let hit = rows;
    const q = {
      where: (cond) => { hit = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      then: (resolve) => resolve(hit),
      update: async (patch) => { hit.forEach((r) => Object.assign(r, patch)); return hit.length; },
    };
    return q;
  };
  knex.schema = { hasTable: async () => true };
  return knex;
}

describe('upsell_termite script migration', () => {
  test('the old script and tone are the seeded text', () => {
    expect(seedSource).toContain(mig.OLD_SCRIPT);
    expect(seedSource).toContain(mig.OLD_TONE);
  });

  test('the new text has no dollar figure and no repair or damage promise', () => {
    const text = `${mig.NEW_SCRIPT} ${mig.NEW_TONE}`;
    expect(text).not.toMatch(/\$|\d+\s?K\b|guarantee/i);
    expect(text).toMatch(/do not repair termite damage/i);
    expect(text).not.toMatch(/damage (repair )?guarantee|repair guarantee/i);
  });

  test('seeded rows are rewritten; a second run changes nothing', async () => {
    const rows = [{ id: 'a', scenario: 'upsell_termite', script: mig.OLD_SCRIPT, tone_notes: mig.OLD_TONE }];
    await mig.up(fakeKnex(rows));
    expect(rows[0]).toMatchObject({ script: mig.NEW_SCRIPT, tone_notes: mig.NEW_TONE });
    await mig.up(fakeKnex(rows));
    expect(rows[0]).toMatchObject({ script: mig.NEW_SCRIPT, tone_notes: mig.NEW_TONE });
  });

  test('an edited script is kept and logged; the untouched tone is still rewritten', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const edited = 'Ask about the $500K repair guarantee.';
    const rows = [{ id: 'b', scenario: 'upsell_termite', script: edited, tone_notes: mig.OLD_TONE }];
    await mig.up(fakeKnex(rows));
    expect(rows[0].script).toBe(edited);
    expect(rows[0].tone_notes).toBe(mig.NEW_TONE);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('other scenarios are untouched', async () => {
    const rows = [{ id: 'c', scenario: 'objection_too_expensive', script: mig.OLD_SCRIPT, tone_notes: mig.OLD_TONE }];
    await mig.up(fakeKnex(rows));
    expect(rows[0].script).toBe(mig.OLD_SCRIPT);
  });
});
