// Click-to-estimate mint (GATE_REPORT_CLICK_TO_ESTIMATE) — unit tests with
// every collaborator injected, covering the money invariants:
//   - reuse on a repeat tap (same offer, live estimate) writes NOTHING
//   - a dead prior link re-mints; a changed offer supersedes the old link
//   - cent-exact price drift REFUSES the mint (ClickEstimateDriftError)
//   - a member whose membership context can't load fails CLOSED
//   - a snapshot that didn't freeze pricing fails CLOSED
//   - the minted row is the publish-without-delivery shape: status 'sent',
//     all four follow-up flags pre-burned, no delivery channel anywhere.
// Fixture identities are INVENTED (never copied from live payloads).

const {
  mintReportClickEstimate,
  ClickEstimateDriftError,
  priorMintStillLive,
} = require('../services/service-report/click-estimate-mint');

const CUSTOMER = {
  id: 'cust-9', first_name: 'Testa', last_name: 'Fixture',
  phone: '+15550100200', email: 'testa@example.com',
  address_line1: '12 Invented Way', city: 'Parrish', zip: '34219',
  lot_sqft: 9000, property_sqft: 2100, bed_sqft: null, palm_count: null, lawn_type: null,
};

// The raw staff-writable price sources the composition stamped — the mint
// re-reads customers + customer_turf_profiles under its lock and refuses
// any change as drift.
const PRICING_SOURCE_STAMP = {
  lot_sqft: 9000, property_sqft: 2100, bed_sqft: null, palm_count: null,
  lawn_type: null, turf_lawn_sqft: null, turf_track_key: null,
};

function fakeTrx({ priorEstimateRows = [], customerRow = CUSTOMER } = {}) {
  const ops = { inserts: [], updates: [], selects: [], noWaitLocks: [] };
  const trx = (table) => {
    const q = {
      _criteria: null,
      where(criteria) { q._criteria = criteria; ops.selects.push({ table, criteria }); return q; },
      whereNull() { return q; },
      whereNot() { return q; },
      whereRaw() { return q; },
      forUpdate() { q._forUpdate = true; return q; },
      noWait() { q._noWait = true; ops.noWaitLocks.push({ table, forUpdate: !!q._forUpdate }); return q; },
      // Awaiting the bare chain (the prior-mint lineage query) resolves the
      // row LIST for estimates.
      then(resolve, reject) {
        return Promise.resolve(table === 'estimates' ? priorEstimateRows : []).then(resolve, reject);
      },
      first: async () => {
        if (table === 'customers') return customerRow;
        return null;
      },
      update: async (patch) => { ops.updates.push({ table, criteria: q._criteria, patch }); return 1; },
      insert: (row) => ({
        returning: async () => {
          ops.inserts.push({ table, row });
          return [{ ...row, id: 'est-new-1', estimate_data: JSON.parse(row.estimate_data) }];
        },
      }),
    };
    return q;
  };
  return { trx, ops };
}

const PROPERTY_INPUT = { homeSqFt: 2100, lotSqFt: 9000, stories: 1, propertyType: 'single_family' };
const RAW_RESULT = {
  lineItems: [{ service: 'pest_control', annualAfterDiscount: 456, visitsPerYear: 4 }],
  summary: { recurringAnnualBeforeDiscount: 480, recurringAnnualAfterDiscount: 456 },
  waveGuard: { tier: 'Silver' },
};

