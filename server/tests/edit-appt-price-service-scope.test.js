/**
 * Edit appointment — "Apply price & service change to" series scope
 * (GATE_EDIT_APPT_PRICE_SERVICE_SCOPE).
 *
 * Unit tests drive the extracted helpers with a scripted fake connection
 * (house style — see recurring-series-maintenance.test.js); source-pattern
 * guards pin the wiring that can't be unit-driven: the gate refusal in
 * update-details, the overlay call in every extension writer, and the
 * stale-override clear on the make-this-recurring spawn path.
 */

// The gate is fail-closed in EVERY environment, so it must be flipped on
// before the route module (and its isEnabled closure) loads.
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';

// The route-level tests at the bottom drive the real handlers through a
// swappable `db` (the admin-schedule-discount-provenance-fields.test.js
// pattern): a scripted fake for series-summary, a rolled-back PostgreSQL
// transaction for the service-line sheet's saves. The helper tests pass
// their own connection and never touch it.
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});

const fs = require('fs');
const path = require('path');

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  normalizePriceServiceScope,
  computePriceServiceGroupChanges,
  pickUnpinnedGroupFields,
  readProvenanceOverrides,
  resolveSeriesExtensionPriceTemplate,
  parseTemplateOverrides,
  overlayRecurringTemplateOverrides,
  stampRecurringTemplateOverrides,
  propagatePriceServiceToFollowingSiblings,
  applyStoredVisitFinancials,
  PRICE_SERVICE_OVERRIDE_KEYS,
} = adminScheduleRouter._test;

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
const gatesSrc = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');

const COLS = {
  service_type: {}, service_id: {}, service_key_snapshot: {}, service_category_snapshot: {},
  is_callback: {}, appointment_type: {},
  estimated_price: {}, primary_line_price: {},
  discount_type: {}, discount_amount: {}, discount_dollars: {},
  discount_id: {}, discount_name: {},
  discount_service_key_filter: {}, discount_service_category_filter: {},
  line_discount_id: {}, line_discount_name: {}, line_discount_type: {},
  line_discount_amount: {}, line_discount_dollars: {},
  recurring_template_overrides: {},
};

// Minimal scriptable fake knex connection: records chained calls and
// resolves terminal ops through the scenario handler. `.transaction(cb)`
// hands cb a fresh conn (the add-on preload savepoint).
function makeConn(handler) {
  const make = () => {
    const fn = (table) => {
      const calls = [];
      const b = {};
      const record = (name) => (...args) => { calls.push([name, ...args]); return b; };
      for (const m of ['where', 'orWhere', 'whereIn', 'whereNot', 'whereNotIn', 'orderBy', 'select', 'limit', 'forUpdate', 'noWait']) {
        b[m] = record(m);
      }
      // The sibling mint-lock candidate read (owner ruling 2026-09-28)
      // conditionally adds its own date filter inside `.modify()` — invoke
      // the callback against this SAME builder (so its `.where(...)` lands
      // in this query's own `calls`, not the real targetQuery's) and keep
      // chaining.
      b.modify = (cb) => { calls.push(['modify']); if (typeof cb === 'function') cb(b); return b; };
      b.first = (...args) => {
        calls.push(['first', ...args]);
        return Promise.resolve(handler({ table, calls, op: 'first' }));
      };
      b.pluck = (...args) => {
        calls.push(['pluck', ...args]);
        return Promise.resolve(handler({ table, calls, op: 'pluck' }) || []);
      };
      b.columnInfo = () => Promise.resolve(handler({ table, calls, op: 'columnInfo' }) || {});
      b.update = (data) => {
        calls.push(['update', data]);
        return { then: (res, rej) => Promise.resolve(handler({ table, calls, op: 'update', data })).then(res, rej) };
      };
      b.then = (res, rej) => Promise.resolve(handler({ table, calls, op: 'await', args: calls })).then(res, rej);
      return b;
    };
    fn.transaction = (cb) => Promise.resolve().then(() => cb(make()));
    // Schema probes: the add-on table exists (its reads are exercised);
    // the invoice link column and the billing-covered tables answer absent
    // so those paths stay inert unless a test opts in via row fields.
    fn.schema = {
      hasTable: async (name) => name === 'scheduled_service_addons',
      hasColumn: async () => false,
    };
    fn.fn = { now: () => new Date() };
    // The sibling mint try-lock (pg_try_advisory_xact_lock) — always free here.
    fn.raw = async () => ({ rows: [{ acquired: true }] });
    return fn;
  };
  return make();
}

describe('normalizePriceServiceScope', () => {
  it("defaults everything except 'following' to 'this_only'", () => {
    expect(normalizePriceServiceScope('following')).toBe('following');
    expect(normalizePriceServiceScope('this_only')).toBe('this_only');
    expect(normalizePriceServiceScope('series')).toBe('this_only');
    expect(normalizePriceServiceScope(undefined)).toBe('this_only');
  });
});

describe('computePriceServiceGroupChanges — presence is not change', () => {
  const before = {
    service_type: 'Lawn Care Visit', service_id: 7,
    primary_line_price: '25.00', estimated_price: '25.00',
    discount_type: null, discount_amount: null, line_discount_dollars: null,
  };

  it('same-value echoes flag nothing', () => {
    const groups = computePriceServiceGroupChanges(before, {
      service_type: 'Lawn Care Visit',
      primary_line_price: 25,
      estimated_price: 25,
    });
    expect(groups.changed).toBe(false);
    expect(groups.fields).toEqual({});
  });

  it('a primary price change collects only the price-group keys present in updates', () => {
    const groups = computePriceServiceGroupChanges(before, {
      service_type: 'Lawn Care Visit',
      primary_line_price: 30,
      estimated_price: 30,
      discount_dollars: null,
      scheduled_date: '2098-01-15', // never propagated
    });
    expect(groups.priceChanged).toBe(true);
    expect(groups.serviceChanged).toBe(false);
    expect(groups.fields).toEqual({
      primary_line_price: 30, estimated_price: 30, discount_dollars: null,
    });
    expect(Object.keys(groups.fields).every((k) => PRICE_SERVICE_OVERRIDE_KEYS.has(k))).toBe(true);
  });

  it('a service change requires an explicit catalog pick — a label-only delta is the modal normalization echo', () => {
    // The modal posts "Lawn Care" for a row stored as "Lawn Care Visit" on
    // EVERY save; without serviceId that must never read as a switch.
    const labelEcho = computePriceServiceGroupChanges(before, { service_type: 'Pest Control Service' });
    expect(labelEcho.serviceChanged).toBe(false);
    expect(labelEcho.fields).toEqual({});

    const byId = computePriceServiceGroupChanges(before, {
      service_type: 'Lawn Care Visit', service_id: 9, service_key_snapshot: 'pest_control', is_callback: false,
    });
    expect(byId.serviceChanged).toBe(true);
    expect(byId.fields).toEqual({
      service_type: 'Lawn Care Visit', service_id: 9, service_key_snapshot: 'pest_control', is_callback: false,
    });

    // Same catalog id posted with a new label (a picked library item that
    // resolves to the same service row) still counts — the id is present,
    // so this is a deliberate pick, not an echo.
    const relabelWithId = computePriceServiceGroupChanges(before, {
      service_type: 'Pest Control Service', service_id: 7,
    });
    expect(relabelWithId.serviceChanged).toBe(true);
  });

  it('an appointment-discount change counts as a price change', () => {
    const groups = computePriceServiceGroupChanges(before, {
      primary_line_price: 25,
      discount_type: 'percentage', discount_amount: 10,
    });
    expect(groups.priceChanged).toBe(true);
  });
});

