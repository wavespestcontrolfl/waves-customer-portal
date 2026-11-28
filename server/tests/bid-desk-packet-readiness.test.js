'use strict';

const { evaluateBidPacketReadiness, loadBidPacketReadiness } = require('../services/bid-desk/packet-readiness');
const { templateRows } = require('../../shared/bid-checklist-templates.cjs');

const NOW = new Date('2026-11-27T15:00:00Z');
const ATTESTED = '2026-11-01T12:00:00Z';

function kitDoc(itemKey, extra = {}) {
  return {
    id: `kit-${itemKey}`,
    kind: 'document',
    item_key: itemKey,
    has_file: true,
    expires_on: '2027-09-30',
    attested_at: ATTESTED,
    archived_at: null,
    ...extra,
  };
}

function kitRef(idx, extra = {}) {
  return {
    id: `ref-${idx}`,
    kind: 'reference',
    item_key: 'reference',
    value: `Municipal Reference ${idx}`,
    permission_on: '2026-10-15',
    attested_at: ATTESTED,
    archived_at: null,
    ...extra,
  };
}

function fullItbKit() {
  return [
    kitDoc('business_license_copy'),
    kitDoc('cpco_certificate'),
    kitDoc('cpco_fulltime_statement', { expires_on: null }),
    kitDoc('employee_id_cards'),
    kitDoc('product_list', { expires_on: null }),
    kitDoc('sunbiz_status', { expires_on: null }),
    kitDoc('business_tax_receipt'),
    kitDoc('everify', { expires_on: null }),
    kitDoc('drug_free_policy', { expires_on: null }),
    kitDoc('service_center_proof', { expires_on: null }),
    kitRef(1),
    kitRef(2),
    kitRef(3),
  ];
}

function checkedItbChecklist() {
  return templateRows('itb').map((row, idx) => ({
    id: `chk-${idx}`,
    ...row,
    checked_at: ATTESTED,
    archived_at: null,
  }));
}

function healthyEstimate() {
  return {
    id: 'est-1',
    status: 'draft',
    estimate_data: {
      proposal: {
        enabled: true,
        validThrough: '2027-02-01',
        buildings: [{
          name: 'Main Campus',
          // $1,000/mo recurring building line = $12,000/yr via computeProposalTotals
          lineItems: [{ description: 'Monthly IPM Service', quantity: 1, unitPrice: 1000, frequency: 'monthly' }],
        }],
      },
      proposalCosting: {
        revenueYears: 1,
        rows: [
          { category: 'labor', phase: 'Service', description: 'Tech visits', quantity: 2, unit: 'hour', unitCost: 90, occurrences: 12 },
          { category: 'material', phase: 'Service', description: 'Bait & residual', quantity: 1, unit: 'trip', unitCost: 150, occurrences: 12 },
        ],
      },
    },
  };
}

