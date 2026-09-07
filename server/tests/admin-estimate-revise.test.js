jest.mock('../models/db', () => jest.fn());
// Gate values are fixed at module load; this passthrough flips the one gate
// under test (send-requires-server-pricing revise refusal) per case.
const mockGateState = { sendRequiresServerPricing: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => (gate === 'sendRequiresServerPricing'
      ? mockGateState.sendRequiresServerPricing
      : actual.isEnabled(gate)),
  };
});

const {
  estimateReviseBlock,
  reviseAdminEstimate,
  estimateEditVersion,
} = require('../services/admin-estimate-persistence');
const { clearAllEstimatePricingCache } = require('../services/estimate-pricing-cache');

// Force the CLIENT_FALLBACK pricing path so tests exercise the revise
// plumbing (guards, preserved columns, atomic update) without needing a
// syncable pricing engine or a real customer-services lookup.
const noRecompute = async () => ({ recomputed: false, reason: 'NO_INPUTS' });

// Pin the clock inside the fixture's validity window (sent 07-09, expires
// 07-16) — the expiry guard compares against `now`, so real-clock tests would
// start failing the day the fixture's expires_at passes.
const fixedNow = () => new Date('2026-07-10T12:00:00Z');

// Default linked-customer row matches the sentEstimate fixture's contact, so
// contact-preserving revises pass the customer revalidation guard untouched.
const matchingCustomer = {
  id: 'cust-9',
  phone: '9415550102',
  email: 'beverly@example.com',
};

function makeReviseDatabase({
  estimate,
  lead = null,
  customer = matchingCustomer,
  updateReturnsEmpty = false,
  // The row the FOR UPDATE read inside the write transaction sees — lets a
  // test model a send committing between the pre-read and the lock.
  lockedEstimate = null,
  // What the scheduled-group guard's sibling lookup returns (a scheduled
  // member of this row's group), if anything.
  scheduledGroupMember = null,
  // What the mid-send guard's lookup returns (a member currently 'sending').
  sendingGroupMember = null,
  // The call row the unit-hold check reads (call_log.metadata.unit_answer).
  callRow = null,
}) {
  const updates = [];
  const rawGuards = [];
  const groupedWheres = [];
  const database = (table) => {
    if (table === 'call_log') {
      const callChain = { where: () => callChain, first: async () => callRow };
      return callChain;
    }
    if (table === 'customers') {
      let clause = null;
      const customerChain = {
        where: (c) => {
          clause = c;
          return customerChain;
        },
        first: async () => {
          if (!customer) return null;
          return String(customer.id) === String(clause?.id) ? customer : null;
        },
      };
      return customerChain;
    }
    if (table === 'leads') {
      // FK lookup passes { estimate_id }; the mirror lookup passes { id }.
      let clause = null;
      const leadChain = {
        where: (c) => {
          clause = c;
          return leadChain;
        },
        whereNull: () => leadChain,
        first: async () => {
          if (!lead) return null;
          if (clause?.estimate_id !== undefined) {
            return String(lead.estimate_id || '') === String(clause.estimate_id) ? lead : null;
          }
          if (clause?.id !== undefined) {
            return String(lead.id) === String(clause.id) ? lead : null;
          }
          return null;
        },
      };
      return leadChain;
    }
    if (String(table).startsWith('scheduled_services')) {
      // The setup-waiver evidence read is UNGATED since codex #3591 r73 P1
      // (planGate: false): it reaches the live rows even for a non-member
      // customer, so the fake must serve an empty account instead of
      // throwing (a real lookup failure here 503s the save by design).
      // leftJoin + the aliased table name serve the canonical catalog join
      // the waiver read runs regardless of the auto-tier gate (r79 P1).
      const rowsChain = {
        where: () => rowsChain,
        whereNotIn: () => rowsChain,
        whereNull: () => rowsChain,
        leftJoin: () => rowsChain,
        columnInfo: async () => ({ is_recurring: {} }),
        select: async () => [],
        first: async () => null,
      };
      return rowsChain;
    }
    if (table !== 'estimates') {
      // Any side lookup (prior qualifying services, pricing sync) is
      // best-effort in the pipeline — throwing here proves the fallback path.
      throw new Error(`unexpected table ${table}`);
    }
    const chain = {
      // The expiry mirror is a grouped where (whereNull OR >) — record the
      // callback so tests can replay it against a recorder and assert the
      // predicate without a real query builder.
      where: (clause) => {
        if (typeof clause === 'function') {
          if (chain.__groupQuery) {
            // The in-flight verdict is a grouped where: status = 'sending'
            // OR a fresh delivery claim. Replay it against a recorder so the
            // fixture served depends on the predicate actually written.
            const sub = {
              where: (c) => { if (c && typeof c === 'object' && c.status) chain.__groupStatus = c.status; return sub; },
              orWhereRaw: (sql) => { chain.__inFlightRaw = sql; return sub; },
            };
            clause(sub);
          } else {
            groupedWheres.push(clause);
          }
        }
        if (clause && typeof clause === 'object' && 'estimate_group_id' in clause) { chain.__groupQuery = true; chain.__groupStatus = clause.status; }
        return chain;
      },
      whereNot: () => chain,
      whereNull: () => chain,
      whereNotIn: () => chain,
      whereRaw: (sql) => {
        rawGuards.push(sql);
        return chain;
      },
      forUpdate: () => { chain.__locked = true; return chain; },
      modify: (fn) => { fn(chain); return chain; },
      first: async () => {
        if (chain.__groupQuery) {
          return chain.__groupStatus === 'sending' ? sendingGroupMember : scheduledGroupMember;
        }
        return chain.__locked && lockedEstimate ? lockedEstimate : estimate;
      },
      update: (patch) => {
        updates.push(patch);
        return {
          returning: async () => (updateReturnsEmpty ? [] : [{ ...estimate, ...patch }]),
        };
      },
    };
    return chain;
  };
  // The atomic revise (guarded UPDATE + learning-loop baseline capture)
  // runs inside database.transaction — reuse the same recording builder as
  // the trx so assertions see the guarded update unchanged.
  database.transaction = async (callback) => callback(database);
  // The scheduled-group guard takes the group's advisory xact lock.
  database.raw = jest.fn(async () => ({}));
  return { database, updates, rawGuards, groupedWheres };
}

const sentEstimate = {
  id: 'est-1',
  token: 'tok-abc123',
  status: 'sent',
  customer_id: 'cust-9',
  customer_name: 'Beverly Carter',
  customer_phone: '(941) 555-0102',
  customer_email: 'beverly@example.com',
  address: '456 Gulf Dr',
  satellite_url: 'https://maps.example.com/sat.png',
  price_locked_at: null,
  archived_at: null,
  sent_at: '2026-07-09T14:00:00Z',
  expires_at: '2026-07-16T14:00:00Z',
  created_by_technician_id: 'tech-1',
  estimate_data: JSON.stringify({
    inputs: { address: '456 Gulf Dr', svcPest: true },
    result: { recurring: { grandTotal: 48, services: [{ service: 'pest_control', name: 'Pest Control', mo: 48 }] } },
    engineRequest: { profile: { homeSqFt: 1800 }, selectedServices: ['PEST'], options: {} },
    sendSnapshot: { renderedAt: '2026-07-09T14:00:00Z', pricingBundle: { stale: true } },
    preferences: { interiorService: false },
  }),
};

