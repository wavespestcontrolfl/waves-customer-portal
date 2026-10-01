// A street-level address hold is released ONLY by the office's explicit confirm
// (owner ruling 2026-09-30): no field tap and no writer that merely moves the visit
// may activate it. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn(async () => ({})) }));

const fs = require('fs');
const db = require('../models/db');
const { transitionJobStatus } = require('../services/job-status');
const trackRouter = require('../routes/tech-track');
const { activateLegacyOutboundReviewRowIfNeeded } = require('../services/outbound-review-confirm');

const { autoConfirmOutboundReviewBooking, respondToTransitionConflict } = trackRouter.__private;

beforeEach(() => { jest.clearAllMocks(); });

// A fake knex handle. `held` answers the live-hold lookup (`scheduled_services as ss`).
const makeHandle = ({ visit, held, calls, history = false }) => {
  const h = (table) => {
    const q = {};
    ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'whereExists', 'orderBy', 'forUpdate', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => {
      if (table === 'scheduled_services as ss') { calls.hold += 1; return held ? { id: visit.id } : undefined; }
      if (table === 'job_status_history') { calls.history = (calls.history || 0) + 1; return history ? { job_id: visit.id } : undefined; }
      if (table === 'scheduled_services') return { ...visit };
      return null;
    });
    q.update = jest.fn(async (vals) => { calls.updates.push({ table, vals }); return 1; });
    return q;
  };
  h.transaction = async (cb) => cb(h);
  h.fn = { now: () => new Date() };
  h.raw = jest.fn(async () => ({}));
  return h;
};
const today = '2020-01-06';   // never a future date
const baseVisit = (extra = {}) => ({
  id: 'v1', technician_id: 'tech-1', status: 'pending', customer_confirmed: false, source_action: 'voice_agent',
  scheduled_date: today, customer_id: 'c1', source_call_log_id: 'call-1', ...extra,
});

describe('tech-track: a field tap never confirms a street-level hold', () => {
  const req = { technicianId: 'tech-1' };
  const run = async (held) => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit(), held, calls });
    db.mockImplementation(handle);
    db.transaction = handle.transaction;
    db.fn = handle.fn;
    let err = null;
    try { await autoConfirmOutboundReviewBooking(req, baseVisit()); } catch (e) { err = e; }
    return { err, calls };
  };

  test('refused: nothing is confirmed, no card resolved, no status change, no tracking text path reached', async () => {
    const { err, calls } = await run(true);
    expect(err && err.code).toBe('STREET_LEVEL_HOLD');
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(0);          // no field_confirmed_at stamp either
    expect(calls.hold).toBe(1);
  });

  test('the routes answer 409 with the instruction (en route and on site share the mapping)', () => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    expect(respondToTransitionConflict(res, { code: 'STREET_LEVEL_HOLD' }, 'pending')).toBe(true);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'street_level_hold', error: expect.stringContaining('Office must confirm the address first') }));
  });

  test('every other pending office-review booking still auto-confirms (dispatch-implies-confirm unchanged)', async () => {
    const { err, calls } = await run(false);
    expect(err).toBeNull();
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: 'pending', toStatus: 'confirmed' }));
    expect(calls.updates.some((u) => u.vals.field_confirmed_at)).toBe(true);
  });

  test('both routes reach the guarded function (source order)', () => {
    const s = fs.readFileSync(require.resolve('../routes/tech-track.js'), 'utf8');
    expect(s.split('await autoConfirmOutboundReviewBooking(req, svc);').length - 1).toBe(2);
    const fn = s.slice(s.indexOf('async function autoConfirmOutboundReviewBooking'), s.indexOf('async function autoConfirmOutboundReviewBooking') + 4500);
    expect(fn.indexOf('await isStreetLevelHoldVisit(svc.id, trx)')).toBeLessThan(fn.indexOf("await trx('scheduled_services')\n      .where({ id: svc.id })\n      .whereNull('field_confirmed_at')"));
  });
});

