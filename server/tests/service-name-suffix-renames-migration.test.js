/**
 * 20260825000010 service name suffix renames (owner directive 2026-08-25):
 * every catalog service name ends in " Service", drill-and-foam becomes
 * "Termite Foam Service" / "Recurring Termite Foam Service".
 *
 * Contracts pinned here:
 *  - a row is renamed ONLY while it still carries the shipped name — an
 *    admin-edited name is owner data and survives untouched;
 *  - open future visits under the old label are relabeled; completed and
 *    cancelled history keeps the label it rendered with;
 *  - protocol_template_service_types gains a new-name alias for every
 *    template that carried the old-name alias (one-tap protocol buttons
 *    resolve by exact string);
 *  - down() reverses exactly what up() did.
 */
const migration = require('../models/migrations/20260825000010_service_name_suffix_renames');

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereRaw(sql, bindings) {
        if (/scheduled_date\s*>=\s*CURRENT_DATE/.test(sql)) {
          filters.push({ raw_future: true });
          return q;
        }
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (!m) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        filters.push({ raw: { col: m[1], val: bindings[0] } });
        return q;
      },
      whereNull(col) { filters.push({ raw_null: col }); return q; },
      first: async () => {
        const hit = rowsNow().find((r) => rowMatchWithFuture(r));
        return hit ? { ...hit } : undefined;
      },
      update: async (patch) => {
        const hits = rowsNow().filter((r) => rowMatchWithFuture(r));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
    };
    const rowMatchWithFuture = (r) => filters.every((f) => {
      if (f.raw_future) return r.past !== true; // rows flagged past are pre-CURRENT_DATE
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      if (f.raw_null) return r[f.raw_null] === null || r[f.raw_null] === undefined;
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql, bindings) => {
    const aliases = db.protocol_template_service_types || [];
    if (/^INSERT INTO protocol_template_service_types/i.test(sql.trim())) {
      const [toName, fromName] = bindings;
      const sources = aliases.filter(
        (r) => String(r.service_type).toLowerCase() === String(fromName).toLowerCase()
      );
      for (const src of sources) {
        const dup = aliases.some(
          (r) => r.protocol_template_id === src.protocol_template_id && r.service_type === toName
        );
        if (!dup) {
          aliases.push({
            protocol_template_id: src.protocol_template_id,
            service_type: toName,
            notes: 'alias added by migration:20260825000010 (catalog rename)',
          });
        }
      }
      return;
    }
    if (/^DELETE FROM protocol_template_service_types/i.test(sql.trim())) {
      const [toName, fromName] = bindings;
      db.protocol_template_service_types = aliases.filter((t) => !(
        t.service_type === toName
        && aliases.some(
          (s) => s.protocol_template_id === t.protocol_template_id
            && String(s.service_type).toLowerCase() === String(fromName).toLowerCase()
        )
      ));
      return;
    }
    throw new Error(`fake raw: unsupported sql ${sql}`);
  };
  return knex;
}

function seededDb() {
  return {
    services: [
      { id: 's-foam', service_key: 'foam_drill', name: 'Drill-and-Foam Termite' },
      { id: 's-foamr', service_key: 'foam_recurring', name: 'Recurring Foam Treatment' },
      { id: 's-roach', service_key: 'cockroach_control', name: 'Cockroach Treatment' },
      // Admin-edited row: shipped name gone, owner's wording stays.
      { id: 's-guar', service_key: 'rodent_guarantee', name: 'Rodent Guarantee Plan (Adam)' },
    ],
    scheduled_services: [
      { id: 'v-open', service_type: 'Drill-and-Foam Termite', completed_at: null, cancelled_at: null },
      { id: 'v-done', service_type: 'Drill-and-Foam Termite', completed_at: 'X', cancelled_at: null },
      { id: 'v-cxl', service_type: 'Recurring Foam Treatment', completed_at: null, cancelled_at: 'X' },
      { id: 'v-past', service_type: 'Cockroach Treatment', completed_at: null, cancelled_at: null, past: true },
      { id: 'v-guar', service_type: 'Rodent Guarantee', completed_at: null, cancelled_at: null },
    ],
    protocol_template_service_types: [
      { protocol_template_id: 'pt-1', service_type: 'Cockroach Treatment' },
      { protocol_template_id: 'pt-1', service_type: 'German Roach Cleanout' },
    ],
  };
}

const svc = (db, key) => db.services.find((r) => r.service_key === key);
const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);

describe('20260825000010 service name suffix renames', () => {
  test('up() renames shipped rows, skips admin-edited rows', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    expect(svc(db, 'foam_drill').name).toBe('Termite Foam Service');
    expect(svc(db, 'foam_recurring').name).toBe('Recurring Termite Foam Service');
    expect(svc(db, 'cockroach_control').name).toBe('Cockroach Treatment Service');
    expect(svc(db, 'rodent_guarantee').name).toBe('Rodent Guarantee Plan (Adam)');
  });

  test('up() relabels only open FUTURE visits; history and past rows keep their label', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-open').service_type).toBe('Termite Foam Service');
    expect(visit(db, 'v-done').service_type).toBe('Drill-and-Foam Termite');
    expect(visit(db, 'v-cxl').service_type).toBe('Recurring Foam Treatment');
    expect(visit(db, 'v-past').service_type).toBe('Cockroach Treatment');
    // Visits relabel even when the catalog row itself was admin-owned —
    // the old shipped label on the visit is still the old shipped label.
    expect(visit(db, 'v-guar').service_type).toBe('Rodent Guarantee Service');
  });

  test('up() copies protocol aliases for renamed types, once', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db)); // idempotent re-run
    const forTemplate = db.protocol_template_service_types
      .filter((r) => r.protocol_template_id === 'pt-1')
      .map((r) => r.service_type).sort();
    expect(forTemplate).toEqual([
      'Cockroach Treatment',
      'Cockroach Treatment Service',
      'German Roach Cleanout',
      'German Roach Cleanout Service',
    ]);
  });

  test('down() reverses renames, visit labels, and copied aliases', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(svc(db, 'foam_drill').name).toBe('Drill-and-Foam Termite');
    expect(svc(db, 'foam_recurring').name).toBe('Recurring Foam Treatment');
    expect(svc(db, 'cockroach_control').name).toBe('Cockroach Treatment');
    expect(svc(db, 'rodent_guarantee').name).toBe('Rodent Guarantee Plan (Adam)');
    expect(visit(db, 'v-open').service_type).toBe('Drill-and-Foam Termite');
    expect(db.protocol_template_service_types.map((r) => r.service_type).sort())
      .toEqual(['Cockroach Treatment', 'German Roach Cleanout']);
  });

  test('up() survives absent companion tables', async () => {
    const db = { services: seededDb().services };
    await migration.up(fakeKnex(db));
    expect(svc(db, 'foam_drill').name).toBe('Termite Foam Service');
  });
});
