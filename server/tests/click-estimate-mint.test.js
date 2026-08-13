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
};

function fakeTrx({ priorEstimateRows = [], customerRow = CUSTOMER } = {}) {
  const ops = { inserts: [], updates: [], selects: [] };
  const trx = (table) => {
    const q = {
      _criteria: null,
      where(criteria) { q._criteria = criteria; ops.selects.push({ table, criteria }); return q; },
      whereNull() { return q; },
      whereNot() { return q; },
      whereRaw() { return q; },
      forUpdate() { return q; },
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
    },
    computeMembershipContext: jest.fn(async () => ({ member: true })),
    bundleUtils: { pricingBundleMatchesEstimateTotals: () => true },
    buildEstimateSendSnapshot: jest.fn(async (estimate) => ({
      ...estimate.estimate_data,
      sendSnapshot: { renderedAt: 'now', tierDiscounts: {}, pricingBundle: { frequencies: [{}] } },
    })),
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
    const out = await mintReportClickEstimate(trx, baseArgs({ deduped: true }));
    expect(out.reused).toBe(true);
    expect(out.url).toBe('/estimate/tok-old');
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(0);
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
    const { trx, ops } = fakeTrx({
      priorEstimateRows: [priorMint(), priorMint({ id: 'est-old-2', token: 'tok-old-2' })],
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
});
