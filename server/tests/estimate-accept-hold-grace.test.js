/**
 * Hold-expiry grace on the estimate accept path (owner case 2026-09-11).
 *
 * A customer reserved a slot (15-min hold), reloaded the page — which
 * re-offered her OWN hold as an "existing appointment" with no expiry — spent
 * the hold on card entry + the prepay quote round-trip, and confirmed 34 s
 * after expiry. The accept 409'd with the generic "not linked" copy, the
 * client mapped it to "slot taken", and she believed she had paid.
 *
 * Pins: (1) the acceptance contract carries the hold's expiry so the client
 * can run a timer; (2) the accept-path adoption lookup honours the commit
 * grace for the estimate's OWN hold only; (3) the view path never OFFERS a
 * lapsed hold (no grace); (4) every expiry 409 carries RESERVATION_EXPIRED.
 */

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));

const fs = require('fs');
const path = require('path');
const {
  findLinkedUpcomingAppointment,
  buildEstimateAcceptanceContract,
} = require('../routes/estimate-public');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');

const lawnEstimate = () => ({
  id: 'est-1',
  customer_id: null,
  service_interest: 'Lawn Care',
  estimate_data: {
    result: {
      recurring: {
        services: [{ service: 'lawn_care', name: 'Lawn Care', monthly: 48, visitsPerYear: 9 }],
      },
    },
  },
});

const OWN_HOLD = {
  id: 'hold-1',
  customer_id: null,
  source_estimate_id: 'est-1',
  status: 'pending',
  service_type: 'Lawn Care',
  scheduled_date: '2026-09-16',
  window_start: '13:00:00',
  window_end: '14:00:00',
  reservation_expires_at: new Date('2026-09-11T18:52:37.000Z'),
  is_callback: false,
};

function makeFakeConn(resultsByQuery) {
  const queries = [];
  const conn = () => {
    const rec = { clauses: [] };
    const index = queries.length;
    queries.push(rec);
    const record = (method) => (...args) => {
      rec.clauses.push([method, args]);
      if (typeof args[0] === 'function') args[0](nestedBuilder(rec));
      return q;
    };
    const q = {};
    ['whereIn', 'where', 'andWhere', 'orWhere', 'whereNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'limit', 'offset', 'leftJoin', 'select'].forEach((m) => {
      q[m] = record(m);
    });
    q.first = () => Promise.resolve(resultsByQuery[index] ?? null);
    q.then = (resolve, reject) => Promise.resolve(resultsByQuery[index] ?? null).then(resolve, reject);
    return q;
  };
  conn.queries = queries;
  return conn;
}

function nestedBuilder(rec) {
  const b = {};
  ['where', 'orWhere', 'whereNull', 'orWhereNull', 'orWhereRaw', 'whereRaw'].forEach((m) => {
    b[m] = (...args) => {
      rec.clauses.push([`nested.${m}`, args]);
      if (typeof args[0] === 'function') args[0](nestedBuilder(rec));
      return b;
    };
  });
  return b;
}

const graceClauses = (conn) => conn.queries[0].clauses
  .filter(([m, args]) => m === 'nested.whereRaw' && /make_interval\(mins => \?\)/.test(String(args[0])));

describe('acceptance contract exposes the hold expiry', () => {
  test('an adopted uncommitted hold is flagged isHold with its ISO expiry', () => {
    const contract = buildEstimateAcceptanceContract({ existingAppointment: OWN_HOLD });
    expect(contract.mode).toBe('existing_appointment');
    expect(contract.appointment.isHold).toBe(true);
    expect(contract.appointment.reservationExpiresAt).toBe('2026-09-11T18:52:37.000Z');
  });

  test('a committed appointment is not a hold and carries no expiry', () => {
    const committed = { ...OWN_HOLD, customer_id: 'cust-1', reservation_expires_at: null };
    const contract = buildEstimateAcceptanceContract({ existingAppointment: committed });
    // ABSENT, not false/null (codex r14 P0): the contract promises a
    // committed visit's payload is byte-identical to the pre-PR shape.
    expect(contract.appointment).not.toHaveProperty('isHold');
    expect(contract.appointment).not.toHaveProperty('reservationExpiresAt');
  });

  test('a COMMITTED row carrying a stray future expiry is still not a hold (hold-grace self-audit)', () => {
    // releaseExpiredReservations exists partly to rescue committed rows whose
    // reservation_expires_at was never cleared. Flagging one as a hold would
    // start a countdown on a real booked appointment, 404 its extend, and
    // then offer an expired-hold recovery for a visit that is fine.
    const strayExpiry = { ...OWN_HOLD, customer_id: 'cust-1', reservation_expires_at: new Date(Date.now() + 6e5) };
    const contract = buildEstimateAcceptanceContract({ existingAppointment: strayExpiry });
    expect(contract.appointment).not.toHaveProperty('isHold');
    expect(contract.appointment).not.toHaveProperty('reservationExpiresAt');
  });
});