const reviseBody = {
  address: '456 Gulf Dr',
  customerName: 'Beverly Carter',
  customerPhone: '(941) 555-0102',
  customerEmail: 'beverly@example.com',
  customerId: null,
  estimateData: {
    inputs: { address: '456 Gulf Dr', svcPest: true, svcLawn: true },
    result: {
      recurring: {
        grandTotal: 132,
        services: [
          { service: 'pest_control', name: 'Pest Control', mo: 48 },
          { service: 'lawn_care', name: 'Lawn Care', mo: 84 },
        ],
      },
    },
    engineRequest: { profile: { homeSqFt: 1800 }, selectedServices: ['PEST', 'LAWN'], options: {} },
  },
  monthlyTotal: 132,
  annualTotal: 1584,
  onetimeTotal: 0,
  waveguardTier: 'Silver',
  notes: 'Added lawn care per customer request',
  satelliteUrl: null,
  showOneTimeOption: false,
  billByInvoice: false,
};

describe('estimateReviseBlock', () => {
  test.each(['draft', 'scheduled', 'sent', 'viewed', 'send_failed'])(
    'status %s is editable',
    (status) => {
      expect(estimateReviseBlock({ status, price_locked_at: null, archived_at: null })).toBeNull();
    },
  );

  test.each([
    ['accepted', 409],
    ['declined', 409],
    ['expired', 409],
    ['sending', 409],
  ])('status %s blocks with %s', (status, statusCode) => {
    const block = estimateReviseBlock({ status, price_locked_at: null, archived_at: null });
    expect(block).not.toBeNull();
    expect(block.statusCode).toBe(statusCode);
  });

  test('price lock blocks even on an otherwise-editable status', () => {
    const block = estimateReviseBlock({ status: 'sent', price_locked_at: '2026-07-09T15:00:00Z', archived_at: null });
    expect(block.statusCode).toBe(409);
    expect(block.message).toMatch(/price-locked/);
  });

  test('archived rows block with 400', () => {
    const block = estimateReviseBlock({ status: 'sent', price_locked_at: null, archived_at: '2026-07-09T15:00:00Z' });
    expect(block.statusCode).toBe(400);
    expect(block.message).toMatch(/archived/i);
  });

  test('commercial proposals route to the proposal editor', () => {
    const block = estimateReviseBlock(
      { status: 'sent', price_locked_at: null, archived_at: null },
      { proposal: { enabled: true } },
    );
    expect(block.statusCode).toBe(400);
    expect(block.message).toMatch(/commercial proposal/i);
  });

  test('date-expired rows block with 409 even before the worker flips status', () => {
    const block = estimateReviseBlock(
      { status: 'sent', price_locked_at: null, archived_at: null, expires_at: '2026-07-09T14:00:00Z' },
      undefined,
      new Date('2026-07-10T12:00:00Z'),
    );
    expect(block).not.toBeNull();
    expect(block.statusCode).toBe(409);
    expect(block.message).toMatch(/expiration/i);
  });

  test('a future expiry stays editable', () => {
    expect(estimateReviseBlock(
      { status: 'sent', price_locked_at: null, archived_at: null, expires_at: '2026-07-16T14:00:00Z' },
      undefined,
      new Date('2026-07-10T12:00:00Z'),
    )).toBeNull();
  });

  test('parses stringified estimate_data when no parsed blob is supplied', () => {
    const block = estimateReviseBlock({
      status: 'sent',
      price_locked_at: null,
      archived_at: null,
      estimate_data: JSON.stringify({ proposal: { enabled: true } }),
    });
    expect(block).not.toBeNull();
    expect(block.message).toMatch(/commercial proposal/i);
  });
});

