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

const LINKED_ESTIMATE = {
  linked: true,
  estimateSlug: 'EST-2026-0254',
  quotedTotal: 450,
  lines: [
    { name: 'Quarterly Pest Control', cadence: 'quarterly', perApplicationPrice: 115 },
    { name: 'Mosquito — WaveGuard Silver', monthlyPrice: 89 },
  ],
  deposit: { required: false, paid: 100, creditRemaining: 40, payerBilled: false },
  payment: { billingTerm: 'per_service', annualPrepay: false },
};

describe('VisitBriefPanel', () => {
  it('renders the three distinct money labels from the linked estimate + prediction', () => {
    render(
      <VisitBriefPanel
        stop={stopOf({ ...BASE_SERVICE, prepaidAmount: 50, prepaidMethod: 'card' })}
        detail={{ status: 'ready', estimate: LINKED_ESTIMATE, brief: { brief: null } }}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Quoted:')).toBeInTheDocument();
    expect(screen.getByText('$450')).toBeInTheDocument();
    expect(screen.getByText('Paid · prepaid:')).toBeInTheDocument();
    expect(screen.getByText('Prepaid $50 (card)')).toBeInTheDocument();
    expect(screen.getByText('Amount due today:')).toBeInTheDocument();
    expect(screen.getByText('Collect $95 today')).toBeInTheDocument();
    // Quoted lines with their accepted unit prices.
    expect(screen.getByText(/\$115 \/application/)).toBeInTheDocument();
    expect(screen.getByText(/\$89 \/mo/)).toBeInTheDocument();
    expect(screen.getByText(/Deposit paid \$100 · \$40 credit remaining/)).toBeInTheDocument();
  });

  it('unlinked estimate shows NO Quoted row — never a catalog price', () => {
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={{ status: 'ready', estimate: { linked: false }, brief: { brief: null } }}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Quoted/)).not.toBeInTheDocument();
    // Amount due today still rides the day payload.
    expect(screen.getByText('Collect $95 today')).toBeInTheDocument();
  });

  it('tap-to-call and tap-to-text anchors carry sanitized hrefs; hidden without a phone', () => {
    const { unmount } = render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)} detail={{ status: 'ready', estimate: null, brief: null }}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    expect(screen.getByText('Call').closest('a')).toHaveAttribute('href', 'tel:9415550100');
    expect(screen.getByText('Text').closest('a')).toHaveAttribute('href', 'sms:9415550100');
    unmount();
    render(
      <VisitBriefPanel
        stop={stopOf({ ...BASE_SERVICE, customerPhone: null })}
        detail={{ status: 'ready', estimate: null, brief: null }}
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
        detail={{ status: 'ready', estimate: null, brief: { brief: null, facts } }}
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
        detail={{ status: 'ready', estimate: null, brief: { brief: null } }}
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

  it('shows the retry row only when both detail fetches failed', () => {
    const onRetry = vi.fn();
    render(
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)} detail={{ status: 'error', estimate: null, brief: null }}
        onRetry={onRetry} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />,
    );
    const btn = screen.getByText(/retry/i);
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders the per-service action buttons with the old ServiceRow logic preserved', () => {
    const onProject = vi.fn();
    const onZone = vi.fn();
    const sent = { ...BASE_SERVICE, id: 'svc-1', linkedProject: { id: 'p1', status: 'sent' } };
    const traceless = { ...BASE_SERVICE, id: 'svc-2', serviceType: 'Rodent Station Check', traceEligible: false };
    render(
      <VisitBriefPanel
        stop={{ key: 'visit:v1', isVisit: true, services: [sent, traceless], primary: sent, liveCount: 2 }}
        detail={{ status: 'ready', estimate: null, brief: null }}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={onProject} onZone={onZone} onLead={vi.fn()}
      />,
    );
    // Terminal label for the sent report; member service types shown on a grouped stop.
    expect(screen.getByText('🗂️ Sent')).toBeInTheDocument();
    expect(screen.getByText('Rodent Station Check')).toBeInTheDocument();
    // traceEligible === false hides Zone for that member only.
    expect(screen.getAllByLabelText('Trace treatment zone')).toHaveLength(1);
    fireEvent.click(screen.getByText('🗂️ Sent'));
    expect(onProject).toHaveBeenCalledWith(sent);
  });
});
