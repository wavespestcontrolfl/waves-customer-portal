import { describe, expect, it } from 'vitest';
import { documentRenderAffirmed, synthesizeDocumentProposal } from './estimate-document-proposal';

const estimate = { customerName: 'William Carter', address: '10225 Kalamazoo Pl, Parrish, FL 34219' };

describe('estimate preview document proposal (mode=pdf parity)', () => {
  it('prices a recurring fixture per application, like the server synthesizer', () => {
    const proposal = synthesizeDocumentProposal({
      estimate,
      pricing: {
        services: [{
          key: 'pest_control',
          label: 'Pest Control',
          defaultFrequencyKey: 'quarterly',
          frequencies: [
            { key: 'quarterly', label: 'Quarterly', monthly: 31.33, annual: 375.96, perVisit: 94, visitsPerYear: 4 },
            { key: 'monthly', label: 'Monthly', monthly: 55, annual: 660, perVisit: 55, visitsPerYear: 12 },
          ],
        }],
        oneTimeBreakdown: { total: 0, items: [] },
      },
    });
    expect(proposal).toMatchObject({ enabled: false, synthesized: true, title: 'Service Proposal', preparedFor: 'William Carter' });
    expect(proposal.buildings).toEqual([{
      name: estimate.address,
      note: null,
      lineItems: [{
        description: 'Pest Control — 4 applications/yr',
        quantity: 1,
        unitPrice: 94,
        amount: 94,
        frequency: 'per_application',
        frequencyLabel: 'Per application',
        taxable: false,
        visitsPerYear: 4,
      }],
    }]);
    expect(proposal.totals).toMatchObject({ annualRecurring: 376, oneTime: 0, firstYearTotal: 376, hasTax: false });
    expect(documentRenderAffirmed(proposal)).toBe(true);
  });

  it('prints charged and included one-time rows only when they reconcile to the total', () => {
    const reconciled = synthesizeDocumentProposal({
      estimate,
      pricing: {
        services: [],
        oneTimeBreakdown: {
          total: 694,
          items: [
            { service: 'trap_only_retainer', label: 'Standard Trap-Only Monitoring Retainer', amount: 495, kind: 'charge' },
            { service: 'trap_only_setup', label: 'Trap-Only Setup / Inspection', amount: 199, kind: 'charge' },
            { service: 'callback', label: 'First callback', amount: 0, kind: 'included' },
          ],
        },
      },
    });
    expect(reconciled.buildings[0].lineItems.map((line) => [line.description, line.amount, line.frequencyLabel])).toEqual([
      ['Standard Trap-Only Monitoring Retainer', 495, 'One-time'],
      ['Trap-Only Setup / Inspection', 199, 'One-time'],
      ['First callback (Included)', 0, 'One-time'],
    ]);
    expect(reconciled.totals).toMatchObject({ annualRecurring: 0, oneTime: 694, firstYearTotal: 694 });

    const unreconciled = synthesizeDocumentProposal({
      estimate,
      pricing: { services: [], oneTimeBreakdown: { total: 500, items: [{ label: 'Partial row', amount: 300, kind: 'charge' }] } },
    });
    expect(unreconciled.buildings[0].lineItems).toEqual([expect.objectContaining({ description: 'One-time service', amount: 500 })]);
  });

  it('withholds the document for a quote-required fixture with no priced line', () => {
    const proposal = synthesizeDocumentProposal({
      estimate,
      pricing: {
        services: [],
        oneTimeBreakdown: { total: 0, items: [{ service: 'bed_bug_heat', label: 'Bed Bug Heat Treatment', amount: null, kind: 'quote_required' }] },
      },
    });
    expect(proposal.buildings[0].lineItems).toEqual([]);
    expect(documentRenderAffirmed(proposal)).toBe(false);
    expect(documentRenderAffirmed(null)).toBe(false);
    expect(documentRenderAffirmed({ buildings: [], programs: [{ label: 'Program' }] })).toBe(true);
  });
});