describe('findLinkedUpcomingAppointment hold grace', () => {
  test('accept path (holdGraceMinutes > 0) widens the expiry predicate for the estimate\'s OWN hold only', async () => {
    const est = lawnEstimate();
    const conn = makeFakeConn([OWN_HOLD]);
    const row = await findLinkedUpcomingAppointment(est, est.estimate_data, {
      appointmentId: 'hold-1',
      serviceModes: ['recurring'],
      holdGraceMinutes: 10,
      database: conn,
    });
    expect(row?.id).toBe('hold-1');
    const grace = graceClauses(conn);
    expect(grace).toHaveLength(1);
    expect(grace[0][1][1]).toEqual([10]);
    // The widened branch is scoped to this estimate's unclaimed hold, never
    // to another customer's lapsed hold.
    const scoped = conn.queries[0].clauses.find(([m, args]) => m === 'nested.where'
      && args[0] === 'scheduled_services.source_estimate_id' && args[1] === 'est-1');
    expect(scoped).toBeTruthy();
  });

  test('view path (no grace option) keeps the strict live-hold predicate — a lapsed hold is never OFFERED', async () => {
    const est = lawnEstimate();
    const conn = makeFakeConn([OWN_HOLD]);
    await findLinkedUpcomingAppointment(est, est.estimate_data, {
      serviceModes: ['recurring'],
      database: conn,
    });
    expect(graceClauses(conn)).toHaveLength(0);
  });

  test('grace is clamped to [0, 30] minutes and ignores garbage', async () => {
    const est = lawnEstimate();
    for (const [input, expected] of [[45, 30], [-5, 0], ['abc', 0], [7.9, 7]]) {
      const conn = makeFakeConn([OWN_HOLD]);
      await findLinkedUpcomingAppointment(est, est.estimate_data, {
        serviceModes: ['recurring'],
        holdGraceMinutes: input,
        database: conn,
      });
      const grace = graceClauses(conn);
      if (expected === 0) expect(grace).toHaveLength(0);
      else expect(grace[0][1][1]).toEqual([expected]);
    }
  });
});

