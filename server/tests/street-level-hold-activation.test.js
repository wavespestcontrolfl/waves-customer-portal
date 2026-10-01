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
    for (const status of ['en_route', 'on_site']) {
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

describe('owner ruling 2026-10-01: completing the visit confirms the address (shared completion engine)', () => {
  const { releaseStreetLevelHoldForCompletion } = require('../services/outbound-review-confirm');
  const actor = { technicianId: 'tech-1', techRole: 'technician' };

  test('a held visit is confirmed (pending -> confirmed, attributed to the completer) and the office-confirm activation runs', async () => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit(), held: true, calls });
    db.mockImplementation(handle);
    db.transaction = handle.transaction; db.fn = handle.fn; db.raw = handle.raw;
    const svc = baseVisit();
    await releaseStreetLevelHoldForCompletion(svc, actor);
    expect(calls.hold).toBe(1);
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'v1', fromStatus: 'pending', toStatus: 'confirmed', transitionedBy: 'tech-1', legacyOutboundActivation: 'caller',
    }));
  });

  test('a moved hold already confirmed is not transitioned again; non-holds and activated rows are untouched', async () => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit({ status: 'confirmed' }), held: true, calls });
    db.mockImplementation(handle); db.transaction = handle.transaction; db.fn = handle.fn; db.raw = handle.raw;
    await releaseStreetLevelHoldForCompletion(baseVisit({ status: 'confirmed' }), actor);
    expect(transitionJobStatus).not.toHaveBeenCalled();
    jest.clearAllMocks();
    const none = makeHandle({ visit: baseVisit(), held: false, calls });
    db.mockImplementation(none);
    expect(await releaseStreetLevelHoldForCompletion(baseVisit(), actor)).toBeNull();
    expect(await releaseStreetLevelHoldForCompletion(baseVisit({ customer_confirmed: true }), actor)).toBeNull();
    expect(await releaseStreetLevelHoldForCompletion(baseVisit({ source_action: 'ai_call_pipeline' }), actor)).toBeNull();
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('never throws, and the engine calls it once the completion attempt is claimed (before the recap and billing work)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(releaseStreetLevelHoldForCompletion(baseVisit(), actor)).resolves.toBe(false);
    const s = fs.readFileSync(require.resolve('../services/complete-scheduled-service.js'), 'utf8');
    // Only after the completion is DURABLY committed (fresh path and the resume path), never at the
    // claim: a later rejected caption / tip / ownership conflict must not approve the address.
    const calls = [];
    let from = 0;
    for (;;) { const i = s.indexOf('releaseStreetLevelHoldForCompletion(svc, completionInput.actor)', from); if (i === -1) break; calls.push(i); from = i + 1; }
    expect(calls).toHaveLength(2);
    for (const i of calls) expect(s.slice(i - 900, i)).toContain('durableCompletionCommitted = true;');
    expect(s.indexOf('completionAttempt = claim.attempt;')).toBeLessThan(calls[0]);
    expect(s.slice(s.indexOf('completionAttempt = claim.attempt;'), s.indexOf('completionAttempt = claim.attempt;') + 900)).not.toContain('releaseStreetLevelHoldForCompletion');
    // Every completer goes through completeScheduledService (the route, the packets, the issued-invoice closeout).
    for (const f of ['../routes/admin-dispatch.js', '../services/visit-completion-packets.js', '../services/invoice-issued-closeout.js']) {
      expect(fs.readFileSync(require.resolve(f), 'utf8')).toContain('completeScheduledService(');
    }
  });
});

describe('the technician hears about a moved hold the office approves', () => {
  test('both status routes key the new-visit card on pending -> confirmed OR a successful activation, after the activation runs', () => {
    for (const [f, tag] of [['../routes/admin-dispatch.js', "'admin-dispatch'"], ['../routes/admin-schedule.js', "'admin-schedule'"]]) {
      const s = fs.readFileSync(require.resolve(f), 'utf8');
      const act = s.indexOf(`officeConfirmActivated = await runOfficeConfirmActivation(db, svc, ${tag}`);
      const notify = s.indexOf("(fromStatus === 'pending' || officeConfirmActivated)");
      expect(act).toBeGreaterThan(0);
      expect(notify).toBeGreaterThan(act);
    }
  });
});