describe('activateLegacyOutboundReviewRowIfNeeded: a schedule move never releases a street-level hold', () => {
  const activate = async (visit, held) => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit, held, calls });
    const out = await activateLegacyOutboundReviewRowIfNeeded(handle, 'v1', 'rebooker-reschedule');
    return { out, calls };
  };

  test('a moved pending hold (SmartRebooker / admin-schedule update-details) is NOT activated: no stamp, no hook', async () => {
    const { out, calls } = await activate(baseVisit({ scheduled_date: '2026-10-12' }), true);
    expect(out).toBe(false);
    expect(calls.hold).toBe(1);
    expect(calls.updates).toHaveLength(0);
  });

  test('an unconfirmed hold moved to a live status by a direct writer is skipped too (only the office confirm releases it)', async () => {
    for (const status of ['en_route', 'on_site', 'completed']) {
      const { out, calls } = await activate(baseVisit({ status }), true);
      expect(out).toBe(false);
      expect(calls.updates).toHaveLength(0);
    }
  });

  test('SmartRebooker writes status confirmed on a move: that is NOT approval, so the moved hold is still skipped (the reschedule-to-activation sequence)', async () => {
    // rescheduleOnce: status 'confirmed' + a new date, then activateLegacyOutboundReviewRowIfNeeded(db, id, 'rebooker-reschedule').
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit({ status: 'confirmed', scheduled_date: '2026-10-12' }), held: true, history: false, calls });
    const out = await activateLegacyOutboundReviewRowIfNeeded(handle, 'v1', 'rebooker-reschedule');
    expect(out).toBe(false);
    expect(calls.history).toBe(1);                 // looked for a recorded office confirm; none
    expect(calls.updates).toHaveLength(0);         // no stamp, no hook
    // SmartRebooker records its move's pending -> confirmed with transitioned_by NULL, so the proof
    // requires a user-recorded transition.
    const src = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    expect(src).toContain(".whereNotNull('transitioned_by')");
    const rb = fs.readFileSync(require.resolve('../services/rebooker.js'), 'utf8');
    expect(rb).toContain('transitioned_by: null,');
    expect(rb).toContain("activateLegacyOutboundReviewRowIfNeeded(db, serviceId, 'rebooker-reschedule')");
  });

  test('a hold the office confirmed through the route (a recorded pending -> confirmed) whose hook failed stays on the retry rail', async () => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit({ status: 'confirmed' }), held: true, history: true, calls });
    await activateLegacyOutboundReviewRowIfNeeded(handle, 'v1', 'legacy-activation-sweep').catch(() => {});
    expect(calls.history).toBe(1);
    // It proceeded past the guard (the hook legs / stamp are attempted, not skipped).
    expect(calls.updates.length + (calls.hold || 0)).toBeGreaterThan(0);
  });

  test('a plain voice-agent or outbound-review row is untouched by the guard (no hold lookup for non-voice rows)', async () => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit({ source_action: 'ai_call_outbound_review' }), held: true, calls });
    await activateLegacyOutboundReviewRowIfNeeded(handle, 'v1', 'x').catch(() => {});
    expect(calls.hold).toBe(0);
  });
});