function baseArgs(overrides = {}) {
  const deps = {
    persistence: {
      estimateViewUrl: (token) => `https://portal.wavespestcontrol.com/estimate/${token}`,
      estimateExpiresAt: () => new Date('2026-08-20T00:00:00Z'),
    },
    recompute: jest.fn(async () => ({
      recomputed: true,
      serverResult: { engineVersion: 'v4.2-test', recurring: {} },
      serverTotals: { monthlyTotal: 38, annualTotal: 456, onetimeTotal: 0 },
      pestPricingVersion: 'PEST_V2',
      rawEngineResult: RAW_RESULT,
    })),
    pricingAi: {
      quotedPerVisitForServiceKey: () => 114,
      addressForCustomer: (c) => [c.address_line1, c.city, c.zip].filter(Boolean).join(', '),
      // In-transaction ownership revalidation (audit r7 P0): the default
      // fresh read AGREES with the composed baseline (lawn qualifying,
      // pest not owned) — drift tests override this.
      loadCurrentServiceKeys: jest.fn(async () => ({
        currentServiceKeys: ['lawn'], ownedServiceKeys: ['lawn'], ownershipLookupFailed: false,
      })),
      // Price-input drift re-read (GitHub round): default turf profile is
      // absent, matching the stamp's null turf fields.
      loadTurfProfile: jest.fn(async () => null),
    },
    computeMembershipContext: jest.fn(async () => ({ member: true })),
    bundleUtils: { pricingBundleMatchesEstimateTotals: () => true },
    buildEstimateSendSnapshot: jest.fn(async (estimate) => ({
      ...estimate.estimate_data,
      sendSnapshot: { renderedAt: 'now', tierDiscounts: {}, pricingBundle: { frequencies: [{}] } },
    })),
    // Single-premises re-proof (GitHub round P1): the default composition
    // proved the report through its own linkage, so the proof is not
    // consulted — the premises tests flip premisesProof and this fake.
    customerHasOnlyPrimaryPremises: jest.fn(async () => true),
    ...(overrides.deps || {}),
  };
  return {
    customer: { ...CUSTOMER },
    service: { id: 'sr-7' },
    crossSell: {
      serviceKey: 'pest_control',
      label: 'Quarterly Pest Control',
      mode: 'priced',
      fingerprint: 'fp-1',
      option: { id: 'pest-quarterly', perVisit: 114, waveguardTier: 'Silver' },
      engineContext: {
        propertyInput: PROPERTY_INPUT,
        targetOnlyServices: { pest: { frequency: 'quarterly' } },
        currentServiceKeys: ['lawn'],
        primaryStreet: '12 invented way|parrish|34219',
        pricingSourceStamp: { ...PRICING_SOURCE_STAMP },
        premisesProof: 'report_linkage',
      },
    },
    requestRow: { id: 'req-3' },
    deduped: false,
    revisionSnapshot: { source: 'service_report', serviceRecordId: 'sr-7', crossSell: {} },
    now: () => new Date('2026-08-13T12:00:00Z'),
    randomBytes: () => Buffer.alloc(16, 7),
    ...overrides,
    deps,
  };
}

