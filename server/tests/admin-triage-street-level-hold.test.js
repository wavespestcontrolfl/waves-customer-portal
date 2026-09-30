// A street-level address hold's outbound_booking_review card (owner ruling
// 2026-09-30) is settled by its visit, never by a generic call verdict or a
// single-card Resolve / Dismiss while the visit is still pending. On confirm,
// the promised follow-up (deferred at booking) is filed as the existing owed
// follow-up card. Synthetic data only.
const fs = require('fs');
const adminTriage = require('../routes/admin-triage');
const { fileOwedFollowUpForStreetLevelHold } = require('../services/outbound-review-confirm');

const { streetLevelHoldStillPending, STREET_LEVEL_HOLD_OPEN_SQL } = adminTriage.__private;

const card = (extra = {}) => ({
  reason_code: 'outbound_booking_review',
  payload: { origin: 'voice_agent', street_level_address: true, scheduled_service_id: 'visit-1' },
  ...extra,
});
const connWithVisit = (visit) => () => ({ where() { return this; }, first: async () => visit });

describe('streetLevelHoldStillPending', () => {
  test('true only while the linked visit is pending and unconfirmed', async () => {
    expect(await streetLevelHoldStillPending(connWithVisit({ status: 'pending', customer_confirmed: false }), card())).toBe(true);
    // confirmed, corrected-and-confirmed, cancelled, skipped or gone: the card may settle.
    expect(await streetLevelHoldStillPending(connWithVisit({ status: 'confirmed', customer_confirmed: true }), card())).toBe(false);
    expect(await streetLevelHoldStillPending(connWithVisit({ status: 'cancelled', customer_confirmed: false }), card())).toBe(false);
    expect(await streetLevelHoldStillPending(connWithVisit(undefined), card())).toBe(false);
  });

  test('the voice agent\'s own outbound_booking_review card (no street-level flag) is untouched', async () => {
    const plain = card({ payload: { origin: 'voice_agent', scheduled_service_id: 'visit-1' } });
    expect(await streetLevelHoldStillPending(connWithVisit({ status: 'pending', customer_confirmed: false }), plain)).toBe(false);
    expect(await streetLevelHoldStillPending(connWithVisit({ status: 'pending', customer_confirmed: false }), card({ reason_code: 'missing_service_address' }))).toBe(false);
  });

  test('a JSON-string payload is read too', async () => {
    expect(await streetLevelHoldStillPending(connWithVisit({ status: 'pending', customer_confirmed: false }), card({ payload: JSON.stringify(card().payload) }))).toBe(true);
  });
});

describe('the routes keep the hold out of generic verdicts and single-card actions', () => {
  const src = fs.readFileSync(require.resolve('../routes/admin-triage.js'), 'utf8');
  test('the bulk verdict resolve excludes a still-pending hold card (a sibling verdict never sweeps it)', () => {
    expect(STREET_LEVEL_HOLD_OPEN_SQL).toContain("payload->>'street_level_address' = 'true'");
    expect(STREET_LEVEL_HOLD_OPEN_SQL).toContain("hold_ss.status = 'pending' AND hold_ss.customer_confirmed = false");
    const bulk = src.indexOf('.whereRaw(`NOT ${STREET_LEVEL_HOLD_OPEN_SQL}`)');
    expect(bulk).toBeGreaterThan(src.indexOf('.whereRaw("payload->\'reschedule_proposal\' IS NULL")'));
    expect(src.indexOf('.update({', bulk)).toBeGreaterThan(bulk);
  });
  test('the clicked hold card is refused by the verdict route and by Resolve / Dismiss', () => {
    expect(src).toContain("if (await streetLevelHoldStillPending(db, item)) {\n      return res.status(409).json({ error: STREET_LEVEL_HOLD_MESSAGE, code: 'STREET_LEVEL_HOLD_PENDING' });");
    expect(src).toContain("if (await streetLevelHoldStillPending(conn, item)) {\n    throw Object.assign(new Error(STREET_LEVEL_HOLD_MESSAGE), { statusCode: 409, code: 'STREET_LEVEL_HOLD_PENDING' });");
  });
  test('transitionCore refuses a pending hold before touching the card', async () => {
    const conn = (table) => {
      const q = { where() { return q; }, first: async () => (table === 'triage_items' ? { id: 't1', status: 'open', ...card() } : { status: 'pending', customer_confirmed: false }) };
      return q;
    };
    await expect(adminTriage.transitionCore({ id: 't1', nextStatus: 'resolved', conn })).rejects.toMatchObject({ statusCode: 409, code: 'STREET_LEVEL_HOLD_PENDING' });
  });
});

describe('office confirm files the deferred follow-up as the owed follow-up card', () => {
  const svc = { id: 'visit-1', source_call_log_id: 'call-1' };
  const plan = { scheduled_date: '2026-10-19', window_start: '09:00' };
  const make = ({ payload, child = null, handled = null }) => {
    const inserts = [];
    const trx = (table) => {
      const q = {
        _t: table,
        where() { return q; }, whereIn() { return q; }, orderBy() { return q; },
        first: async () => {
          if (table === 'triage_items' && q._reason === 'outbound_booking_review') return { payload };
          if (table === 'scheduled_services') return child;
          return handled;
        },
        insert(row) { inserts.push({ table, row }); return q; },
        onConflict() { return q; }, merge: async () => [],
      };
      const w = q.where;
      q.where = (arg, ...rest) => { if (arg && arg.reason_code) q._reason = arg.reason_code; return w(arg, ...rest); };
      return q;
    };
    trx.raw = (s) => s;
    return { trx, inserts };
  };
  const heldPayload = (extra = {}) => ({ origin: 'voice_agent', street_level_address: true, scheduled_service_id: 'visit-1', follow_up_plan: plan, ...extra });

  test('a confirmed street-level hold with a promised follow-up files attached_booking_followup_unbooked carrying the plan', async () => {
    const { trx, inserts } = make({ payload: heldPayload() });
    expect(await fileOwedFollowUpForStreetLevelHold(trx, svc)).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.reason_code).toBe('attached_booking_followup_unbooked');
    expect(JSON.stringify(inserts[0].row.payload)).toContain('2026-10-19');
    expect(JSON.stringify(inserts[0].row.payload)).toContain('street_level_address_confirmed_follow_up_unbooked');
  });
  test('idempotent and scoped: nothing without a plan, for another visit, a plain voice card, an existing child, or a handled card', async () => {
    for (const opts of [
      { payload: heldPayload({ follow_up_plan: undefined }) },
      { payload: heldPayload({ scheduled_service_id: 'other' }) },
      { payload: heldPayload({ street_level_address: undefined }) },
      { payload: heldPayload(), child: { id: 'child-1' } },
      { payload: heldPayload(), handled: { id: 'done' } },
    ]) {
      const { trx, inserts } = make(opts);
      expect(await fileOwedFollowUpForStreetLevelHold(trx, svc)).toBe(false);
      expect(inserts).toHaveLength(0);
    }
  });
  test('the hook runs it inside the card-resolve transaction, before the review card is resolved', () => {
    const s = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    const file = s.indexOf('await fileOwedFollowUpForStreetLevelHold(trx, svc);');
    expect(file).toBeGreaterThan(0);
    expect(file).toBeLessThan(s.indexOf("status: 'resolved', updated_at: trx.fn.now()", file));
  });
});