describe('reviseAdminEstimate', () => {
  test('rejects an older editor snapshot without writing', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({ database, estimateId: 'est-1',
      body: { ...reviseBody, expectedEditVersion: estimateEditVersion({ ...sentEstimate, notes: 'prior scope' }) },
      technicianId: 'tech-2', recompute: noRecompute, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('rechecks the editor snapshot under the existing row lock', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate,
      lockedEstimate: { ...sentEstimate, notes: 'Newer customer-visible scope' },
    });
    await expect(reviseAdminEstimate({ database, estimateId: 'est-1',
      body: { ...reviseBody, expectedEditVersion: estimateEditVersion(sentEstimate) },
      technicianId: 'tech-2', recompute: noRecompute, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  beforeEach(() => {
    clearAllEstimatePricingCache();
  });

  test('revises a sent estimate in place without touching identity/lifecycle columns', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    const { estimate } = await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      technicianId: 'tech-2',
      recompute: noRecompute,
      now: fixedNow,
    });

    expect(updates).toHaveLength(1);
    const patch = updates[0];
    // Identity + lifecycle stay owned by the row.
    expect(patch).not.toHaveProperty('token');
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('expires_at');
    expect(patch).not.toHaveProperty('created_by_technician_id');
    // Quote content is replaced.
    expect(patch.monthly_total).toBe(132);
    expect(patch.annual_total).toBe(1584);
    const data = JSON.parse(patch.estimate_data);
    expect(data.inputs.svcLawn).toBe(true);
    expect(data.result.recurring.services).toHaveLength(2);
    // The stale send snapshot + customer preferences described the previous
    // quote and must not survive the revise.
    expect(data.sendSnapshot).toBeUndefined();
    expect(data.preferences).toBeUndefined();
    expect(estimate.id).toBe('est-1');
    expect(estimate.token).toBe('tok-abc123');
    expect(estimate.status).toBe('sent');
  });

  test('a clarify re-price marker stamped between the pre-read and the row lock survives the rewrite; the revision reports only the attempt it observed before recomputing', async () => {
    const withMarker = (row, attempt) => {
      const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : { ...(row.estimate_data || {}) };
      return { ...row, estimate_data: JSON.stringify({ ...data, estimatorEngine: { ...(data.estimatorEngine || {}), callLogId: 'call-1', reprice_pending_at: '2026-09-03T12:00:00Z', reprice_attempt: attempt } }) };
    };
    // Pre-read clean, a reply stamps the guard before the FOR UPDATE read.
    let db1 = makeReviseDatabase({ estimate: sentEstimate, lockedEstimate: withMarker(sentEstimate, 'att-new') });
    let out = await reviseAdminEstimate({ database: db1.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow });
    let eng = JSON.parse(db1.updates[0].estimate_data).estimatorEngine;
    expect(eng.reprice_pending_at).toBe('2026-09-03T12:00:00Z');
    expect(eng.reprice_attempt).toBe('att-new');
    expect(out.observedRepriceAttempt).toBeNull();
    // Pre-read already guarded: that attempt is the one this revision priced in — lifted INSIDE the locked write.
    const guarded = withMarker(sentEstimate, 'att-seen');
    db1 = makeReviseDatabase({ estimate: guarded, lockedEstimate: guarded });
    out = await reviseAdminEstimate({ database: db1.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow });
    expect(out.observedRepriceAttempt).toBe('att-seen');
    eng = JSON.parse(db1.updates[0].estimate_data).estimatorEngine;
    expect(eng.reprice_pending_at).toBeUndefined();
    expect(eng.reprice_attempt).toBeUndefined();
    expect(eng.callLogId).toBe('call-1');
    // A UNIT hold (the call carries a fence) is lifted only once the revised address carries the unit.
    const FENCE = { unit: 'Apt 204', building: { street_line_1: '1048 Example Lakes Cir', city: 'Sarasota', postal_code: '34232' } };
    const heldRow = { ...guarded, address: '1048 Example Lakes Cir, Sarasota, FL 34232' };
    db1 = makeReviseDatabase({ estimate: heldRow, lockedEstimate: heldRow, callRow: { metadata: { unit_answer: FENCE } } });
    out = await reviseAdminEstimate({ database: db1.database, estimateId: 'est-1', body: { ...reviseBody, address: '1048 Example Lakes Cir, Sarasota, FL 34232' }, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow });
    eng = JSON.parse(db1.updates[0].estimate_data).estimatorEngine;
    expect(eng.reprice_attempt).toBe('att-seen');
    expect(eng.reprice_pending_at).toBe('2026-09-03T12:00:00Z');
    db1 = makeReviseDatabase({ estimate: heldRow, lockedEstimate: heldRow, callRow: { metadata: { unit_answer: FENCE } } });
    out = await reviseAdminEstimate({ database: db1.database, estimateId: 'est-1', body: { ...reviseBody, address: '1048 Example Lakes Cir Apt 204, Sarasota, FL 34232' }, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow });
    eng = JSON.parse(db1.updates[0].estimate_data).estimatorEngine;
    expect(eng.reprice_pending_at).toBeUndefined();
    // Observed one attempt, the locked row carries a NEWER one: preserved, not lifted.
    db1 = makeReviseDatabase({ estimate: withMarker(sentEstimate, 'att-seen'), lockedEstimate: withMarker(sentEstimate, 'att-newer') });
    out = await reviseAdminEstimate({ database: db1.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow });
    eng = JSON.parse(db1.updates[0].estimate_data).estimatorEngine;
    expect(eng.reprice_attempt).toBe('att-newer');
    expect(eng.reprice_pending_at).toBe('2026-09-03T12:00:00Z');
  });

  test('preserves existing customer linkage and satellite snapshot when the body omits them', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerId: null, satelliteUrl: null },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates[0].customer_id).toBe('cust-9');
    expect(updates[0].satellite_url).toBe('https://maps.example.com/sat.png');
  });

  test('404s when the estimate does not exist', async () => {
    const { database } = makeReviseDatabase({ estimate: null });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'missing',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('409s on an accepted estimate without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: { ...sentEstimate, status: 'accepted', price_locked_at: '2026-07-09T15:00:00Z' },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('400s on an archived estimate without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: { ...sentEstimate, archived_at: '2026-07-09T15:00:00Z' },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toHaveLength(0);
  });

  test('400s on a commercial proposal without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: {
        ...sentEstimate,
        estimate_data: JSON.stringify({ proposal: { enabled: true, buildings: [] } }),
      },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toHaveLength(0);
  });

  test('409s when the guarded update loses to a concurrent lock', async () => {
    const { database } = makeReviseDatabase({ estimate: sentEstimate, updateReturnsEmpty: true });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('400s when the revise body carries no estimateData', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, estimateData: null },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toHaveLength(0);
  });

  test('a click-mint revise keeps the zero-comms marker and lineage but INVALIDATES the offer fingerprint (#3391 audit P0)', async () => {
    const clickMint = {
      ...sentEstimate,
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        noEngagementAutomation: true,
        reportCtaMint: {
          serviceKey: 'pest_control',
          serviceRecordId: 'sr-1',
          requestId: 'req-1',
          fingerprint: 'fp-card-1',
          mintedAt: '2026-08-13T00:00:00.000Z',
        },
      }),
    };
    const { database, updates } = makeReviseDatabase({ estimate: clickMint });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    const data = JSON.parse(updates[0].estimate_data);
    // The zero-comms contract survives — a revise must never re-enable
    // automated outreach on the lane that promises none.
    expect(data.noEngagementAutomation).toBe(true);
    // Lineage survives (reuse/supersession resolves through it) …
    expect(data.reportCtaMint.serviceKey).toBe('pest_control');
    expect(data.reportCtaMint.mintedAt).toBe('2026-08-13T00:00:00.000Z');
    // … but the fingerprint does NOT: staff changed the terms, so a later
    // identical card tap must supersede this row, never reuse it.
    expect(data.reportCtaMint.fingerprint).toBeUndefined();
    expect(data.reportCtaMint.fingerprintInvalidatedAt).toBeTruthy();
  });

  test('a click-mint revise preserves the delivery witness — a DELIVERED mint must not become "unsent" (audit on 573ee332e P1)', async () => {
    // The witness (firstDeliveredAt / lastDeliveredAt) is what the
    // source-performance report and both watcher predicates key on; a
    // revise replaces estimate_data wholesale and never authors delivery
    // state, so the prior row's is authoritative (prior-wins).
    const deliveredMint = {
      ...sentEstimate,
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        noEngagementAutomation: true,
        reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-card-1' },
        deliveryState: {
          firstDeliveredAt: '2026-08-13T01:00:00.000Z',
          lastDeliveredAt: '2026-08-13T02:00:00.000Z',
          sentChannels: ['email'],
          channels: { email: { ok: true, provider: 'email' } },
        },
      }),
    };
    const { database, updates } = makeReviseDatabase({ estimate: deliveredMint });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    const data = JSON.parse(updates[0].estimate_data);
    expect(data.deliveryState.firstDeliveredAt).toBe('2026-08-13T01:00:00.000Z');
    expect(data.deliveryState.lastDeliveredAt).toBe('2026-08-13T02:00:00.000Z');
  });

  test('the witness merge is MONOTONIC — the locked row\'s newer delivery state beats a stale pre-lock copy (audit on bf357980f P1)', async () => {
    // preserveClickMintMarkersAcrossRevise runs once pre-lock and again
    // against the locked re-read; a resend finishing in between means the
    // pending payload already carries the OLDER witness, and undefined-only
    // preservation would let the revision overwrite the new one.
    const { preserveClickMintMarkersAcrossRevise } = require('../services/admin-estimate-persistence');
    const mark = { serviceKey: 'pest_control' };
    const stale = { firstDeliveredAt: '2026-08-13T01:00:00.000Z', lastDeliveredAt: '2026-08-13T02:00:00.000Z' };
    const fresh = { firstDeliveredAt: '2026-08-13T01:00:00.000Z', lastDeliveredAt: '2026-08-13T06:00:00.000Z' };
    // Locked row (prior) newer → wins over the stale pre-lock copy.
    const next1 = { reportCtaMint: mark, deliveryState: { ...stale } };
    preserveClickMintMarkersAcrossRevise(next1, { reportCtaMint: mark, deliveryState: fresh });
    expect(next1.deliveryState.lastDeliveredAt).toBe('2026-08-13T06:00:00.000Z');
    // Pending payload already newer (prior stale) → kept, never regressed.
    const next2 = { reportCtaMint: mark, deliveryState: { ...fresh } };
    preserveClickMintMarkersAcrossRevise(next2, { reportCtaMint: mark, deliveryState: stale });
    expect(next2.deliveryState.lastDeliveredAt).toBe('2026-08-13T06:00:00.000Z');
  });

  test('a plan_restart quote refuses in-place revision — scope is the cancellation\'s, price is always the mint\'s (codex GH r16+r17 P1 on #3671)', async () => {
    // A wholesale rewrite either dropped planRestart (bricked acceptance)
    // or, force-preserved, let a changed composition restart work outside
    // the cancellation scope — so the revise gate refuses the source
    // outright, and the builder preflight surfaces the same message.
    const restartRow = {
      ...sentEstimate,
      source: 'plan_restart',
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        planRestart: { families: ['pest_control'], cancellationCaseId: 'case-3', cancellationRequestId: 'req-3' },
      }),
    };
    const { database, updates } = makeReviseDatabase({ estimate: restartRow });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('carries the lead_id mirror and schedule-stitch pointer across the rewrite', async () => {
    const withLinkage = {
      ...sentEstimate,
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        lead_id: 'lead-7',
        lead_linkage: 'stamp',
        scheduled_service_id: 'svc-3',
      }),
    };
    // The mirror lead's contact matches (same phone), so a same-contact revise
    // must succeed AND keep both linkage keys.
    const { database, updates } = makeReviseDatabase({
      estimate: withLinkage,
      lead: { id: 'lead-7', estimate_id: null, phone: '9415550102', email: null, customer_id: null },
    });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    const data = JSON.parse(updates[0].estimate_data);
    expect(data.lead_id).toBe('lead-7');
    // The linkage CLASS survives too (codex P0, PR #3304): without it a
    // later stamp-clear cannot judge durability and skips invalidating
    // the former lead's draft.
    expect(data.lead_linkage).toBe('stamp');
    expect(data.scheduled_service_id).toBe('svc-3');
    // Still a full rewrite otherwise — stale snapshot stays dropped.
    expect(data.sendSnapshot).toBeUndefined();
  });

  test('guards the atomic update against a concurrent commercial-proposal conversion', async () => {
    const { database, rawGuards } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(rawGuards.some((sql) => String(sql).includes("'COMMERCIAL'"))).toBe(true);
  });

  test('mirrors the date-expiry verdict inside the guarded update', async () => {
    const { database, groupedWheres } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    // Replay the grouped where against a recorder: it must scope the commit
    // to (expires_at IS NULL OR expires_at > now).
    const recorded = [];
    const recorder = {
      whereNull: (...args) => { recorded.push(['whereNull', ...args]); return recorder; },
      orWhere: (...args) => { recorded.push(['orWhere', ...args]); return recorder; },
    };
    expect(groupedWheres).toHaveLength(1);
    groupedWheres[0](recorder);
    expect(recorded).toEqual([
      ['whereNull', 'expires_at'],
      ['orWhere', 'expires_at', '>', fixedNow()],
    ]);
  });

  test('clears the satellite snapshot when the revise changes the address', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, address: '789 Bay St' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].satellite_url).toBeNull();
  });

  test('409s when the revise tries to move a linked estimate to another customer id', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerId: 'cust-other' },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('409s a contact move on a delivered token-only estimate', async () => {
    const tokenOnly = { ...sentEstimate, customer_id: null };
    const { database, updates } = makeReviseDatabase({ estimate: tokenOnly, customer: null });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerPhone: '9415559999', customerEmail: 'other@example.com' },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('409s an audience swap that attaches a matching customer to a delivered token-only estimate', async () => {
    const tokenOnly = { ...sentEstimate, customer_id: null };
    const otherCustomer = { id: 'cust-2', phone: '9415559999', email: 'other@example.com' };
    const { database, updates } = makeReviseDatabase({ estimate: tokenOnly, customer: otherCustomer });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: {
        ...reviseBody,
        customerId: 'cust-2',
        customerPhone: '9415559999',
        customerEmail: 'other@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('allows a pure contact reformat on a delivered token-only estimate', async () => {
    const tokenOnly = { ...sentEstimate, customer_id: null };
    const { database, updates } = makeReviseDatabase({ estimate: tokenOnly, customer: null });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerPhone: '941-555-0102' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].customer_id).toBeNull();
  });

  test('dryRun runs the guards and pricing pipeline without writing', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    const result = await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.estimate.token).toBe('tok-abc123');
    expect(Number(result.estimate.monthly_total)).toBe(132);
    expect(updates).toHaveLength(0);
  });

  test('dryRun still rejects a guarded revise the same way', async () => {
    const tokenOnly = { ...sentEstimate, customer_id: null };
    const { database, updates } = makeReviseDatabase({ estimate: tokenOnly, customer: null });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerPhone: '9415559999', customerEmail: 'other@example.com' },
      recompute: noRecompute,
      now: fixedNow,
      dryRun: true,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('keeps the satellite snapshot across a pure address reformat', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, address: '  456  GULF dr ' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].satellite_url).toBe('https://maps.example.com/sat.png');
  });

  test('409s when the revise moves the contact away from an FK-linked lead', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: sentEstimate,
      lead: { id: 'lead-7', estimate_id: 'est-1', phone: '9415550102', email: 'beverly@example.com', customer_id: null },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: {
        ...reviseBody,
        customerName: 'Someone Else',
        customerPhone: '9415559999',
        customerEmail: 'someone.else@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('allows a contact reformat that still matches the linked lead', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: sentEstimate,
      lead: { id: 'lead-7', estimate_id: 'est-1', phone: '(941) 555-0102', email: null, customer_id: null },
    });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      // Raw string differs from the row (digits vs formatted) but normalizes
      // to the same phone — must not 409.
      body: { ...reviseBody, customerPhone: '941-555-0102' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
  });

  test('409s a date-expired row the worker has not flipped yet, without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: { ...sentEstimate, expires_at: '2026-07-01T14:00:00Z' },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('409s when the revise moves the contact away from the linked customer', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      // customer_id 'cust-9' is preserved by the revise, but neither the new
      // phone nor the new email matches that customer's contact.
      body: {
        ...reviseBody,
        customerName: 'Someone Else',
        customerPhone: '9415559999',
        customerEmail: 'someone.else@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('allows a contact change that still matches the linked customer on one channel', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      // Phone moves to a new number, but the email still matches cust-9 —
      // same one-channel match rule as the lead guard.
      body: { ...reviseBody, customerPhone: '9415559999' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].customer_id).toBe('cust-9');
  });

  test('409s when the preserved customer link points at a missing customer row', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate, customer: null });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerPhone: '9415559999', customerEmail: 'other@example.com' },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('blocks a mirror-linked (no-FK) lead the same way', async () => {
    const withMirror = {
      ...sentEstimate,
      customer_id: null,
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        lead_id: 'lead-9',
      }),
    };
    const { database, updates } = makeReviseDatabase({
      estimate: withMirror,
      lead: { id: 'lead-9', estimate_id: null, phone: '9415550102', email: null, customer_id: null },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: {
        ...reviseBody,
        customerId: null,
        customerPhone: '9415559999',
        customerEmail: 'other@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });
});

describe('reviseAdminEstimate — engine-authoritative pricing on a LIVE link (SEC-002 / pre-push codex P0)', () => {
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  beforeEach(() => {
    clearAllEstimatePricingCache();
    mockGateState.sendRequiresServerPricing = true;
  });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('a delivered estimate whose recompute fell back is refused (409) with nothing written while the gate is on', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already with the customer/i) });
    expect(updates).toHaveLength(0);
  });

  test('the dryRun preflight surfaces the same refusal', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow, dryRun: true,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('with the gate off the revision still saves fail-open and reports the fallback reason for the post-commit bell', async () => {
    mockGateState.sendRequiresServerPricing = false;
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    const out = await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].pricing_authority).toBe('CLIENT_FALLBACK');
    expect(out.pricingFallbackReason).toBe('ENGINE_ERROR');
  });

  test('a server-priced revision of a delivered estimate is unaffected by the gate', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    const out = await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', now: fixedNow,
      recompute: async () => ({ recomputed: true, source: 'engineInputs', serverResult: { recurring: { services: [], monthlyTotal: 60, annualTotal: 720 }, oneTime: { items: [] } }, serverTotals: { monthlyTotal: 60, annualTotal: 720, onetimeTotal: 0 } }),
    });
    expect(updates).toHaveLength(1);
    expect(out.pricingFallbackReason).toBeNull();
  });
});

