// @vitest-environment jsdom
// The pre-visit brief prints each product's stored rate. Nothing a tech sees
// is in mL (owner ruling 2026-09-29): a rate the brief stored in mL reads in
// fl oz, keeping its basis; every other unit prints exactly as stored.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SERVICE = {
  id: 'svc-1',
  status: 'confirmed',
  customerName: 'Pat Sample',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Lawn Care Service',
};
const STOP = { key: 'row:svc-1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };

function renderGuidance(products, conditionalProducts = []) {
  render(
    <VisitBriefPanel
      stop={STOP}
      detail={{
        status: 'ready',
        byService: {
          'svc-1': {
            brief: {
              brief: {
                product_guidance: {
                  source: 'lawn_protocol_window',
                  available: true,
                  window: { title: 'September — Recovery window' },
                  products,
                  conditional_products: conditionalProducts,
                },
              },
              type: 'visit_brief_v1',
            },
          },
        },
      }}
      onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />,
  );
}

it('a rate stored in mL reads in fl oz, per 1,000 sq ft or on its own basis', () => {
  renderGuidance(
    [{ name: 'Example Liquid Kelp', ratePer1000: 30, rateUnit: 'ml', role: 'biostimulant' }],
    // A service-history shaped row carries `rate`, not `ratePer1000`.
    [{ name: 'SUPERthrive Foliage-Pro 9-3-6', rate: 5, rateUnit: 'mL/gal', trigger: 'heat_stress' }],
  );
  expect(screen.getByText('• Example Liquid Kelp · 1.014 fl oz/1000 sq ft · biostimulant')).toBeInTheDocument();
  expect(screen.getByText('• SUPERthrive Foliage-Pro 9-3-6 · 0.169 fl oz/gal — conditional: heat stress')).toBeInTheDocument();
  expect(screen.getByTestId('visit-brief-panel').textContent).not.toMatch(/\bml\b/i);
});

it('every other unit prints exactly as stored', () => {
  renderGuidance(
    [{ name: 'Headway G', ratePer1000: 3, rateUnit: 'lb', role: 'fungicide' }],
    [{ name: 'Example Potash', rate: 0.5, rateUnit: 'fl_oz/gal', trigger: 'low_k' }],
  );
  expect(screen.getByText('• Headway G · 3 lb/1000 sq ft · fungicide')).toBeInTheDocument();
  expect(screen.getByText('• Example Potash · 0.5 fl_oz/gal — conditional: low k')).toBeInTheDocument();
});
