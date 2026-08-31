/**
 * Migration 20260829000040 — backfill pre-convention visit labels.
 * Asserts the population contracts (cadence-mapped unlinked rows,
 * whitelist-gated linked sync with the run-time live-catalog exclusion,
 * add-ons under open parents), Invariant 1 (terminal rows untouched), the
 * fail-closed skip when a mapping target is missing from the active
 * catalog, the snapshot fanout (reminder own-row + LIVE same-slot siblings
 * component-wise, self-booking exact-or-qualified, attached AND
 * unambiguous unattached draft/scheduled invoices under the updated_at CAS
 * with frozen statements skipped), and the down() reversal gated on each
 * component visit's own identity-checked reversal.
 *
 * Purpose-built fake knex: this migration's only grouped-where callback is
 * the open-visit-status predicate, so the fake evaluates where(fn) as
 * exactly that predicate (the shared suffix-renames harness ignores
 * grouped callbacks, which would silently drop Invariant 1 here).
 */
const migration = require('../models/migrations/20260829000040_backfill_pre_convention_visit_labels');

const STATE_KEY = 'migration.20260829000040.state';
const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];

const stripAlias = (k) => k.replace(/^(ss|sv|a)\./, '');

function fakeKnex(db, { missingTables = [], missingColumns = [] } = {}) {
  const knex = (tableExpr) => {
    const table = String(tableExpr).split(' ')[0];
    const filters = [];
    let joined = false; // only services-on-service_id joins are used
    let openOnly = false;
    let rawNeq = null; // { col } — `<col> <> sv.name`
    let likeAny = null; // unattached-invoice label prefilter
    const inClauses = [];
    const catalogChecks = []; // `(SELECT name FROM services WHERE id = ?) = ?` write predicates
    const rows = () => db[table] || [];
    const isOpen = (r) => r.status == null || !TERMINAL.includes(r.status);
    const svcById = (id) => (db.services || []).find((s) => s.id === id);
    const match = (r) => {
      if (openOnly && !isOpen(r)) return false;
      for (const c of inClauses) if (!c.vals.includes(r[stripAlias(c.col)])) return false;
      if (rawNeq) {
        const sv = svcById(r.service_id);
        if (!sv || r[rawNeq.col] === sv.name) return false;
      }
      if (joined && !svcById(r.service_id)) return false;
      if (likeAny) {
        const { from } = likeAny;
        const has = (v) => typeof v === 'string' && v.includes(from);
        if (!(has(r.title) || has(r.service_type) || has(typeof r.line_items === 'string' ? r.line_items : JSON.stringify(r.line_items)))) return false;
      }
      if (!catalogChecks.every((check) => check())) return false;
      return filters.every((f) => Object.entries(f).every(([k, v]) => k.startsWith('__') || r[stripAlias(k)] === v));
    };
    const q = {
      join() { joined = true; return q; },
      where(cond) {
        if (typeof cond === 'function') { openOnly = true; return q; }
        filters.push(cond);
        return q;
      },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereIn(col, vals) { inClauses.push({ col, vals }); return q; },
      whereRaw(sql, bindings) {
        let m = /^(?:ss|a)\.(service_type|service_name) <> sv\.name$/.exec(sql);
        if (m) { rawNeq = { col: m[1] }; return q; }
        if (/^updated_at::text = \?$/.test(sql)) { filters.push({ updated_at: bindings[0] }); return q; }
        if (/^EXISTS \(SELECT 1 FROM services WHERE name = \? AND is_active = true\)$/.test(sql)) {
          const [name] = bindings;
          filters.push({ __target_still_active: name });
          catalogChecks.push(() => (db.services || []).some((s) => s.name === name && s.is_active === true));
          return q;
        }
        if (/^\(SELECT name FROM services WHERE id = \?\) = \?$/.test(sql)) {
          const [sid, name] = bindings;
          filters.push({ __catalog_name_still: name });
          catalogChecks.push(() => svcById(sid)?.name === name);
          return q;
        }
        if (/^\(title = \? OR title LIKE \?/.test(sql)) { likeAny = { from: bindings[0] }; return q; }
        throw new Error(`fake whereRaw: unsupported ${sql}`);
      },
      forUpdate() { return q; },
      async select(...cols) {
        return rows().filter(match).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => {
            const [expr, , alias] = String(c).split(' ');
            const key = stripAlias(expr).replace(/::text$/, '');
            const fromJoin = expr.startsWith('sv.');
            out[alias || key] = fromJoin ? svcById(r.service_id)?.[key] : r[key];
          });
          return out;
        });
      },
      async first(...cols) { return (await q.select(...cols))[0] || null; },
      async update(payload) {
        const hit = rows().filter(match);
        hit.forEach((r) => Object.assign(r, payload));
        return hit.length;
      },
      async insert(payload) { rows().push({ ...payload }); return [1]; },
      async del() {
        const keep = rows().filter((r) => !match(r));
        const removed = rows().length - keep.length;
        db[table] = keep;
        return removed;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && !!db[t],
    hasColumn: async (t, c) => !missingColumns.includes(`${t}.${c}`) && (db[t] || []).some((r) => c in r),
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = (sql) => sql; // only used as `updated_at::text AS updated_at_cas`
  return knex;
}

function seedDb() {
  return {
    services: [
      { id: 'svc-q', name: 'Quarterly Pest Control Service', is_active: true },
      { id: 'svc-m', name: 'Monthly Pest Control Service', is_active: true },
      { id: 'svc-l6', name: 'Every 6 Weeks Lawn Care Service', is_active: true },
      { id: 'svc-sa', name: 'Semiannual Pest Control Service', is_active: true },
      { id: 'svc-mosq', name: 'Mosquito Control', is_active: true },
      // A LIVE catalog row whose name is on the linked whitelist — the
      // run-time exclusion must drop it from the sweep.
      { id: 'svc-gp', name: 'General Pest Control', is_active: true },
      // Inactive catalog names do not count as live.
      { id: 'svc-old', name: 'Pest Control Service', is_active: false },
      // NOTE: no 'Bi-Monthly Lawn Care Service' row — that mapping must skip.
    ],
    scheduled_services: [
      // Leg A hits
      { id: 'u1', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: 'sb-1' },
      { id: 'u2', service_id: null, service_type: 'Pest Control', recurring_pattern: 'monthly', status: null, self_booking_id: null },
      // wrong cadence for its label — mapping pair doesn't exist, untouched
      { id: 'u3', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'custom', status: 'pending', self_booking_id: null },
      // terminal — Invariant 1, untouched
      { id: 'u4', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'completed', self_booking_id: 'sb-4' },
      // mapping whose target is missing from the catalog — fail closed
      { id: 'u5', service_id: null, service_type: 'Lawn Care Service', recurring_pattern: 'bimonthly', status: 'pending', self_booking_id: null },
      // Leg B hit: whitelist label, syncs from catalog; shares booking sb-1 with u1
      { id: 'l1', service_id: 'svc-q', service_type: 'Pest Control', recurring_pattern: 'quarterly', status: 'confirmed', self_booking_id: 'sb-1' },
      // linkage conflict: label is a valid catalog name — NOT whitelisted, untouched
      { id: 'l2', service_id: 'svc-q', service_type: 'Semiannual Pest Control Service', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      // linked, label already equals catalog name — untouched
      { id: 'l3', service_id: 'svc-m', service_type: 'Monthly Pest Control Service', recurring_pattern: 'monthly', status: 'pending', self_booking_id: null },
      // whitelisted label that is ALSO a live catalog name, contradicting
      // its service_id — linkage conflict, owner-managed, untouched
      { id: 'l4', service_id: 'svc-q', service_type: 'General Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      // whitelisted label that exists only as an INACTIVE catalog row — still stale, syncs
      { id: 'l5', service_id: 'svc-m', service_type: 'Pest Control Service', recurring_pattern: 'monthly', status: 'pending', self_booking_id: 'sb-5' },
      // second Quarterly Pest Control visit sharing l1's slot (c2/T2) — so that
      // slot is swept by TWO passes converging on one target
      { id: 'u6', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      // and a THIRD at that slot with the same mapping as u6 — a shared sibling
      // reminder then represents both
      { id: 'u7', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      // DIVERGENT slot (c6/T6): one stale label, two targets — a quarterly and a
      // monthly visit both stored as bare "Pest Control". Visits relabel; the
      // shared reminder rows must fail closed.
      // Both also link ONE self-booking (sb-div) — its snapshot must fail closed too.
      { id: 'd1', service_id: null, service_type: 'Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: 'sb-div' },
      { id: 'd2', service_id: null, service_type: 'Pest Control', recurring_pattern: 'monthly', status: 'pending', self_booking_id: 'sb-div' },
      // add-on-only parents: label fine, add-ons stale (open / terminal)
      { id: 'p-open', service_id: 'svc-mosq', service_type: 'Mosquito Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      { id: 'p-done', service_id: 'svc-mosq', service_type: 'Mosquito Control', recurring_pattern: 'quarterly', status: 'completed', self_booking_id: null },
      // parked same-slot siblings of l1 (c2/T2): a rescheduled placeholder and a cancelled visit
      { id: 'x-resched', service_id: 'svc-mosq', service_type: 'Mosquito Control', recurring_pattern: 'quarterly', status: 'rescheduled', self_booking_id: null },
      { id: 'x-cancel', service_id: 'svc-mosq', service_type: 'Mosquito Control', recurring_pattern: 'quarterly', status: 'cancelled', self_booking_id: null },
    ],
    scheduled_service_addons: [
      // linked stale add-on under an open parent → catalog name
      { id: 'a-linked', scheduled_service_id: 'p-open', service_id: 'svc-q', service_name: 'Pest Control', recurring_pattern: null },
      // name-only add-on with NO cadence of its own, parent quarterly → parent cadence (legacy fallback)
      { id: 'a-legacy', scheduled_service_id: 'p-open', service_id: null, service_name: 'Quarterly Pest Control', recurring_pattern: null },
      // name-only ambiguous label, no own cadence, parent monthly → the PARENT cadence disambiguates
      { id: 'a-monthly', scheduled_service_id: 'u2', service_id: null, service_name: 'Pest Control', recurring_pattern: null },
      // name-only add-on with its OWN cadence (quarterly) under a MONTHLY parent — its own
      // cadence maps it; the parent's would find no (label, monthly) pair at all
      { id: 'a-own', scheduled_service_id: 'u2', service_id: null, service_name: 'Quarterly Pest Control', recurring_pattern: 'quarterly' },
      // under a TERMINAL parent — untouched
      { id: 'a-done', scheduled_service_id: 'p-done', service_id: null, service_name: 'Quarterly Pest Control', recurring_pattern: null },
      // linked add-on whose name is a LIVE catalog name — linkage conflict, untouched
      { id: 'a-conflict', scheduled_service_id: 'p-open', service_id: 'svc-q', service_name: 'General Pest Control', recurring_pattern: null },
    ],
    appointment_reminders: [
      // u1's own registration — plain stale label
      { id: 'r-u1', scheduled_service_id: 'u1', customer_id: 'c1', appointment_time: 'T1', service_type: 'Quarterly Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // l1's own registration holds a MERGED label — only the component swaps
      { id: 'r-l1', scheduled_service_id: 'l1', customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control & Mosquito Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // live same-slot sibling of l1 (legacy, unlinked) — swept via customer_id + appointment_time
      { id: 'r-sib', scheduled_service_id: null, customer_id: 'c2', appointment_time: 'T2', service_type: 'Mosquito Control, Pest Control, and Lawn Care', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // u6's and u7's own registrations, same slot as l1
      { id: 'r-u6', scheduled_service_id: 'u6', customer_id: 'c2', appointment_time: 'T2', service_type: 'Quarterly Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      { id: 'r-u7', scheduled_service_id: 'u7', customer_id: 'c2', appointment_time: 'T2', service_type: 'Quarterly Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // legacy sibling holding BOTH stale components that converge on one target
      { id: 'r-conv', scheduled_service_id: null, customer_id: 'c2', appointment_time: 'T2', service_type: 'Quarterly Pest Control & Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // a longer name that merely STARTS with the stale label — never matches
      { id: 'r-long', scheduled_service_id: null, customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control Premium', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // PARKED same-slot siblings — the merger excludes them, so must we
      { id: 'r-sib-cancelled', scheduled_service_id: null, customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control & Mosquito Control', cancelled: true, windows_preclosed: false, updated_at: 'orig' },
      { id: 'r-sib-preclosed', scheduled_service_id: null, customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control & Mosquito Control', cancelled: false, windows_preclosed: true, updated_at: 'orig' },
      { id: 'r-sib-resched', scheduled_service_id: 'x-resched', customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control & Mosquito Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      { id: 'r-sib-terminal', scheduled_service_id: 'x-cancel', customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control & Mosquito Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // registration for an untouched (terminal) visit — untouched
      { id: 'r-u4', scheduled_service_id: 'u4', customer_id: 'c3', appointment_time: 'T3', service_type: 'Quarterly Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // linkage-conflict visit's registration — untouched
      { id: 'r-l4', scheduled_service_id: 'l4', customer_id: 'c4', appointment_time: 'T4', service_type: 'General Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // divergent slot's rows — untouched (fail closed)
      { id: 'r-d1', scheduled_service_id: 'd1', customer_id: 'c6', appointment_time: 'T6', service_type: 'Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      { id: 'r-d2', scheduled_service_id: 'd2', customer_id: 'c6', appointment_time: 'T6', service_type: 'Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
      // add-on-only parent: merged label carries the add-on component
      { id: 'r-p-open', scheduled_service_id: 'p-open', customer_id: 'c5', appointment_time: 'T5', service_type: 'Mosquito Control & Quarterly Pest Control', cancelled: false, windows_preclosed: false, updated_at: 'orig' },
    ],
    self_booked_appointments: [
      // linked from BOTH u1 (Quarterly Pest Control → …) and l1 (Pest
      // Control → …); its label matches u1's stale name, qualifier kept
      { id: 'sb-1', service_type: 'Quarterly Pest Control (Quarterly)' },
      // linked only from terminal u4 — never in the sweep
      { id: 'sb-4', service_type: 'Quarterly Pest Control' },
      // linked from l5 but carries a label that isn't l5's stale name — untouched
      { id: 'sb-5', service_type: 'Owner Custom Booking Label' },
      // linked from d1 (→ Quarterly) AND d2 (→ Monthly): one label, two targets — fail closed
      { id: 'sb-div', service_type: 'Pest Control' },
    ],
    invoices: [
      // draft for u1: title + service_type + one line item swap. line_items
      // is a DECODED array here — the jsonb shape node-postgres hands back.
      { id: 'i-u1', scheduled_service_id: 'u1', status: 'draft', title: 'Quarterly Pest Control — first visit', service_type: 'Quarterly Pest Control', payer_statement_id: null, updated_at: 'orig',
        line_items: [{ description: 'Quarterly Pest Control', category: 'Quarterly Pest Control', amount: 100 }, { description: 'Fuel surcharge', category: 'fee', amount: 5 }] },
      // SENT invoice for u1 — history, untouched
      { id: 'i-u1-sent', scheduled_service_id: 'u1', status: 'sent', title: 'Quarterly Pest Control', service_type: 'Quarterly Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      // scheduled invoice for l1 on a FROZEN payer statement — issued document, untouched
      { id: 'i-l1-frozen', scheduled_service_id: 'l1', status: 'scheduled', title: 'Pest Control', service_type: 'Pest Control', payer_statement_id: 'ps-closed', updated_at: 'orig', line_items: '[]' },
      // scheduled invoice for l5 on an OPEN statement — swaps
      { id: 'i-l5', scheduled_service_id: 'l5', status: 'scheduled', title: 'Lawn + Pest Control Service', service_type: 'Pest Control Service', payer_statement_id: 'ps-open', updated_at: 'orig', line_items: null },
      // draft for an untouched visit — untouched
      { id: 'i-l4', scheduled_service_id: 'l4', status: 'draft', title: 'General Pest Control', service_type: 'General Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      // add-on-only parent's draft: line items carry BOTH stale add-on names
      // (two different (from → to) passes touch this one invoice)
      { id: 'i-p-open', scheduled_service_id: 'p-open', status: 'draft', title: 'Mosquito Control + Quarterly Pest Control + Pest Control', service_type: 'Mosquito Control', payer_statement_id: null, updated_at: 'orig',
        line_items: JSON.stringify([{ description: 'Mosquito Control', category: 'Mosquito Control' }, { description: 'Quarterly Pest Control', category: 'Quarterly Pest Control' }, { description: 'Pest Control', category: 'Pest Control' }]) },
      // UNATTACHED drafts: unambiguous label swaps; bare "Pest Control" is a guess → untouched
      { id: 'i-free-q', scheduled_service_id: null, status: 'draft', title: 'Quarterly Pest Control — first visit', service_type: 'Quarterly Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      // combined unattached draft with TWO unambiguous stale components
      { id: 'i-free-2', scheduled_service_id: null, status: 'draft', title: 'Quarterly Pest Control + General Pest Control (Semiannual)', service_type: null, payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      { id: 'i-free-amb', scheduled_service_id: null, status: 'draft', title: 'Pest Control', service_type: 'Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      { id: 'i-free-sent', scheduled_service_id: null, status: 'sent', title: 'Quarterly Pest Control', service_type: 'Quarterly Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      // bare generics: no cadence in the label, no visit to supply one — untouched
      // ('Lawn Care Service' additionally has its mapping target absent from the catalog)
      { id: 'i-free-nocat', scheduled_service_id: null, status: 'draft', title: 'Lawn Care Service', service_type: 'Lawn Care Service', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      { id: 'i-free-gp', scheduled_service_id: null, status: 'draft', title: 'General Pest Control', service_type: 'General Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      // linked-only generic: seen with ONE target among linked rows (l5 → Monthly) — an
      // accidental singleton, never used for a draft
      { id: 'i-free-linkedonly', scheduled_service_id: null, status: 'draft', title: 'Pest Control Service', service_type: 'Pest Control Service', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
    ],
    payer_statements: [
      { id: 'ps-closed', status: 'issued' },
      { id: 'ps-open', status: 'open' },
    ],
    system_settings: [],
  };
}

const byId = (db, id) => db.scheduled_services.find((r) => r.id === id);
const rem = (db, id) => db.appointment_reminders.find((r) => r.id === id);
const sb = (db, id) => db.self_booked_appointments.find((r) => r.id === id);
const inv = (db, id) => db.invoices.find((r) => r.id === id);
const addon = (db, id) => db.scheduled_service_addons.find((r) => r.id === id);
const readState = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('20260829000040 backfill up()', () => {
  test('relabels mapped unlinked + whitelisted linked open rows; honors Invariant 1, fail-closed target guard, live-catalog exclusion', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(byId(db, 'u2').service_type).toBe('Monthly Pest Control Service'); // NULL status is open
    expect(byId(db, 'u3').service_type).toBe('Quarterly Pest Control'); // cadence pair not mapped
    expect(byId(db, 'u4').service_type).toBe('Quarterly Pest Control'); // terminal
    expect(byId(db, 'u5').service_type).toBe('Lawn Care Service'); // target missing → skip
    expect(byId(db, 'l1').service_type).toBe('Quarterly Pest Control Service');
    expect(byId(db, 'l2').service_type).toBe('Semiannual Pest Control Service'); // linkage conflict excluded
    expect(byId(db, 'l3').service_type).toBe('Monthly Pest Control Service'); // already synced
    expect(byId(db, 'l4').service_type).toBe('General Pest Control'); // live catalog name → owner-managed
    expect(byId(db, 'l5').service_type).toBe('Monthly Pest Control Service'); // inactive row ≠ live
    expect(byId(db, 'p-open').service_type).toBe('Mosquito Control'); // parent label untouched

    const state = readState(db);
    expect(byId(db, 'd1').service_type).toBe('Quarterly Pest Control Service'); // the visits themselves are unambiguous
    expect(byId(db, 'd2').service_type).toBe('Monthly Pest Control Service');
    expect(state.unlinked.map((r) => r.id).sort()).toEqual(['d1', 'd2', 'u1', 'u2', 'u6', 'u7']);
    expect(state.linked.map((r) => r.id).sort()).toEqual(['l1', 'l5']);
    // Population identity rides in the record for down().
    expect(state.unlinked.find((r) => r.id === 'u1')).toEqual(
      { id: 'u1', from: 'Quarterly Pest Control', to: 'Quarterly Pest Control Service', pattern: 'quarterly' }
    );
    expect(state.linked.find((r) => r.id === 'l1')).toEqual(
      { id: 'l1', from: 'Pest Control', to: 'Quarterly Pest Control Service', service_id: 'svc-q' }
    );
  });

  test('relabels add-ons under OPEN parents: linked via the whitelist, name-only via the parent cadence; leaves terminal parents and live-catalog names', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(addon(db, 'a-linked').service_name).toBe('Quarterly Pest Control Service');
    expect(addon(db, 'a-legacy').service_name).toBe('Quarterly Pest Control Service');
    expect(addon(db, 'a-monthly').service_name).toBe('Monthly Pest Control Service'); // parent u2 is monthly
    expect(addon(db, 'a-own').service_name).toBe('Quarterly Pest Control Service'); // its OWN quarterly cadence, not the monthly parent
    expect(addon(db, 'a-done').service_name).toBe('Quarterly Pest Control'); // terminal parent
    expect(addon(db, 'a-conflict').service_name).toBe('General Pest Control'); // live catalog name

    const state = readState(db);
    expect(state.addons.map((r) => r.id).sort()).toEqual(['a-legacy', 'a-linked', 'a-monthly', 'a-own']);
    expect(state.addons.find((r) => r.id === 'a-linked')).toEqual(
      { id: 'a-linked', from: 'Pest Control', to: 'Quarterly Pest Control Service', parent_id: 'p-open', service_id: 'svc-q' }
    );
    // The cadence each name-only mapping rested on, and where it came from.
    expect(state.addons.find((r) => r.id === 'a-legacy')).toMatchObject({ pattern: 'quarterly', pattern_source: 'parent', own_cadence_col: true });
    expect(state.addons.find((r) => r.id === 'a-own')).toMatchObject({ pattern: 'quarterly', pattern_source: 'addon', own_cadence_col: true });
    // The add-on-only parent's copies carry the add-on name → swept too.
    expect(rem(db, 'r-p-open').service_type).toBe('Mosquito Control & Quarterly Pest Control Service');
    // Both add-on passes touched the parent's draft — neither skipped the other.
    expect(inv(db, 'i-p-open').title).toBe('Mosquito Control + Quarterly Pest Control Service + Quarterly Pest Control Service');
    expect(JSON.parse(inv(db, 'i-p-open').line_items).slice(1)).toEqual([
      { description: 'Quarterly Pest Control Service', category: 'Quarterly Pest Control Service' },
      { description: 'Quarterly Pest Control Service', category: 'Quarterly Pest Control Service' },
    ]);
    expect(inv(db, 'i-p-open').service_type).toBe('Mosquito Control');
  });

  test('fans the relabel out to reminder registrations: own row + LIVE same-slot siblings only, component-wise on merged labels', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-u1').updated_at).toBe('NOW');
    expect(rem(db, 'r-l1').service_type).toBe('Quarterly Pest Control Service & Mosquito Control');
    expect(rem(db, 'r-sib').service_type).toBe('Mosquito Control, Quarterly Pest Control Service, and Lawn Care');
    expect(rem(db, 'r-long').service_type).toBe('Pest Control Premium'); // prefix-only, not a component
    // Two passes converged on one target in a single merged label.
    expect(rem(db, 'r-u6').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-conv').service_type).toBe('Quarterly Pest Control Service & Quarterly Pest Control Service');
    // Parked siblings the merger excludes stay historical.
    for (const id of ['r-sib-cancelled', 'r-sib-preclosed', 'r-sib-resched', 'r-sib-terminal']) {
      expect(rem(db, id).service_type).toBe('Pest Control & Mosquito Control');
    }
    expect(rem(db, 'r-u4').service_type).toBe('Quarterly Pest Control'); // terminal visit's reminder
    expect(rem(db, 'r-l4').service_type).toBe('General Pest Control'); // conflict visit's reminder
    // Divergent slot: "Pest Control" → two targets at c6/T6 — both rows fail closed, listed for the owner.
    expect(rem(db, 'r-d1').service_type).toBe('Pest Control');
    expect(rem(db, 'r-d2').service_type).toBe('Pest Control');

    const state = readState(db);
    expect([...new Set(state.divergent.filter((d) => d.scope === 'reminder_slot').map((d) => d.key))].sort()).toEqual(['r-d1', 'r-d2']);
    expect(state.divergent.every((d) => d.from === 'Pest Control')).toBe(true);
    expect(state.reminders.map((r) => r.id).sort()).toEqual(['r-conv', 'r-conv', 'r-l1', 'r-p-open', 'r-sib', 'r-u1', 'r-u6', 'r-u7']);
    // The converging label has one exact prior/written step per pass, and
    // the shared-slot step names EVERY visit it represents (u6 AND u7).
    expect(state.reminders.filter((r) => r.id === 'r-conv').map((r) => [r.prior, r.written, [...r.visit_ids].sort()]).sort()).toEqual([
      ['Quarterly Pest Control & Pest Control', 'Quarterly Pest Control Service & Pest Control', ['u6', 'u7']],
      ['Quarterly Pest Control Service & Pest Control', 'Quarterly Pest Control Service & Quarterly Pest Control Service', ['l1']],
    ]);
    // A sibling records the COMPONENT visit that swept it, not its own owner.
    expect(state.reminders.find((r) => r.id === 'r-sib')).toEqual({
      id: 'r-sib',
      prior: 'Mosquito Control, Pest Control, and Lawn Care',
      written: 'Mosquito Control, Quarterly Pest Control Service, and Lawn Care',
      from: 'Pest Control',
      to: 'Quarterly Pest Control Service',
      visit_ids: ['l1'],
      addon_ids: [],
    });
  });

  test('sibling sweep tolerates a schema without windows_preclosed', async () => {
    const db = seedDb();
    db.appointment_reminders.forEach((r) => { delete r.windows_preclosed; });
    await migration.up(fakeKnex(db));
    expect(rem(db, 'r-sib').service_type).toBe('Mosquito Control, Quarterly Pest Control Service, and Lawn Care');
    expect(rem(db, 'r-sib-cancelled').service_type).toBe('Pest Control & Mosquito Control');
  });

  test('fans the relabel out to self-booking snapshots (exact-or-qualified) and records every linked visit', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control Service (Quarterly)');
    expect(sb(db, 'sb-4').service_type).toBe('Quarterly Pest Control'); // only a terminal visit links it
    expect(sb(db, 'sb-5').service_type).toBe('Owner Custom Booking Label'); // label ≠ the visit's stale name
    // d1 (→ Quarterly) and d2 (→ Monthly) share sb-div: divergent across groups → untouched, listed.
    expect(sb(db, 'sb-div').service_type).toBe('Pest Control');

    const state = readState(db);
    expect(state.divergent.filter((d) => d.scope === 'self_booking').map((d) => d.key)).toEqual(['sb-div', 'sb-div']);
    // sb-1 is linked from u1 (Quarterly Pest Control → …) and l1 (Pest
    // Control → …); only the u1 pass matched its label.
    expect(state.selfBookings).toEqual([
      {
        id: 'sb-1',
        from: 'Quarterly Pest Control',
        to: 'Quarterly Pest Control Service',
        prior: 'Quarterly Pest Control (Quarterly)',
        written: 'Quarterly Pest Control Service (Quarterly)',
        visit_ids: ['u1'],
      },
    ]);
  });

  test('fans the relabel out to draft/scheduled invoices — attached, plus unattached on unambiguous labels only; skips sent + frozen', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    const iu1 = inv(db, 'i-u1');
    expect(iu1.title).toBe('Quarterly Pest Control Service — first visit');
    expect(iu1.service_type).toBe('Quarterly Pest Control Service');
    expect(JSON.parse(iu1.line_items)).toEqual([
      { description: 'Quarterly Pest Control Service', category: 'Quarterly Pest Control Service', amount: 100 },
      { description: 'Fuel surcharge', category: 'fee', amount: 5 },
    ]);
    expect(iu1.updated_at).toBe('NOW');
    expect(inv(db, 'i-u1-sent').service_type).toBe('Quarterly Pest Control'); // sent = history
    expect(inv(db, 'i-l1-frozen').service_type).toBe('Pest Control'); // frozen statement
    expect(inv(db, 'i-l5').title).toBe('Lawn + Monthly Pest Control Service');
    expect(inv(db, 'i-l5').service_type).toBe('Monthly Pest Control Service');
    expect(inv(db, 'i-l4').service_type).toBe('General Pest Control'); // untouched visit
    // Unattached: "Quarterly Pest Control" has one target everywhere → swaps;
    // bare "Pest Control" resolved to two targets (quarterly + monthly) → guess, untouched.
    expect(inv(db, 'i-free-q').service_type).toBe('Quarterly Pest Control Service');
    expect(inv(db, 'i-free-q').title).toBe('Quarterly Pest Control Service — first visit');
    expect(inv(db, 'i-free-amb').service_type).toBe('Pest Control');
    expect(inv(db, 'i-free-sent').service_type).toBe('Quarterly Pest Control');
    expect(inv(db, 'i-free-nocat').service_type).toBe('Lawn Care Service'); // bare generic (+ target missing)
    expect(inv(db, 'i-free-gp').service_type).toBe('General Pest Control'); // bare generic
    expect(inv(db, 'i-free-linkedonly').service_type).toBe('Pest Control Service'); // linked-only singleton
    // A combined unattached draft gets EVERY unambiguous component swapped.
    expect(inv(db, 'i-free-2').title).toBe('Quarterly Pest Control Service + Semiannual Pest Control Service');

    const state = readState(db);
    // One record per (invoice, pass): i-p-open and i-free-2 were each touched twice.
    expect(state.invoices.map((r) => r.id).sort()).toEqual(['i-free-2', 'i-free-2', 'i-free-q', 'i-l5', 'i-p-open', 'i-p-open', 'i-u1']);
    // Exact prior/written per field — the rollback chain, not an inverse swap.
    expect(state.invoices.find((r) => r.id === 'i-u1')).toEqual({
      id: 'i-u1',
      from: 'Quarterly Pest Control',
      to: 'Quarterly Pest Control Service',
      prior: {
        title: 'Quarterly Pest Control — first visit',
        service_type: 'Quarterly Pest Control',
        // the decoded jsonb array is stored as the JSON text down() will write
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control', category: 'Quarterly Pest Control', amount: 100 }, { description: 'Fuel surcharge', category: 'fee', amount: 5 }]),
      },
      written: {
        title: 'Quarterly Pest Control Service — first visit',
        service_type: 'Quarterly Pest Control Service',
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', category: 'Quarterly Pest Control Service', amount: 100 }, { description: 'Fuel surcharge', category: 'fee', amount: 5 }]),
      },
      visit_id: 'u1',
      addon_ids: [],
      written_at: 'NOW', // the timestamp up() stamped — down() CASes on it
    });
    expect(state.invoices.find((r) => r.id === 'i-free-q').visit_id).toBeNull();
    expect(state.invoices.filter((r) => r.id === 'i-free-2').map((r) => r.from).sort()).toEqual(['General Pest Control (Semiannual)', 'Quarterly Pest Control']);
  });

  test('skips a snapshot fanout whose table is missing, still relabels visits', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingTables: ['appointment_reminders', 'self_booked_appointments', 'invoices', 'scheduled_service_addons'] }));
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control (Quarterly)');
    expect(inv(db, 'i-u1').service_type).toBe('Quarterly Pest Control');
    expect(addon(db, 'a-legacy').service_name).toBe('Quarterly Pest Control');
    const state = readState(db);
    expect(state.addons).toEqual([]);
    expect(state.reminders).toEqual([]);
    expect(state.selfBookings).toEqual([]);
    expect(state.invoices).toEqual([]);
  });

  test('no-ops without the scheduled_services table', async () => {
    const db = seedDb();
    await expect(migration.up(fakeKnex(db, { missingTables: ['scheduled_services'] }))).resolves.toBeUndefined();
    expect(db.system_settings).toHaveLength(0);
  });
});

describe('20260829000040 down()', () => {
  test('clean reversal restores every visit and every snapshot copy; clears state', async () => {
    const db = seedDb();
    const before = JSON.parse(JSON.stringify(seedDb()));
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    for (const t of ['scheduled_services', 'scheduled_service_addons', 'self_booked_appointments']) {
      expect(db[t]).toEqual(before[t]);
    }
    const strip = (rows) => rows.map(({ updated_at, ...r }) => r);
    expect(strip(db.appointment_reminders)).toEqual(strip(before.appointment_reminders));
    // A restored jsonb line_items comes back as JSON TEXT (what a real update
    // must send) — compare structurally, and assert the type explicitly.
    const norm = (rows) => strip(rows).map((r) => ({ ...r, line_items: typeof r.line_items === 'string' ? JSON.parse(r.line_items) : r.line_items }));
    expect(norm(db.invoices)).toEqual(norm(before.invoices));
    expect(typeof inv(db, 'i-u1').line_items).toBe('string');
    expect(db.system_settings).toHaveLength(0);
  });

  test('CAS-restores recorded rows still open, unchanged, and in-population under the written label', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    // u1 completed under the NEW label after up() — down must leave it.
    byId(db, 'u1').status = 'completed';
    // l1 was hand-edited after up() — CAS mismatch, down must leave it.
    byId(db, 'l1').service_type = 'Owner Custom Label';
    // u2 was LINKED by the owner after up() — no longer the unlinked
    // population; label agrees with the link, down must leave it.
    byId(db, 'u2').service_id = 'svc-m';
    // l5 was re-linked to a different service after up() — down must leave it.
    byId(db, 'l5').service_id = 'svc-q';

    await migration.down(knex);

    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(byId(db, 'u2').service_type).toBe('Monthly Pest Control Service'); // linked since → kept
    expect(byId(db, 'l1').service_type).toBe('Owner Custom Label');
    expect(byId(db, 'l5').service_type).toBe('Monthly Pest Control Service'); // relinked since → kept
  });

  test('restores an unlinked row whose cadence is unchanged, leaves one the owner re-cadenced', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    byId(db, 'u1').recurring_pattern = 'monthly'; // owner re-cadenced after up()
    await migration.down(knex);
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service'); // identity changed → kept
    expect(byId(db, 'u2').service_type).toBe('Pest Control'); // restored
  });

  test('snapshot copies revert ONLY in step with their component visit: a visit kept for any reason keeps its copies', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    byId(db, 'u1').status = 'completed'; // history
    byId(db, 'u2').service_id = 'svc-m'; // owner linked since → visit kept
    byId(db, 'l1').recurring_pattern = 'monthly'; // (linked leg ignores cadence) → l1 reverts
    byId(db, 'l5').service_type = 'Owner Custom Label'; // hand-edited → kept
    // r-u1 was edited since up() — no longer exactly what up() wrote → the owner's row now.
    rem(db, 'r-u1').service_type = 'Quarterly Pest Control Service & Mosquito Control';

    await migration.down(knex);

    // u1 (completed): reminder, self-booking, invoice all keep the new label.
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control Service & Mosquito Control');
    // Converging label unwinds exactly: u6 reverted (its pass) and l1 reverted (the other).
    expect(rem(db, 'r-conv').service_type).toBe('Quarterly Pest Control & Pest Control');
    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control Service (Quarterly)');
    expect(inv(db, 'i-u1').service_type).toBe('Quarterly Pest Control Service');
    expect(inv(db, 'i-u1').title).toBe('Quarterly Pest Control Service — first visit');
    // u2 (linked since): its add-on keeps the new name too.
    expect(byId(db, 'u2').service_type).toBe('Monthly Pest Control Service');
    expect(addon(db, 'a-monthly').service_name).toBe('Monthly Pest Control Service');
    // l1 reverted → its reminder and the live sibling it swept revert with it.
    expect(byId(db, 'l1').service_type).toBe('Pest Control');
    expect(rem(db, 'r-l1').service_type).toBe('Pest Control & Mosquito Control');
    expect(rem(db, 'r-sib').service_type).toBe('Mosquito Control, Pest Control, and Lawn Care');
    // l5 (hand-edited): its scheduled invoice keeps the new labels.
    expect(inv(db, 'i-l5').service_type).toBe('Monthly Pest Control Service');
    expect(inv(db, 'i-l5').title).toBe('Lawn + Monthly Pest Control Service');
    // Unattached draft has no visit → reverts under the still-draft guard alone.
    expect(inv(db, 'i-free-q').service_type).toBe('Quarterly Pest Control');
  });

  test('add-on-only parents: copies revert while the parent is still open, stay once it completed', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    byId(db, 'p-open').status = 'completed';
    await migration.down(knex);
    expect(addon(db, 'a-linked').service_name).toBe('Quarterly Pest Control Service');
    expect(addon(db, 'a-legacy').service_name).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-p-open').service_type).toBe('Mosquito Control & Quarterly Pest Control Service');
    expect(inv(db, 'i-p-open').title).toBe('Mosquito Control + Quarterly Pest Control Service + Quarterly Pest Control Service');
  });

  test('a name-only add-on under an add-on-only parent the owner re-cadenced since stays; the linked add-on beside it reverts', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    byId(db, 'p-open').recurring_pattern = 'monthly'; // cadence that justified the mapping is gone
    addon(db, 'a-own').recurring_pattern = 'monthly'; // an add-on's OWN cadence changed since → its identity is gone too
    await migration.down(knex);
    expect(addon(db, 'a-legacy').service_name).toBe('Quarterly Pest Control Service'); // kept
    expect(addon(db, 'a-linked').service_name).toBe('Pest Control'); // catalog-linked, cadence-independent → reverted
    expect(addon(db, 'a-own').service_name).toBe('Quarterly Pest Control Service'); // own cadence changed → kept
    // r-p-open's component came from a-legacy, which was kept → the copy stays in agreement with it.
    expect(rem(db, 'r-p-open').service_type).toBe('Mosquito Control & Quarterly Pest Control Service');
  });

  test('copies carrying an add-on component revert only when that add-on reverted (repointed add-on keeps its copies)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    addon(db, 'a-linked').service_id = 'svc-m'; // owner repointed the linked add-on since
    await migration.down(knex);
    expect(addon(db, 'a-linked').service_name).toBe('Quarterly Pest Control Service'); // identity gone → kept
    expect(addon(db, 'a-legacy').service_name).toBe('Quarterly Pest Control'); // reverted
    // r-p-open only ever carried a-legacy's component → reverts with it.
    expect(rem(db, 'r-p-open').service_type).toBe('Mosquito Control & Quarterly Pest Control');
    // i-p-open's LAST step came from a-linked's pass → retained, so the
    // whole invoice stays (an earlier component is never restored underneath).
    expect(inv(db, 'i-p-open').title).toBe('Mosquito Control + Quarterly Pest Control Service + Quarterly Pest Control Service');
  });

  test('a parent-fallback add-on that gained its OWN cadence in flight is missed by the write, and one that gained it after up() is kept on rollback', async () => {
    // In flight: the owner assigns a-legacy its own cadence before its write executes.
    const db = seedDb();
    const orig = fakeKnex(db);
    let assigned = false;
    const wrapped = (t) => {
      const q = orig(t);
      const update = q.update;
      q.update = async (payload) => {
        if (!assigned && t === 'scheduled_service_addons' && addon(db, 'a-legacy').service_name === 'Quarterly Pest Control') {
          assigned = true;
          addon(db, 'a-legacy').recurring_pattern = 'monthly';
        }
        return update(payload);
      };
      return q;
    };
    wrapped.schema = orig.schema; wrapped.fn = orig.fn; wrapped.raw = orig.raw;
    await migration.up(wrapped);
    expect(addon(db, 'a-legacy').service_name).toBe('Quarterly Pest Control'); // parent-cadence write missed
    expect(readState(db).addons.map((r) => r.id)).not.toContain('a-legacy');

    // After up(): the same assignment makes the rollback leave the add-on (and its copies).
    const db2 = seedDb();
    const knex2 = fakeKnex(db2);
    await migration.up(knex2);
    addon(db2, 'a-legacy').recurring_pattern = 'monthly';
    await migration.down(knex2);
    expect(addon(db2, 'a-legacy').service_name).toBe('Quarterly Pest Control Service');
    expect(rem(db2, 'r-p-open').service_type).toBe('Mosquito Control & Quarterly Pest Control Service');
  });

  test('invoice rollback compares jsonb line items key-order-insensitively', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // Simulate a jsonb round trip that reorders object keys (and decodes to an array).
    const reordered = JSON.parse(inv(db, 'i-u1').line_items).map((item) => Object.fromEntries(Object.entries(item).reverse()));
    inv(db, 'i-u1').line_items = reordered;
    await migration.down(knex);
    expect(inv(db, 'i-u1').service_type).toBe('Quarterly Pest Control');
    expect(JSON.parse(inv(db, 'i-u1').line_items)[0].description).toBe('Quarterly Pest Control');
  });

  test('a self-booking edited since up() (new prefix, new qualifier) is the owner\'s — not rewritten', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    sb(db, 'sb-1').service_type = 'Quarterly Pest Control Service (Custom)';
    await migration.down(knex);
    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control Service (Custom)');
  });

  test('a mapped write re-checks its target is still an ACTIVE catalog name (deactivation in flight makes the CAS miss)', async () => {
    const db = seedDb();
    const orig = fakeKnex(db);
    let deactivated = false;
    const wrapped = (t) => {
      const q = orig(t);
      const update = q.update;
      q.update = async (payload) => {
        // First mapped write of the Monthly target (u2 in Leg A): deactivate it right then.
        if (!deactivated && t === 'scheduled_services' && payload.service_type === 'Monthly Pest Control Service') {
          deactivated = true;
          db.services.find((s) => s.id === 'svc-m').is_active = false;
        }
        return update(payload);
      };
      return q;
    };
    wrapped.schema = orig.schema; wrapped.fn = orig.fn; wrapped.raw = orig.raw;
    await migration.up(wrapped);
    expect(byId(db, 'u2').service_type).toBe('Pest Control'); // the write in flight missed
    expect(addon(db, 'a-monthly').service_name).toBe('Pest Control'); // later mapped write to the same target misses too
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service'); // other targets unaffected
    expect(readState(db).unlinked.map((r) => r.id)).not.toContain('u2');
  });

  test('a sibling reminder shared by two same-mapping visits reverts only when BOTH revert', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    byId(db, 'u7').status = 'completed'; // u6 reverts, u7 does not
    await migration.down(knex);
    // Last step (l1's pass) unwinds; the shared u6+u7 step is retained whole.
    expect(rem(db, 'r-conv').service_type).toBe('Quarterly Pest Control Service & Pest Control');
    // Every row at that slot carrying the shared label represents both visits
    // (the merger dedupes identical labels) — u6's own row included.
    expect(rem(db, 'r-u6').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-u7').service_type).toBe('Quarterly Pest Control Service');
    // u1's row (a different slot) reverts with u1 as usual.
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
  });

  test('a linked write re-checks the catalog name it stamps (an admin rename in between makes the CAS miss)', async () => {
    const db = seedDb();
    // Simulate the rename landing between the join read and the write: the
    // fake evaluates the predicate at write time against the live row.
    const knex = fakeKnex(db);
    const orig = knex;
    let renamed = false;
    const wrapped = (t) => {
      const q = orig(t);
      const update = q.update;
      q.update = async (payload) => {
        // Leg B's l5 write is the one stamping svc-m's name AFTER Leg A has
        // relabeled every unlinked monthly "Pest Control" row (u2, d2) to the
        // same string — rename svc-m right then.
        const legADone = !db.scheduled_services.some((r) => r.service_id === null && r.recurring_pattern === 'monthly' && r.service_type === 'Pest Control');
        if (!renamed && legADone && t === 'scheduled_services' && payload.service_type === 'Monthly Pest Control Service') {
          renamed = true;
          db.services.find((s) => s.id === 'svc-m').name = 'Monthly Pest Control Plan';
        }
        return update(payload);
      };
      return q;
    };
    wrapped.schema = orig.schema; wrapped.fn = orig.fn; wrapped.raw = orig.raw;
    await migration.up(wrapped);
    // l5 (svc-m) was the write in flight — the stale name was NOT stamped.
    expect(byId(db, 'l5').service_type).toBe('Pest Control Service');
    expect(readState(db).linked.map((r) => r.id)).toEqual(['l1']);
  });

  test('a converging merged reminder stops unwinding at the first non-revertible step and never guesses', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // The LAST pass on r-conv was l1's (Pest Control → …). Complete l1: that
    // step is retained, and the earlier u6 step cannot be restored underneath
    // it — the label stays whole rather than half-reverted.
    byId(db, 'l1').status = 'completed';
    await migration.down(knex);
    expect(rem(db, 'r-conv').service_type).toBe('Quarterly Pest Control Service & Quarterly Pest Control Service');
    // A reminder edited since up() is left exactly as the owner left it.
    const db2 = seedDb();
    const knex2 = fakeKnex(db2);
    await migration.up(knex2);
    rem(db2, 'r-conv').service_type = 'Owner Rewrote This';
    await migration.down(knex2);
    expect(rem(db2, 'r-conv').service_type).toBe('Owner Rewrote This');
  });

  test('a combined draft touched by two passes unwinds BOTH components in one write', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(inv(db, 'i-free-2').title).toBe('Quarterly Pest Control + General Pest Control (Semiannual)');
    expect(inv(db, 'i-p-open').title).toBe('Mosquito Control + Quarterly Pest Control + Pest Control');
    expect(JSON.parse(inv(db, 'i-p-open').line_items).slice(1)).toEqual([
      { description: 'Quarterly Pest Control', category: 'Quarterly Pest Control' },
      { description: 'Pest Control', category: 'Pest Control' },
    ]);
  });

  test('invoice reversal compares against the timestamp up() WROTE (an owner edit since is theirs) and a statement frozen since up()', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    inv(db, 'i-l5').updated_at = 'edited-since'; // CAS mismatch → kept
    inv(db, 'i-free-q').payer_statement_id = 'ps-open';
    db.payer_statements.find((p) => p.id === 'ps-open').status = 'issued'; // froze since → kept
    await migration.down(knex);
    expect(inv(db, 'i-l5').service_type).toBe('Monthly Pest Control Service');
    expect(inv(db, 'i-free-q').service_type).toBe('Quarterly Pest Control Service');
    expect(inv(db, 'i-u1').service_type).toBe('Quarterly Pest Control'); // clean → restored
  });

  test('down is a no-op without a state row', async () => {
    const db = seedDb();
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control');
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
  });
});
