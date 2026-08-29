/**
 * Service cadence convention (owner rulings 2026-08-28, scope v4):
 *   - migration 20260829000010 renames 10 cadence rows with the
 *     20260825000010 fan-out contract (Invariant 1 history frozen,
 *     Invariant 2 CAS rollback);
 *   - the slot-reservation booking literals equal the MIGRATED catalog
 *     names for the key the visit-count linker resolves (literal ⇄ catalog);
 *   - self-booking-plan-sync resolves the 6-visit lawn row as bimonthly
 *     once it carries a cadence token (was quarterly by default);
 *   - Invariant 3: canonical cadence spelling in catalog targets, booking
 *     literals and estimate runtime names;
 *   - migration 20260829000011 corrects termite_bait frequency.
 * Fake-knex harness mirrors service-name-suffix-renames-migration.test.js.
 */
const migration = require('../models/migrations/20260829000010_service_cadence_convention_renames');
const termiteFix = require('../models/migrations/20260829000011_termite_bait_frequency_quarterly');
const { cadenceCatalogKeyForProfile, _internals: { canonicalServiceTypeForProfile } } = require('../services/slot-reservation');
const { resolveSelfBookedRecurringPlan } = require('../services/self-booking-plan-sync');
const { CADENCE_CONVENTION_RENAMES, counterpartServiceName } = require('../config/service-name-aliases');
const { serviceNameCandidates } = require('../services/service-completion-profiles');
const { resolveCallBookingCatalogService } = require('../services/call-booking-catalog');

const STATE_KEY = 'migration.20260829000010.state';
const ALIAS_MARKER = 'alias added by migration:20260829000010 (cadence convention)';
const PEST_OLD = 'General Pest Control Service (Bi-Monthly)';
const PEST_NEW = 'Bi-Monthly Pest Control Service';
const LAWN_OLD = 'Lawn Care Program Service';
const LAWN_NEW = 'Bi-Monthly Lawn Care Service';
const MOSQ_OLD = 'Mosquito Control Service (Monthly)';
const MOSQ_NEW = 'Monthly Mosquito Control Service';

