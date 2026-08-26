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

const fs = require('fs');
const path = require('path');

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  normalizePriceServiceScope,
  computePriceServiceGroupChanges,
  pickUnpinnedGroupFields,
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
      for (const m of ['where', 'orWhere', 'whereIn', 'whereNot', 'whereNotIn', 'orderBy', 'select', 'limit', 'forUpdate']) {
        b[m] = record(m);
      }
      b.first = (...args) => {
        calls.push(['first', ...args]);
        return Promise.resolve(handler({ table, calls, op: 'first' }));
      };
      b.pluck = (...args) => {
        calls.push(['pluck', ...args]);
        return Promise.resolve(handler({ table, calls, op: 'pluck' }) || []);
      };
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

  it('update-details refuses a posted scope while the gate is off (never silently per-visit)', () => {
    expect(src).toMatch(/priceServiceScope !== undefined && !isEnabled\('editApptPriceServiceScope'\)/);
  });

  it('every extension writer overlays the template overrides over the parent row', () => {
    // auto-extend, visit-count top-up, and the alert extend/convert loops all
    // reassign their parent through the overlay before copying fields.
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
});