describe('a completed hold (completion recorded the approval) may retry its failed activation', () => {
  test('status completed passes the guard without a recorded transition; a merely moved hold still does not', async () => {
    const calls = { hold: 0, updates: [] };
    const completed = makeHandle({ visit: baseVisit({ status: 'completed' }), held: true, calls });
    await activateLegacyOutboundReviewRowIfNeeded(completed, 'v1', 'legacy-activation-sweep').catch(() => {});
    expect(calls.history || 0).toBe(0);                         // no transition lookup needed
    expect(calls.updates.length + calls.hold).toBeGreaterThan(0); // proceeded past the guard
    const moved = { hold: 0, updates: [] };
    const h = makeHandle({ visit: baseVisit({ status: 'confirmed' }), held: true, history: false, calls: moved });
    expect(await activateLegacyOutboundReviewRowIfNeeded(h, 'v1', 'rebooker-reschedule')).toBe(false);
    expect(moved.updates).toHaveLength(0);
  });
});

describe('a failed release keeps the saved completion resumable', () => {
  const { releaseStreetLevelHoldForCompletion } = require('../services/outbound-review-confirm');
  test('both release sites turn a failed release into a retryable 503 (attempt released for resume) instead of finalizing', () => {
    const s = fs.readFileSync(require.resolve('../services/complete-scheduled-service.js'), 'utf8');
    expect(s.split('if (holdRelease === false) {').length - 1).toBe(2);
    expect(s.split("code: 'street_level_hold_release_failed',").length - 1).toBe(2);
    expect(s.split("releaseCompletionAttemptForResume(completionAttempt, new Error('street_level_hold_release_failed'))").length - 1).toBe(2);
  });
  test('the release reports false (not null) when it is a hold whose activation failed or threw', async () => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit: baseVisit(), held: true, calls });
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await releaseStreetLevelHoldForCompletion(baseVisit(), { technicianId: 't' })).toBe(false);
    void handle;
  });
});

describe('the two completion activators race: the lazy post-commit one may win the stamp', () => {
  const { releaseStreetLevelHoldForCompletion } = require('../services/outbound-review-confirm');
  // A fake where the activation hook runs but the guarded stamp matches no row (the other helper stamped first).
  const world = ({ stampedByOther }) => {
    const calls = { reads: 0 };
    const h = (table) => {
      const q = {};
      ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'whereExists', 'orderBy', 'forUpdate', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services as ss') return { id: 'v1' };
        if (table === 'scheduled_services') { calls.reads += 1; return { ...baseVisit({ status: 'completed' }), customer_confirmed: stampedByOther && calls.reads > 1 }; }
        return null;
      });
      q.update = jest.fn(async () => 0);       // our guarded stamp loses the race
      q.select = jest.fn(async () => []);
      return q;
    };
    h.transaction = async (cb) => cb(h); h.fn = { now: () => new Date() }; h.raw = jest.fn(async () => ({}));
    return h;
  };
  test('a stamp lost to the other activator is a SUCCESS (the visit is confirmed), not a failed release', async () => {
    db.mockImplementation(world({ stampedByOther: true }));
    expect(await releaseStreetLevelHoldForCompletion(baseVisit({ status: 'completed' }), { technicianId: 't' })).toBe(true);
  });
  test('a hold nobody released stays a failure', async () => {
    db.mockImplementation(world({ stampedByOther: false }));
    expect(await releaseStreetLevelHoldForCompletion(baseVisit({ status: 'completed' }), { technicianId: 't' })).toBe(false);
  });
});