describe('reviseAdminEstimate — send-versus-revise race on the live-link guard (pre-push codex P0)', () => {
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  const draftEstimate = { ...sentEstimate, status: 'draft', sent_at: null, viewed_at: null };
  beforeEach(() => {
    clearAllEstimatePricingCache();
    mockGateState.sendRequiresServerPricing = true;
  });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('a draft at the pre-read that a concurrent send delivered before the row lock is refused under the lock — nothing written', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: draftEstimate,
      lockedEstimate: { ...draftEstimate, status: 'sent', sent_at: '2026-07-10T11:59:00Z' },
    });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already with the customer/i) });
    expect(updates).toHaveLength(0);
  });

  test('control: a draft that stays a draft under the lock keeps the fail-open save', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: draftEstimate });
    const out = await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].pricing_authority).toBe('CLIENT_FALLBACK');
    expect(out.pricingFallbackReason).toBe('ENGINE_ERROR');
  });
});

describe('reviseAdminEstimate — a scheduled row is protected from a fallback revision (GH codex P1 on #3750)', () => {
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  const scheduledEstimate = { ...sentEstimate, status: 'scheduled', sent_at: null, viewed_at: null, scheduled_at: '2026-07-11T14:00:00Z' };
  beforeEach(() => {
    clearAllEstimatePricingCache();
    mockGateState.sendRequiresServerPricing = true;
  });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('refuses (409) so the cron never claims a fallback-priced scheduled row', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: scheduledEstimate });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/scheduled to send/i) });
    expect(updates).toHaveLength(0);
  });

  test('a server-priced revision of a scheduled row still saves', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: scheduledEstimate });
    await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', now: fixedNow,
      recompute: async () => ({ recomputed: true, source: 'engineInputs', serverResult: { recurring: { services: [], monthlyTotal: 60, annualTotal: 720 }, oneTime: { items: [] } }, serverTotals: { monthlyTotal: 60, annualTotal: 720, onetimeTotal: 0 } }),
    });
    expect(updates).toHaveLength(1);
  });
});