describe('accept-path wiring (source pins)', () => {
  test('the accept preflight reads the commit grace from the reservation service and threads it into the adoption lookup', () => {
    expect(src).toMatch(/const holdGraceMinutes = typeof slotReservation\.commitGraceMinutes === 'function'/);
    expect(src).toMatch(/adoptableStatuses: acceptAdoptableStatuses,\s*\n\s*holdGraceMinutes,\s*\n\s*\}\)/);
  });

  test('a slotId whose hold lapsed inside the grace is NOT 409\'d at preflight (commitReservation re-verifies)', () => {
    // DB-clock, never this process's clock (pre-push audit P1): under
    // app/DB skew a JS-side comparison could refuse a hold commitReservation
    // would graduate — the same wrongly-declined-by-seconds failure.
    expect(src).toMatch(/\.select\('\*', db\.raw\('\(reservation_expires_at < NOW\(\) - make_interval\(mins => \?\)\) AS _beyond_grace', \[holdGraceMinutes\]\)\)/);
    expect(src).toMatch(/if \(reservationRow\._beyond_grace\) \{\s*\n\s*return res\.status\(409\)\.json\(HOLD_EXPIRED_409\)/);
    expect(src).not.toMatch(/Date\.now\(\) - holdGraceMinutes/);
  });

  test('every hold-expiry 409 carries code RESERVATION_EXPIRED, and the lapsed OWN hold is classified as expiry, not "not linked"', () => {
    expect(src).toMatch(/const HOLD_EXPIRED_409 = \{\s*\n\s*error: 'Your time-slot hold expired[^']*',\s*\n\s*code: 'RESERVATION_EXPIRED',/);
    expect(src).toMatch(/const ownLapsedHold = await db\('scheduled_services'\)\s*\n\s*\.where\(\{ id: String\(existingAppointmentId\), source_estimate_id: estimate\.id \}\)\s*\n\s*\.whereNull\('customer_id'\)\s*\n\s*\.whereNotNull\('reservation_expires_at'\)\s*\n\s*\.whereRaw\('reservation_expires_at < NOW\(\)'\)/);
    // Both commit-time mappings (slot pick + adopted hold) stamp the code the
    // route's catch forwards to the client.
    const expiredMappings = src.match(/commitErr\.code === 'RESERVATION_EXPIRED'\) \{\s*\n\s*const err = new Error\(HOLD_EXPIRED_409\.error\);\s*\n\s*err\.status = 409;\s*\n\s*err\.code = 'RESERVATION_EXPIRED';/g) || [];
    expect(expiredMappings).toHaveLength(2);
    const unavailableMappings = src.match(/commitErr\.code === 'SLOT_UNAVAILABLE'\) \{\s*\n\s*const err = new Error\('slot no longer available — re-pick a slot'\);\s*\n\s*err\.status = 409;\s*\n\s*err\.code = 'SLOT_UNAVAILABLE';/g) || [];
    expect(unavailableMappings).toHaveLength(2);
    expect(src).toMatch(/return res\.status\(err\.status\)\.json\(\{ error: err\.message, \.\.\.\(err\.code \? \{ code: err\.code \} : \{\}\) \}\)/);
  });

  test('only an ACTUALLY lapsed own hold is reported as an expiry — a live hold that failed adoption keeps the linkage message (pre-push audit P1)', () => {
    // Without the `reservation_expires_at < NOW()` predicate, a hold refused
    // for status / callback / family / property reasons would be reported to
    // the customer as "your hold expired", sending them to re-pick a slot
    // while the real defect stayed invisible.
    // Slice to the linkage refusal itself rather than a fixed length — the
    // swept-hold branch (codex r2 P2) now sits between the two.
    const start = src.indexOf('const ownLapsedHold');
    const block = src.slice(start, src.indexOf("error: 'existing appointment is not linked to this active estimate'", start) + 80);
    expect(block).toContain(".whereRaw('reservation_expires_at < NOW()')");
    expect(block).toContain("return res.status(409).json(HOLD_EXPIRED_409)");
    expect(block).toContain("error: 'existing appointment is not linked to this active estimate'");
  });

  test('every hold-expiry decision is measured by POSTGRES, never the app process clock (pre-push audit r1/r2 P1)', () => {
    const reservationSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
    // The three extend-time booleans and the commit-time one all come from
    // SQL. App/DB skew must not decide whether a hold is alive.
    expect(reservationSrc).toContain("AS _hold_limit_reached");
    expect(reservationSrc).toContain("AS _already_lapsed");
    expect(reservationSrc).toContain("AS _new_expiry");
    expect(reservationSrc).toContain("AS _expired");
    expect(reservationSrc).toContain('const alreadyLapsed = !!row._already_lapsed;');
    // The sweep's grace-shifted cutoff is SQL too, not a JS-computed Date.
    expect(reservationSrc).toMatch(/\.whereRaw\('reservation_expires_at < NOW\(\) - make_interval\(mins => \?\)', \[commitGraceMinutes\(\)\]\)/);
    expect(reservationSrc).not.toMatch(/const releaseCutoff = new Date\(/);
    // No JS-side comparison of a hold expiry against Date.now().
    expect(reservationSrc).not.toMatch(/new Date\(row\.reservation_expires_at\)\.getTime\(\) <= Date\.now\(\)/);
  });

  test('the still-uncommitted hold delete is ONE shared predicate, not re-typed per call site (pre-push audit P1)', () => {
    const reservationSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
    expect(reservationSrc).toMatch(/function uncommittedHoldQuery\(client, \{ scheduledServiceId, estimateId \}\)/);
    // Every deleter goes through it; no hand-rolled copy of the predicate.
    expect((reservationSrc.match(/uncommittedHoldQuery\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(reservationSrc).not.toMatch(/\.whereNull\('customer_id'\)\s*\n\s*\.whereNotNull\('reservation_expires_at'\)\s*\n\s*\.del\(\)/);
  });
});

// A hold the sweep already DELETED must still refuse as an expiry (codex r2
// P2): the row is gone, so the lapsed-hold lookup finds nothing and the
// handler used to fall through to the uncoded linkage 409 — which the client
// renders as "That slot was just taken", the exact misdirection this PR
// removes. A deleted row is provably not a committed visit (those are never
// swept), so when the estimate's own data names that id the answer is the
// coded expiry.
describe('accept: a swept hold still answers RESERVATION_EXPIRED', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
  const branch = src.slice(
    src.indexOf('if (existingAppointmentId && !existingAppointmentRow)'),
    src.indexOf("return res.status(409).json({ error: 'existing appointment is not linked to this active estimate' });"),
  );

  test('the missing-row case is classified before the generic linkage 409', () => {
    expect(branch).toContain('const rowStillExists = await db(\'scheduled_services\')');
    expect(branch).toMatch(/estimateOwnedThatHold = String\(estData\?\.scheduled_service_id \|\| ''\) === String\(existingAppointmentId\)/);
    expect(branch).toContain('if (!rowStillExists && estimateOwnedThatHold) {');
    // Both refusals carry the coded body, so the client's banner is chosen by
    // code and never by prose.
    expect(branch.match(/HOLD_EXPIRED_409/g).length).toBeGreaterThanOrEqual(2);
  });

  test('a still-present row is NOT treated as swept (the linkage message survives)', () => {
    // The existence probe gates the expiry answer — a live row that failed
    // adoption for some other reason must keep the linkage message.
    expect(branch.indexOf('rowStillExists')).toBeLessThan(branch.indexOf('if (!rowStillExists && estimateOwnedThatHold)'));
    expect(branch).not.toMatch(/if \(!existingAppointmentRow\) \{\s*return res\.status\(409\)\.json\(HOLD_EXPIRED_409\)/);
  });
});

// An in-grace commit must arbitrate against LIVE rival holds, not only
// committed visits (codex r3 P1). The moment a hold's expiry passes, every
// reserve-side check stops counting it, so another customer can legitimately
// hold the same window; the narrow pre-check is technician-scoped, so a rival
// unassigned hold slips past it entirely. extendReservation already mirrors
// this with `includeHolds: alreadyLapsed`.
describe('commitReservation weighs live holds only for a LAPSED graduation', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const commit = src.slice(src.indexOf('async function commitReservation'), src.indexOf('async function releaseReservation'));

  test('the tech-blind backstop keys includeHolds off an EXACT lapse boolean', () => {
    expect(commit).toContain('includeHolds: !!row._lapsed,');
    // A Postgres boolean, not a truncated seconds count: `::int` rounds a
    // sub-second lapse to 0 and would read as punctual (codex r6 P2).
    expect(commit).toContain('AS _lapsed');
    expect(commit).not.toMatch(/includeHolds: Number\(/);
  });

  test('a punctual hold still ignores live holds (reserve already arbitrated them)', () => {
    // Anything that made this unconditional would refuse an on-time accept
    // over a rival hold the reserve path had already permitted.
    expect(commit).not.toMatch(/includeHolds: true/);
  });
});

// A hold row that is GONE at commit — swept, or superseded by a concurrent
// extension that found a conflict — must still answer the coded expiry
// (codex r6 P1). Unmapped, commitReservation's RESERVATION_NOT_FOUND
// surfaced as a generic failure and the client showed no recovery.
describe('accept maps a missing hold at commit to the coded expiry', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');

  test('both commit call sites map RESERVATION_NOT_FOUND to RESERVATION_EXPIRED', () => {
    const sites = src.match(/commitErr\.code === 'RESERVATION_NOT_FOUND'/g) || [];
    expect(sites).toHaveLength(2);
    // Each mapping carries the shared copy + code, never a bare rethrow.
    for (const m of src.matchAll(/commitErr\.code === 'RESERVATION_NOT_FOUND'\)\s*\{([\s\S]{0,420}?)\}\n/g)) {
      expect(m[1]).toContain('HOLD_EXPIRED_409.error');
      expect(m[1]).toContain("err.code = 'RESERVATION_EXPIRED';");
    }
  });
});

// The legacy SSR renderer has no timer and no extend action, and its adoption
// UI says "Appointment already scheduled" — so it must NOT adopt the
// estimate's own live hold (codex r7 P1), or a V1/control customer is told
// they are booked while the hold silently lapses. Re-reserving the same slot
// is idempotent for its owner, so the normal picker (with its own countdown)
// is the correct surface there.
describe('legacy renderer never adopts a live hold', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');

  test('the V1 template filters isHold rows out of existingAppointment', () => {
    expect(src).toContain("const existingAppointment = (est.existingAppointment && !est.existingAppointment.isHold)");
    // The committed-appointment copy still exists for real appointments.
    expect(src).toContain('Appointment already scheduled');
  });

  test('the /data shape still carries the hold metadata for the React page', () => {
    // Bounded by the function's own end, not a fixed length.
    const shapeAt = src.indexOf('function shapeLinkedAppointment');
    const shape = src.slice(shapeAt, src.indexOf("\n// serviceKeyFor's fallback", shapeAt));
    // Spread ONLY for an actual hold, so a committed visit's payload is
    // byte-identical to the pre-PR shape the contract promises (codex r14 P0).
    expect(shape).toContain('...((!row.customer_id && row.reservation_expires_at)');
    expect(shape).toContain('isHold: true');
    expect(shape).not.toMatch(/isHold: !row\.customer_id/);
  });

  test('the public contract documents both new fields (P0: public payload change)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../docs/public-route-contracts.md'), 'utf8');
    expect(doc).toContain('`isHold` is true and `reservationExpiresAt` carries the hold');
    expect(doc).toContain('Both fields are ABSENT for a genuinely');
    // The stale "never a reservation hold" claim is gone.
    expect(doc).not.toContain('never a reservation hold or a callback visit');
  });
});

