/**
 * Per-channel short-link minting for the admin estimate send route
 * (routes/admin-estimates.js → sendEstimateNow — click-tracking round 7).
 *
 * Same class as round 6's estimate-follow-up.js fix, in the delivery route:
 * sendMethod='both' used to mint ONE short code tagged channel='sms' and
 * hand the same URL to both legs. The legs fail independently — the SMS
 * template can be missing/disabled, the SMS can be policy-blocked at send
 * time — and the click-followup candidate scan (services/click-followup.js)
 * admits sc.channel='sms' links only, so a click on an EMAIL-only delivery
 * would masquerade as an SMS click and queue a proactive SMS nudge. Pins:
 *   - sendMethod='both' with both handles → TWO mints, channel-tagged per
 *     leg, same purpose + linkage; the SMS template gets the sms-tagged URL
 *     and the email payload gets the email-tagged URL;
 *   - SMS leg fails (template missing) while email succeeds → the email
 *     that went out carries the EMAIL-tagged URL, never the sms-tagged one
 *     (the undelivered sms code is unclickable, so it can never seed the
 *     followup queue);
 *   - sendMethod='email' → NO sms-tagged mint exists at all;
 *   - sendMethod='sms' → no email-tagged mint.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  // The pre-delivery verdict check runs a short transaction on the same
  // connection shape.
  mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  // Channel-distinguishable URLs so the wiring (which leg got which link)
  // is observable downstream.
  shortenOrPassthrough: jest.fn(async (url, opts = {}) => `https://short.test/${opts.channel}`),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-synthetic-accepted' })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (_key, vars) => `SMS: ${vars.estimate_url}`),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => 'lead-9'),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(() => new Date('2026-08-04T00:00:00.000Z')),
  estimateViewUrl: jest.fn((token) => `https://portal.wavespestcontrol.com/estimate/${token}`),
  // REAL implementations — the pre-delivery revalidation and the
  // deferred-invalidation release below exercise these against the mocked db.
  staleCallLinkageReason: jest.requireActual('../services/admin-estimate-persistence').staleCallLinkageReason,
  completePendingInvalidation: jest.requireActual('../services/admin-estimate-persistence').completePendingInvalidation,
  takePendingInvalidation: jest.requireActual('../services/admin-estimate-persistence').takePendingInvalidation,
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-estimates');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const smsTemplates = require('../routes/admin-sms-templates');

function estimateRow(overrides = {}) {
  return {
    id: 'est-1',
    token: 'tok-1',
    status: 'sending', // route claims the row before calling sendEstimateNow
    customer_id: 'cust-1',
    customer_name: 'Dana Reyes',
    customer_phone: '+19415550101',
    customer_email: 'dana@example.com',
    monthly_total: '89',
    annual_total: '1068',
    estimate_data: null,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

// Minimal chainable builder: .first() resolves the estimate row (email leg
// fresh read + finalize snapshot/audit reads), .update() resolves 1 (the
// finalize claim write succeeds).
function makeBuilder(row) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereRaw', 'forUpdate', 'select', 'orderBy', 'limit']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(async () => row);
  b.update = jest.fn(async () => 1);
  return b;
}

function mintedChannels() {
  return shortenOrPassthrough.mock.calls.map(([, opts]) => opts.channel);
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => makeBuilder(estimateRow()));
  db.raw = jest.fn((expr) => expr);
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (fn) => fn(db));
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-synthetic-accepted' });
  smsTemplates.getTemplate.mockImplementation(async (_key, vars) => `SMS: ${vars.estimate_url}`);
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
});

describe('sendEstimateNow — durable first-delivery witness (#3391 round)', () => {
  // deliveryState.firstDeliveredAt is the click-mint delivery truth the
  // source-performance report and both watchers key on: stamped only for
  // REAL deliveries, carried across resends, and persisted even when a
  // concurrent accept wins the send claim.
  const deliveryPatches = () => db.raw.mock.calls
    .filter(([sql, bindings]) => /jsonb/.test(String(sql)) && Array.isArray(bindings))
    .map(([, bindings]) => { try { return JSON.parse(bindings[0]); } catch { return null; } })
    .filter((patch) => patch && patch.deliveryState);

  test('a real delivery stamps firstDeliveredAt', async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(true);
    const patches = deliveryPatches();
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0].deliveryState.firstDeliveredAt).toBeTruthy();
  });

  test('a resend carries the ORIGINAL firstDeliveredAt forward — sent_at inflation never reaches the witness', async () => {
    const first = '2026-07-02T09:00:00.000Z';
    const row = estimateRow({
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: first } }),
    });
    db.mockImplementation(() => makeBuilder(row));
    await router.sendEstimateNow(row, 'email');
    const patches = deliveryPatches();
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0].deliveryState.firstDeliveredAt).toBe(first);
  });

  test('a real delivery advances lastDeliveredAt; a suppressed-SMS-only attempt carries BOTH witnesses forward unchanged (audit on 573ee332e)', async () => {
    // The watchers compare lastDeliveredAt against their call/task
    // boundary — a suppressed attempt must advance neither sent_at nor
    // the witness, or a pre-promise delivery plus a suppressed
    // later attempt would falsely keep the promise.
    const first = '2026-07-02T09:00:00.000Z';
    const last = '2026-07-03T09:00:00.000Z';
    const row = estimateRow({
      customer_email: null, // sms-only attempt
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: first, lastDeliveredAt: last } }),
    });
    db.mockImplementation(() => makeBuilder(row));
    // A sentinel is an acknowledged suppression, not a provider handoff.
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'gate-blocked' });
    const result = await router.sendEstimateNow(row, 'sms');
    expect(result.sent).toBe(false);
    expect(result.channels.sms).toMatchObject({ ok: false, real: false, suppressed: true });
    // No publication write at all: both existing witnesses survive, and a
    // suppressed attempt cannot advance the linked lead or fulfill its ask.
    expect(deliveryPatches()).toHaveLength(0);
    expect(JSON.parse(row.estimate_data).deliveryState).toMatchObject({ firstDeliveredAt: first, lastDeliveredAt: last });
    expect(require('../services/lead-estimate-link').markLinkedLeadEstimateSent).not.toHaveBeenCalled();
  });

  test('a REAL group handoff appends each already-published sibling\'s frozen scope at the GROUP instant, pricing snapshot untouched (codex #3811 r34 P2)', async () => {
    // The triage sweep pairs a cited revision only with sibling revisions
    // of the same handoff instant; a sibling stamped only at its own
    // earlier send would drop out of a genuinely complete group quote.
    const anchor = estimateRow({ estimate_group_id: 'grp-1' });
    const frozenScope = { lines: [{ names: ['Lawn Care'], recurring: true, oneTime: false }], address: '77 Oak St, Bradenton, FL 34205', property: null };
    const earlier = '2026-06-01T09:00:00.000Z';
    const sibling = {
      id: 'est-sib', status: 'sent', estimate_group_id: 'grp-1',
      estimate_data: JSON.stringify({ sendSnapshot: { pricingBundle: { frozen: true }, scope: frozenScope, scopeHistory: [{ deliveredAt: earlier, scope: frozenScope }] } }),
    };
    // One builder shape for every query the group send issues: the live
    // (sent/viewed) sibling read resolves the sibling; the mid-send and
    // blocking-sibling probes and the claimable-sibling read find nothing.
    db.mockImplementation(() => {
      const b = makeBuilder(anchor);
      let live = false; let probe = false;
      b.where = jest.fn((clause) => { if (clause && typeof clause === 'object' && clause.estimate_group_id && clause.id !== anchor.id) probe = true; return b; });
      b.whereNot = jest.fn(() => b);
      b.whereRaw = jest.fn(() => b);
      b.modify = jest.fn((fn) => { fn(b); return b; });
      b.whereIn = jest.fn((col, vals) => { if (col === 'status' && vals.includes('viewed')) live = true; return b; });
      b.first = jest.fn(async () => (probe ? null : anchor));
      b.select = jest.fn(() => Promise.resolve(live ? [sibling] : []));
      b.then = (resolve, reject) => Promise.resolve(live ? [sibling] : []).then(resolve, reject);
      return b;
    });
    const result = await router.sendEstimateNow(anchor, 'email', { callerPreClaimed: true });
    expect(result.sent).toBe(true);
    const groupInstant = deliveryPatches()[0].deliveryState.lastDeliveredAt;
    expect(groupInstant).toBeTruthy();
    // The flag/expiry reconciliation still merges only the publisher id…
    const siblingPatch = db.raw.mock.calls
      .filter(([sql, bindings]) => /jsonb/.test(String(sql)) && Array.isArray(bindings))
      .map(([, bindings]) => { try { return JSON.parse(bindings[0]); } catch { return null; } })
      .find((patch) => patch && patch.groupPublishedByEstimateId === anchor.id);
    expect(siblingPatch).toEqual({ groupPublishedByEstimateId: anchor.id });
    // …and the scope stamp is ONE jsonb_set on the history key alone, at
    // the group instant, reading the row's own scope at write time — never
    // a rebuilt snapshot that could restore pricing a concurrent customer
    // selection dropped (codex r35 P1).
    const stamp = db.raw.mock.calls.find(([sql]) => /jsonb_set\(estimate_data, '\{sendSnapshot,scopeHistory\}'/.test(String(sql)));
    expect(stamp).toBeTruthy();
    expect(stamp[0]).toMatch(/estimate_data->'sendSnapshot'->'scope'\)/);
    expect(stamp[1]).toEqual([groupInstant, groupInstant, 25]);
    // Only the anchor's own finalize writes a snapshot; no sibling-bound JSON patch carries one.
    const siblingJsonPatches = db.raw.mock.calls.filter(([sql, bindings]) => /\|\| \?::jsonb/.test(String(sql)) && Array.isArray(bindings) && /groupPublishedByEstimateId/.test(String(bindings[0])));
    expect(siblingJsonPatches.length).toBe(1);
    expect(String(siblingJsonPatches[0][1][0])).not.toMatch(/sendSnapshot/);
    expect(sibling.estimate_data).toContain(earlier); // the fixture's own history was never rewritten client-side
  });

  test('a REAL provider send advances lastDeliveredAt past the prior stamp', async () => {
    const last = '2026-07-03T09:00:00.000Z';
    const row = estimateRow({
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: last, lastDeliveredAt: last } }),
    });
    db.mockImplementation(() => makeBuilder(row));
    await router.sendEstimateNow(row, 'email');
    const patches = deliveryPatches();
    expect(patches[0].deliveryState.firstDeliveredAt).toBe(last);
    expect(patches[0].deliveryState.lastDeliveredAt).not.toBe(last);
    expect(new Date(patches[0].deliveryState.lastDeliveredAt).getTime()).toBeGreaterThan(new Date(last).getTime());
  });

  test('losing the sending claim to a concurrent accept still persists the delivery witness (estimate_data-only merge)', async () => {
    const updatePayloads = [];
    db.mockImplementation(() => {
      const b = makeBuilder(estimateRow());
      // Every guarded update misses (the accept won the claim); the
      // witness merge is an unguarded estimate_data-only update.
      b.update = jest.fn(async (payload) => { updatePayloads.push(payload); return 0; });
      return b;
    });
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(true);
    expect(result.superseded).toBe(true);
    // A merge that touches ONLY estimate_data (+updated_at) — never
    // status/sent_at/expiry, which belong to the accepted state.
    const witnessMerge = updatePayloads.find((p) => p && p.estimate_data && !p.status && !p.sent_at);
    expect(witnessMerge).toBeTruthy();
    const patches = deliveryPatches();
    expect(patches.some((p) => p.deliveryState.firstDeliveredAt)).toBe(true);
    // ...and the scope this send delivered rides along, merged UNDER
    // sendSnapshot (the accepted row's bundle is not replaced) so the
    // triage sweep can pair it with the witness (pre-push hook P1 on
    // #3811 1b4240350).
    const scopeMerge = db.raw.mock.calls.find(([sql, bindings]) => /'\{sendSnapshot\}'/.test(String(sql)) && Array.isArray(bindings) && bindings.length === 2);
    expect(scopeMerge).toBeTruthy();
    expect(JSON.parse(scopeMerge[1][0]).deliveryState.firstDeliveredAt).toBeTruthy();
    const scope = { lines: [{ names: [], recurring: true, oneTime: false }], address: null, property: null };
    // The scope rides with its revision history — one entry per real
    // delivery, stamped with the handoff time (codex #3811 r32 P2).
    expect(JSON.parse(scopeMerge[1][1])).toEqual({ scope, scopeHistory: [{ deliveredAt: expect.any(String), scope }] });
  });
});

describe('sendEstimateNow — per-channel tracked links (round 7)', () => {
  test("sendMethod='both': two mints, sms leg texts the sms-tagged URL, email carries the email-tagged URL", async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'both');

    expect(result.sent).toBe(true);
    expect(result.sentChannels.sort()).toEqual(['email', 'sms']);

    // One mint per leg, both with the same purpose + linkage.
    expect(shortenOrPassthrough).toHaveBeenCalledTimes(2);
    expect(mintedChannels().sort()).toEqual(['email', 'sms']);
    for (const [, opts] of shortenOrPassthrough.mock.calls) {
      expect(opts).toMatchObject({
        kind: 'estimate',
        entityType: 'estimates',
        entityId: 'est-1',
        customerId: 'cust-1',
        leadId: 'lead-9',
        purpose: 'estimate_send',
      });
    }

    // SMS body renders from the sms-tagged link…
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'SMS: https://short.test/sms',
    }));
    // …and the email payload carries the email-tagged link, never the sms one.
    const emailPayload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(emailPayload.estimate_url).toBe('https://short.test/email');
  });

  test('SMS template missing on both-send: email still goes out with the EMAIL-tagged URL only', async () => {
    smsTemplates.getTemplate.mockResolvedValue(null); // template disabled/missing

    const result = await router.sendEstimateNow(estimateRow(), 'both');

    expect(result.sent).toBe(true);
    expect(result.partialFailure).toBe(true);
    expect(result.sentChannels).toEqual(['email']);
    expect(result.failedChannels).toEqual(['sms']);
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // The delivered email carries its own email-tagged code — a click on it
    // can never masquerade as an SMS click (the sms code was never sent).
    const emailPayload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(emailPayload.estimate_url).toBe('https://short.test/email');
    expect(JSON.stringify(emailPayload)).not.toContain('https://short.test/sms');
  });

  test("sendMethod='email': no sms-tagged code is ever minted", async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'email');

    expect(result.sent).toBe(true);
    expect(mintedChannels()).toEqual(['email']);
  });

  test("sendMethod='sms': no email-tagged code is ever minted", async () => {
    const result = await router.sendEstimateNow(estimateRow(), 'sms');

    expect(result.sent).toBe(true);
    expect(mintedChannels()).toEqual(['sms']);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'SMS: https://short.test/sms',
    }));
  });
});

describe('sendEstimateNow — pre-delivery call-linkage revalidation (PR #3304 r21)', () => {
  // Engine-drafted row whose durable linkage is re-resolved inside the
  // locked verdict transaction: the call processor can commit a corrected
  // stamp BEFORE its reconcile archives the draft, so the marker check
  // alone would deliver the former lead's content.
  function engineRow() {
    return estimateRow({
      estimate_data: JSON.stringify({
        lead_id: 'lead-A',
        lead_linkage: 'stamp',
        estimatorEngine: { callLogId: 'call-1' },
      }),
    });
  }

  function mockTables({ callRow, leadRows }) {
    const estimateUpdates = [];
    db.mockImplementation((table) => {
      const b = makeBuilder(engineRow());
      if (table === 'call_log') b.first = jest.fn(async () => callRow);
      if (table === 'leads') {
        b.first = jest.fn(async () => {
          // The revalidation queries leads by sid or by stamped id; the
          // fixture answers by stamp target existence only.
          return leadRows.length ? leadRows[0] : undefined;
        });
      }
      if (table === 'estimates') {
        b.update = jest.fn(async (r) => { estimateUpdates.push(r); return 1; });
      }
      return b;
    });
    return estimateUpdates;
  }

  test('a settled stamp now pointing at a DIFFERENT lead aborts before any provider call', async () => {
    const estimateUpdates = mockTables({
      callRow: {
        twilio_call_sid: null,
        metadata: { lead_id: 'lead-B' },
        processing_token: null,
        processing_status: 'processed',
      },
      leadRows: [{ id: 'lead-B' }],
    });

    await expect(router.sendEstimateNow(engineRow(), 'both')).rejects.toMatchObject({ statusCode: 409 });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(estimateUpdates.some((r) => r.last_send_error === 'call_linkage_changed_before_delivery')).toBe(true);
  });

  test('a call mid-reprocess (live processing_token) aborts — the verdict is about to change', async () => {
    const estimateUpdates = mockTables({
      callRow: {
        twilio_call_sid: null,
        metadata: { lead_id: 'lead-A' },
        processing_token: 'tok-live',
        processing_status: 'processing',
      },
      leadRows: [{ id: 'lead-A' }],
    });

    await expect(router.sendEstimateNow(engineRow(), 'both')).rejects.toMatchObject({ statusCode: 409 });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(estimateUpdates.some((r) => r.last_send_error === 'call_reprocessing_before_delivery')).toBe(true);
  });

  test('an unchanged settled linkage proceeds to delivery', async () => {
    mockTables({
      callRow: {
        twilio_call_sid: null,
        metadata: { lead_id: 'lead-A' },
        processing_token: null,
        processing_status: 'processed',
      },
      leadRows: [{ id: 'lead-A' }],
    });

    const result = await router.sendEstimateNow(engineRow(), 'both');

    expect(result.sent).toBe(true);
    expect(result.sentChannels.sort()).toEqual(['email', 'sms']);
  });

  // Stateful estimates row: updates land on a live row object so later
  // reads (pre-handoff re-check, claim release) see what the verdict stamp
  // and the (simulated) reconciler deferral actually wrote.
  function statefulMock({ liveLead = 'lead-A' } = {}) {
    const state = { row: engineRow(), liveLead };
    const estimateUpdates = [];
    const leadUpdates = [];
    db.mockImplementation((table) => {
      const b = makeBuilder(state.row);
      if (table === 'call_log') {
        // The call's LIVE linkage. When it has moved off the draft's lead,
        // a deferred invalidation is current; when it still names the
        // draft's lead, the deferred verdict is obsolete and the release
        // discards it instead (codex P2, PR #3304 GH r8).
        b.first = jest.fn(async () => ({
          twilio_call_sid: null,
          metadata: { lead_id: state.liveLead },
          processing_token: null,
          processing_status: 'processed',
        }));
      }
      if (table === 'leads') {
        b.first = jest.fn(async () => ({ id: state.liveLead }));
        b.update = jest.fn(async (r) => { leadUpdates.push(r); return 1; });
      }
      if (table === 'estimates') {
        b.first = jest.fn(async () => ({ ...state.row }));
        b.update = jest.fn(async (r) => {
          estimateUpdates.push(r);
          // Plain-value writes only — the finalize claim write patches
          // estimate_data/status with raw SQL expressions this stateful
          // mock can't evaluate.
          if (typeof r.estimate_data === 'string' && r.estimate_data.trim().startsWith('{')) {
            state.row = { ...state.row, estimate_data: r.estimate_data };
          }
          if (typeof r.status === 'string' && /^[a-z_]+$/.test(r.status)) {
            state.row = { ...state.row, status: r.status };
          }
          if (r.archived_at !== undefined) state.row = { ...state.row, archived_at: r.archived_at };
          return 1;
        });
      }
      return b;
    });
    return { state, estimateUpdates, leadUpdates };
  }

  function injectPendingMarker(state, extra = {}) {
    const data = JSON.parse(state.row.estimate_data);
    data.estimatorEngine.invalidation_pending_at = new Date().toISOString();
    data.estimatorEngine.invalidation_pending_from = 'lead-A';
    data.estimatorEngine.invalidation_pending_to = 'lead-C';
    state.row = { ...state.row, estimate_data: JSON.stringify(data), ...extra };
  }

  test('the send snapshot freezes the delivered scope — priced lines at their cadence and the address (codex r25 P1 on #3811)', async () => {
    // The triage sweep binds a quote_promised card to THIS stamp, never to
    // the live row a later in-place re-author may have widened.
    const snapshot = await router.buildEstimateSendSnapshot(estimateRow({ service_interest: 'Pest Control', address: '77 Oak St, Bradenton, FL 34205' }));
    expect(snapshot.sendSnapshot.scope).toEqual({
      lines: [{ names: expect.arrayContaining(['Pest Control']), recurring: true, oneTime: false }],
      address: '77 Oak St, Bradenton, FL 34205',
      property: null,
    });
    // A suppressed attempt (nothing really handed off — lastDeliveredAt
    // stays) carries the PRIOR send's stamp forward untouched, and stamps
    // nothing where there was none (pre-push hook P1).
    const prior = { lines: [{ names: ['Lawn Care'], recurring: false, oneTime: true }], address: '5 Pine Ave, Sarasota, FL 34236', property: null };
    const suppressed = await router.buildEstimateSendSnapshot(estimateRow({ service_interest: 'Pest Control', address: '77 Oak St, Bradenton, FL 34205', estimate_data: JSON.stringify({ sendSnapshot: { scope: prior } }) }), undefined, { delivered: false });
    expect(suppressed.sendSnapshot.scope).toEqual(prior);
    const neverDelivered = await router.buildEstimateSendSnapshot(estimateRow({ service_interest: 'Pest Control' }), undefined, { delivered: false });
    expect(neverDelivered.sendSnapshot.scope).toBeUndefined();
  });

  test('a PENDING invalidation recorded during delivery is COMPLETED by the claim release', async () => {
    const { state, estimateUpdates, leadUpdates } = statefulMock();
    // Mid-delivery, the reconciler defers behind the live claim by writing
    // the pending marker (claim keys preserved — it never touches them),
    // and the call's live linkage really did move to lead-C.
    sendCustomerMessage.mockImplementation(async () => {
      injectPendingMarker(state);
      state.liveLead = 'lead-C';
      return { sent: true, providerMessageId: 'SM-synthetic-accepted' };
    });

    const result = await router.sendEstimateNow(engineRow(), 'sms');
    expect(result.sent).toBe(true);

    // The release consumed the pending marker into the full invalidation.
    const final = JSON.parse(state.row.estimate_data);
    expect(final.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    expect(final.estimatorEngine.linkage_invalidated_from).toBe('lead-A');
    expect(final.estimatorEngine.linkage_invalidated_to).toBe('lead-C');
    expect(final.estimatorEngine.invalidation_pending_at).toBeUndefined();
    expect(final.estimatorEngine.delivering_token).toBeUndefined();
    expect(final.lead_id).toBeUndefined();
    expect(final.lead_linkage).toBeUndefined();
    const finalWrite = estimateUpdates[estimateUpdates.length - 1];
    expect(finalWrite.archived_at).toBeTruthy();
    expect(finalWrite.status).toBe('draft');
    expect(finalWrite.scheduled_at).toBeNull();
    // Old-lead unlink rode the same transaction.
    expect(leadUpdates).toContainEqual({ estimate_id: null });
  });

  test('a pending marker landing between verdict and handoff BLOCKS the provider call (PR #3304 r23)', async () => {
    const { state } = statefulMock();
    // The marker commits after the verdict transaction released its lock
    // but before the SMS provider handoff — simulated inside template
    // render, which runs between the two.
    smsTemplates.getTemplate.mockImplementation(async (_key, vars) => {
      injectPendingMarker(state);
      return `SMS: ${vars.estimate_url}`;
    });

    const result = await router.sendEstimateNow(engineRow(), 'sms');

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
    expect(result.channels.sms.ok).toBe(false);
    expect(result.channels.sms.error).toBe('invalidated_before_delivery');
  });

  test('an OBSOLETE pending verdict is DISCARDED — a later retry restored the recorded linkage (GH r8)', async () => {
    const { state, estimateUpdates } = statefulMock();
    // The marker records A→C, but by release time the call's live linkage
    // resolves to lead-A again (a second retry moved it back). Finalizing
    // would kill a VALID linkage, so the marker is dropped instead.
    sendCustomerMessage.mockImplementation(async () => {
      injectPendingMarker(state);
      return { sent: true, providerMessageId: 'SM-synthetic-accepted' };
    });

    const result = await router.sendEstimateNow(engineRow(), 'sms');
    expect(result.sent).toBe(true);

    const final = JSON.parse(state.row.estimate_data);
    expect(final.estimatorEngine.linkage_invalidated_at).toBeUndefined();
    expect(final.estimatorEngine.invalidation_pending_at).toBeUndefined();
    expect(final.estimatorEngine.delivering_token).toBeUndefined();
    expect(final.lead_id).toBe('lead-A');
    const releaseWrite = estimateUpdates[estimateUpdates.length - 1];
    expect(releaseWrite.archived_at).toBeUndefined();
    expect(releaseWrite.status).toBeUndefined();
  });

  test('a terminal status reached before the release gets a MARKER-ONLY invalidation — status and money preserved (PR #3304 r26)', async () => {
    const { state, estimateUpdates } = statefulMock();
    // Deferral lands mid-delivery AND the customer accept races in before
    // the release transaction runs (belt-and-suspenders: the public gates
    // reject pending rows, but the release must still never rewrite a
    // money-bearing terminal's status — while the marker must still land,
    // or the permanent public token keeps serving wrong-lead content).
    sendCustomerMessage.mockImplementation(async () => {
      injectPendingMarker(state, { status: 'accepted' });
      state.liveLead = 'lead-C';
      return { sent: true, providerMessageId: 'SM-synthetic-accepted' };
    });

    const result = await router.sendEstimateNow(engineRow(), 'sms');
    expect(result.sent).toBe(true);

    const final = JSON.parse(state.row.estimate_data);
    // Full marker applied, linkage keys removed — the public token dies.
    expect(final.estimatorEngine.linkage_invalidated_at).toBeTruthy();
    expect(final.estimatorEngine.invalidation_pending_at).toBeUndefined();
    expect(final.estimatorEngine.delivering_token).toBeUndefined();
    expect(final.lead_id).toBeUndefined();
    // Status, archive state, and money fields untouched by the release.
    const releaseWrite = estimateUpdates[estimateUpdates.length - 1];
    expect(releaseWrite.archived_at).toBeUndefined();
    expect(releaseWrite.status).toBeUndefined();
    expect(state.row.status).toBe('accepted');
  });
});
