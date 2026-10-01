// Follow-ups to the street-level address hold (#5381), owner ruling 2026-09-30/10-01: the six deferred
// review findings that had to land before GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL flips. Synthetic data only.
//   1. the confirm dialog shows the visit's LIVE slot (server list read)
//   3. the background scanners (missed-appointment sweep, no-show detector, tech-late) skip an uncleared hold
//   6. a retried approval is bound to the address the office confirmed
// (2 lives in call-outbound-booking.test.js, 4 and the dialog view in TriageInboxTabV2.test.jsx, 5 in
// street-level-hold-comms / admin-communications-*.test.js.)
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const knex = require('knex')({ client: 'pg' });
const hold = require('../services/street-level-hold');
const { activateLegacyOutboundReviewRowIfNeeded } = require('../services/outbound-review-confirm');

const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');

const ADDRESS = { service_address_line1: '1234 Sample Newbuild Trl', service_address_line2: null, service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219' };
const NORM = '1234 sample newbuild trl parrish fl 34219';

describe('finding 1: the live visit slot is read with the list, in the card\'s own format', () => {
  test('visitWhenLine matches the card writer\'s "date HH:MM" shape (string or Date date, trimmed seconds)', () => {
    expect(hold.visitWhenLine({ scheduled_date: '2026-10-12', window_start: '13:00:00' })).toBe('2026-10-12 13:00');
    expect(hold.visitWhenLine({ scheduled_date: new Date('2026-10-12T00:00:00Z'), window_start: '08:30' })).toBe('2026-10-12 08:30');
    expect(hold.visitWhenLine({ scheduled_date: '2026-10-12', window_start: null })).toBe('2026-10-12');
    expect(hold.visitWhenLine({})).toBe('');
  });

  test('the triage list selects the visit\'s date and window with the live address and refreshes the payload visit_when from it', () => {
    const s = read('../routes/admin-triage.js');
    expect(s).toContain(".select('id', 'scheduled_date', 'window_start', 'service_address_line1'");
    expect(s).toContain('const when = visitWhenLine(r);');
    // Behavior (visit_when and the Open visit link on the live date): admin-triage-hold-live-visit.test.js.
  });
});

describe('finding 3: an uncleared street-level hold is not a missed visit, a no-show or a late tech', () => {
  test('heldVisitSql is the heldVisitSubquery predicate as SQL text for the given visit alias', () => {
    const sql = hold.heldVisitSql('s');
    expect(sql).toContain(`"hold_ti"."reason_code" = 'outbound_booking_review'`);
    expect(sql).toContain("hold_ti.payload->>'scheduled_service_id' = s.id::text");
    expect(sql).toContain('s.customer_confirmed = false');
    expect(sql).toContain("s.status NOT IN ('cancelled', 'skipped', 'rescheduled')");
    expect(sql).toContain("COALESCE(hold_ti.payload->>'closed_out', '') = ''");
    expect(sql).toBe(hold.heldVisitSubquery(knex.queryBuilder(), 's').toQuery());
  });

  test('the missed-appointment sweep, the no-show candidate feed and the tech-late scan each exclude it', () => {
    const sched = read('../services/scheduler.js');
    const sweep = sched.slice(sched.indexOf('DAILY 6PM — Missed appointment check'));
    expect(sweep.slice(0, sweep.indexOf('windowHasPassed')))
      .toContain("require('./street-level-hold').heldVisitSubquery(this, 'scheduled_services');");

    const ns = read('../services/no-show-detector.js');
    expect(ns).toContain("require('./street-level-hold').heldVisitSubquery(this, 's');");
    const list = ns.slice(ns.indexOf('async function listNoShows'), ns.indexOf('async function listNoShows') + 3500);
    expect(list.split('.whereNotExists(unclearedHold)').length - 1).toBe(2);   // the candidates and the stranded stops

    // Scan-then-act rechecks (Codex #5506 r2): the no-show detector's per-card loop rechecks under the stop's
    // FOR UPDATE row lock; the sweep and the tech-late scan re-read under runUnlessLiveHold's visit lock.
    expect(ns).toContain("if (await require('./street-level-hold').isStreetLevelHoldVisit(card.id, trx)) return null;");
    expect(ns.indexOf('isStreetLevelHoldVisit(card.id, trx)')).toBeGreaterThan(ns.indexOf('await lockedStop(trx, card.id'));
    expect(ns.indexOf('isStreetLevelHoldVisit(card.id, trx)')).toBeLessThan(ns.indexOf('recordTrackingNotice(trx'));
    expect(sweep.slice(0, sweep.indexOf('Missed appointment check done')))
      .toContain("runUnlessLiveHold(svc.id, () => missedAppointment.onSkip(svc.id, 'no_show'))");
    expect(read('../services/tech-late-detector.js')).toContain('runUnlessLiveHold(row.job_id, () => createAlert({');

    const late = read('../services/tech-late-detector.js');
    expect(late).toContain("AND NOT EXISTS (${heldVisitSql('s')})");
    expect(late).toContain("const { heldVisitSql, runUnlessLiveHold } = require('./street-level-hold');");
  });

  test('the sweep query compiles to a NOT EXISTS over the hold card (exact SQL)', () => {
    const sql = knex('scheduled_services')
      .whereIn('status', ['pending', 'confirmed'])
      .whereNotExists(function unclearedAddressHold() { hold.heldVisitSubquery(this, 'scheduled_services'); })
      .select('id').toQuery();
    expect(sql).toContain('not exists (select 1 from "triage_items" as "hold_ti"');
    expect(sql).toContain("hold_ti.payload->>'scheduled_service_id' = scheduled_services.id::text");
    expect(sql).toContain('scheduled_services.customer_confirmed = false');
  });
});

describe('finding 5 (scheduled path): the linked visits survive the queue so the hold is re-checked at delivery', () => {
  test('/schedule-sms persists them on the queued row and the cron replay forwards them into the send metadata', () => {
    const route = read('../routes/admin-communications.js');
    expect(route).toContain('if (scheduledLinkedVisitIds.length) metaObj.linked_scheduled_service_ids = scheduledLinkedVisitIds;');
    const cron = read('../services/scheduler.js');
    expect(cron).toContain('{ linked_scheduled_service_ids: claimMeta.linked_scheduled_service_ids }');
    // ...which the shared send step reads (every linked visit is checked).
    expect(read('../services/messaging/send-customer-message.js')).toContain('metadata?.linked_scheduled_service_ids');
  });
});

describe('finding 5 (draft approval): a revised draft carries its linked visits too', () => {
  test('the composer posts linkedVisitIds on /revise and the route forwards them into the send metadata', () => {
    const client = fs.readFileSync(require.resolve('../../client/src/pages/admin/CommunicationsPageV2.jsx'), 'utf8');
    expect(client).toContain('body: JSON.stringify({ revisedResponse: revised, fromNumber, linkedVisitIds: linkedVisitIds.length ? linkedVisitIds : undefined }),');
    const route = read('../routes/admin-drafts.js');
    expect(route).toContain("const linkedVisitIds = require('../services/street-level-hold').linkedVisitIdsFrom(req.body?.linkedVisitIds);");
    expect(route).toContain('...(linkedVisitIds.length ? { linked_scheduled_service_ids: linkedVisitIds } : {}),');
  });
  test('linkedVisitIdsFrom keeps only well-formed, de-duplicated, capped ids', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6${i}`);
    expect(hold.linkedVisitIdsFrom([ids[0], ids[0].toUpperCase(), 'nope', 7, null])).toEqual([ids[0]]);
    expect(hold.linkedVisitIdsFrom(ids)).toHaveLength(5);
    expect(hold.linkedVisitIdsFrom('x')).toEqual([]);
  });
});

describe('finding 6: the office approval is bound to the address it was given for', () => {
  // A fake trx / conn: the visit row, the live-hold lookup, the hold card.
  const makeConn = ({ visit = { source_action: 'voice_agent', source_call_log_id: 'call-1', ...ADDRESS }, held = true, card = { id: 'card-1', status: 'open', payload: { street_level_address: true, scheduled_service_id: 'v1' } }, history = true, status = 'confirmed' } = {}) => {
    const log = { updates: [] };
    const conn = (table) => {
      const q = {};
      ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'whereExists', 'orderBy', 'forUpdate', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services as ss') return held ? { id: 'v1' } : undefined;
        if (table === 'scheduled_services') return { id: 'v1', status, customer_confirmed: false, customer_id: 'c1', ...visit };
        if (table === 'triage_items') return card;
        if (table === 'job_status_history') return history ? { job_id: 'v1' } : undefined;
        return null;
      });
      q.update = jest.fn(async (vals) => { log.updates.push({ table, vals }); return 1; });
      return q;
    };
    conn.transaction = async (fn) => fn(conn);
    conn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    conn.fn = { now: () => new Date() };
    return { conn, log };
  };

  describe('recordApprovedAddressWitness (inside the approving transition, under the visit row lock)', () => {
    test('a live hold: the visit\'s normalized address is merged onto its card', async () => {
      const { conn, log } = makeConn();
      expect(await hold.recordApprovedAddressWitness(conn, 'v1')).toBe(true);
      const upd = log.updates.find((u) => u.table === 'triage_items');
      expect(upd).toBeTruthy();
      expect(upd.vals.payload.sql).toContain("COALESCE(payload, '{}'::jsonb) || ?::jsonb");
      expect(JSON.parse(upd.vals.payload.bindings[0])).toEqual({ approved_address: NORM });
    });

    test('not a hold, not a voice-agent visit, or no card: nothing is written', async () => {
      for (const opts of [{ held: false }, { visit: { source_action: 'ai_call_outbound_review', source_call_log_id: 'call-1', ...ADDRESS } }, { card: null }]) {
        const { conn, log } = makeConn(opts);
        expect(await hold.recordApprovedAddressWitness(conn, 'v1')).toBe(false);
        expect(log.updates).toHaveLength(0);
      }
    });
  });

  describe('approvedAddressStillCurrent (the lazy / stranded-activation retry)', () => {
    const cardWith = (witness) => ({ id: 'card-1', status: 'open', payload: { street_level_address: true, scheduled_service_id: 'v1', ...(witness ? { approved_address: witness } : {}) } });

    test('the address the office confirmed (spelling aside) is still current', async () => {
      expect(await hold.approvedAddressStillCurrent(makeConn({ card: cardWith(NORM) }).conn, 'v1')).toBe(true);
      const respelled = { source_action: 'voice_agent', source_call_log_id: 'call-1', ...ADDRESS, service_address_line1: '1234  SAMPLE Newbuild Trl.' };
      expect(await hold.approvedAddressStillCurrent(makeConn({ card: cardWith(NORM), visit: respelled }).conn, 'v1')).toBe(true);
    });

    test('any correction made after the approval voids it', async () => {
      for (const moved of [{ service_address_line1: '1240 Sample Newbuild Trl' }, { service_address_line2: 'Unit 2' }, { service_address_zip: '34203' }, { service_address_city: 'Sarasota' }]) {
        const visit = { source_action: 'voice_agent', source_call_log_id: 'call-1', ...ADDRESS, ...moved };
        expect(await hold.approvedAddressStillCurrent(makeConn({ card: cardWith(NORM), visit }).conn, 'v1')).toBe(false);
      }
    });

    test('an approval with no witness keeps the old behavior; a lookup error fails closed', async () => {
      expect(await hold.approvedAddressStillCurrent(makeConn({ card: cardWith(null) }).conn, 'v1')).toBe(true);
      expect(await hold.approvedAddressStillCurrent(makeConn({ card: null }).conn, 'v1')).toBe(true);
      const boom = () => { throw new Error('db down'); };
      expect(await hold.approvedAddressStillCurrent(boom, 'v1')).toBe(false);
    });
  });

  describe('activateLegacyOutboundReviewRowIfNeeded', () => {
    const witnessCard = (witness) => ({ id: 'card-1', status: 'open', payload: { street_level_address: true, scheduled_service_id: 'v1', approved_address: witness } });

    test('a recorded office approval whose address then changed is NOT activated (nothing stamped, hook not run)', async () => {
      const changed = { source_action: 'voice_agent', source_call_log_id: 'call-1', ...ADDRESS, service_address_line1: '1240 Sample Newbuild Trl' };
      const { conn, log } = makeConn({ visit: changed, card: witnessCard(NORM) });
      expect(await activateLegacyOutboundReviewRowIfNeeded(conn, 'v1', 'legacy-activation-sweep')).toBe(false);
      expect(log.updates).toHaveLength(0);
    });

    test('the same approval with the address unchanged is past the guard (the hook legs and stamp are attempted)', async () => {
      const { conn, log } = makeConn({ card: witnessCard(NORM) });
      await activateLegacyOutboundReviewRowIfNeeded(conn, 'v1', 'legacy-activation-sweep').catch(() => {});
      expect(log.updates.length).toBeGreaterThan(0);
    });
  });

  describe('the final stamp is bound to the approved address (Codex #5506 r1)', () => {
    const { runOfficeConfirmActivation } = require('../services/outbound-review-confirm');
    const witnessCard = (witness) => ({ id: 'card-1', status: 'open', payload: { street_level_address: true, scheduled_service_id: 'v1', approved_address: witness } });

    test('an office approval whose address changed before the activation runs none of the legs and stamps nothing', async () => {
      const changed = { source_action: 'voice_agent', source_call_log_id: 'call-1', ...ADDRESS, service_address_line1: '1240 Sample Newbuild Trl' };
      const { conn, log } = makeConn({ visit: changed, card: witnessCard(NORM) });
      expect(await runOfficeConfirmActivation(conn, { id: 'v1', source_action: 'voice_agent' }, 'admin-dispatch')).toBe(false);
      expect(log.updates).toHaveLength(0);
    });

    test('a technician\'s own field confirm is not bound to the office witness', () => {
      const s = read('../services/outbound-review-confirm.js');
      expect(s).toContain("const bindAddress = svc.source_action === 'voice_agent' && !opts.skipCardRequest;");
    });

    test('an approved hold is activated lock + verify + STAMP first, then the legs; every other row keeps hook-first (Codex #5506 r3)', () => {
      const s = read('../services/outbound-review-confirm.js');
      // Both rails route an office-approved hold through the one fenced function.
      expect(s).toContain("return activateHoldFencedByAddress(dbh, svc, routeTag, opts);");
      expect(s).toContain('return await activateHoldFencedByAddress(db, row, routeTag, {');
      const fence = s.slice(s.indexOf('async function activateHoldFencedByAddress'), s.indexOf('async function runOfficeConfirmActivation'));
      // Order inside it: the locked, address-checked stamp, then the hook legs, then (on failure) the un-stamp.
      expect(fence.indexOf('await stampCustomerConfirmed(dbh, svc, { bindAddress: true, stampedAt, markActivationPending: mode })'))
        .toBeLessThan(fence.indexOf('await runOutboundReviewConfirmHook(dbh, svc, routeTag, hookOpts)'));
      expect(fence.indexOf('await runOutboundReviewConfirmHook')).toBeLessThan(fence.indexOf('.update({ customer_confirmed: false, confirmed_at: null })'));
      const stampFn = s.slice(s.indexOf('async function stampCustomerConfirmed'), s.indexOf('async function activateHoldFencedByAddress'));
      expect(stampFn.indexOf(".forUpdate().first('id', 'source_call_log_id')")).toBeGreaterThan(0);
      expect(stampFn.indexOf('approvedAddressStillCurrent(trx')).toBeGreaterThan(stampFn.indexOf('.forUpdate()'));
      // A resumed activation hands the hook the same row shape the lazy rail does (callback / pricing / field-confirm).
      const resume = s.slice(s.indexOf('async function resumePendingHoldActivations'), s.indexOf('async function runOfficeConfirmActivation'));
      for (const col of ['ss.is_callback', 'ss.estimated_price', 'ss.field_confirmed_at', 'ss.customer_confirmed']) expect(resume).toContain(`'${col}'`);
      // The completed-and-field-confirmed visit (the tech stood at the property) is not bound.
      expect(s).toContain('officeApprovedHold = officeApproved;');
    });
  });

  test('both office-confirm routes record the witness in the approving transaction, before the transition', () => {
    for (const [file, before] of [['../routes/admin-dispatch.js', 'transition = await transitionJobStatus({'], ['../routes/admin-schedule.js', 'await transitionJobStatus({']]) {
      const s = read(file);
      const at = s.indexOf("require('../services/street-level-hold').recordApprovedAddressWitness(trx, svc.id)");
      expect(at).toBeGreaterThan(0);
      expect(s.slice(at - 300, at)).toContain("isOfficeReviewConfirm && svc.source_action === 'voice_agent' && svc.customer_confirmed !== true");
      expect(at).toBeLessThan(s.indexOf(before, at));
    }
    // admin-dispatch: after the expected-address check, so the witness is the address the office read back.
    const d = read('../routes/admin-dispatch.js');
    expect(d.indexOf('assertExpectedServiceAddress(trx')).toBeLessThan(d.indexOf('recordApprovedAddressWitness(trx'));
  });

  test('the activation guard consults the witness only for a confirmed (office-approved) hold, never for a performed completion', () => {
    const s = read('../services/outbound-review-confirm.js');
    expect(s).toContain("const officeApproved = row.status === 'confirmed' && await hasRecordedOfficeConfirm(db, serviceId);");
    expect(s).toContain('const addressVoided = officeApproved && !(await approvedAddressStillCurrent(db, serviceId));');
    expect(s).toContain("const approved = (row.status === 'completed' && !!row.field_confirmed_at) || (officeApproved && !addressVoided);");
  });
});