function seedDb() {
  return {
    services: [
      { id: 'svc-pest6', service_key: 'pest_general_bimonthly', name: PEST_OLD, updated_at: 'orig' },
      { id: 'svc-lawn6', service_key: 'lawn_care_recurring', name: LAWN_OLD, updated_at: 'orig' },
      { id: 'svc-mosq', service_key: 'mosquito_monthly', name: MOSQ_OLD, updated_at: 'orig' },
      // Admin-edited: shipped name gone — rename AND its fanout must skip.
      { id: 'svc-rm', service_key: 'rodent_monitoring', name: 'Rodent Stations (Adam)', updated_at: 'orig' },
      // Already on the convention — not in RENAMES, must be untouched.
      { id: 'svc-ts6', service_key: 'tree_shrub_program', name: 'Bi-Monthly Tree & Shrub Care Service', updated_at: 'orig' },
      { id: 'svc-tb', service_key: 'termite_bait', name: 'Termite Bait Station System Service', frequency: 'annual', visits_per_year: 4, updated_at: 'orig' },
    ],
    scheduled_services: [
      { id: 'v-open-1', service_type: PEST_OLD, status: 'pending', service_id: 'svc-pest6', self_booking_id: 'sb-1' },
      { id: 'v-open-2', service_type: PEST_OLD, status: 'confirmed', service_id: null },
      { id: 'v-done', service_type: PEST_OLD, status: 'completed', service_id: 'svc-pest6' },
      { id: 'v-cancel', service_type: PEST_OLD, status: 'cancelled', service_id: 'svc-pest6' },
      { id: 'v-resched', service_type: PEST_OLD, status: 'rescheduled', service_id: 'svc-pest6' },
      { id: 'v-rm', service_type: 'Rodent Monitoring Service (Monthly)', status: 'pending', service_id: 'svc-rm' },
      { id: 'v-lawn', service_type: LAWN_OLD, status: 'pending', service_id: 'svc-lawn6' },
      { id: 'v-ts', service_type: 'Bi-Monthly Tree & Shrub Care Service', status: 'pending', service_id: 'svc-ts6' },
      { id: 'v-parent', service_type: 'Quarterly Pest Control Service', status: 'confirmed', service_id: null },
    ],
    self_booked_appointments: [{ id: 'sb-1', service_type: PEST_OLD, status: 'confirmed' }],
    scheduled_service_addons: [
      { id: 'add-open', scheduled_service_id: 'v-parent', service_id: 'svc-mosq', service_name: MOSQ_OLD },
      { id: 'add-done', scheduled_service_id: 'v-done', service_id: 'svc-mosq', service_name: MOSQ_OLD },
    ],
    payer_statements: [{ id: 'stmt-frozen', status: 'finalized' }],
    invoices: [
      { id: 'inv-draft', scheduled_service_id: 'v-open-1', status: 'draft', title: PEST_OLD, service_type: PEST_OLD,
        line_items: JSON.stringify([{ description: PEST_OLD, amount: 97 }]), payer_statement_id: null, updated_at: 'inv-orig' },
      { id: 'inv-sent', scheduled_service_id: 'v-open-1', status: 'sent', title: PEST_OLD, service_type: PEST_OLD,
        line_items: JSON.stringify([{ description: PEST_OLD, amount: 97 }]), payer_statement_id: null, updated_at: 'inv-orig' },
      { id: 'inv-frozen', scheduled_service_id: 'v-open-1', status: 'draft', title: PEST_OLD, service_type: PEST_OLD,
        line_items: JSON.stringify([{ description: PEST_OLD, amount: 97 }]), payer_statement_id: 'stmt-frozen', updated_at: 'inv-orig' },
    ],
    appointment_reminders: [
      { id: 'rem-1', scheduled_service_id: 'v-open-1', customer_id: 'c1', appointment_time: 't1', service_type: PEST_OLD },
      { id: 'rem-merged', scheduled_service_id: 'v-parent', customer_id: 'c1', appointment_time: 't1', service_type: `Quarterly Pest Control Service & ${PEST_OLD}` },
      { id: 'rem-done', scheduled_service_id: 'v-done', customer_id: 'c2', appointment_time: 't2', service_type: PEST_OLD },
    ],
    service_completion_profiles: [
      { service_key: 'pest_general_bimonthly', service_name_snapshot: PEST_OLD },
      { service_key: 'mosquito_monthly', service_name_snapshot: MOSQ_OLD },
    ],
    protocol_template_service_types: [
      { protocol_template_id: 'pt-1', service_type: PEST_OLD, notes: null },
      { protocol_template_id: 'pt-2', service_type: PEST_NEW, notes: 'admin' },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const inClauses = [];
    const notInClauses = [];
    const rawWheres = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => (
      inClauses.every((c) => c.vals.includes(r[c.col]))
      && notInClauses.every((c) => !c.vals.includes(r[c.col]))
      && filters.every((cond) => Object.entries(cond).every(([k, v]) => {
        if (k === 'label_or_qualified') {
          const s = String(r[v.col || 'service_type'] || '');
          return s === v.exact || s.startsWith(v.prefix);
        }
        if (k === 'engine_keys_cas') {
          const cur = Array.isArray(r.engine_keys) ? r.engine_keys
            : (() => { try { return JSON.parse(r.engine_keys); } catch { return null; } })();
          return JSON.stringify(cur) === v;
        }
        return r[k] === v;
      }))
      && rawWheres.every((rw) => String(r.updated_at) === String(rw.bindings[0]))
    );
    const q = {
      where(cond) {
        // Grouped-where callbacks carry only label OR-filters the per-row
        // swap re-checks — safe to ignore in the fake.
        if (typeof cond === 'function') return q;
        filters.push(cond);
        return q;
      },
      whereIn(col, vals) { inClauses.push({ col, vals }); return q; },
      whereNotIn(col, vals) { notInClauses.push({ col, vals }); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereRaw(sql, bindings) {
        if (/(?:service_type|service_name) = \? OR (?:service_type|service_name) LIKE \?/.test(sql)) {
          const col = sql.includes('service_name') ? 'service_name' : 'service_type';
          const [exact, like] = bindings;
          const prefix = String(like).replace(/%$/, '');
          filters.push({ label_or_qualified: { col, exact, prefix } });
          return q;
        }
        if (/engine_keys\s*=\s*\?::jsonb/.test(sql)) {
          const expected = bindings[0];
          filters.push({ engine_keys_cas: expected });
          return q;
        }
        if (/title = \?/.test(sql)) return q; // unattached-invoice label OR-filter — per-row swap re-checks
        if (!/updated_at::text\s*=\s*\?/.test(sql)) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        rawWheres.push({ sql, bindings });
        return q;
      },
      forUpdate() { return q; },
      async select(...cols) {
        return rowsNow().filter(rowMatch).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => {
            if (c && typeof c === 'object' && c.__raw) {
              if (!/updated_at::text AS updated_at_cas/i.test(c.__raw)) throw new Error(`fake raw select: unsupported ${c.__raw}`);
              out.updated_at_cas = r.updated_at == null ? null : String(r.updated_at);
              return;
            }
            out[c] = r[c];
          });
          return out;
        });
      },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      update: async (patch, returning) => {
        const hits = rowsNow().filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        if (Array.isArray(returning)) {
          return hits.map((r) => {
            const out = {};
            returning.forEach((c) => { out[c] = r[c]; });
            return out;
          });
        }
        return hits.length;
      },
      del: async () => {
        const hits = rowsNow().filter(rowMatch);
        db[table] = rowsNow().filter((r) => !hits.includes(r));
        return hits.length;
      },
      insert: async (row) => {
        (db[table] = rowsNow()).push({ ...row });
        return [1];
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && c !== undefined,
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = (sql, bindings) => {
    if (/^INSERT INTO protocol_template_service_types/i.test(String(sql).trim())) {
      const [toName, marker, fromName] = bindings;
      const aliases = db.protocol_template_service_types || [];
      const sources = aliases.filter((r) => r.service_type === fromName);
      for (const src of sources) {
        const dup = aliases.some(
          (r) => r.protocol_template_id === src.protocol_template_id && r.service_type === toName
        );
        if (!dup) {
          aliases.push({ protocol_template_id: src.protocol_template_id, service_type: toName, notes: marker });
        }
      }
      return Promise.resolve();
    }
    return { __raw: sql, bindings };
  };
  return knex;
}

const svc = (db, key) => db.services.find((r) => r.service_key === key);
const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const invoiceById = (db, id) => db.invoices.find((r) => r.id === id);
const reminder = (db, id) => db.appointment_reminders.find((r) => r.id === id);
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260829000010 cadence convention renames', () => {
  test('RENAMES is the ruled 10-row list; already-conforming rows are absent', () => {
    expect(migration.RENAMES.map(([k]) => k)).toEqual([
      'pest_general_bimonthly', 'pest_general_semiannual',
      'lawn_care_quarterly', 'lawn_care_recurring', 'lawn_care_6week', 'lawn_care_monthly',
      'mosquito_monthly', 'rodent_monitoring',
      'termite_active_bait_quarterly', 'termite_active_annual',
    ]);
    expect(migration.RENAMES.some(([k]) => k === 'tree_shrub_program')).toBe(false);
  });

  test('up() renames shipped rows, skips admin-edited rows AND their fanout, leaves conforming rows', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(svc(db, 'pest_general_bimonthly')).toMatchObject({ name: PEST_NEW, updated_at: 'NOW' });
    expect(svc(db, 'lawn_care_recurring').name).toBe(LAWN_NEW);
    expect(svc(db, 'mosquito_monthly').name).toBe(MOSQ_NEW);
    expect(svc(db, 'rodent_monitoring').name).toBe('Rodent Stations (Adam)');
    expect(visit(db, 'v-rm').service_type).toBe('Rodent Monitoring Service (Monthly)');
    expect(svc(db, 'tree_shrub_program')).toMatchObject({ name: 'Bi-Monthly Tree & Shrub Care Service', updated_at: 'orig' });
    expect(visit(db, 'v-ts').service_type).toBe('Bi-Monthly Tree & Shrub Care Service');
    const state = JSON.parse(stateRow(db).value);
    expect(state.renames.pest_general_bimonthly.renamed).toBe(true);
    expect(state.renames.rodent_monitoring.renamed).toBe(false);
  });

  test('Invariant 1: open visits relabel (linked + legacy), terminal statuses stay frozen', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-open-1').service_type).toBe(PEST_NEW);
    expect(visit(db, 'v-open-2').service_type).toBe(PEST_NEW);
    expect(visit(db, 'v-resched').service_type).toBe(PEST_NEW);
    expect(visit(db, 'v-done').service_type).toBe(PEST_OLD);
    expect(visit(db, 'v-cancel').service_type).toBe(PEST_OLD);
    expect(visit(db, 'v-lawn').service_type).toBe(LAWN_NEW);
  });

  test('Invariant 1 across every fan-out table: self-booking, add-ons, invoices, reminders, profile snapshot, aliases', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(db.self_booked_appointments[0].service_type).toBe(PEST_NEW);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(MOSQ_NEW);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-done').service_name).toBe(MOSQ_OLD);
    expect(invoiceById(db, 'inv-draft').title).toBe(PEST_NEW);
    expect(JSON.parse(invoiceById(db, 'inv-draft').line_items)[0]).toEqual({ description: PEST_NEW, amount: 97 });
    expect(invoiceById(db, 'inv-sent').title).toBe(PEST_OLD);
    expect(invoiceById(db, 'inv-frozen').title).toBe(PEST_OLD);
    expect(reminder(db, 'rem-1').service_type).toBe(PEST_NEW);
    expect(reminder(db, 'rem-merged').service_type).toBe(`Quarterly Pest Control Service & ${PEST_NEW}`);
    expect(reminder(db, 'rem-done').service_type).toBe(PEST_OLD);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(PEST_NEW);
    expect(db.service_completion_profiles[1].service_name_snapshot).toBe(MOSQ_NEW);
    const aliases = db.protocol_template_service_types.filter((r) => r.protocol_template_id === 'pt-1').map((r) => r.service_type).sort();
    expect(aliases).toEqual([PEST_NEW, PEST_OLD].sort());
  });

  test('Invariant 2: down() reverses exactly what up() wrote and only marker-owned aliases', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(svc(db, 'pest_general_bimonthly').name).toBe(PEST_OLD);
    expect(svc(db, 'lawn_care_recurring').name).toBe(LAWN_OLD);
    expect(visit(db, 'v-open-1').service_type).toBe(PEST_OLD);
    expect(visit(db, 'v-lawn').service_type).toBe(LAWN_OLD);
    expect(db.self_booked_appointments[0].service_type).toBe(PEST_OLD);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(MOSQ_OLD);
    expect(invoiceById(db, 'inv-draft').title).toBe(PEST_OLD);
    expect(reminder(db, 'rem-merged').service_type).toBe(`Quarterly Pest Control Service & ${PEST_OLD}`);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(PEST_OLD);
    expect(db.protocol_template_service_types.find((r) => r.protocol_template_id === 'pt-2').notes).toBe('admin');
    expect(db.protocol_template_service_types.filter((r) => r.service_type === PEST_NEW)).toHaveLength(1);
    expect(stateRow(db)).toBeUndefined();
  });

  test('Invariant 2: a post-deploy admin edit survives down() (CAS on the catalog row and its snapshots)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    svc(db, 'pest_general_bimonthly').name = 'Custom Pest Plan (Adam)';
    visit(db, 'v-open-1').service_type = 'Custom Pest Plan (Adam)';
    await migration.down(fakeKnex(db));
    expect(svc(db, 'pest_general_bimonthly').name).toBe('Custom Pest Plan (Adam)');
    // Catalog name did not revert ⇒ snapshots keep agreeing with the admin's story.
    expect(visit(db, 'v-open-1').service_type).toBe('Custom Pest Plan (Adam)');
    expect(visit(db, 'v-open-2').service_type).toBe(PEST_NEW);
    // Rows whose catalog name DID revert are restored as usual.
    expect(svc(db, 'lawn_care_recurring').name).toBe(LAWN_OLD);
    expect(visit(db, 'v-lawn').service_type).toBe(LAWN_OLD);
  });

  test('down() leaves every snapshot of a visit completed since up() under its new label', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-open-1').status = 'completed';
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-open-1').service_type).toBe(PEST_NEW);
    expect(db.self_booked_appointments[0].service_type).toBe(PEST_NEW);
    expect(invoiceById(db, 'inv-draft').title).toBe(PEST_NEW);
    expect(reminder(db, 'rem-1').service_type).toBe(PEST_NEW);
    expect(visit(db, 'v-open-2').service_type).toBe(PEST_OLD);
  });

  test('up() → up() → down() still restores everything the FIRST run changed', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(svc(db, 'pest_general_bimonthly').name).toBe(PEST_OLD);
    expect(visit(db, 'v-open-1').service_type).toBe(PEST_OLD);
    expect(invoiceById(db, 'inv-draft').title).toBe(PEST_OLD);
  });

  test('down() with no ownership record restores nothing', async () => {
    const db = seedDb();
    svc(db, 'pest_general_bimonthly').name = PEST_NEW;
    await migration.down(fakeKnex(db));
    expect(svc(db, 'pest_general_bimonthly').name).toBe(PEST_NEW);
  });

  test('up() survives absent companion tables', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingTables: ['invoices', 'appointment_reminders', 'protocol_template_service_types', 'self_booked_appointments'] }));
    expect(svc(db, 'pest_general_bimonthly').name).toBe(PEST_NEW);
    expect(visit(db, 'v-open-1').service_type).toBe(PEST_NEW);
  });
});