describe('parseTemplateOverrides', () => {
  it('parses object or JSON-string values and drops non-allowlisted keys', () => {
    expect(parseTemplateOverrides({ primary_line_price: 30, status: 'cancelled', scheduled_date: '2098-01-01' }))
      .toEqual({ primary_line_price: 30 });
    expect(parseTemplateOverrides(JSON.stringify({ service_type: 'Pest Control Service' })))
      .toEqual({ service_type: 'Pest Control Service' });
  });

  it('rejects garbage', () => {
    expect(parseTemplateOverrides('not-json')).toBeNull();
    expect(parseTemplateOverrides([1, 2])).toBeNull();
    expect(parseTemplateOverrides(null)).toBeNull();
    expect(parseTemplateOverrides({ status: 'cancelled' })).toBeNull();
  });
});

describe('overlayRecurringTemplateOverrides', () => {
  const parent = {
    id: 'p1', scheduled_date: '2098-01-15', status: 'completed',
    service_type: 'Lawn Care Visit', primary_line_price: '25.00', estimated_price: '25.00',
    recurring_template_overrides: { primary_line_price: 30, estimated_price: 30, status: 'cancelled' },
  };

  it('overlays allowlisted keys over the parent (never status/dates)', () => {
    const tmpl = overlayRecurringTemplateOverrides(parent, COLS);
    expect(tmpl.primary_line_price).toBe(30);
    expect(tmpl.estimated_price).toBe(30);
    expect(tmpl.service_type).toBe('Lawn Care Visit');
    expect(tmpl.status).toBe('completed');
    expect(tmpl.scheduled_date).toBe('2098-01-15');
  });

  it('is the identity without the column, without overrides, or on garbage', () => {
    expect(overlayRecurringTemplateOverrides(parent, {})).toBe(parent);
    expect(overlayRecurringTemplateOverrides({ ...parent, recurring_template_overrides: null }, COLS).primary_line_price)
      .toBe('25.00');
    expect(overlayRecurringTemplateOverrides({ ...parent, recurring_template_overrides: 'oops{' }, COLS).primary_line_price)
      .toBe('25.00');
  });

  it('is the identity while the gate is off (kill switch restores copy-the-parent)', () => {
    let overlayOff;
    jest.isolateModules(() => {
      delete process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE;
       
      overlayOff = require('../routes/admin-schedule')._test.overlayRecurringTemplateOverrides;
    });
    process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';
    expect(overlayOff(parent, COLS)).toBe(parent);
  });
});

describe('stampRecurringTemplateOverrides', () => {
  function stampScenario({ existing }) {
    const updates = [];
    const conn = makeConn(({ table, calls, op, data }) => {
      if (op === 'first' && table === 'scheduled_services') {
        return { recurring_template_overrides: existing };
      }
      if (op === 'update') { updates.push(data); return 1; }
      return null;
    });
    return { conn, updates };
  }

  it('preserves future address defaults when a price edit clears price provenance', async () => {
    const address = { property_id: 'property-next', service_address_city: 'Test City', zone: null };
    const { conn, updates } = stampScenario({ existing: {
      appointment_address: address, anchored_split_per_visit: 25,
    } });
    await stampRecurringTemplateOverrides(conn, 'p1', { estimated_price: 30 }, COLS);
    expect(JSON.parse(updates[0].recurring_template_overrides)).toEqual({
      appointment_address: address, estimated_price: 30,
    });
  });

  it('merges new fields over existing overrides, allowlisted only', async () => {
    const { conn, updates } = stampScenario({ existing: { service_type: 'Pest Control Service' } });
    const stamped = await stampRecurringTemplateOverrides(conn, 'p1', {
      primary_line_price: 30, estimated_price: 30, status: 'cancelled',
    }, COLS);
    expect(stamped).toBe(true);
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].recurring_template_overrides)).toEqual({
      service_type: 'Pest Control Service', primary_line_price: 30, estimated_price: 30,
    });
  });

  it('skips the write when nothing would change, when no allowlisted fields were passed, or without the column', async () => {
    const same = stampScenario({ existing: { primary_line_price: 30 } });
    expect(await stampRecurringTemplateOverrides(same.conn, 'p1', { primary_line_price: 30 }, COLS)).toBe(false);
    expect(same.updates).toHaveLength(0);

    const none = stampScenario({ existing: null });
    expect(await stampRecurringTemplateOverrides(none.conn, 'p1', { status: 'cancelled' }, COLS)).toBe(false);
    expect(await stampRecurringTemplateOverrides(none.conn, 'p1', { primary_line_price: 30 }, {})).toBe(false);
  });
});