describe('mintReportClickEstimate', () => {
  test('the prior-mint lineage lock is FOR UPDATE NOWAIT — never waits while holding the customer lock (audit r6 P1)', async () => {
    // Both lock orders exist in the repo (accept: estimates→customer;
    // admin edits: customer→estimates), so the mint must not WAIT on an
    // estimate lock while the CTA writer's customer lock is held — a held
    // lineage row 55P03s immediately into the route's retryable 503.
    const { trx, ops } = fakeTrx();
    await mintReportClickEstimate(trx, baseArgs());
    expect(ops.noWaitLocks).toContainEqual({ table: 'estimates', forUpdate: true });
  });

  test('mints the publish-without-delivery shape: sent + all four follow-up flags burned + server authority', async () => {
    const { trx, ops } = fakeTrx();
    const out = await mintReportClickEstimate(trx, baseArgs());
    expect(out.reused).toBe(false);
    // RELATIVE path (uncapped audit r4 P1): an absolute prod URL fails the
    // client's same-origin guard on preview/dev origins — the client
    // resolves this against its own origin.
    expect(out.url).toMatch(/^\/estimate\/[A-Za-z0-9_-]+$/);
    const insert = ops.inserts.find((i) => i.table === 'estimates');
    expect(insert.row.status).toBe('sent');
    expect(insert.row.sent_at).toBeTruthy();
    expect(insert.row.followup_unviewed_sent).toBe(true);
    expect(insert.row.followup_viewed_sent).toBe(true);
    expect(insert.row.followup_final_sent).toBe(true);
    expect(insert.row.followup_expiring_sent).toBe(true);
    expect(insert.row.source).toBe('service_report_cta');
    expect(insert.row.pricing_authority).toBe('SERVER');
    expect(insert.row.customer_id).toBe('cust-9');
    expect(insert.row.monthly_total).toBe(38);
    expect(insert.row.annual_total).toBe(456);
    const data = JSON.parse(insert.row.estimate_data);
    // Durable engagement opt-out (#3391 audit r2 P1): the engagement
    // engine's view/quiet rules would otherwise email a zero-comms estimate.
    expect(data.noEngagementAutomation).toBe(true);
    expect(data.engineInputs.services).toEqual({ pest: { frequency: 'quarterly', version: 'PEST_V2' } });
    expect(data.priorQualifyingServices).toEqual(['lawn']);
    expect(data.result).toBeTruthy();
    expect(data.membershipSnapshot).toEqual({ member: true });
    // Snapshot freeze lands in a follow-up update on the same row.
    const snapUpdate = ops.updates.find((u) => u.table === 'estimates' && u.patch.estimate_data);
    expect(JSON.parse(snapUpdate.patch.estimate_data).sendSnapshot.pricingBundle).toBeTruthy();
    // Request-row linkage stamped with the minted estimate.
    const linkUpdate = ops.updates.find((u) => u.table === 'service_requests');
    expect(JSON.parse(linkUpdate.patch.pricing_revision).mintedEstimate.id).toBe('est-new-1');
  });

  test('identity is server-derived: the recompute receives priorQualifyingServices + recurringCustomer', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    await mintReportClickEstimate(trx, args);
    expect(args.deps.recompute).toHaveBeenCalledWith(expect.any(Object), {
      priorQualifyingServices: ['lawn'],
      recurringCustomer: true,
    });
  });

  // Prior mints are resolved DURABLY from the estimates table (out-of-band
  // audit P0): the request row's pointer dies when staff terminalize the
  // row or acceptance resolves it, so lineage never depends on it.
  const priorMint = (over = {}) => ({
    id: 'est-old', token: 'tok-old', status: 'viewed',
    expires_at: new Date('2026-08-19T00:00:00Z'), archived_at: null, price_locked_at: null,
    estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-1' } },
    ...over,
  });

  test('repeat tap on an unchanged offer REUSES the live estimate (found by lineage, not the request row) and writes nothing', async () => {
    const { trx, ops } = fakeTrx({ priorEstimateRows: [priorMint()] });
    const out = await mintReportClickEstimate(trx, baseArgs({
      deduped: true,
      // The normal deduped shape: the refreshed row still carries the mint
      // pointer — an unlinked deduped row relinks instead (audit on
      // e60d94729; test below).
      requestRow: { id: 'req-3', pricing_revision: JSON.stringify({ mintedEstimate: { id: 'est-old', token: 'tok-old' } }) },
    }));
    expect(out.reused).toBe(true);
    expect(out.url).toBe('/estimate/tok-old');
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
  });

  test('a DEDUPED tap whose row lacks the mint pointer RELINKS it — dedupe is not proof of linkage (out-of-band audit on e60d94729 P1)', async () => {
    // A gate-off tap can create an identical request without minting; when
    // the gate returns, the writer dedupes that row while the reuse hands
    // back the earlier live estimate. Without the relink, acceptance can
    // never match and resolve the open row — staff get paged for booked
    // work.
    const { trx, ops } = fakeTrx({ priorEstimateRows: [priorMint()] });
    const out = await mintReportClickEstimate(trx, baseArgs({
      deduped: true,
      requestRow: { id: 'req-3', pricing_revision: JSON.stringify({ source: 'service_report' }) },
    }));
    expect(out.reused).toBe(true);
    const relink = ops.updates.find((u) => u.table === 'service_requests');
    expect(relink.criteria).toEqual({ id: 'req-3' });
    expect(JSON.parse(relink.patch.pricing_revision).mintedEstimate.id).toBe('est-old');
  });

  test('a dead prior link (expired) re-mints even on a dedupe tap', async () => {
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint({ status: 'sent', expires_at: new Date('2026-08-01T00:00:00Z') })],
    });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: true }));
    expect(out.reused).toBe(false);
    expect(ops.inserts).toHaveLength(1);
  });

  test('a dedupe tap whose live prior carries a DIFFERENT fingerprint re-mints and supersedes it', async () => {
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint({ estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-stale' } } })],
    });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: true }));
    expect(out.reused).toBe(false);
    const archive = ops.updates.find((u) => u.table === 'estimates' && u.patch.archived_at && u.criteria?.id === 'est-old');
    expect(archive).toBeTruthy();
  });

  test('a changed offer supersedes (archives) EVERY live unaccepted prior mint', async () => {
    // Priors carry STALE fingerprints — an identical fingerprint would now
    // reuse regardless of the writer's dedupe verdict (GitHub round P0).
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [
        priorMint({ estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-stale-1' } } }),
        priorMint({
          id: 'est-old-2',
          token: 'tok-old-2',
          estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-stale-2' } },
        }),
      ],
    });
    await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    const archived = ops.updates.filter((u) => u.table === 'estimates' && u.patch.archived_at).map((u) => u.criteria?.id);
    expect(archived.sort()).toEqual(['est-old', 'est-old-2']);
    const data = JSON.parse(ops.inserts[0].row.estimate_data);
    expect(data.reportCtaMint.supersededEstimateIds.sort()).toEqual(['est-old', 'est-old-2']);
    expect(data.reportCtaMint.serviceKey).toBe('pest_control');
  });

  test('an ACCEPTED prior estimate is never archived', async () => {
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint({ status: 'accepted', price_locked_at: new Date('2026-08-12T00:00:00Z') })],
    });
    await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    const archive = ops.updates.find((u) => u.table === 'estimates' && u.patch.archived_at);
    expect(archive).toBeUndefined();
  });

  test('cent-level per-application drift refuses the mint with the drift error', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.pricingAi.quotedPerVisitForServiceKey = () => 114.02;
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(ClickEstimateDriftError);
    expect(ops.inserts).toHaveLength(0);
  });

  test('a WaveGuard tier mismatch refuses the mint', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    args.crossSell.option.waveguardTier = 'Gold';
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(ClickEstimateDriftError);
  });

  test('an unchanged offer REUSES even when the writer says deduped=false — a terminalized request must not kill the live token (GitHub P0)', async () => {
    const { trx, ops } = fakeTrx({ priorEstimateRows: [priorMint()] });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    expect(out.reused).toBe(true);
    expect(out.estimateId).toBe('est-old');
    // An UNACCEPTED reuse still leaves an open request row — the bell-skip
    // flag belongs to the accepted fast path alone.
    expect(out.acceptedReuse).toBeUndefined();
    // Nothing archived, nothing inserted — the customer's token stays live.
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates.filter((u) => u.table === 'estimates')).toHaveLength(0);
    // The fresh request row is RELINKED to the reused estimate.
    const relink = ops.updates.find((u) => u.table === 'service_requests');
    expect(relink.criteria).toEqual({ id: 'req-3' });
    const stored = JSON.parse(relink.patch.pricing_revision);
    expect(stored.mintedEstimate.id).toBe('est-old');
    expect(stored.mintedEstimate.token).toBe('tok-old');
  });

  test('a deduped repeat tap whose row already carries the linkage writes NOTHING', async () => {
    const { trx, ops } = fakeTrx({ priorEstimateRows: [priorMint()] });
    const args = baseArgs({
      deduped: true,
      requestRow: { id: 'req-3', pricing_revision: JSON.stringify({ mintedEstimate: { id: 'est-old', token: 'tok-old' } }) },
    });
    const out = await mintReportClickEstimate(trx, args);
    expect(out.reused).toBe(true);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
  });

  test('premises drift refuses BEFORE the reuse fast path — a moved customer never gets the stale estimate back (GitHub P1)', async () => {
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint()],
      customerRow: { ...CUSTOMER, address_line1: '99 Somewhere Else' },
    });
    await expect(mintReportClickEstimate(trx, baseArgs({ deduped: true })))
      .rejects.toThrow(/premises changed/);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
  });

  test('a changed price-bearing input (lot_sqft, turf profile, …) refuses as drift under the lock (GitHub P1)', async () => {
    const { trx, ops } = fakeTrx({ customerRow: { ...CUSTOMER, lot_sqft: 12000 } });
    await expect(mintReportClickEstimate(trx, baseArgs()))
      .rejects.toThrow(/price-bearing property inputs changed/);
    expect(ops.inserts).toHaveLength(0);

    // A turf-profile edit (independently writable) drifts the same way.
    const second = fakeTrx();
    const args = baseArgs();
    args.deps.pricingAi.loadTurfProfile = jest.fn(async () => ({ lawn_sqft: 4200, track_key: 'A' }));
    await expect(mintReportClickEstimate(second.trx, args))
      .rejects.toThrow(/price-bearing property inputs changed/);
  });

  test('a termite panel key replays as canonical termite_bait — no phantom tier drift for termite customers (GitHub P1)', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.crossSell.engineContext.currentServiceKeys = ['termite'];
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: ['termite'], ownedServiceKeys: ['termite'], ownershipLookupFailed: false,
    }));
    await mintReportClickEstimate(trx, args);
    const data = JSON.parse(ops.inserts[0].row.estimate_data);
    expect(data.priorQualifyingServices).toEqual(['termite_bait']);
  });

  test('a fresh mint archives EXPIRED prior lineage rows too — the extension flow must have nothing to revive (audit r8 P0)', async () => {
    const expired = priorMint({
      id: 'est-expired',
      token: 'tok-expired',
      expires_at: '2026-08-01T00:00:00Z',
      estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-stale' } },
    });
    const accepted = priorMint({
      id: 'est-accepted-old',
      status: 'accepted',
      estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-older' } },
    });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [expired, accepted] });
    await mintReportClickEstimate(trx, baseArgs());
    const archived = ops.updates.filter((u) => u.table === 'estimates' && u.patch.archived_at).map((u) => u.criteria?.id);
    expect(archived).toEqual(['est-expired']);
    const data = JSON.parse(ops.inserts[0].row.estimate_data);
    expect(data.reportCtaMint.supersededEstimateIds).toEqual(['est-expired']);
  });

  test('an ACCEPTED identical mint reuses AND resolves the fresh request row — even when the customer now owns the service (audit r8 P0)', async () => {
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint({ status: 'accepted' })],
    });
    const args = baseArgs({ deduped: false });
    // Ownership reflects the acceptance — the accepted-reuse path must not
    // consult it (the tap just gets the accepted estimate back).
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: ['lawn', 'pest_control'], ownedServiceKeys: ['lawn', 'pest_control'], ownershipLookupFailed: false,
    }));
    const out = await mintReportClickEstimate(trx, args);
    expect(out.reused).toBe(true);
    expect(out.estimateId).toBe('est-old');
    expect(ops.inserts).toHaveLength(0);
    const rowUpdate = ops.updates.find((u) => u.table === 'service_requests');
    expect(rowUpdate.patch.status).toBe('resolved');
    // The route keys the "Bundle inquiry" bell off this flag (GitHub round
    // P1): the work is booked and the fresh row was just resolved, so
    // deduped=false alone must not page staff.
    expect(out.acceptedReuse).toBe(true);
  });

  test('an UNACCEPTED identical mint does NOT reuse when the customer now owns the service — revalidation precedes reuse (audit r8 P0)', async () => {
    const { trx, ops } = fakeTrx({ priorEstimateRows: [priorMint()] });
    const args = baseArgs({ deduped: false });
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: ['lawn'], ownedServiceKeys: ['lawn', 'pest_control'], ownershipLookupFailed: false,
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/now owned/);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
  });

  test('a target service the customer NOW owns refuses the mint as drift (audit r7 P0)', async () => {
    // An acceptance or staff add between composition and the tap: the
    // in-transaction re-read sees pest owned — publishing another
    // acceptable pest estimate would duplicate billing on accept.
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: ['lawn'], ownedServiceKeys: ['lawn', 'pest_control'], ownershipLookupFailed: false,
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/now owned/);
    expect(ops.inserts).toHaveLength(0);
  });

  test('a CHANGED qualifying baseline refuses the mint as drift — the card priced a different tier basis', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: ['lawn', 'mosquito'], ownedServiceKeys: ['lawn', 'mosquito'], ownershipLookupFailed: false,
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/qualifying services changed/);
    expect(ops.inserts).toHaveLength(0);
  });

  test('a failed ownership revalidation fails CLOSED as a retryable non-drift error', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: [], ownedServiceKeys: [], ownershipLookupFailed: true,
    }));
    const err = await mintReportClickEstimate(trx, args).catch((e) => e);
    expect(err.message).toMatch(/ownership revalidation failed/);
    expect(err.name).not.toBe('ClickEstimateDriftError');
    expect(ops.inserts).toHaveLength(0);
  });

  test('a member whose membership context fails to load fails CLOSED (no estimate at wrong terms)', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.computeMembershipContext = jest.fn(async () => { throw new Error('transient'); });
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/existing-member context/);
    expect(ops.inserts).toHaveLength(0);
  });

  test('a customer with NO prior services mints without a membership snapshot', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.crossSell.engineContext.currentServiceKeys = [];
    args.deps.pricingAi.loadCurrentServiceKeys = jest.fn(async () => ({
      currentServiceKeys: [], ownedServiceKeys: [], ownershipLookupFailed: false,
    }));
    args.deps.computeMembershipContext = jest.fn(async () => null);
    const out = await mintReportClickEstimate(trx, args);
    expect(out.reused).toBe(false);
    const data = JSON.parse(ops.inserts[0].row.estimate_data);
    expect(data.membershipSnapshot).toBeUndefined();
    expect(data.priorQualifyingServices).toBeUndefined();
  });

  test('a snapshot that did not freeze pricing fails CLOSED', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    args.deps.buildEstimateSendSnapshot = jest.fn(async (estimate) => ({
      ...estimate.estimate_data,
      sendSnapshot: { pricingBundleError: 'bundle exploded' },
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/did not freeze pricing/);
  });

  test('a snapshot whose bundle disagrees with the minted totals fails CLOSED', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    args.deps.bundleUtils = { pricingBundleMatchesEstimateTotals: () => false };
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/does not match the minted totals/);
  });

  test('identity persists from the row re-read UNDER the lock — a profile edit between pricing and tap reaches the estimate', async () => {
    const { trx, ops } = fakeTrx({
      customerRow: { ...CUSTOMER, email: 'renamed@example.com', first_name: 'Renamed' },
    });
    await mintReportClickEstimate(trx, baseArgs());
    const insert = ops.inserts.find((i) => i.table === 'estimates');
    expect(insert.row.customer_email).toBe('renamed@example.com');
    expect(insert.row.customer_name).toBe('Renamed Fixture');
  });

  test('a premises change between pricing and tap is offer drift — refuse, never price the old property', async () => {
    const { trx, ops } = fakeTrx({
      customerRow: { ...CUSTOMER, address_line1: '99 Moved Ave' },
    });
    await expect(mintReportClickEstimate(trx, baseArgs())).rejects.toThrow(ClickEstimateDriftError);
    expect(ops.inserts).toHaveLength(0);
  });

  test('a vanished/deactivated customer row refuses the mint', async () => {
    const { trx } = fakeTrx({ customerRow: { ...CUSTOMER, active: false } });
    await expect(mintReportClickEstimate(trx, baseArgs())).rejects.toThrow(/customer row vanished/);
  });

  test('a failed recompute refuses the mint', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    args.deps.recompute = jest.fn(async () => ({ recomputed: false, reason: 'ENGINE_ERROR' }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/recompute failed/);
  });

  test('a one-time total with NO declared line fee refuses the mint (undisclosed charge)', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.recompute = jest.fn(async () => ({
      recomputed: true,
      serverResult: { engineVersion: 'v4.2-test', recurring: {} },
      serverTotals: { monthlyTotal: 38, annualTotal: 456, onetimeTotal: 99 },
      pestPricingVersion: null,
      rawEngineResult: RAW_RESULT,
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(ClickEstimateDriftError);
    expect(ops.inserts).toHaveLength(0);
  });

  test('the line-declared standing setup fee is PERMITTED (the estimate page itemizes it before acceptance)', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.deps.recompute = jest.fn(async () => ({
      recomputed: true,
      serverResult: { engineVersion: 'v4.2-test', recurring: {} },
      serverTotals: { monthlyTotal: 38, annualTotal: 456, onetimeTotal: 99 },
      pestPricingVersion: null,
      rawEngineResult: {
        ...RAW_RESULT,
        lineItems: [{ ...RAW_RESULT.lineItems[0], initialFee: 99 }],
      },
    }));
    const out = await mintReportClickEstimate(trx, args);
    expect(out.reused).toBe(false);
    expect(ops.inserts).toHaveLength(1);
  });

  test('a one-time total EXCEEDING the declared fee refuses the mint', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    args.deps.recompute = jest.fn(async () => ({
      recomputed: true,
      serverResult: { engineVersion: 'v4.2-test', recurring: {} },
      serverTotals: { monthlyTotal: 38, annualTotal: 456, onetimeTotal: 148 },
      pestPricingVersion: null,
      rawEngineResult: {
        ...RAW_RESULT,
        lineItems: [{ ...RAW_RESULT.lineItems[0], initialFee: 99 }],
      },
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(ClickEstimateDriftError);
  });

  test('a tiered card whose recompute has NO tier refuses the mint', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    args.deps.recompute = jest.fn(async () => ({
      recomputed: true,
      serverResult: { engineVersion: 'v4.2-test', recurring: {} },
      serverTotals: { monthlyTotal: 38, annualTotal: 456, onetimeTotal: 0 },
      pestPricingVersion: null,
      rawEngineResult: { ...RAW_RESULT, waveGuard: undefined },
    }));
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(ClickEstimateDriftError);
  });

  test('the membership snapshot is bounded to the card\'s primary-property street scope', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    await mintReportClickEstimate(trx, args);
    expect(args.deps.computeMembershipContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      customerId: 'cust-9',
      streetScope: {
        estimateStreet: '12 invented way|parrish|34219',
        customerPrimaryStreet: '12 invented way|parrish|34219',
        requireSharedLocality: true,
      },
    }));
  });

  test('a live STAFF-REVISED lineage row blocks the tap as drift — never archived, never minted beside (GitHub round P0)', async () => {
    // A revise drops the fingerprint (preserveClickMintMarkersAcrossRevise
    // stamps fingerprintInvalidatedAt), so the revised row can never match
    // for reuse — and it may already be DELIVERED. Archiving it breaks the
    // customer's in-flight token; minting beside it puts two live honorable
    // prices in their hands. The tap refuses instead.
    const revised = priorMint({
      estimate_data: {
        reportCtaMint: {
          serviceKey: 'pest_control',
          fingerprintInvalidatedAt: '2026-08-13T10:00:00Z',
        },
      },
    });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [revised] });
    await expect(mintReportClickEstimate(trx, baseArgs({ deduped: false })))
      .rejects.toThrow(/staff-revised/);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
  });

  test('an EXPIRED staff-revised row does not block — the fresh mint supersedes it like any dead lineage row (audit on round 9)', async () => {
    // The customer's revised token is already dead: 409ing forever would
    // orphan the card, and leaving the row unarchived would give the
    // public extension flow something to revive beside the fresh mint.
    const deadRevised = priorMint({
      id: 'est-revised-dead',
      expires_at: new Date('2026-08-01T00:00:00Z'),
      estimate_data: {
        reportCtaMint: {
          serviceKey: 'pest_control',
          fingerprintInvalidatedAt: '2026-08-13T10:00:00Z',
        },
      },
    });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [deadRevised] });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    expect(out.reused).toBe(false);
    expect(ops.inserts).toHaveLength(1);
    const archive = ops.updates.find((u) => u.table === 'estimates' && u.patch.archived_at);
    expect(archive.criteria).toEqual({ id: 'est-revised-dead' });
  });

  test('an ARCHIVED or ACCEPTED staff-revised row does not block a fresh mint', async () => {
    // Archived = staff already retired it; accepted = the work is booked
    // (ownership revalidation guards that case). Neither is a live second
    // price, so the tap proceeds.
    const mark = { serviceKey: 'pest_control', fingerprintInvalidatedAt: '2026-08-13T10:00:00Z' };
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [
        priorMint({ id: 'est-archived', archived_at: new Date('2026-08-12T00:00:00Z'), estimate_data: { reportCtaMint: mark } }),
      ],
    });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    expect(out.reused).toBe(false);
    expect(ops.inserts).toHaveLength(1);
  });

  test('a report admitted by the SINGLE-PREMISES proof re-proves it under the lock — new premises evidence refuses reuse and mint alike (GitHub round P1)', async () => {
    // Staff sets has_multi_home or adds a customer_properties row between
    // composition and the tap: the premises-pair and pricing-source checks
    // compare the primary profile against itself and cannot see it, but the
    // report may belong to the newly evidenced secondary premises.
    const { trx, ops } = fakeTrx({ priorEstimateRows: [priorMint()] });
    const args = baseArgs({ deduped: true });
    args.crossSell.engineContext.premisesProof = 'single_premises';
    args.deps.customerHasOnlyPrimaryPremises = jest.fn(async () => false);
    await expect(mintReportClickEstimate(trx, args))
      .rejects.toThrow(/premises evidence changed/);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
    // The proof re-ran with the row re-read UNDER the lock, on the same
    // scope key the composition anchored to.
    expect(args.deps.customerHasOnlyPrimaryPremises).toHaveBeenCalledWith(
      trx, 'cust-9', expect.objectContaining({ id: 'cust-9' }), '12 invented way|parrish|34219',
    );
  });

  test('a single-premises report whose proof still holds mints normally', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    args.crossSell.engineContext.premisesProof = 'single_premises';
    const out = await mintReportClickEstimate(trx, args);
    expect(out.reused).toBe(false);
    expect(ops.inserts).toHaveLength(1);
    expect(args.deps.customerHasOnlyPrimaryPremises).toHaveBeenCalledTimes(1);
  });

  test('a LINKAGE-proven report never consults the single-premises proof', async () => {
    // The report carries its own address evidence — a second property on
    // the account is irrelevant to a visit proven at the primary.
    const { trx } = fakeTrx();
    const args = baseArgs();
    await mintReportClickEstimate(trx, args);
    expect(args.deps.customerHasOnlyPrimaryPremises).not.toHaveBeenCalled();
  });

  test('a context with NO premises-proof stamp refuses as a hard error (old composition shape)', async () => {
    const { trx, ops } = fakeTrx();
    const args = baseArgs();
    delete args.crossSell.engineContext.premisesProof;
    await expect(mintReportClickEstimate(trx, args)).rejects.toThrow(/without engine context/);
    expect(ops.inserts).toHaveLength(0);
  });

  test('a MID-SEND lineage row refuses a superseding mint as retryable — never archived under an in-flight delivery (GitHub round P0)', async () => {
    // The admin send workflow commits status='sending' before the provider
    // calls, and finalization does not reject an archived row: archiving
    // here would deliver a dead token and mint a second estimate beside it.
    const midSend = priorMint({
      id: 'est-midsend', status: 'sending',
      estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-DIFFERENT' } },
    });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [midSend] });
    const err = await mintReportClickEstimate(trx, baseArgs({ deduped: false })).catch((e) => e);
    // Retryable (route 503), NOT drift — the send finishes in seconds and
    // the next tap proceeds.
    expect(err).toBeInstanceOf(Error);
    expect(err.clickEstimateDrift).toBeUndefined();
    expect(err.message).toMatch(/in flight/);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates.filter((u) => u.table === 'estimates')).toHaveLength(0);
  });

  test('a mid-send row with the UNCHANGED fingerprint reuses — the tap hands back the very token being delivered', async () => {
    const midSend = priorMint({ id: 'est-midsend', status: 'sending' });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [midSend] });
    const out = await mintReportClickEstimate(trx, baseArgs({
      deduped: true,
      requestRow: { id: 'req-3', pricing_revision: JSON.stringify({ mintedEstimate: { id: 'est-midsend', token: 'tok-old' } }) },
    }));
    expect(out.reused).toBe(true);
    expect(out.estimateId).toBe('est-midsend');
    expect(ops.updates.filter((u) => u.table === 'estimates')).toHaveLength(0);
  });

  test('a SCHEDULED delivery refuses a superseding mint as DRIFT — archiving would silently cancel the planned send (GitHub round P0)', async () => {
    // The scheduler skips archived rows, so archival kills the token the
    // customer may already hold; and unlike 'sending', the job can be days
    // out — drift (card refresh), not a "retry shortly".
    const scheduled = priorMint({
      id: 'est-scheduled', status: 'scheduled',
      estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-DIFFERENT' } },
    });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [scheduled] });
    await expect(mintReportClickEstimate(trx, baseArgs({ deduped: false })))
      .rejects.toThrow(ClickEstimateDriftError);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates.filter((u) => u.table === 'estimates')).toHaveLength(0);
  });

  test('a scheduled row with the UNCHANGED fingerprint reuses — the tap hands back the token staff planned to deliver', async () => {
    const scheduled = priorMint({ id: 'est-scheduled', status: 'scheduled' });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [scheduled] });
    const out = await mintReportClickEstimate(trx, baseArgs({
      deduped: true,
      requestRow: { id: 'req-3', pricing_revision: JSON.stringify({ mintedEstimate: { id: 'est-scheduled', token: 'tok-old' } }) },
    }));
    expect(out.reused).toBe(true);
    expect(ops.updates.filter((u) => u.table === 'estimates')).toHaveLength(0);
  });

  test('an accepted mint whose service was since CANCELED is terminal history — the tap mints a fresh offer instead of the dead end (GitHub round P1)', async () => {
    // Default ownership mock: lawn held, pest_control NOT — the post-cancel
    // state. The accepted row must neither satisfy the tap (auto-resolved
    // request, nothing acceptable) nor block the fresh mint.
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint({ status: 'accepted' })],
    });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    expect(out.reused).toBe(false);
    expect(out.acceptedReuse).toBeUndefined();
    expect(ops.inserts).toHaveLength(1);
    // The accepted row itself is never archived.
    const archive = ops.updates.find((u) => u.table === 'estimates' && u.patch.archived_at);
    expect(archive).toBeUndefined();
  });

  test('the turf-profile revalidation read takes the row lock — the admin turf PUT writes without the customer lock (GitHub round P1)', async () => {
    const { trx } = fakeTrx();
    const args = baseArgs();
    await mintReportClickEstimate(trx, args);
    expect(args.deps.pricingAi.loadTurfProfile).toHaveBeenCalledWith(trx, 'cust-9', { forUpdate: true });
  });

  test('a CRASHED send (sending, window lapsed) supersedes like any dead lineage row', async () => {
    const crashed = priorMint({
      id: 'est-crashed', status: 'sending', expires_at: new Date('2026-08-01T00:00:00Z'),
      estimate_data: { reportCtaMint: { serviceKey: 'pest_control', fingerprint: 'fp-DIFFERENT' } },
    });
    const { trx, ops } = fakeTrx({ priorEstimateRows: [crashed] });
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: false }));
    expect(out.reused).toBe(false);
    const archive = ops.updates.find((u) => u.table === 'estimates' && u.patch.archived_at);
    expect(archive.criteria).toEqual({ id: 'est-crashed' });
  });

  test('the minted row stamps the engine version that actually priced it', async () => {
    const { trx, ops } = fakeTrx();
    await mintReportClickEstimate(trx, baseArgs());
    expect(ops.inserts[0].row.pricing_version).toBe('v4.2-test');
  });
});