// A reshaped estimate must not graduate its own pending hold into a phantom
// visit (codex r14 P1). /reserve and /extend both refuse a guarantee-only or
// trenching-review shape; the accept path applied only the slotId refusal, so
// a stale adopted hold id could still ride in.
describe('accept refuses a no-booking reshape on the adopted-hold path', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
  const guard = src.slice(
    src.indexOf('if (slotId && isRodentGuaranteeOnlyEstimate(estimate, estData))'),
    src.indexOf('const acceptAdoptableStatuses = adoptableAppointmentStatuses();'),
  );

  test('an UNCOMMITTED adopted hold is refused for both no-booking shapes', () => {
    expect(guard).toContain('if (existingAppointmentId');
    expect(guard).toContain('isRodentGuaranteeOnlyEstimate(estimate, estData)');
    expect(guard).toContain('estimateTrenchingReviewRequired(estData)');
    // The commercial reshape is the third shape (codex r15 P1): staff can set
    // commercialEstimatedPricing without touching service rows, so family
    // matching keeps passing and the hold would graduate the appointment
    // commercial scheduling places by hand.
    expect(guard).toContain('isCommercialAutoAcceptEstimate(estimate)');
    expect(guard).toContain('invoiceOnlyAcceptance: true,');
    expect(guard).toContain('reviewBeforeBooking: true,');
    expect(guard).toContain('commercialManualScheduling: true,');
  });

  test('a COMMITTED visit still adopts — it exists whatever the estimate becomes', () => {
    const at = guard.indexOf("const adoptedIsHold = await db('scheduled_services')");
    expect(at).toBeGreaterThan(-1);
    const q = guard.slice(at, at + 320);
    expect(q).toContain(".whereNull('customer_id')");
    expect(q).toContain(".whereNotNull('reservation_expires_at')");
  });

  test('the guard runs BEFORE the adoption lookup', () => {
    expect(guard.indexOf('const adoptedIsHold')).toBeLessThan(guard.length);
    expect(src.indexOf('const adoptedIsHold')).toBeLessThan(src.indexOf('const existingAppointmentRow = existingAppointmentId'));
  });
});