describe('estimate_data.proposal is server-owned on revise (pre-push P0 on #3750)', () => {
  test('the browser copy is discarded and the row\'s disabled authored proposal is carried forward verbatim', async () => {
    const storedProposal = { enabled: false, buildings: [{ name: 'Authored then disabled', lineItems: [{ description: 'Office', amount: 240 }] }] };
    const estimate = {
      ...sentEstimate,
      estimate_data: JSON.stringify({ ...JSON.parse(sentEstimate.estimate_data), proposal: storedProposal }),
    };
    const { database, updates } = makeReviseDatabase({ estimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, estimateData: { ...reviseBody.estimateData, proposal: { enabled: true, buildings: [{ name: 'Forged', lineItems: [{ description: 'Browser-priced', amount: 1 }] }] } } },
      technicianId: 'tech-2',
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    const data = JSON.parse(updates[0].estimate_data);
    expect(data.proposal).toEqual(storedProposal);
  });

  test('a row without a proposal never gains one from the browser', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, estimateData: { ...reviseBody.estimateData, proposal: { enabled: true } } },
      technicianId: 'tech-2',
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].estimate_data).proposal).toBeUndefined();
  });
});

describe('reviseAdminEstimate — a draft member of a SCHEDULED group refuses a fallback revision (GH codex P2 r5 on #3750)', () => {
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  // A real UUID: the revise validates estimateGroupId (400 otherwise).
  const groupedDraft = { ...sentEstimate, status: 'draft', sent_at: null, viewed_at: null, estimate_group_id: '2f5e7a10-6c3b-4d9e-9a11-3b7c5d2e8f01' };
  beforeEach(() => {
    clearAllEstimatePricingCache();
    mockGateState.sendRequiresServerPricing = true;
  });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('refused under the row lock when a sibling anchor is scheduled — the cron\'s group claim would fail the anchor without retry', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: groupedDraft, scheduledGroupMember: { id: 'est-anchor' } });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/group is scheduled to send/i) });
    expect(updates).toHaveLength(0);
  });

  test('control: no scheduled member in the group keeps the draft\'s fail-open save; gate off never refuses', async () => {
    const open = makeReviseDatabase({ estimate: groupedDraft, scheduledGroupMember: null });
    await reviseAdminEstimate({
      database: open.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    });
    expect(open.updates).toHaveLength(1);
    expect(open.updates[0].pricing_authority).toBe('CLIENT_FALLBACK');

    mockGateState.sendRequiresServerPricing = false;
    const gateOff = makeReviseDatabase({ estimate: groupedDraft, scheduledGroupMember: { id: 'est-anchor' } });
    await reviseAdminEstimate({
      database: gateOff.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    });
    expect(gateOff.updates).toHaveLength(1);
  });
});