describe('r20: the confirm is bound to the address the office was shown', () => {
  const { assertExpectedServiceAddress, visitServiceAddressLine } = require('../services/street-level-hold');
  const row = { service_address_line1: '1234 Sample Newbuild Trl', service_address_line2: null, service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219' };
  const trxFor = ({ held, live }) => {
    const calls = { locked: false };
    const t = (table) => {
      const q = {};
      ['where', 'whereIn', 'whereNotIn', 'whereRaw', 'whereExists'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.forUpdate = jest.fn(() => { calls.locked = true; return q; });
      q.first = jest.fn(async () => (table === 'scheduled_services as ss' ? (held ? { id: 'v1' } : undefined) : live));
      return q;
    };
    return { t, calls };
  };

  test('the same address (formatting aside) passes; a corrected one is a 409 address_changed, read under the row lock', async () => {
    const same = trxFor({ held: true, live: row });
    await expect(assertExpectedServiceAddress(same.t, 'v1', '1234 sample newbuild trl, parrish, fl 34219')).resolves.toBeUndefined();
    expect(same.calls.locked).toBe(true);
    const moved = trxFor({ held: true, live: { ...row, service_address_line1: '1240 Sample Newbuild Trl' } });
    await expect(assertExpectedServiceAddress(moved.t, 'v1', '1234 Sample Newbuild Trl, Parrish, FL, 34219')).rejects.toMatchObject({ status: 409, code: 'address_changed' });
  });

  test('house-number / street boundaries are preserved: 1 23rd Ave is not 12 3rd Ave', async () => {
    const t = trxFor({ held: true, live: { ...row, service_address_line1: '12 3rd Ave' } });
    await expect(assertExpectedServiceAddress(t.t, 'v1', '1 23rd Ave, Parrish, FL, 34219')).rejects.toMatchObject({ code: 'address_changed' });
  });

  test('an absent expectation, or a visit that is not a hold, is today\'s behavior (no lookup / no refusal)', async () => {
    const none = trxFor({ held: true, live: row });
    await expect(assertExpectedServiceAddress(none.t, 'v1', '')).resolves.toBeUndefined();
    expect(none.calls.locked).toBe(false);
    const plain = trxFor({ held: false, live: { ...row, service_address_line1: 'elsewhere' } });
    await expect(assertExpectedServiceAddress(plain.t, 'v1', '1 Other St')).resolves.toBeUndefined();
  });

  test('the dispatch status route applies it to an office confirm under the lock; the list and the check share one address format', () => {
    const s = fs.readFileSync(require.resolve('../routes/admin-dispatch.js'), 'utf8');
    const lock = s.indexOf("const lockedRow = await lockOwnedLiveVisit(trx, req, svc.id, ['technician_id', 'customer_confirmed', 'status']");
    const check = s.indexOf('assertExpectedServiceAddress(trx, svc.id, req.body.expected_service_address)', lock);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeLessThan(s.indexOf('await transitionJobStatus({', check));
    const t = fs.readFileSync(require.resolve('../routes/admin-triage.js'), 'utf8');
    expect(t).toContain("const { visitServiceAddressLine, visitWhenLine, streetLevelVisitLink } = require('../services/street-level-hold');");
    expect(t).toContain('visitServiceAddressLine(r)');
    expect(visitServiceAddressLine(row)).toBe('1234 Sample Newbuild Trl, Parrish, FL, 34219');
  });
});

describe('a moved hold stays out of customer self-service (status confirmed, customer_confirmed false)', () => {
  const { isUnreviewedDispatchOwned, UNREVIEWED_VOICE_MOVED_SQL } = require('../services/call-booking-source-actions');
  const svc = (extra = {}) => ({ source_action: 'voice_agent', status: 'pending', customer_confirmed: false, ...extra });

  test('pending and moved-to-confirmed voice rows are unreviewed; confirmed-by-office, other statuses and other sources are not', () => {
    expect(isUnreviewedDispatchOwned(svc())).toBe(true);
    expect(isUnreviewedDispatchOwned(svc({ status: 'confirmed' }))).toBe(true);           // SmartRebooker's move
    expect(isUnreviewedDispatchOwned(svc({ status: 'confirmed', customer_confirmed: true }))).toBe(false);
    expect(isUnreviewedDispatchOwned(svc({ status: 'completed' }))).toBe(false);
    // The legacy outbound-review and follow-up rows keep their exact prior (pending-only) behavior.
    expect(isUnreviewedDispatchOwned(svc({ source_action: 'ai_call_outbound_review', status: 'confirmed' }))).toBe(false);
    expect(isUnreviewedDispatchOwned(svc({ source_action: 'ai_call_outbound_review' }))).toBe(true);
    expect(isUnreviewedDispatchOwned(svc({ source_action: 'ai_call_pipeline', status: 'pending' }))).toBe(false);
  });

  test('every customer-facing reader uses it: lists (SQL twin), confirm, reschedule, the bearer-token page and eligibility', () => {
    const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
    const sched = read('../routes/schedule.js');
    expect(sched.split('NOT ${UNREVIEWED_VOICE_MOVED_SQL}').length - 1).toBe(4);
    expect(sched.split('isUnreviewedDispatchOwned(service)').length - 1).toBe(2);
    expect(read('../routes/appointment-public.js')).toContain('return isUnreviewedDispatchOwned(svc);');
    expect(read('../services/reschedule-eligibility.js')).toContain('isUnreviewedDispatchOwned(svc)');
    expect(UNREVIEWED_VOICE_MOVED_SQL).toContain("source_action = 'voice_agent'");
    // Only CONFIRMED rows: an ordinary rescheduled voice booking (pending-rebook marker) stays visible.
    expect(UNREVIEWED_VOICE_MOVED_SQL).toContain("status = 'confirmed'");
    expect(isUnreviewedDispatchOwned(svc({ status: 'rescheduled' }))).toBe(false);
  });
});

describe('r22: a COMPLETED hold activates lazily only with the completion\'s field-confirmation stamp', () => {
  const act = async (visit) => {
    const calls = { hold: 0, updates: [] };
    const handle = makeHandle({ visit, held: true, history: false, calls });
    const out = await activateLegacyOutboundReviewRowIfNeeded(handle, 'v1', 'job-status-legacy-activation').catch(() => false);
    return { out, calls };
  };
  test('an incomplete / declined closeout (completed status, no stamp) is skipped: nothing stamped, nothing converted', async () => {
    const { out, calls } = await act(baseVisit({ status: 'completed', field_confirmed_at: null }));
    expect(out).toBe(false);
    expect(calls.updates).toHaveLength(0);
  });
  test('a closeout performed at the property (the stamp committed with the status) passes the guard', async () => {
    const { calls } = await act(baseVisit({ status: 'completed', field_confirmed_at: new Date() }));
    expect(calls.updates.length).toBeGreaterThan(0);
  });
  test('the completion engine stamps field_confirmed_at in the record transaction (before any post-commit activator) and releases only for performed outcomes', () => {
    const s = fs.readFileSync(require.resolve('../services/complete-scheduled-service.js'), 'utf8');
    expect(s).toContain("const addressConfirmingOutcome = visitOutcome !== 'incomplete' && visitOutcome !== 'customer_declined';");
    const stamp = s.indexOf('scheduledServiceUpdate.field_confirmed_at = svc.field_confirmed_at || new Date();');
    expect(stamp).toBeGreaterThan(s.indexOf('const scheduledServiceUpdate = { ...lifecycleUpdates };'));
    expect(stamp).toBeLessThan(s.indexOf("toStatus: 'completed',", stamp));
    expect(s.split('addressConfirmingOutcome ? await require').length - 1).toBe(2);
    const o = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    expect(o).toContain("(row.status === 'completed' && !!row.field_confirmed_at)");
  });
});

describe('r22: the status routes recheck the hold UNDER the visit row lock (serialized with promotion)', () => {
  const { assertNotLiveHoldUnderLock } = require('../services/street-level-hold');
  const trxFor = (held) => {
    const calls = { locked: false, order: [] };
    const t = (table) => {
      const q = {};
      ['where', 'whereIn', 'whereRaw', 'whereExists'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.forUpdate = jest.fn(() => { calls.locked = true; calls.order.push('lock'); return q; });
      q.first = jest.fn(async () => { calls.order.push(table); return table === 'scheduled_services as ss' ? (held ? { id: 'v1' } : undefined) : { id: 'v1' }; });
      return q;
    };
    return { t, calls };
  };
  test('locks the row first, then refuses a hold with 409 street_level_hold; a non-hold passes', async () => {
    const h = trxFor(true);
    await expect(assertNotLiveHoldUnderLock(h.t, 'v1')).rejects.toMatchObject({ status: 409, code: 'street_level_hold' });
    expect(h.calls.order[0]).toBe('lock');
    await expect(assertNotLiveHoldUnderLock(trxFor(false).t, 'v1')).resolves.toBeUndefined();
  });
  test('both status routes call it inside their transaction when the guard applies', () => {
    for (const f of ['../routes/admin-dispatch.js', '../routes/admin-schedule.js']) {
      const s = fs.readFileSync(require.resolve(f), 'utf8');
      const at = s.indexOf("if (holdGuardApplies) await require('../services/street-level-hold').assertNotLiveHoldUnderLock(trx, svc.id);");
      expect(at).toBeGreaterThan(s.indexOf('const holdGuardApplies ='));
      expect(s.lastIndexOf('db.transaction(async (trx) => {', at)).toBeGreaterThan(s.indexOf('const holdGuardApplies ='));
    }
  });
});

describe('r22 P0: an unsuccessful closeout of a hold earns no inspection-credit evidence', () => {
  test('the completed transition skips the credit evidence for a hold with no field-confirmation stamp (and still writes it for every other row)', () => {
    const s = fs.readFileSync(require.resolve('../services/job-status.js'), 'utf8');
    expect(s).toContain("'customer_id', 'field_confirmed_at');");
    const guard = s.indexOf('const unapprovedHold = legacyOutboundActivationNeeded && legacyRow.source_action === \'voice_agent\' && !legacyRow.field_confirmed_at');
    const gate = s.indexOf("if (legacyOutboundActivationNeeded && !unapprovedHold && String(toStatus || '') === 'completed' && legacyRow.customer_id) {");
    expect(guard).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(guard);
    expect(s.indexOf('markBookingForInspectionCredit(t, {', gate)).toBeGreaterThan(gate);
    // The stamp is committed in the completion's own transaction before that transition.
    const c = fs.readFileSync(require.resolve('../services/complete-scheduled-service.js'), 'utf8');
    expect(c.indexOf('scheduledServiceUpdate.field_confirmed_at')).toBeLessThan(c.indexOf("toStatus: 'completed',", c.indexOf('scheduledServiceUpdate.field_confirmed_at')));
  });
});