describe('literal ⇄ migrated catalog parity (booking literals equal services.name)', () => {
  // Migrated catalog = every RENAMES target plus the rows already on the
  // convention. The booking literal for (family, visits) must equal the
  // catalog name of the key the visit-count linker resolves.
  const migrated = new Map(migration.RENAMES.map(([key, , to]) => [key, to]));
  for (const [key, name] of [
    ['pest_general_quarterly', 'Quarterly Pest Control Service'],
    ['pest_general_monthly', 'Monthly Pest Control Service'],
    ['mosquito_seasonal', 'Seasonal Mosquito Control Service'],
    ['tree_shrub_quarterly', 'Quarterly Tree & Shrub Care Service'],
    ['tree_shrub_program', 'Bi-Monthly Tree & Shrub Care Service'],
    ['tree_shrub_6week', 'Every 6 Weeks Tree & Shrub Care Service'],
  ]) migrated.set(key, name);

  const CASES = [
    ['pest_control', 2], ['pest_control', 4], ['pest_control', 6], ['pest_control', 12],
    ['lawn_care', 4], ['lawn_care', 6], ['lawn_care', 9], ['lawn_care', 12],
    ['mosquito', 9], ['mosquito', 12],
    ['tree_shrub', 4], ['tree_shrub', 6], ['tree_shrub', 9],
  ];
  test.each(CASES)('%s × %i/yr literal equals its catalog row', (service, visitsPerYear) => {
    const primary = { service, visitsPerYear };
    const key = cadenceCatalogKeyForProfile(primary, false);
    expect(key).toBeTruthy();
    expect(migrated.has(key)).toBe(true);
    expect(canonicalServiceTypeForProfile({ services: [primary] })).toBe(migrated.get(key));
  });
});