describe('propagatePriceServiceToFollowingSiblings', () => {
  function propagationScenario({ siblings, addonsByVisit = {}, invoicesByVisit = {} }) {
    const updates = [];
    const reminderUpdates = [];
    const targetQueries = [];
    const conn = makeConn(({ table, calls, op, data }) => {
      if (op === 'await' && table === 'scheduled_services') {
        targetQueries.push(calls);
        return siblings;
      }
      if (op === 'first' && table === 'invoices') {
        const whereCall = calls.find(([name, arg]) => name === 'where' && arg && arg.scheduled_service_id);
        return invoicesByVisit[whereCall?.[1]?.scheduled_service_id] || null;
      }
      if (op === 'await' && table === 'scheduled_service_addons') {
        const whereCall = calls.find(([name, arg]) => name === 'where' && arg && arg.scheduled_service_id);
        return addonsByVisit[whereCall?.[1]?.scheduled_service_id] || [];
      }
      if (op === 'update') {
        const whereCall = calls.find(([name, arg]) => name === 'where' && arg && (arg.id || arg.scheduled_service_id));
        if (table === 'appointment_reminders') {
          reminderUpdates.push({ id: whereCall?.[1]?.scheduled_service_id, data });
          return 1;
        }
        if (table !== 'scheduled_services') return 1;
        updates.push({ id: whereCall?.[1]?.id, data });
        return 1;
      }
      return null;
    });
    return { conn, updates, reminderUpdates, targetQueries };
  }

  it('re-derives each sibling price from its OWN add-on rows instead of copying the edited total', async () => {
    const siblings = [
      { id: 's1', primary_line_price: '25.00', estimated_price: '25.00', discount_type: null, discount_amount: null },
      { id: 's2', primary_line_price: '25.00', estimated_price: '55.00', discount_type: null, discount_amount: null },
    ];
    const { conn, updates } = propagationScenario({
      siblings,
      addonsByVisit: { s2: [{ estimated_price: '30.00' }] },
    });
    const ids = await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { primary_line_price: 50, estimated_price: 50 },
      serviceChanged: false, priceChanged: true, cols: COLS,
    });
    expect(ids).toEqual(['s1', 's2']);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u.data]));
    // No add-ons: new total = new primary.
    expect(byId.s1.primary_line_price).toBe(50);
    expect(byId.s1.estimated_price).toBe(50);
    // $30 add-on rides on top of the new $50 primary — NOT the edited row's
    // add-on-free $50 total.
    expect(byId.s2.estimated_price).toBe(80);
  });

  it('a service-only change updates identity fields and RE-DERIVES financials (service-scoped discounts key off the identity)', async () => {
    const siblings = [{
      id: 's1', primary_line_price: '25.00', estimated_price: '25.00',
      pre_service_brief_type: null,
    }];
    const { conn, updates } = propagationScenario({ siblings });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { service_type: 'Pest Control Service', service_id: 9 },
      serviceChanged: true, priceChanged: false, cols: COLS,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].data.service_type).toBe('Pest Control Service');
    expect(updates[0].data.service_id).toBe(9);
    expect(updates[0].data.appointment_type).toBeDefined();
    // Unscoped discount → the recompute reproduces the stored number.
    expect(updates[0].data.estimated_price).toBe(25);
  });

  it('never writes appointment_reminders — senders re-resolve labels LIVE from scheduled_services', async () => {
    // liveReminderServiceLabel (appointment-reminders.js) re-derives the
    // customer-facing label from the visit row at send time, merging
    // same-slot siblings; a direct stored-label write would corrupt the
    // owner/suppressed merged-slot labels the fallback path depends on.
    const siblings = [{
      id: 's1', primary_line_price: '25.00', estimated_price: '25.00',
      pre_service_brief_type: null,
    }];
    const { conn, reminderUpdates } = propagationScenario({ siblings });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { service_type: 'Pest Control Service', service_id: 9 },
      serviceChanged: true, priceChanged: false, cols: COLS,
    });
    expect(reminderUpdates).toHaveLength(0);
  });

  it('never writes a column the schema lacks', async () => {
    const siblings = [{ id: 's1', primary_line_price: '25.00', estimated_price: '25.00' }];
    const { conn, updates } = propagationScenario({ siblings });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { primary_line_price: 50, estimated_price: 50, line_discount_dollars: null },
      serviceChanged: false, priceChanged: true,
      cols: { estimated_price: {}, primary_line_price: {} },
    });
    expect(updates[0].data.line_discount_dollars).toBeUndefined();
    expect(updates[0].data.primary_line_price).toBe(50);
  });

  it('a parent-sourced edit covers the whole remaining plan — no date threshold to race the cadence rewrite', async () => {
    const siblings = [{ id: 's1', primary_line_price: '25.00', estimated_price: '25.00' }];
    const { conn, updates, targetQueries } = propagationScenario({ siblings });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'p1', parentId: 'p1', fromDateStr: null,
      fields: { primary_line_price: 50, estimated_price: 50 },
      serviceChanged: false, priceChanged: true, cols: COLS,
    });
    expect(updates).toHaveLength(1);
    const dateFilters = targetQueries[0].filter(([name, col]) => name === 'where' && col === 'scheduled_date');
    expect(dateFilters).toHaveLength(0);
    // Targets are row-locked up front so a concurrent invoice mint can't
    // mint from the old price after the reconcile probes ran.
    expect(targetQueries[0].some(([name]) => name === 'forUpdate')).toBe(true);
    // NOWAIT (Codex r6 P2 on #5253): a peer 'following' save's row maps to
    // VISIT_BUSY_RETRY instead of a raw deadlock abort.
    expect(targetQueries[0].some(([name]) => name === 'noWait')).toBe(true);
  });

  it('keeps an explicitly free series an explicit $0, never NULL', async () => {
    const siblings = [{ id: 's1', primary_line_price: '25.00', estimated_price: '25.00' }];
    const { conn, updates } = propagationScenario({ siblings });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      // The route normalizes the price handlers' NULL-for-zero to an
      // explicit 0 before calling — the helper must persist that zero.
      fields: { primary_line_price: 0, estimated_price: 0 },
      serviceChanged: false, priceChanged: true, cols: COLS,
    });
    expect(updates[0].data.estimated_price).toBe(0);
  });

  it('refuses to reprice a visit that already holds money (fail-closed, same contract as the plan trim)', async () => {
    const siblings = [
      { id: 's1', scheduled_date: '2098-02-15', primary_line_price: '25.00', estimated_price: '25.00', prepaid_amount: '25.00' },
    ];
    const { conn, updates } = propagationScenario({ siblings });
    await expect(propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { primary_line_price: 50, estimated_price: 50 },
      serviceChanged: false, priceChanged: true, cols: COLS,
    })).rejects.toMatchObject({ status: 409 });
    expect(updates).toHaveLength(0);
  });

  it('refuses while a target visit has ANY live invoice — nothing is voided, nothing is written (r7, owner decision)', async () => {
    const siblings = [
      { id: 's1', scheduled_date: '2098-02-15', primary_line_price: '25.00', estimated_price: '25.00' },
    ];
    const { conn, updates } = propagationScenario({
      siblings,
      invoicesByVisit: { s1: { id: 'inv1', status: 'draft', payer_statement_id: null } },
    });
    // Opt this scenario into the invoice link column so the live probe runs.
    conn.schema.hasColumn = async (table, col) => table === 'invoices' && col === 'scheduled_service_id';
    await expect(propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { primary_line_price: 50, estimated_price: 50 },
      serviceChanged: false, priceChanged: true, cols: COLS,
    })).rejects.toMatchObject({ status: 409 });
    expect(updates).toHaveLength(0);
  });

  it("the EDITED visit's own live invoice refuses too — excluded from the update loop, never from the billing guards (r8)", async () => {
    const siblings = [
      { id: 's1', scheduled_date: '2098-02-15', primary_line_price: '25.00', estimated_price: '25.00' },
    ];
    const { conn, updates } = propagationScenario({
      siblings,
      invoicesByVisit: { edited: { id: 'inv-edited', status: 'sent', payer_statement_id: null } },
    });
    conn.schema.hasColumn = async (table, col) => table === 'invoices' && col === 'scheduled_service_id';
    await expect(propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited',
      editedRow: { id: 'edited', scheduled_date: '2098-01-15', primary_line_price: '25.00', estimated_price: '25.00' },
      parentId: 'p1', fromDateStr: '2098-01-15',
      fields: { primary_line_price: 50, estimated_price: 50 },
      serviceChanged: false, priceChanged: true, cols: COLS,
    })).rejects.toMatchObject({ status: 409 });
    expect(updates).toHaveLength(0);
  });
});

