// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE_SERVICE = {
  id: 'svc-1',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Quarterly Pest Control',
  billingLane: { prediction: { kind: 'invoice', amount: 95 } },
};

const stopOf = (...services) => ({
  key: `row:${services[0].id}`,
  isVisit: services.length > 1,
  services,
  primary: services[0],
  liveCount: services.length,
});

const detailFor = (byService, status = 'ready') => ({ status, byService });

const LINKED_ESTIMATE = {
  linked: true,
  estimateId: 'est-1',
  estimateSlug: 'EST-2026-0254',
  quotedTotal: 450,
  lines: [
    { name: 'Quarterly Pest Control', cadence: 'quarterly', perApplicationPrice: 115 },
    { name: 'Mosquito — WaveGuard Silver', cadence: 'monthly', monthlyPrice: 89 },
  ],
  deposit: { required: false, paid: 100, creditRemaining: 40, payerBilled: false },
  payment: { billingTerm: 'per_service', annualPrepay: false },
};

describe('VisitBriefPanel', () => {
  it('renders the three distinct money labels from the linked estimate + prediction', () => {
    render(
      <VisitBriefPanel
        stop={stopOf({ ...BASE_SERVICE, prepaidAmount: 50, prepaidMethod: 'card' })}
        detail={detailFor({ 'svc-1': { estimate: LINKED_ESTIMATE, brief: { brief: null } } })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Quoted:')).toBeInTheDocument();
    // Unit-aware terms, never the blended monthly+one-time number.
    expect(screen.getByText('$115/application + $89/mo')).toBeInTheDocument();
    expect(screen.getByText('Paid · prepaid:')).toBeInTheDocument();
    expect(screen.getByText('Prepaid $50 (card)')).toBeInTheDocument();
    expect(screen.getByText('Amount due today:')).toBeInTheDocument();
    expect(screen.getByText('Collect $95 today')).toBeInTheDocument();
    expect(screen.getByText(/\$115 \/application/)).toBeInTheDocument();
    expect(screen.getByText(/\$89 \/mo/)).toBeInTheDocument();
    expect(screen.getByText(/Deposit paid \$100 · \$40 credit remaining/)).toBeInTheDocument();
  });

  it('unlinked estimate shows NO Quoted row — never a catalog price', () => {
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={detailFor({ 'svc-1': { estimate: { linked: false }, brief: { brief: null } } })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Quoted/)).not.toBeInTheDocument();
    expect(screen.getByText('Collect $95 today')).toBeInTheDocument();
  });

  it('tap-to-call and tap-to-text anchors carry sanitized hrefs; hidden without a phone', () => {
    const { unmount } = render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)} detail={detailFor({})}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Call').closest('a')).toHaveAttribute('href', 'tel:9415550100');
    expect(screen.getByText('Text').closest('a')).toHaveAttribute('href', 'sms:9415550100');
    unmount();
    render(
      <VisitBriefPanel
        stop={stopOf({ ...BASE_SERVICE, customerPhone: null })}
        detail={detailFor({})}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.queryByText('Call')).not.toBeInTheDocument();
    expect(screen.queryByText('Text')).not.toBeInTheDocument();
    expect(screen.getByText('Navigate')).toBeInTheDocument();
  });

  it('gate codes render only when the brief response carries facts (or a served brief)', () => {
    const facts = {
      access: {
        codes: { neighborhoodGate: '9911', propertyGate: null, garage: null, lockbox: null },
        pets: 'Two dogs in the back yard',
        alerts: [],
      },
      last_visit: { date: '2026-07-14', type: 'Quarterly Pest Control', products: [{ name: 'Talstar P' }, { name: 'Taurus SC' }] },
    };
    const { unmount } = render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={detailFor({ 'svc-1': { brief: { brief: null, facts } } })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Neighborhood gate:')).toBeInTheDocument();
    expect(screen.getByText('9911')).toBeInTheDocument();
    expect(screen.getByText(/Two dogs in the back yard/)).toBeInTheDocument();
    expect(screen.getByText(/Talstar P, Taurus SC/)).toBeInTheDocument();
    unmount();
    // Degraded: no facts, no day-row alerts → the Access section vanishes
    // silently (no placeholder).
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={detailFor({ 'svc-1': { brief: { brief: null } } })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.queryByText('Access')).not.toBeInTheDocument();
    expect(screen.queryByText('Neighborhood gate:')).not.toBeInTheDocument();
  });

  it('day-row property alerts render even with no brief data at all', () => {
    render(
      <VisitBriefPanel
        stop={stopOf({ ...BASE_SERVICE, propertyAlerts: [{ type: 'chemical', text: 'Chemical sensitivity — no interior spray' }] })}
        detail={undefined}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Chemical sensitivity — no interior spray')).toBeInTheDocument();
  });

  it('shows the retry row only when every detail fetch failed', () => {
    const onRetry = vi.fn();
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)} detail={detailFor({}, 'error')}
        onRetry={onRetry} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/retry/i));
    expect(onRetry).toHaveBeenCalled();
  });

  it('last-visit fallback uses ONLY the line-scoped day-row fields', () => {
    render(
      <VisitBriefPanel
        stop={stopOf({
          ...BASE_SERVICE,
          lastServiceDate: '2026-08-20',
          lastServiceType: 'Quarterly Pest Control',
          lastServiceNotes: 'Pest visit notes',
          lastLineServiceDate: '2026-06-02',
          lastLineServiceType: 'Lawn Care Service',
          lastLineServiceNotes: 'Fertilized front turf',
        })}
        detail={detailFor({})}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText(/2026-06-02 · Lawn Care Service/)).toBeInTheDocument();
    expect(screen.getByText('Fertilized front turf')).toBeInTheDocument();
    expect(screen.queryByText(/2026-08-20/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pest visit notes')).not.toBeInTheDocument();
  });

  it('renders the WDO pre-inspection schema instead of dropping it', () => {
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={detailFor({
          'svc-1': {
            brief: {
              brief: {
                risk_score: 'High',
                risk_reason: '1968 slab home near mapped activity',
                top_3_priorities: ['Probe garage sill plate'],
                top_3_unknowns: ['Crawlspace access'],
                homeowner_questions: ['Any past termite treatment?'],
              },
              type: 'wdo_inspection',
              facts: {
                access: { codes: { neighborhoodGate: null, propertyGate: '4482', garage: null, lockbox: null }, alerts: [] },
                last_visit: null,
              },
            },
          },
        })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText(/Risk: High/)).toBeInTheDocument();
    expect(screen.getByText('• Probe garage sill plate')).toBeInTheDocument();
    expect(screen.getByText('• Crawlspace access')).toBeInTheDocument();
    expect(screen.getByText('• Any past termite treatment?')).toBeInTheDocument();
    expect(screen.getByText('4482')).toBeInTheDocument();
  });

  it('grouped stop renders money per member — a prepaid primary does not hide a sibling due', () => {
    const primary = {
      ...BASE_SERVICE, id: 'svc-1', serviceType: 'Quarterly Pest Control',
      billingLane: { prediction: { kind: 'prepaid', amount: 0 } },
    };
    const sibling = {
      ...BASE_SERVICE, id: 'svc-2', serviceType: 'Lawn Care Service',
      billingLane: { prediction: { kind: 'invoice', amount: 60 } },
    };
    render(
      <VisitBriefPanel
        stop={{ key: 'visit:v1', isVisit: true, services: [primary, sibling], primary, liveCount: 2 }}
        detail={detailFor({})}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Prepaid — nothing to collect')).toBeInTheDocument();
    expect(screen.getByText('Collect $60 today')).toBeInTheDocument();
  });

  it('falls back to the cached brief\'s access when facts carry access: null (prefs outage)', () => {
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={detailFor({
          'svc-1': {
            brief: {
              brief: {
                access: { codes: { neighborhoodGate: '9911', propertyGate: null, garage: null, lockbox: null }, alerts: [] },
                last_visit: null,
              },
              type: 'visit_brief_v1',
              facts: { access: null, last_visit: null },
            },
          },
        })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('9911')).toBeInTheDocument();
  });

  it('service-scoped deposit posture renders per member, never deduped with a shared estimate', () => {
    const primary = { ...BASE_SERVICE, id: 'svc-1', serviceType: 'Quarterly Pest Control', billingLane: null };
    const sibling = { ...BASE_SERVICE, id: 'svc-2', serviceType: 'Lawn Care Service', billingLane: null };
    const stop = { key: 'visit:v1', isVisit: true, services: [primary, sibling], primary, liveCount: 2 };
    render(
      <VisitBriefPanel
        stop={stop}
        detail={detailFor({
          'svc-1': { estimate: { ...LINKED_ESTIMATE, deposit: { payerBilled: false, paid: 100, creditRemaining: 0 } } },
          // Same estimate id, but THIS member bills to a payer.
          'svc-2': { estimate: { ...LINKED_ESTIMATE, deposit: { payerBilled: true } } },
        })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    // Shared quote lines render once…
    expect(screen.getAllByText('Quoted · EST-2026-0254')).toHaveLength(1);
    // …but each member keeps its own billing posture.
    expect(screen.getByText(/Deposit paid \$100/)).toBeInTheDocument();
    expect(screen.getByText('Bills to a payer — do not collect from the homeowner.')).toBeInTheDocument();
  });

  it('grouped stop renders each member\'s own estimate and history; one shared estimate renders once', () => {
    const primary = { ...BASE_SERVICE, id: 'svc-1', serviceType: 'Quarterly Pest Control', billingLane: null };
    const sibling = { ...BASE_SERVICE, id: 'svc-2', serviceType: 'Lawn Care Service', billingLane: null };
    const stop = { key: 'visit:v1', isVisit: true, services: [primary, sibling], primary, liveCount: 2 };
    const siblingEstimate = {
      linked: true, estimateId: 'est-2', estimateSlug: 'EST-2026-0301', quotedTotal: 720,
      lines: [{ name: 'Lawn Care Program', monthlyPrice: 60 }], deposit: null, payment: null,
    };
    const { unmount } = render(
      <VisitBriefPanel
        stop={stop}
        detail={detailFor({
          'svc-1': {
            estimate: LINKED_ESTIMATE,
            brief: { brief: null, facts: { access: null, last_visit: { date: '2026-06-02', type: 'Quarterly Pest Control', products: [{ name: 'Talstar P' }] } } },
          },
          'svc-2': {
            estimate: siblingEstimate,
            brief: { brief: null, facts: { access: null, last_visit: { date: '2026-05-19', type: 'Lawn Care Service', products: [{ name: 'Prodiamine' }] } } },
          },
        })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    // Both estimates render their own Quoted sections…
    expect(screen.getByText('Quoted · EST-2026-0254')).toBeInTheDocument();
    expect(screen.getByText('Quoted · EST-2026-0301')).toBeInTheDocument();
    // …and no single headline Quoted total (two distinct estimates).
    expect(screen.queryByText('Quoted:')).not.toBeInTheDocument();
    // Each member's line-scoped history renders.
    expect(screen.getByText(/Talstar P/)).toBeInTheDocument();
    expect(screen.getByText(/Prodiamine/)).toBeInTheDocument();
    unmount();
    // Same estimate on both members → rendered once.
    render(
      <VisitBriefPanel
        stop={stop}
        detail={detailFor({
          'svc-1': { estimate: LINKED_ESTIMATE, brief: { brief: null } },
          'svc-2': { estimate: LINKED_ESTIMATE, brief: { brief: null } },
        })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Quoted · EST-2026-0254')).toHaveLength(1);
    expect(screen.getByText('Quoted:')).toBeInTheDocument();
  });

  it('renders the served brief\'s guidance: scope, context, and lawn fixed-vs-conditional products', () => {
    render(
      <VisitBriefPanel
        stop={stopOf({ ...BASE_SERVICE, serviceType: 'Lawn Care Service' })}
        detail={detailFor({
          'svc-1': {
            brief: {
              brief: {
                open_scope: 'Booked from accepted estimate (Silver tier).',
                customer_context: 'Customer asked about brown patches near the driveway.',
                priorities: ['Walk the west fence line first'],
                watch_items: ['Sprinkler head cracked near bed 2'],
                last_visit: null,
                access: null,
                product_guidance: {
                  source: 'lawn_protocol_window',
                  available: true,
                  window: { title: 'August — Summer stress window', goal: 'Fungus prevention and stress recovery' },
                  protocol_gates: [{ title: 'Blackout ordinance', ruleText: 'No fertilizer before Sep 30 in Sarasota County' }],
                  products: [{ name: 'Headway G', ratePer1000: 3, rateUnit: 'lb', role: 'fungicide' }],
                  conditional_products: [
                    { name: 'Dylox 420', trigger: 'visible grub damage', conditional: true },
                    { name: 'Hydretain Liquid', conditional: true, gates: { premiumTier: true, maxTempF: 90 } },
                  ],
                },
              },
              type: 'visit_brief_v1',
            },
          },
        })}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Visit guidance')).toBeInTheDocument();
    expect(screen.getByText('Booked from accepted estimate (Silver tier).')).toBeInTheDocument();
    expect(screen.getByText('Customer asked about brown patches near the driveway.')).toBeInTheDocument();
    expect(screen.getByText(/August — Summer stress window/)).toBeInTheDocument();
    expect(screen.getByText(/Blackout ordinance — No fertilizer before Sep 30/)).toBeInTheDocument();
    expect(screen.getByText('• Headway G · 3 lb/1000 sq ft · fungicide')).toBeInTheDocument();
    expect(screen.getByText('• Dylox 420 — conditional: visible grub damage')).toBeInTheDocument();
    // Structured gates without a trigger still explain the condition.
    expect(screen.getByText('• Hydretain Liquid — conditional: premium plan only; skip above 90°F')).toBeInTheDocument();
    // priorities/watch_items are THIS visit's guidance — they live here,
    // not under a Last visit heading (the section is absent entirely).
    expect(screen.getByText('• Walk the west fence line first')).toBeInTheDocument();
    expect(screen.getByText('• Sprinkler head cracked near bed 2')).toBeInTheDocument();
    expect(screen.queryByText('Last visit')).not.toBeInTheDocument();
  });

  it('renders the per-service action buttons with the old ServiceRow logic preserved', () => {
    const onProject = vi.fn();
    const onZone = vi.fn();
    const sent = { ...BASE_SERVICE, id: 'svc-1', linkedProject: { id: 'p1', status: 'sent' } };
    const traceless = { ...BASE_SERVICE, id: 'svc-2', serviceType: 'Rodent Station Check', traceEligible: false };
    render(
      <VisitBriefPanel
        stop={{ key: 'visit:v1', isVisit: true, services: [sent, traceless], primary: sent, liveCount: 2 }}
        detail={detailFor({})}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={onProject} onZone={onZone} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('🗂️ Sent')).toBeInTheDocument();
    expect(screen.getAllByText('Rodent Station Check').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Trace treatment zone')).toHaveLength(1);
    fireEvent.click(screen.getByText('🗂️ Sent'));
    expect(onProject).toHaveBeenCalledWith(sent);
  });
});