describe('cadence resolution after the rename', () => {
  test('the 6-visit lawn row resolves bimonthly once it carries a cadence token (was quarterly by default)', () => {
    expect(resolveSelfBookedRecurringPlan(LAWN_OLD)).toMatchObject({ recurringPattern: 'quarterly' });
    expect(resolveSelfBookedRecurringPlan(LAWN_NEW)).toMatchObject({ planKey: 'lawn_care_bimonthly', recurringPattern: 'bimonthly' });
  });
});

describe('Invariant 3 — canonical cadence vocabulary', () => {
  const ALT_FORMS = /\bBimonthly\b|\bBi-monthly\b|Every 2 Months|Every 2 months|6-Weekly|\((Quarterly|Monthly|Bi-Monthly|Semiannual|Annual)\)/;
  test('migration targets use canonical spellings only', () => {
    for (const [, , to] of migration.RENAMES) expect({ to, ok: !ALT_FORMS.test(to) }).toEqual({ to, ok: true });
  });
  test('booking literals and estimate runtime names use canonical spellings only', () => {
    const fs = require('fs');
    const path = require('path');
    for (const rel of ['../services/slot-reservation.js', '../routes/estimate-public.js']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const offending = src.split('\n').filter((l) => (
        /(name|label|return|type):?\s*'[^']*(Pest Control|Lawn Care|Mosquito Control|Tree & Shrub|Bait Station)[^']*'/.test(l)
        && !/^\s*(\/\/|\*)/.test(l)
        && ALT_FORMS.test(l)
      ));
      expect({ file: rel, offending }).toEqual({ file: rel, offending: [] });
    }
  });
});