describe('applyStoredVisitFinancials — scoped explicit-$0 carries to spawned rows', () => {
  const cols = { estimated_price: {} };

  it('a template override of estimated_price 0 keeps the extension row at an explicit 0', () => {
    const target = {};
    applyStoredVisitFinancials(target, cols, {
      primary_line_price: 0, estimated_price: 0,
      recurring_template_overrides: { primary_line_price: 0, estimated_price: 0 },
    }, [], []);
    expect(target.estimated_price).toBe(0);
  });

  it('the shared NULL-for-zero contract is untouched for parents WITHOUT overrides', () => {
    const target = {};
    applyStoredVisitFinancials(target, cols, { primary_line_price: 0, estimated_price: 0 }, [], []);
    expect(target.estimated_price).toBeUndefined();
  });
});

describe('pickUnpinnedGroupFields — per-GROUP pin decision', () => {
  const before = { service_type: 'Lawn Care Visit', service_id: 7, primary_line_price: '25.00', estimated_price: '25.00' };

  it('pins a changed group only while no key of that group is stamped yet', () => {
    const groups = {
      serviceChanged: false,
      priceChanged: true,
      fields: { primary_line_price: 30, estimated_price: 30 },
    };
    expect(pickUnpinnedGroupFields(null, groups, before))
      .toEqual({ primary_line_price: '25.00', estimated_price: '25.00' });
    // A price key already stamped means the price group is series-owned —
    // never overwrite it with a hybrid of old values.
    expect(pickUnpinnedGroupFields({ primary_line_price: 30 }, groups, before)).toEqual({});
  });

  it('an existing PRICE stamp must not stop a later SERVICE pin (and vice versa)', () => {
    const serviceGroups = {
      serviceChanged: true,
      priceChanged: false,
      fields: { service_type: 'Pest Control Service', service_id: 9 },
    };
    expect(pickUnpinnedGroupFields({ primary_line_price: 30, estimated_price: 30 }, serviceGroups, before))
      .toEqual({ service_type: 'Lawn Care Visit', service_id: 7 });
    const priceGroups = {
      serviceChanged: false,
      priceChanged: true,
      fields: { primary_line_price: 30, estimated_price: 30 },
    };
    expect(pickUnpinnedGroupFields({ service_type: 'Pest Control Service' }, priceGroups, before))
      .toEqual({ primary_line_price: '25.00', estimated_price: '25.00' });
  });
});