describe('priorMintStillLive', () => {
  const now = new Date('2026-08-13T12:00:00Z');
  test('live sent/viewed rows with future expiry are live; accepted is always live', () => {
    expect(priorMintStillLive({ status: 'sent', expires_at: '2026-08-20' }, now)).toBe(true);
    expect(priorMintStillLive({ status: 'accepted', expires_at: '2026-08-01' }, now)).toBe(true);
  });
  test('archived, expired, declined, and draft rows are dead', () => {
    expect(priorMintStillLive({ status: 'sent', archived_at: '2026-08-12' }, now)).toBe(false);
    expect(priorMintStillLive({ status: 'sent', expires_at: '2026-08-01' }, now)).toBe(false);
    expect(priorMintStillLive({ status: 'declined' }, now)).toBe(false);
    expect(priorMintStillLive({ status: 'draft' }, now)).toBe(false);
    expect(priorMintStillLive(null, now)).toBe(false);
  });
  test('an in-flight operator send (sending, window not lapsed) is LIVE; a stale claim (lapsed) is a crashed send and dead (GitHub round P0)', () => {
    expect(priorMintStillLive({ status: 'sending', expires_at: '2026-08-20' }, now)).toBe(true);
    expect(priorMintStillLive({ status: 'sending', expires_at: '2026-08-01' }, now)).toBe(false);
  });
  test('a SCHEDULED delivery is live even past its old expiry — the send finalization writes the real one (GitHub round P0)', () => {
    expect(priorMintStillLive({ status: 'scheduled', expires_at: '2026-08-20' }, now)).toBe(true);
    expect(priorMintStillLive({ status: 'scheduled', expires_at: '2026-08-01' }, now)).toBe(true);
  });
});