describe('20260829000011 termite_bait frequency', () => {
  test('up() corrects annual/4 to quarterly/4 and down() restores only that state', async () => {
    const db = seedDb();
    await termiteFix.up(fakeKnex(db));
    expect(svc(db, 'termite_bait')).toMatchObject({ frequency: 'quarterly', visits_per_year: 4 });
    await termiteFix.down(fakeKnex(db));
    expect(svc(db, 'termite_bait').frequency).toBe('annual');
  });
  test('an admin-corrected row is untouched', async () => {
    const db = seedDb();
    svc(db, 'termite_bait').frequency = 'semiannual';
    await termiteFix.up(fakeKnex(db));
    expect(svc(db, 'termite_bait').frequency).toBe('semiannual');
  });
});

describe('runtime alias bridge (pre-deploy labels keep resolving the renamed rows, and vice versa)', () => {
  test('the runtime alias list equals the migration RENAMES', () => {
    expect(CADENCE_CONVENTION_RENAMES).toEqual(migration.RENAMES.map(([, from, to]) => [from, to]));
  });
  test.each(migration.RENAMES)('%s: both spellings are candidates of each other', (key, from, to) => {
    expect(counterpartServiceName(from)).toBe(to);
    expect(counterpartServiceName(to)).toBe(from);
    expect(serviceNameCandidates(from).map((c) => c.toLowerCase())).toContain(to.toLowerCase());
    expect(serviceNameCandidates(to).map((c) => c.toLowerCase())).toContain(from.toLowerCase());
  });
  test('a replayed call extraction carrying the OLD label resolves the RENAMED catalog row', () => {
    const catalog = [{ id: 'svc', name: 'Bi-Monthly Pest Control Service', service_key: 'pest_general_bimonthly' }];
    expect(resolveCallBookingCatalogService({ extracted: { matched_service: 'General Pest Control Service (Bi-Monthly)' }, services: catalog })).toMatchObject({ id: 'svc' });
  });
  test('after down(), a NEW label still resolves the restored catalog row', () => {
    const catalog = [{ id: 'svc', name: 'Lawn Care Program Service', service_key: 'lawn_care_recurring' }];
    expect(resolveCallBookingCatalogService({ extracted: { matched_service: 'Bi-Monthly Lawn Care Service' }, services: catalog })).toMatchObject({ id: 'svc' });
  });
});