describe('source-pattern guards — wiring that unit tests cannot drive', () => {
  it('the gate exists and is fail-closed in every environment', () => {
    expect(gatesSrc).toMatch(/editApptPriceServiceScope: process\.env\.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE === 'true'/);
  });

  it("the service-line sheet's gate is its own strict opt-in", () => {
    expect(gatesSrc).toMatch(/serviceSheetPriceScope: process\.env\.GATE_SERVICE_SHEET_PRICE_SCOPE === 'true'/);
  });

  it('update-details refuses a posted scope while the gate is off (never silently per-visit)', () => {
    expect(src).toMatch(/priceServiceScope !== undefined && !isEnabled\('editApptPriceServiceScope'\)/);
  });

  it('every extension writer overlays the template overrides over the parent row', () => {
    // Auto-extend, visit-count top-up, and alert actions all overlay their
    // parent before copying fields into new appointments.
    const overlays = src.match(/parent = overlayRecurringTemplateOverrides\(parent, cols\);/g) || [];
    expect(overlays.length).toBeGreaterThanOrEqual(3);
  });

  it('series-summary reports the gate so the modal can render the selector dark-safely', () => {
    expect(src).toMatch(/canScopePriceService: isEnabled\('editApptPriceServiceScope'\)/);
  });

  it('make-this-recurring clears stale overrides so a re-anchored series follows its fresh values', () => {
    expect(src).toMatch(/spawnScopeCols\.recurring_template_overrides && parent\.recurring_template_overrides/);
  });

  it('every template writer serializes on the per-parent recurring-series maintenance lock', () => {
    expect(src).toMatch(/\|\| wantsPriceServiceScope\n/);
    // The gate-enabled NO-scope path (legacy coherence refresh + conversion
    // stamp) joins the same lock decision.
    expect(src).toMatch(/&& Object\.keys\(updates\)\.some\(\(key\) => PRICE_SERVICE_OVERRIDE_KEYS\.has\(key\)\)\);\s*\n\s*if \(wantsExistingPlanMutation && commsPeek\)/);
  });

  it('re-service conversions honor a posted scope instead of silently ignoring it', () => {
    expect(src).toMatch(/const conversionScopedThisOnly = wantsPriceServiceScope/);
    expect(src).toMatch(/isTemplateEdit && !conversionScopedThisOnly/);
    expect(src).toMatch(/Converting to a re-service can't be applied to following visits from a mid-series appointment/);
  });

  it("a booster can never be a 'following' propagation source", () => {
    expect(src).toMatch(/!priceServiceBeforeRow\.is_recurring && priceServiceBeforeRow\.recurring_parent_id/);
    expect(src).toMatch(/Booster visits keep their own pricing/);
  });

  it("a this_only template re-service conversion pins the pre-edit template", () => {
    expect(src).toMatch(/conversionScopedThisOnly && isTemplateEdit && priceServiceBeforeRow/);
    expect(src).toMatch(/const conversionPin = pickUnpinnedGroupFields\(/);
  });

  it("a child edit anchors 'following' on the LOCKED pre-edit date, never the date the same save moves it to", () => {
    expect(src).toMatch(/: \(dateOnly\(priceServiceBeforeRow\.scheduled_date\) \|\| etDateString\(\)\),/);
  });

  it('invoice reconciliation and the financial re-derive run for a service change too', () => {
    expect(src).toMatch(/const billingRelevant = priceChanged \|\| serviceChanged;/);
  });

  it('a this_only free conversion refuses when the template carries priced add-ons (no add-on override mechanism)', () => {
    expect(src).toMatch(/conversionScopedThisOnly && isTemplateEdit && reServiceConversionZeroPrice/);
    expect(src).toMatch(/would also zero this template visit's add-on lines/);
  });

  it('the no-scope coherence refresh is VALUE-gated against the locked before-image, never presence-gated', () => {
    expect(src).toMatch(/const legacyGroups = computePriceServiceGroupChanges\(priceServiceBeforeRow, updates\);/);
    expect(src).toMatch(/if \(legacyGroups\.changed\) \{/);
  });

  it('a series-wide conversion stamps its values into existing template overrides', () => {
    expect(src).toMatch(/stampRecurringTemplateOverrides\(trx, req\.params\.id, conversionGroups\.fields, seriesCols\)/);
  });

  it('sibling add-on reads fail closed — only the missing-table compat case proceeds add-on-less', () => {
    expect(src).toMatch(/const addonTableExists = billingRelevant && targets\.length > 0/);
  });

  it('the propagation lane NEVER voids an invoice — any live invoice on a target visit refuses (r7, owner decision)', () => {
    // Only NON-terminal statuses count as live; the refusal replaces the
    // whole void/re-mint machinery (and its race family) in this lane.
    expect(src).toMatch(/\.whereNotIn\('status', \['void', 'refunded', 'canceled', 'cancelled'\]\)\s*\n\s*\.first\('id', 'status', 'payer_statement_id'\)/);
    expect(src).toMatch(/already has an invoice\. Settle or void that invoice first/);
    // Statement-accrued lines still name the payer flow as the remedy.
    expect(src).toMatch(/already accrued to a payer statement\. Handle that statement first/);
    // The propagation helper carries no void call at all — the conversion
    // path's own voiding (pre-existing, `trx`-named) is out of this lane.
    expect(src).not.toMatch(/voidConversionInvoicesRestoringCredits\(\{ trx: conn/);
  });

  it('the edited visit joins the billing guards while staying out of the sibling update loop (r8)', () => {
    expect(src).toMatch(/const guardRows = \(editedRow \? \[editedRow, \.\.\.targets\] : targets\)\.map\(withProposed\);/);
    expect(src).toMatch(/editedRow: priceServiceBeforeRow \? \{\n\s+\.\.\.priceServiceBeforeRow,\n\s+_proposed: saveCoverageProposed\(\),/);
  });

  it('the list payload carries recurring_parent_id so a list-opened modal can tell a child from the template (r8)', () => {
    expect(src).toMatch(/recurringParentId: s\.recurring_parent_id \|\| null,/);
  });

  it('only a genuine TRANSITION into re-service stands the scope block down — an echoed existing re-service repricing propagates (r9)', () => {
    // The transition flag compares the incoming re-service against the row's
    // stored is_callback (unknown column ⇒ conservative transition=true).
    expect(src).toMatch(/reServiceTransition = !cols\.is_callback \|\| !existingRow\?\.is_callback;/);
    // The generic scope block excludes TRANSITIONS only, and the conversion
    // block's mid-series 'following' refusal fires on transitions only —
    // a price-only reprice of a re-service series child reaches the generic
    // propagation instead of a conversion refusal.
    expect(src).toMatch(/wantsPriceServiceScope && !reServiceTransition && priceServiceBeforeRow/);
    expect(src).toMatch(/wantsPriceServiceScope && reServiceTransition && self\?\.recurring_parent_id/);
  });
});

describe('this_only edits on an anchored-split parent keep the seeder marker as the renewal authority', () => {
  const raw = { anchored_split_per_visit: 88.33 };
  const before = {
    id: 'p1', is_recurring: true, recurring_parent_id: null,
    estimated_price: '88.34', primary_line_price: null, service_type: 'Pest Control',
    recurring_template_overrides: raw,
  };

  it('pickUnpinnedGroupFields treats the marker as an existing PRICE pin — the pre-edit remainder is never pinned', () => {
    const groups = computePriceServiceGroupChanges(before, { primary_line_price: 187, estimated_price: 187 });
    expect(groups.priceChanged).toBe(true);
    expect(pickUnpinnedGroupFields(parseTemplateOverrides(before.recurring_template_overrides), groups, before, readProvenanceOverrides(before.recurring_template_overrides)))
      .toEqual({});
    // A this_only DISCOUNT on the anchored parent still pins the pre-edit
    // discount fields (one-visit discount stays one-visit) — only the two
    // price-authority keys are held back so the marker survives the stamp.
    const discountGroups = computePriceServiceGroupChanges(before, { estimated_price: 79.5, discount_type: 'percentage', discount_amount: 10 });
    const discountPin = pickUnpinnedGroupFields(null, discountGroups, before, readProvenanceOverrides(raw));
    expect(discountPin).toEqual({ discount_type: null, discount_amount: null });
    expect(discountPin).not.toHaveProperty('estimated_price');
    // Without the marker the pre-edit price IS pinned (unchanged behaviour).
    expect(pickUnpinnedGroupFields(null, groups, before, readProvenanceOverrides(null)))
      .toEqual({ primary_line_price: null, estimated_price: '88.34' });
  });

  it('a service change on the same save still pins the service group; the marker survives that stamp', async () => {
    const groups = computePriceServiceGroupChanges(before, { service_id: 'svc-2', service_type: 'Pest Control Service', primary_line_price: 187 });
    const pinned = pickUnpinnedGroupFields(null, groups, before, readProvenanceOverrides(raw));
    expect(Object.keys(pinned).sort()).toEqual(['service_id', 'service_type']);
    let written = null;
    const conn = () => ({
      where: () => ({
        first: async () => ({ recurring_template_overrides: raw }),
        update: async (u) => { written = JSON.parse(u.recurring_template_overrides); return 1; },
      }),
    });
    expect(await stampRecurringTemplateOverrides(conn, 'p1', pinned, { recurring_template_overrides: {} })).toBe(true);
    expect(written.anchored_split_per_visit).toBe(88.33);
    expect(written.estimated_price).toBeUndefined();
  });

  it('REGRESSION edit → extension: a this_only reprice of the first visit leaves the marker, and the next extension templates at the per-visit amount in both price columns', async () => {
    const groups = computePriceServiceGroupChanges(before, { primary_line_price: 187, estimated_price: 187 });
    const pinned = pickUnpinnedGroupFields(parseTemplateOverrides(raw), groups, before, readProvenanceOverrides(raw));
    expect(pinned).toEqual({}); // nothing stamped ⇒ marker intact
    const afterEdit = { ...before, estimated_price: '187.00', primary_line_price: '187.00', line_discount_dollars: 0 };
    const template = await resolveSeriesExtensionPriceTemplate(null, 'p1', afterEdit);
    expect(template.estimated_price).toBe(88.33);
    expect(template.primary_line_price).toBeNull();
    expect(template.line_discount_dollars).toBeNull();
    const data = {};
    applyStoredVisitFinancials(data, { estimated_price: {} }, template, [], []);
    expect(data.estimated_price).toBe(88.33);
    // An "apply to following" price edit still wins: it stamps estimated_price and drops the marker.
    let written = null;
    const conn = () => ({
      where: () => ({
        first: async () => ({ recurring_template_overrides: raw }),
        update: async (u) => { written = JSON.parse(u.recurring_template_overrides); return 1; },
      }),
    });
    await stampRecurringTemplateOverrides(conn, 'p1', { primary_line_price: 95, estimated_price: 95 }, { recurring_template_overrides: {} });
    expect(written).toEqual({ primary_line_price: 95, estimated_price: 95 });
    const following = { ...afterEdit, recurring_template_overrides: written };
    expect(await resolveSeriesExtensionPriceTemplate(null, 'p1', following)).toBe(following);
  });

  it('a this_only discount pin on an anchored parent keeps the marker and the renewal template carries NO discount', async () => {
    const discountGroups = computePriceServiceGroupChanges(before, { estimated_price: 79.5, discount_type: 'percentage', discount_amount: 10 });
    const pinned = pickUnpinnedGroupFields(null, discountGroups, before, readProvenanceOverrides(raw));
    let written = null;
    const conn = () => ({
      where: () => ({
        first: async () => ({ recurring_template_overrides: raw }),
        update: async (u) => { written = JSON.parse(u.recurring_template_overrides); return 1; },
      }),
    });
    expect(await stampRecurringTemplateOverrides(conn, 'p1', pinned, { recurring_template_overrides: {} })).toBe(true);
    expect(written).toEqual({ anchored_split_per_visit: 88.33, discount_type: null, discount_amount: null });
    const afterEdit = { ...before, estimated_price: '79.50', discount_type: 'percentage', discount_amount: 10, recurring_template_overrides: written };
    const overlaid = overlayRecurringTemplateOverrides(afterEdit, { recurring_template_overrides: {} });
    expect(overlaid.discount_type).toBeNull();
    const template = await resolveSeriesExtensionPriceTemplate(null, 'p1', overlaid);
    expect(template.estimated_price).toBe(88.33);
    const data = {};
    applyStoredVisitFinancials(data, { estimated_price: {} }, template, [], []);
    expect(data.estimated_price).toBe(88.33);
  });

  it('a this_only free re-service conversion (primary_line_price = 0) never copies the 0 onto renewals', async () => {
    const converted = { ...before, estimated_price: 0, primary_line_price: 0, line_discount_dollars: null };
    const template = await resolveSeriesExtensionPriceTemplate(null, 'p1', converted);
    expect(template.primary_line_price).toBeNull();
    expect(template.estimated_price).toBe(88.33);
    const data = {};
    applyStoredVisitFinancials(data, { estimated_price: {}, primary_line_price: {} }, template, [], []);
    expect(data.estimated_price).toBe(88.33);
    expect(data.primary_line_price).toBeUndefined();
  });

  it('a legacy no-scope parent reprice (mobile sheet) retires the marker with an explicit override — the series follows the new price', async () => {
    // The legacy refresh block fires for a marker-only template.
    expect(src).toMatch(/&& \(parseTemplateOverrides\(priceServiceBeforeRow\.recurring_template_overrides\)\n\s*\|\| Number\(readProvenanceOverrides\(priceServiceBeforeRow\.recurring_template_overrides\)\?\.anchored_split_per_visit\) > 0\)\) \{/);
    const legacyGroups = computePriceServiceGroupChanges(before, { primary_line_price: 120, estimated_price: 120 });
    let written = null;
    const conn = () => ({
      where: () => ({
        first: async () => ({ recurring_template_overrides: raw }),
        update: async (u) => { written = JSON.parse(u.recurring_template_overrides); return 1; },
      }),
    });
    await stampRecurringTemplateOverrides(conn, 'p1', legacyGroups.fields, { recurring_template_overrides: {} });
    expect(written).toEqual({ primary_line_price: 120, estimated_price: 120 });
    const repriced = { ...before, estimated_price: '120.00', primary_line_price: '120.00', recurring_template_overrides: written };
    const overlaid = overlayRecurringTemplateOverrides(repriced, { recurring_template_overrides: {} });
    expect(await resolveSeriesExtensionPriceTemplate(null, 'p1', overlaid)).toBe(overlaid);
    const data = {};
    applyStoredVisitFinancials(data, { estimated_price: {} }, overlaid, [], []);
    expect(data.estimated_price).toBe(120);
  });

  it('both this_only pin sites (price edit + re-service conversion) pass the provenance to the pin decision', () => {
    const calls = src.match(/pickUnpinnedGroupFields\(\n\s*parseTemplateOverrides\(priceServiceBeforeRow\.recurring_template_overrides\),\n\s*\w+,\n\s*priceServiceBeforeRow,\n\s*readProvenanceOverrides\(priceServiceBeforeRow\.recurring_template_overrides\),\n\s*\);/g) || [];
    expect(calls.length).toBe(2);
    expect(src).not.toMatch(/priceServiceBeforeRow,\n\s*\);\n\s*if \(Object\.keys\((?:pinned|conversionPin)\)/);
  });

  it('REGRESSION add-ons: the marker is the visit TOTAL — a structured parent with a recurring add-on extends at the marker, never marker + add-on', async () => {
    const parent = {
      id: 'p1', estimated_price: '150.00', primary_line_price: '150.00', line_discount_dollars: 0,
      recurring_template_overrides: { anchored_split_per_visit: 100 },
    };
    const addon = { estimated_price: 20 };
    const template = await resolveSeriesExtensionPriceTemplate(null, 'p1', parent);
    const data = {};
    applyStoredVisitFinancials(data, { estimated_price: {} }, template, [addon], [addon]);
    expect(data.estimated_price).toBe(100);
    // Same arithmetic as an unstructured anchored parent.
    const plain = await resolveSeriesExtensionPriceTemplate(null, 'p1', { ...parent, primary_line_price: null });
    const plainData = {};
    applyStoredVisitFinancials(plainData, { estimated_price: {} }, plain, [addon], [addon]);
    expect(plainData.estimated_price).toBe(100);
    // An add-on not due on this visit drops out of the total.
    const skipped = {};
    applyStoredVisitFinancials(skipped, { estimated_price: {} }, template, [], [addon]);
    expect(skipped.estimated_price).toBe(80);
  });
});

// The service-line sheet (MobileServiceEditModal) offers the same scope only
// when series-summary says both gates are on: update-details refuses a posted
// priceServiceScope while GATE_EDIT_APPT_PRICE_SERVICE_SCOPE is off, so the
// sheet's own gate alone must never open it.
describe('GET /:id/series-summary — canScopeSheetPrice', () => {
  const FG = require('../config/feature-gates');
  const db = require('../models/db');
  const ROWS = {
    'one-off': { id: 'one-off', is_recurring: false, recurring_parent_id: null },
    p1: { id: 'p1', is_recurring: true, recurring_parent_id: null, recurring_pattern: 'quarterly', recurring_ongoing: true, scheduled_date: '2098-01-15' },
    c1: { id: 'c1', is_recurring: true, recurring_parent_id: 'p1' },
  };
  const saved = {};
  beforeEach(() => {
    saved.scope = FG.gates.editApptPriceServiceScope;
    saved.sheet = FG.gates.serviceSheetPriceScope;
    db.connection = makeConn(({ table, calls, op }) => {
      if (table !== 'scheduled_services') return null;
      if (op === 'columnInfo') return { recurring_ongoing: {} };
      if (op === 'first') {
        const id = calls.find(([name, arg]) => name === 'where' && arg && arg.id)?.[1]?.id;
        return ROWS[id] || null;
      }
      return []; // liveUpcomingSeriesVisits
    });
  });
  afterEach(() => {
    FG.gates.editApptPriceServiceScope = saved.scope;
    FG.gates.serviceSheetPriceScope = saved.sheet;
    db.connection = undefined;
  });

  const layer = adminScheduleRouter.stack.find((l) => l.route?.path === '/:id/series-summary' && l.route.methods.get);
  async function seriesSummary(id) {
    let payload = null;
    let nextErr = null;
    const res = { status() { return this; }, json(p) { payload = p; return this; } };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, headers: {} }, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
    return payload;
  }

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])('Edit appointment gate %s, sheet gate %s: canScopeSheetPrice is %s on a parent and a child', async (scopeGate, sheetGate, expected) => {
    FG.gates.editApptPriceServiceScope = scopeGate;
    FG.gates.serviceSheetPriceScope = sheetGate;
    for (const id of ['p1', 'c1']) {
      const body = await seriesSummary(id);
      expect(body).toMatchObject({ series: true, parentId: 'p1', isParent: id === 'p1' });
      expect(body.canScopeSheetPrice).toBe(expected);
      // Edit appointment's own answer is untouched by the sheet's gate.
      expect(body.canScopePriceService).toBe(scopeGate);
    }
  });

  it('a one-off answers series:false and nothing else, whatever the gates', async () => {
    FG.gates.editApptPriceServiceScope = true;
    FG.gates.serviceSheetPriceScope = true;
    expect(await seriesSummary('one-off')).toEqual({ series: false });
  });
});

// The sheet's EXACT save body (MobileServiceEditModal handleSave, key for key)
// through the real PUT /:id/update-details against migrated PostgreSQL. Each
// test runs in a transaction that is rolled back. Series: parent (visit 1) →
// child 1 → booster → child 2 → child 3, every base visit at $129.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres("PUT /:id/update-details — the service-line sheet's save body on a series (migrated PostgreSQL)", () => {
  const { randomUUID } = require('node:crypto');
  const FG = require('../config/feature-gates');
  const DATES = { parent: '2040-03-05', c1: '2040-06-04', booster: '2040-07-09', c2: '2040-09-03', c3: '2040-12-03' };
  let database;
  let trx;
  let rows;
  let sheetGateBefore;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    sheetGateBefore = FG.gates.serviceSheetPriceScope;
    trx = await database.transaction();
    require('../models/db').connection = trx;
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer',
    });
    const visit = async (overrides) => {
      const [row] = await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
        service_key_snapshot: 'pest_general_quarterly', status: 'pending',
        window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 30,
        estimated_price: 129, primary_line_price: 129,
        is_recurring: true, recurring_pattern: 'quarterly',
        ...overrides,
      }).returning('*');
      return row;
    };
    const parent = await visit({ scheduled_date: DATES.parent, status: 'confirmed' });
    const of = { recurring_parent_id: parent.id };
    rows = {
      parent,
      c1: await visit({ ...of, scheduled_date: DATES.c1 }),
      booster: await visit({ ...of, scheduled_date: DATES.booster, is_recurring: false, estimated_price: 49, primary_line_price: 49 }),
      c2: await visit({ ...of, scheduled_date: DATES.c2 }),
      c3: await visit({ ...of, scheduled_date: DATES.c3 }),
    };
  });

  afterEach(async () => {
    FG.gates.serviceSheetPriceScope = sheetGateBefore;
    require('../models/db').connection = undefined;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  // What the sheet posts for a visit read off the day feed (window bounds are
  // the raw TIME strings that feed carries), with the scope only when the
  // "Apply price change to" choice was on screen.
  function sheetBody(key, { price, scope }) {
    const row = rows[key];
    return {
      scheduledDate: DATES[key],
      windowStart: row.window_start,
      windowEnd: row.window_end,
      autoDispatchLocked: false,
      autoDispatchLockedWas: false,
      estimatedDuration: row.estimated_duration_minutes,
      technicianId: null,
      notes: '',
      estimatedPrice: price,
      price: String(price),
      ...(scope === undefined ? {} : { priceServiceScope: scope }),
    };
  }
  const layer = adminScheduleRouter.stack.find((l) => l.route?.path === '/:id/update-details' && l.route.methods.put);
  async function saveFromSheet(key, opts) {
    let statusCode = 200;
    let payload = null;
    let nextErr = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    await layer.route.stack[layer.route.stack.length - 1].handle(
      { params: { id: rows[key].id }, query: {}, body: sheetBody(key, opts), headers: {} }, res, (err) => { nextErr = err; },
    );
    if (nextErr) throw nextErr;
    expect(statusCode).toBe(200);
    return payload;
  }
  async function prices() {
    const out = {};
    for (const [key, row] of Object.entries(rows)) {
      const now = await trx('scheduled_services').where({ id: row.id }).first('estimated_price', 'primary_line_price');
      out[key] = [Number(now.estimated_price), Number(now.primary_line_price)];
    }
    return out;
  }
  const template = async () => (await trx('scheduled_services').where({ id: rows.parent.id }).first('recurring_template_overrides')).recurring_template_overrides;
  // What a visit the plan adds later copies: the parent with its overrides.
  const nextVisitPrice = async () => {
    const parentNow = await trx('scheduled_services').where({ id: rows.parent.id }).first();
    return Number(overlayRecurringTemplateOverrides(parentNow, { recurring_template_overrides: {} }).estimated_price);
  };

  it("visit 1, 'following': every upcoming base visit and the series template take the new price; the booster keeps its own", async () => {
    const result = await saveFromSheet('parent', { price: 199, scope: 'following' });
    expect(result.priceServiceScope).toEqual({ scope: 'following', updatedVisits: 3 });
    expect(await prices()).toEqual({
      parent: [199, 199], c1: [199, 199], booster: [49, 49], c2: [199, 199], c3: [199, 199],
    });
    expect(await template()).toMatchObject({ estimated_price: 199, primary_line_price: 199 });
    expect(await nextVisitPrice()).toBe(199);
  });

  it("visit 1, 'this_only': only visit 1 changes, and the template is pinned at the old price so later visits keep it", async () => {
    const result = await saveFromSheet('parent', { price: 199, scope: 'this_only' });
    expect(result).not.toHaveProperty('priceServiceScope');
    expect(await prices()).toEqual({
      parent: [199, 199], c1: [129, 129], booster: [49, 49], c2: [129, 129], c3: [129, 129],
    });
    const pin = await template();
    expect(Number(pin.estimated_price)).toBe(129);
    expect(Number(pin.primary_line_price)).toBe(129);
    expect(await nextVisitPrice()).toBe(129);
  });

  it("a later visit, 'following': that visit and the ones after it change, earlier visits do not, and the template follows", async () => {
    const result = await saveFromSheet('c1', { price: 199, scope: 'following' });
    expect(result.priceServiceScope).toEqual({ scope: 'following', updatedVisits: 2 });
    expect(await prices()).toEqual({
      parent: [129, 129], c1: [199, 199], booster: [49, 49], c2: [199, 199], c3: [199, 199],
    });
    expect(await template()).toMatchObject({ estimated_price: 199, primary_line_price: 199 });
    expect(await nextVisitPrice()).toBe(199);
  });

  it("a later visit, 'this_only': only that visit changes and the template is not written", async () => {
    const result = await saveFromSheet('c1', { price: 199, scope: 'this_only' });
    expect(result).not.toHaveProperty('priceServiceScope');
    expect(await prices()).toEqual({
      parent: [129, 129], c1: [199, 199], booster: [49, 49], c2: [129, 129], c3: [129, 129],
    });
    expect(await template()).toBeNull();
    expect(await nextVisitPrice()).toBe(129);
  });

  // Gate off, the sheet posts no scope: update-details must do exactly what it
  // did before this lane, whichever way the sheet's gate is set (it reads only
  // GATE_EDIT_APPT_PRICE_SERVICE_SCOPE, on here as in production).
  it.each([[false], [true]])('no scope posted (sheet gate %s): the legacy unscoped save is unchanged', async (sheetGate) => {
    FG.gates.serviceSheetPriceScope = sheetGate;
    // Unpinned template: visit 1's own row is what later visits copy, so its
    // new price becomes the series price (bug 4); the other visits stay.
    const result = await saveFromSheet('parent', { price: 199 });
    expect(result).not.toHaveProperty('priceServiceScope');
    expect(await prices()).toEqual({
      parent: [199, 199], c1: [129, 129], booster: [49, 49], c2: [129, 129], c3: [129, 129],
    });
    expect(await template()).toBeNull();
    expect(await nextVisitPrice()).toBe(199);

    // Already-pinned template: the legacy refresh stamps the new price.
    await trx('scheduled_services').where({ id: rows.parent.id })
      .update({ recurring_template_overrides: JSON.stringify({ estimated_price: 129, primary_line_price: 129 }) });
    await saveFromSheet('parent', { price: 175 });
    expect(await template()).toMatchObject({ estimated_price: 175, primary_line_price: 175 });
    expect((await prices()).c1).toEqual([129, 129]);
  });
});