describe('bid-desk packet readiness analyzer', () => {
  test('uses proposal builder recurring totals and proposalCosting; clears per-bid actions once their checklist lines are checked', () => {
    const out = evaluateBidPacketReadiness({
      bid: {
        id: 'bid-1',
        status: 'bid',
        solicitation_type: 'itb',
        due_at: '2026-12-18T19:00:00Z',
        due_confirmed: true,
        needs_date_confirmation: false,
        job_walk_mandatory: true,
        job_walk_at: '2026-12-05T15:00:00Z',
        job_walk_confirmed: true,
      },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: healthyEstimate(),
      now: NOW,
    });

    expect(out.blockers).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.kit_coverage.percent).toBe(100);
    expect(out.per_bid_actions).toEqual([]);
    expect(out.pricing).toMatchObject({
      linked: true,
      revenue_total: 12000,
      cost_total: 3960,
      gross_margin_pct: 67,
      costing_complete: true,
    });
    expect(out.status).toBe('ready');

    // While the notarized checklist line is still unchecked, the per-bid action stays active
    const uncheckedNotary = checkedItbChecklist().map((item) => (
      item.template_key === 'itb.operator_statement' ? { ...item, checked_at: null } : item
    ));
    const pendingNotary = evaluateBidPacketReadiness({
      bid: {
        id: 'bid-1',
        status: 'bid',
        solicitation_type: 'itb',
        due_at: '2026-12-18T19:00:00Z',
        due_confirmed: true,
      },
      checklistItems: uncheckedNotary,
      bidKitRows: fullItbKit(),
      estimate: healthyEstimate(),
      now: NOW,
    });
    expect(pendingNotary.per_bid_actions.some((a) => a.key === 'cpco_fulltime_statement' && a.notarized)).toBe(true);
    expect(pendingNotary.status).toBe('action_needed');
  });

  test('blocks when a license is valid today but expires BEFORE the bid due date', () => {
    const kit = fullItbKit().map((row) => (
      row.item_key === 'business_license_copy' ? { ...row, expires_on: '2026-12-10' } : row
    ));
    const out = evaluateBidPacketReadiness({
      bid: { id: 'bid-2', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-20T19:00:00Z', due_confirmed: true },
      checklistItems: checkedItbChecklist(),
      bidKitRows: kit,
      estimate: healthyEstimate(),
      now: NOW,
    });

    expect(out.status).toBe('blocked');
    expect(out.blockers.some((b) => b.code === 'kit_expires_before_due' && b.key === 'business_license_copy')).toBe(true);
  });

  test('blocks on insufficient references, addendum date flag, unconfirmed mandatory job walk, and expired proposal validity', () => {
    const kit = fullItbKit().filter((r) => r.id !== 'ref-2' && r.id !== 'ref-3');
    const staleEstimate = healthyEstimate();
    staleEstimate.estimate_data.proposal.validThrough = '2026-12-01';
    const out = evaluateBidPacketReadiness({
      bid: {
        id: 'bid-3',
        status: 'bid',
        solicitation_type: 'itb',
        due_at: '2026-12-20T19:00:00Z',
        due_confirmed: true,
        needs_date_confirmation: true,
        job_walk_mandatory: true,
        job_walk_at: '2026-12-08T15:00:00Z',
        job_walk_confirmed: false,
      },
      checklistItems: checkedItbChecklist(),
      bidKitRows: kit,
      estimate: staleEstimate,
      now: NOW,
    });

    expect(out.status).toBe('blocked');
    const codes = out.blockers.map((b) => b.code);
    expect(codes).toContain('kit_item_not_ready');
    expect(codes).toContain('addendum_date_check');
    expect(codes).toContain('mandatory_job_walk_unconfirmed');
    expect(codes).toContain('proposal_expires_before_due');
  });

  test('checks estimates.expires_at when fixed validThrough is absent, and blocks overdue unsubmitted active bids', () => {
    const est = healthyEstimate();
    delete est.estimate_data.proposal.validThrough;
    est.expires_at = '2026-11-20T23:59:59Z';
    const out = evaluateBidPacketReadiness({
      bid: {
        id: 'bid-overdue',
        status: 'bid',
        solicitation_type: 'itb',
        due_at: '2026-11-25T19:00:00Z',
        due_confirmed: true,
        submitted_at: null,
      },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: est,
      now: NOW,
    });

    const codes = out.blockers.map((b) => b.code);
    expect(codes).toContain('proposal_expired');
    expect(codes).toContain('bid_due_passed');
  });

  test('respects operator required:false on optional checklist lines and optional stop checks', () => {
    const checklist = checkedItbChecklist().map((item) => (
      item.template_key === 'stop.local_office' || item.template_key === 'itb.responsibility'
        ? { ...item, required: false, checked_at: null }
        : item
    ));
    const kitWithoutServiceCenter = fullItbKit().filter((r) => r.item_key !== 'service_center_proof');
    const out = evaluateBidPacketReadiness({
      bid: { id: 'bid-opt', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-18T19:00:00Z', due_confirmed: true },
      checklistItems: checklist,
      bidKitRows: kitWithoutServiceCenter,
      estimate: healthyEstimate(),
      now: NOW,
    });

    expect(out.blockers).toEqual([]);
    expect(out.kit_coverage.items.some((i) => i.key === 'service_center_proof')).toBe(false);
  });

  test('warns on thin gross margin (< 35%) and predicts kit papers even before checklist is started', () => {
    const thinEst = healthyEstimate();
    thinEst.estimate_data.proposalCosting.rows = [
      { category: 'labor', phase: 'Service', description: 'Heavy crew', quantity: 10, unit: 'hour', unitCost: 75, occurrences: 12 },
    ];
    const out = evaluateBidPacketReadiness({
      bid: { id: 'bid-4', status: 'bid', solicitation_type: 'gc_subcontract', due_at: '2026-12-15T19:00:00Z', due_confirmed: true },
      checklistItems: [],
      bidKitRows: [kitDoc('insurance_certificate'), ...fullItbKit()],
      estimate: thinEst,
      now: NOW,
    });

    expect(out.pricing.gross_margin_pct).toBe(25);
    expect(out.warnings.map((w) => w.code)).toContain('thin_margin');
    expect(out.warnings.map((w) => w.code)).toContain('checklist_not_started');
    expect(out.kit_coverage.items.some((i) => i.key === 'insurance_certificate')).toBe(true);
  });

  test('loadBidPacketReadiness reports explicit kit_unavailable when Bid Kit read fails instead of marking every paper missing', async () => {
    const out = await loadBidPacketReadiness({
      bid: { id: 'bid-5', status: 'new', solicitation_type: 'quote', due_at: '2026-12-15T19:00:00Z', due_confirmed: true },
      checklistItems: [],
      estimate: null,
      now: NOW,
      listKitItems: async () => { throw new Error('db down'); },
    });
    expect(out.status).toBe('blocked');
    expect(out.kit_coverage.unavailable).toBe(true);
    expect(out.kit_coverage.percent).toBeNull();
    expect(out.blockers).toEqual([expect.objectContaining({ code: 'kit_unavailable' })]);
  });

  test('computes fallback revenue from monthly_total/onetime_total, flags complete costing with $0 revenue, and excludes archived template keys', () => {
    const fallbackEstimate = {
      id: 'est-fallback',
      status: 'draft',
      monthly_total: 1000,
      onetime_total: 500,
      estimate_data: {
        proposalCosting: {
          revenueYears: 1,
          rows: [{ category: 'labor', phase: 'Service', description: 'Crew', quantity: 2, unit: 'hour', unitCost: 100, occurrences: 12 }],
        },
      },
    };
    const fallbackOut = evaluateBidPacketReadiness({
      bid: { id: 'bid-fb', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-18T19:00:00Z', due_confirmed: true },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: fallbackEstimate,
      now: NOW,
    });
    expect(fallbackOut.pricing.revenue_total).toBe(12500);
    expect(fallbackOut.pricing.cost_total).toBe(2400);
    expect(fallbackOut.pricing.gross_margin_pct).toBe(80.8);

    const zeroRevenueEstimate = {
      id: 'est-zero',
      status: 'draft',
      estimate_data: {
        proposal: { enabled: true, buildings: [{ name: 'Site', lineItems: [] }] },
        proposalCosting: {
          revenueYears: 1,
          rows: [{ category: 'labor', phase: 'Service', description: 'Crew', quantity: 2, unit: 'hour', unitCost: 100, occurrences: 12 }],
        },
      },
    };
    const zeroOut = evaluateBidPacketReadiness({
      bid: { id: 'bid-zero', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-18T19:00:00Z', due_confirmed: true },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: zeroRevenueEstimate,
      now: NOW,
    });
    expect(zeroOut.pricing.costing_complete).toBe(true);
    expect(zeroOut.pricing.revenue_total).toBe(0);
    expect(zeroOut.warnings.map((w) => w.code)).toContain('missing_proposal_revenue');

    const allItbTemplateKeys = templateRows('itb').map((row) => row.template_key);
    const archivedOut = evaluateBidPacketReadiness({
      bid: { id: 'bid-arch', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-18T19:00:00Z', due_confirmed: true },
      checklistItems: [],
      archivedTemplateKeys: allItbTemplateKeys,
      bidKitRows: [],
      estimate: healthyEstimate(),
      now: NOW,
    });
    expect(archivedOut.kit_coverage.total).toBe(0);
    expect(archivedOut.blockers).toEqual([]);
  });

  test('blocks inactive SAM.gov notices, blocks archived or declined estimates, and treats unconfirmed due dates as provisional for expiry checks', () => {
    const closedSam = evaluateBidPacketReadiness({
      bid: {
        id: 'bid-sam-closed',
        status: 'bid',
        solicitation_type: 'federal',
        source: 'sam_gov',
        source_active: false,
        needs_date_confirmation: false,
        due_at: '2026-12-20T19:00:00Z',
        due_confirmed: true,
      },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: healthyEstimate(),
      now: NOW,
    });
    expect(closedSam.status).toBe('blocked');
    expect(closedSam.blockers.map((b) => b.code)).toContain('source_inactive');

    const archivedEst = { ...healthyEstimate(), archived_at: '2026-11-20T12:00:00Z' };
    const archivedEstOut = evaluateBidPacketReadiness({
      bid: { id: 'bid-est-arch', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-18T19:00:00Z', due_confirmed: true },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: archivedEst,
      now: NOW,
    });
    expect(archivedEstOut.blockers.map((b) => b.code)).toContain('estimate_archived');

    const declinedEst = { ...healthyEstimate(), status: 'declined' };
    const declinedEstOut = evaluateBidPacketReadiness({
      bid: { id: 'bid-est-dec', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-18T19:00:00Z', due_confirmed: true },
      checklistItems: checkedItbChecklist(),
      bidKitRows: fullItbKit(),
      estimate: declinedEst,
      now: NOW,
    });
    expect(declinedEstOut.blockers.map((b) => b.code)).toContain('estimate_not_usable');

    // Unconfirmed due date: valid-today license & proposal expiring before tentative due_at do NOT block
    const soonKit = fullItbKit().map((row) => (
      row.item_key === 'business_license_copy' ? { ...row, expires_on: '2026-12-10' } : row
    ));
    const soonEst = healthyEstimate();
    soonEst.estimate_data.proposal.validThrough = '2026-12-10';
    const provisionalOut = evaluateBidPacketReadiness({
      bid: { id: 'bid-prov', status: 'bid', solicitation_type: 'itb', due_at: '2026-12-20T19:00:00Z', due_confirmed: false },
      checklistItems: checkedItbChecklist(),
      bidKitRows: soonKit,
      estimate: soonEst,
      now: NOW,
    });
    expect(provisionalOut.blockers).toEqual([]);
    expect(provisionalOut.warnings.map((w) => w.code)).toContain('due_date_unconfirmed');
  });
});