describe('scheduled-group guard — dry-run preflight and destination group (GH codex P2 r7 on #3750)', () => {
  const { assertNoFallbackRevisionInScheduledGroup, lockScheduledGroupGuardGroups, scheduledGroupGuardGroupIds } = require('../services/admin-estimate-persistence');
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  const groupedDraft = { ...sentEstimate, status: 'draft', sent_at: null, viewed_at: null, estimate_group_id: '2f5e7a10-6c3b-4d9e-9a11-3b7c5d2e8f01' };
  beforeEach(() => {
    clearAllEstimatePricingCache();
    mockGateState.sendRequiresServerPricing = true;
  });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('the real save takes the group advisory lock BEFORE the row lock (pre-push codex P1: no deadlock against the schedule route)', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: groupedDraft, scheduledGroupMember: null });
    const order = [];
    database.raw.mockImplementation(async () => { order.push('group-lock'); return {}; });
    const originalDb = database;
    // Observe the FOR UPDATE read through the recording chain's forUpdate.
    const chainSpy = originalDb('estimates');
    const forUpdate = chainSpy.forUpdate;
    await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(database.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['estimate-group-send', groupedDraft.estimate_group_id]);
    expect(typeof forUpdate).toBe('function');
    expect(order).toEqual(['group-lock']);
  });

  test('dryRun refuses exactly like the real save (no reprice confirm the write would then 409)', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: groupedDraft, scheduledGroupMember: { id: 'est-anchor' } });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow, dryRun: true,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/group is scheduled to send/i) });
    expect(updates).toHaveLength(0);
    // The unlocked preflight read takes no advisory lock.
    expect(database.raw).not.toHaveBeenCalled();
  });

  // claimHeldGroups: a member whose delivery claim is still fresh while its
  // status has left 'sending' (anchor accepted mid-handoff) — served ONLY
  // through the in-flight predicate's NOT (DELIVERY_CLAIM_NOT_LIVE_SQL) branch.
  function fakeTrx({ scheduledGroups = [], sendingGroups = [], claimHeldGroups = [] } = {}) {
    const queried = [];
    const raws = [];
    const chain = {
      where: (c) => {
        if (typeof c === 'function') {
          const sub = {
            where: (o) => { if (o?.status) chain.__status = o.status; return sub; },
            orWhereRaw: (sql) => { chain.__raw = sql; raws.push(sql); return sub; },
          };
          c(sub);
          return chain;
        }
        chain.__group = c?.estimate_group_id; chain.__status = c?.status; return chain;
      },
      whereNot: () => chain,
      whereNull: () => chain,
      first: async () => {
        queried.push(`${chain.__status}:${chain.__group}`);
        if (chain.__status === 'sending') {
          if (sendingGroups.includes(chain.__group)) return { id: 'est-anchor' };
          const claimBranch = /NOT \(/.test(chain.__raw || '') && /delivering_at/.test(chain.__raw || '');
          return claimBranch && claimHeldGroups.includes(chain.__group) ? { id: 'est-anchor' } : null;
        }
        return scheduledGroups.includes(chain.__group) ? { id: 'est-anchor' } : null;
      },
    };
    const trx = () => chain;
    trx.raw = jest.fn(async () => ({}));
    return { trx, queried, raws };
  }

  test('a fallback revision that MOVES an ungrouped draft into a scheduled group is refused (destination judged); the verdict itself never locks', async () => {
    const { trx, queried } = fakeTrx({ scheduledGroups: ['grp-dest'] });
    await expect(assertNoFallbackRevisionInScheduledGroup(
      trx,
      { id: 'est-1', estimate_group_id: null },
      { pricing_authority: 'CLIENT_FALLBACK', estimate_group_id: 'grp-dest' },
    )).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/group it would join is scheduled/i) });
    expect(queried).toEqual(['sending:grp-dest', 'scheduled:grp-dest']);
    expect(trx.raw).not.toHaveBeenCalled();
  });

  test('a fallback revision while a member still holds a FRESH delivery claim is refused — an anchor accepted mid-handoff has left sending (uncapped codex P0 r35 on #3750)', async () => {
    mockGateState.sendRequiresServerPricing = false;
    const { assertNoRevisionDuringGroupSend } = require('../services/admin-estimate-persistence');
    const { trx, queried, raws } = fakeTrx({ sendingGroups: [], claimHeldGroups: ['grp-live'] });
    await expect(assertNoRevisionDuringGroupSend(
      trx,
      { id: 'est-1', estimate_group_id: 'grp-live' },
      { pricing_authority: 'CLIENT_FALLBACK' },
    )).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/being sent right now/i) });
    expect(queried).toEqual(['sending:grp-live']);
    // The in-flight predicate is status = 'sending' OR a fresh delivery claim.
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatch(/^NOT \(/);
    expect(raws[0]).toMatch(/delivering_at/);
    // No claim, no sending member: the revision proceeds.
    const quiet = fakeTrx({ sendingGroups: [], claimHeldGroups: [] });
    await expect(assertNoRevisionDuringGroupSend(quiet.trx, { id: 'est-1', estimate_group_id: 'grp-live' }, { pricing_authority: 'CLIENT_FALLBACK' })).resolves.toBeUndefined();
  });

  test('a fallback revision while any group member is SENDING is refused — gate OFF too (pre-push codex P0: grouped auto-send exposure)', async () => {
    mockGateState.sendRequiresServerPricing = false;
    const { assertNoRevisionDuringGroupSend } = require('../services/admin-estimate-persistence');
    const { trx, queried } = fakeTrx({ sendingGroups: ['grp-live'] });
    await expect(assertNoRevisionDuringGroupSend(
      trx,
      { id: 'est-1', estimate_group_id: 'grp-live' },
      { pricing_authority: 'CLIENT_FALLBACK' },
    )).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/being sent right now/i) });
    expect(queried).toEqual(['sending:grp-live']);
    // The combined verdict runs the mid-send check with the gate off (and
    // skips the scheduled-group one, which is gate-scoped).
    const combined = fakeTrx({ sendingGroups: [], scheduledGroups: ['grp-live'] });
    await expect(assertNoFallbackRevisionInScheduledGroup(combined.trx, { id: 'est-1', estimate_group_id: 'grp-live' }, { pricing_authority: 'CLIENT_FALLBACK' })).resolves.toBeUndefined();
    expect(combined.queried).toEqual(['sending:grp-live']);
    // Verified pricing changes the reviewed offer too, so the same hold applies.
    const server = fakeTrx({ sendingGroups: ['grp-live'] });
    await expect(assertNoRevisionDuringGroupSend(server.trx, { id: 'est-1', estimate_group_id: 'grp-live' }, { pricing_authority: 'SERVER' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/being sent right now/i) });
    expect(server.queried).toEqual(['sending:grp-live']);
  });

  test('through the revise: a fallback save of a grouped draft is refused while a sibling anchor is sending, gate off, nothing written', async () => {
    mockGateState.sendRequiresServerPricing = false;
    const { database, updates } = makeReviseDatabase({ estimate: groupedDraft, sendingGroupMember: { id: 'est-anchor' } });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/being sent right now/i) });
    expect(updates).toHaveLength(0);
    // The group lock was taken before the row lock even with the gate off.
    expect(database.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['estimate-group-send', groupedDraft.estimate_group_id]);
  });

  test('lockScheduledGroupGuardGroups takes the advisory locks in SORTED order for every grouped save (gate-independent)', async () => {
    const { trx } = fakeTrx();
    await expect(lockScheduledGroupGuardGroups(trx, { id: 'est-1', estimate_group_id: 'grp-z' }, { pricing_authority: 'CLIENT_FALLBACK', estimate_group_id: 'grp-a' })).resolves.toEqual(['grp-a', 'grp-z']);
    expect(trx.raw.mock.calls.map((c) => c[1][1])).toEqual(['grp-a', 'grp-z']);
    const server = fakeTrx();
    await expect(lockScheduledGroupGuardGroups(server.trx, { id: 'est-1', estimate_group_id: 'grp-z' }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-a' })).resolves.toEqual(['grp-a', 'grp-z']);
    expect(server.trx.raw.mock.calls.map((c) => c[1][1])).toEqual(['grp-a', 'grp-z']);
    expect(scheduledGroupGuardGroupIds({ estimate_group_id: null }, { pricing_authority: 'CLIENT_FALLBACK' })).toEqual([]);
    mockGateState.sendRequiresServerPricing = false;
    const gateOff = fakeTrx();
    await expect(lockScheduledGroupGuardGroups(gateOff.trx, { id: 'est-1', estimate_group_id: 'grp-z' }, { pricing_authority: 'CLIENT_FALLBACK' })).resolves.toEqual(['grp-z']);
    expect(scheduledGroupGuardGroupIds({ estimate_group_id: 'grp-z' }, { pricing_authority: 'CLIENT_FALLBACK' })).toEqual([]);
  });

  test('a move between groups judges BOTH the current and the destination group', async () => {
    const { trx, queried } = fakeTrx({ scheduledGroups: [] });
    await expect(assertNoFallbackRevisionInScheduledGroup(
      trx,
      { id: 'est-1', estimate_group_id: 'grp-old' },
      { pricing_authority: 'CLIENT_FALLBACK', estimate_group_id: 'grp-new' },
    )).resolves.toBeUndefined();
    expect(queried).toEqual(['sending:grp-new', 'sending:grp-old', 'scheduled:grp-new', 'scheduled:grp-old']);
    expect(trx.raw).not.toHaveBeenCalled();
    // SERVER revisions check in-flight delivery; the scheduled fallback-only
    // restriction and an ungrouped row going nowhere add no further query.
    const quiet = fakeTrx({ scheduledGroups: ['grp-old'] });
    await assertNoFallbackRevisionInScheduledGroup(quiet.trx, { id: 'est-1', estimate_group_id: 'grp-old' }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-old' });
    await assertNoFallbackRevisionInScheduledGroup(quiet.trx, { id: 'est-1', estimate_group_id: null }, { pricing_authority: 'CLIENT_FALLBACK' });
    expect(quiet.queried).toEqual(['sending:grp-old']);
  });
});

describe('null / unknown pricing authority counts as unverified in the live-link and grouped-send guards (pre-push codex P1)', () => {
  const { writeStampsUnverifiedPricing, fallbackRevisionGroupIds, assertNoFallbackRevisionOfLiveLink } = require('../services/admin-estimate-persistence');
  beforeEach(() => { mockGateState.sendRequiresServerPricing = true; });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('the stamp predicate: NULL (quote-required), CLIENT_FALLBACK and unknown are unverified; SERVER is not; an absent key is not a pricing write', () => {
    expect(writeStampsUnverifiedPricing({ pricing_authority: null })).toBe(true);
    expect(writeStampsUnverifiedPricing({ pricing_authority: 'CLIENT_FALLBACK' })).toBe(true);
    expect(writeStampsUnverifiedPricing({ pricing_authority: 'weird' })).toBe(true);
    expect(writeStampsUnverifiedPricing({ pricing_authority: 'SERVER' })).toBe(false);
    expect(writeStampsUnverifiedPricing({ address: 'x' })).toBe(false);
    expect(writeStampsUnverifiedPricing(null)).toBe(false);
  });

  test('a NULL-authority revision of a live link is refused like a fallback one; the grouped guards lock its groups', () => {
    expect(() => assertNoFallbackRevisionOfLiveLink({ sent_at: '2026-07-10T11:59:00Z' }, { pricing_authority: null })).toThrow(/already with the customer/i);
    expect(() => assertNoFallbackRevisionOfLiveLink({ status: 'scheduled' }, { pricing_authority: null })).toThrow(/scheduled to send/i);
    expect(() => assertNoFallbackRevisionOfLiveLink({ sent_at: '2026-07-10T11:59:00Z' }, { pricing_authority: 'SERVER' })).not.toThrow();
    expect(fallbackRevisionGroupIds({ estimate_group_id: 'grp-a' }, { pricing_authority: null, estimate_group_id: 'grp-b' })).toEqual(['grp-a', 'grp-b']);
    expect(fallbackRevisionGroupIds({ estimate_group_id: 'grp-a' }, { pricing_authority: 'SERVER' })).toEqual([]);
    expect(fallbackRevisionGroupIds({ estimate_group_id: 'grp-a' }, { address: 'no pricing write' })).toEqual([]);
  });
});

describe('a LIVE row moving into a group has the destination judged and locked, whatever its own authority (GH codex P1 r10 on #3750)', () => {
  const { assertLiveRowMayJoinGroup, liveGroupMoveDestinationIds, revisionGroupLockIds } = require('../services/admin-estimate-persistence');
  beforeEach(() => { mockGateState.sendRequiresServerPricing = true; });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });
  const liveRow = { id: 'est-live', estimate_group_id: null, sent_at: '2026-07-10T11:59:00Z' };

  function fakeTrx(siblings) {
    const calls = { whereIns: [], orWhereIns: [] };
    const chain = {
      where: (c) => { if (typeof c === 'function') c(chain); return chain; },
      orWhere: (c) => { if (typeof c === 'function') c(chain); return chain; },
      whereNot: () => chain, whereNull: () => chain, whereRaw: () => chain, orWhereRaw: () => chain,
      whereIn: (col, vals) => { calls.whereIns.push([col, vals]); return chain; },
      orWhereIn: (col, vals) => { calls.orWhereIns.push([col, vals]); return chain; },
      select: async () => siblings,
    };
    const trx = jest.fn(() => chain);
    trx.raw = jest.fn(async () => ({}));
    return { trx, calls };
  }

  test('only a live row changing groups, gate on, names a destination; the lock set includes it even for a SERVER write', () => {
    expect(liveGroupMoveDestinationIds(liveRow, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).toEqual(['grp-dest']);
    // A SCHEDULED first-send row is live too (GH codex P2 r11): it keeps its
    // schedule while joining the group, so the destination is judged now.
    expect(liveGroupMoveDestinationIds({ id: 'est-sched', estimate_group_id: null, status: 'scheduled' }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).toEqual(['grp-dest']);
    expect(liveGroupMoveDestinationIds({ ...liveRow, estimate_group_id: 'grp-dest' }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).toEqual([]);
    expect(liveGroupMoveDestinationIds({ id: 'est-draft', estimate_group_id: null }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).toEqual([]);
    expect(revisionGroupLockIds(liveRow, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).toEqual(['grp-dest']);
    expect(revisionGroupLockIds({ ...liveRow, estimate_group_id: 'grp-z' }, { pricing_authority: 'CLIENT_FALLBACK', estimate_group_id: 'grp-a' })).toEqual(['grp-a', 'grp-z']);
    mockGateState.sendRequiresServerPricing = false;
    expect(liveGroupMoveDestinationIds(liveRow, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).toEqual([]);
  });

  test('refused when the destination holds a published sibling without an engine-verified price; allowed for SERVER siblings and editor-authored proposals', async () => {
    const fallbackSibling = { id: 'est-sib', pricing_authority: 'CLIENT_FALLBACK', estimate_data: '{}' };
    const { trx, calls } = fakeTrx([fallbackSibling]);
    await expect(assertLiveRowMayJoinGroup(trx, liveRow, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/without an engine-verified price/i) });
    // The link-visible scope (shared helper): live unexpired + terminal rows.
    expect(calls.whereIns).toEqual([['status', ['sending', 'sent', 'viewed']]]);
    expect(calls.orWhereIns).toEqual([['status', ['accepted', 'declined']]]);
    const ok = fakeTrx([
      { id: 'est-a', pricing_authority: 'SERVER', estimate_data: '{}' },
      { id: 'est-b', pricing_authority: null, estimate_data: JSON.stringify({ proposal: { enabled: true, provenance: { source: 'proposal-editor' } } }) },
      // A genuinely locked accepted sibling (uncapped P1 r21 / GH P0 r22).
      { id: 'est-c', status: 'accepted', pricing_authority: 'LOCKED', price_locked_at: '2026-07-10T11:59:00Z', estimate_data: '{}' },
    ]);
    await expect(assertLiveRowMayJoinGroup(ok.trx, liveRow, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).resolves.toBeUndefined();
    const legacyProposal = fakeTrx([{ id: 'est-c', pricing_authority: null, estimate_data: JSON.stringify({ proposal: { enabled: true } }) }]);
    await expect(assertLiveRowMayJoinGroup(legacyProposal.trx, liveRow, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' })).rejects.toMatchObject({ statusCode: 409 });
    // Not a group change, or not live: no query at all.
    const quiet = fakeTrx([fallbackSibling]);
    await assertLiveRowMayJoinGroup(quiet.trx, { ...liveRow, estimate_group_id: 'grp-dest' }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' });
    await assertLiveRowMayJoinGroup(quiet.trx, { id: 'est-draft', estimate_group_id: null }, { pricing_authority: 'SERVER', estimate_group_id: 'grp-dest' });
    expect(quiet.trx).not.toHaveBeenCalled();
  });
});

describe('the server-owned proposal is judged and carried from the LOCKED row (pre-push codex P0 r14 on #3750)', () => {
  const draft = { ...sentEstimate, status: 'draft', sent_at: null, viewed_at: null };
  const priorData = JSON.parse(sentEstimate.estimate_data);

  test('a proposal authored by the editor while the payload resolved refuses the generic rewrite — nothing written', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: draft,
      lockedEstimate: {
        ...draft,
        category: 'COMMERCIAL',
        estimate_data: JSON.stringify({ ...priorData, proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [{ name: 'Tower A', lineItems: [] }] } }),
      },
    });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Commercial proposal editor/i) });
    expect(updates).toHaveLength(0);
  });

  test('a proposal disabled in the gap (not a revise block) is carried from the locked row, not the pre-read copy', async () => {
    const lockedProposal = { enabled: false, provenance: { source: 'proposal-editor' }, buildings: [{ name: 'Tower A', lineItems: [{ description: 'Interior', amount: 240 }] }] };
    const { database, updates } = makeReviseDatabase({
      estimate: draft,
      lockedEstimate: { ...draft, estimate_data: JSON.stringify({ ...priorData, proposal: lockedProposal }) },
    });
    await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: noRecompute, now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].estimate_data).proposal).toEqual(lockedProposal);
  });
});