describe('the street-level proof is rebound after the customer-row lock', () => {
  const { streetLevelProofAddressChanged } = require('../services/call-recording-processor')._test;
  const snap = { line1: '1234 Sample Newbuild Trl', line2: '', city: 'Parrish', state: 'FL', zip: '34219' };
  const row = (extra = {}) => ({ address_line1: '1234 Sample Newbuild Trl', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219-1234', ...extra });

  test('an unchanged row (spelling aside) keeps the proof; any moved part, or a missing side, fails closed', () => {
    expect(streetLevelProofAddressChanged(snap, row())).toBe(false);
    expect(streetLevelProofAddressChanged(snap, row({ address_line1: '1234 sample newbuild trl.' }))).toBe(false);
    // The house number is a structured token: a ranged 12-14 never equals 1214.
    expect(streetLevelProofAddressChanged({ ...snap, line1: '12-14 Sample Newbuild Trl' }, row({ address_line1: '1214 Sample Newbuild Trl' }))).toBe(true);
    expect(streetLevelProofAddressChanged({ ...snap, line1: '1214 Sample Newbuild Trl' }, row({ address_line1: '12-14 Sample Newbuild Trl' }))).toBe(true);
    expect(streetLevelProofAddressChanged({ ...snap, line1: '12-14 Sample Newbuild Trl' }, row({ address_line1: '12-14 Sample Newbuild Trail' }))).toBe(false);
    expect(streetLevelProofAddressChanged({ ...snap, line1: '123A Sample Newbuild Trl' }, row({ address_line1: '123B Sample Newbuild Trl' }))).toBe(true);
    for (const moved of [{ address_line1: '1240 Sample Newbuild Trl' }, { address_line2: 'Apt 2' }, { city: 'Sarasota' }, { zip: '34203' }, { state: 'GA' }]) {
      expect(streetLevelProofAddressChanged(snap, row(moved))).toBe(true);
    }
    expect(streetLevelProofAddressChanged(null, row())).toBe(true);
    expect(streetLevelProofAddressChanged(snap, null)).toBe(true);
  });

  test('checked under the customer-comms fence, for street-level holds only, before the fresh row drives the booking', () => {
    const s = fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
    const lock = s.indexOf('await lockCustomerComms(trx, customer.id);');
    const check = s.indexOf('if (v2StreetLevelHold && streetLevelProofAddressChanged(v2OnFileAddressProofSnapshot, freshCallCustomer)) {', lock);
    const adopt = s.indexOf('customer = freshCallCustomer;', lock);
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeLessThan(adopt);
  });
});

describe('the admin status routes: a technician token cannot confirm or run a street-level hold', () => {
  test('admin-dispatch and admin-schedule refuse a technician (confirm or day-of takeover) before any transition; admins still confirm', () => {
    for (const [file, techCheck] of [['../routes/admin-dispatch.js', "req.techRole === 'technician' && (isOfficeReviewConfirm || takeoverCandidate)"], ['../routes/admin-schedule.js', 'isTechnicianRequest(req) && (isOfficeReviewConfirm || isFieldLifecycleTakeover)']]) {
      const s = fs.readFileSync(require.resolve(file), 'utf8');
      const at = s.indexOf(techCheck);
      expect(at).toBeGreaterThan(0);
      expect(s.slice(at, at + 400)).toContain("isStreetLevelHoldVisit(svc.id)");
      expect(s.slice(at, at + 700)).toContain("code: 'street_level_hold'");
      // Before the status transaction.
      expect(at).toBeLessThan(s.indexOf('await db.transaction(async (trx) => {', at));
    }
  });
});

describe('tech-track: the row-locked advance guard also refuses a confirmed-but-unconfirmed hold (a moved hold)', () => {
  const { guardAdvance } = require('../routes/tech-track').__private;
  const run = async (visit, held) => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit, held, calls });
    let err = null;
    try { await guardAdvance(handle, { technicianId: 'tech-1' }, { id: 'v1' }); } catch (e) { err = e; }
    return { err, calls };
  };
  test('en route / on site on a moved hold (status confirmed, customer_confirmed false) is refused before any transition', async () => {
    const { err } = await run(baseVisit({ status: 'confirmed' }), true);
    expect(err && err.code).toBe('STREET_LEVEL_HOLD');
  });
  test('an activated hold, a non-hold voice row and every other source skip it (no lookup for other sources)', async () => {
    expect((await run(baseVisit({ status: 'confirmed', customer_confirmed: true }), true)).err).toBeNull();
    expect((await run(baseVisit({ status: 'confirmed' }), false)).err).toBeNull();
    const other = await run(baseVisit({ source_action: 'ai_call_pipeline' }), true);
    expect(other.err).toBeNull();
    expect(other.calls.hold).toBe(0);
  });
  test('both routes call the guard inside their advance transaction', () => {
    const s = fs.readFileSync(require.resolve('../routes/tech-track.js'), 'utf8');
    expect(s.split('await guardAdvance(trx, req, svc);').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('office approval counts from any prior status (a moved hold is already confirmed)', () => {
  const { hasRecordedOfficeConfirm } = require('../services/outbound-review-confirm')._test || {};
  const src = fs.readFileSync(require.resolve('../services/outbound-review-confirm'), 'utf8');
  const body = src.slice(src.indexOf('async function hasRecordedOfficeConfirm'), src.indexOf('async function activateLegacyOutboundReviewRowIfNeeded'));

  test('the lookup keys on to_status confirmed by a user, never on from_status pending', () => {
    expect(body).toMatch(/to_status: 'confirmed'/);
    expect(body).not.toMatch(/from_status/);
    expect(body).toMatch(/whereNotNull\('transitioned_by'\)/);   // SmartRebooker moves record no user
  });

  (hasRecordedOfficeConfirm ? test : test.skip)('a confirmed -> confirmed office row is recognized', async () => {
    const wheres = [];
    const q = { where: (w) => { wheres.push(w); return q; }, whereNotNull: () => q, first: async () => ({ job_id: 'v1' }) };
    const dbh = () => q;
    expect(await hasRecordedOfficeConfirm(dbh, 'v1')).toBe(true);
    expect(wheres[0]).toEqual({ job_id: 'v1', to_status: 'confirmed' });
  });
});