describe('an EXPIRED row the gate refuses can be re-priced through the engine, and only that (GH codex P1 r30 on #3750)', () => {
  const serverRecompute = async () => ({
    recomputed: true,
    source: 'ENGINE_REQUEST',
    serverResult: { recurring: { grandTotal: 69, monthlyTotal: 69, annualTotal: 828, services: [{ service: 'pest_control', mo: 69 }] }, oneTime: { total: 0 } },
    serverTotals: { monthlyTotal: 69, annualTotal: 828, onetimeTotal: 0 },
  });
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  const expiredFallback = { ...sentEstimate, status: 'expired', expires_at: '2026-07-01T00:00:00Z', pricing_authority: 'CLIENT_FALLBACK' };
  beforeEach(() => { clearAllEstimatePricingCache(); mockGateState.sendRequiresServerPricing = true; });
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('gate on: an engine-verified reprice lands on the expired fallback row (status untouched) so it can then be extended', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: expiredFallback });
    await reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: serverRecompute, now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].pricing_authority).toBe('SERVER');
    expect(updates[0]).not.toHaveProperty('status');
  });

  test('gate on: a fallback reprice of that expired (delivered) row is still refused — the live-link guard', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: expiredFallback });
    await expect(reviseAdminEstimate({
      database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: engineError, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('gate off, or an expired row the gate already accepts (SERVER): the expiry rule stands as before', async () => {
    mockGateState.sendRequiresServerPricing = false;
    const off = makeReviseDatabase({ estimate: expiredFallback });
    await expect(reviseAdminEstimate({
      database: off.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: serverRecompute, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no longer be edited/i) });
    mockGateState.sendRequiresServerPricing = true;
    const verified = makeReviseDatabase({ estimate: { ...expiredFallback, pricing_authority: 'SERVER' } });
    await expect(reviseAdminEstimate({
      database: verified.database, estimateId: 'est-1', body: reviseBody, technicianId: 'tech-2', recompute: serverRecompute, now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no longer be edited/i) });
  });
});
