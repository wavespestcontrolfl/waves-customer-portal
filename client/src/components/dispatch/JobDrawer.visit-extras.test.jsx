// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JobDrawer from './JobDrawer';

vi.mock('./VisualNotesReviewSection', () => ({ default: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));

const JOB = {
  id: 'svc-1',
  customer_id: 'c1',
  customer_first_name: 'Pat',
  customer_last_name: 'Sample',
  customer_phone: '9415550100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  status: 'pending',
  service_type: 'Quarterly Pest Control',
  window_start: '09:00:00',
  window_end: '10:00:00',
  notes: null,
  internal_notes: null,
  tech_id: null,
  tech_full_name: null,
};

function mockFetch({ estimate, brief }) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/admin/dispatch/jobs/')) return { ok: true, json: async () => JOB };
    if (u.includes('/admin/dispatch/technicians')) return { ok: true, json: async () => ({ technicians: [] }) };
    if (u.includes('/estimate-source')) return { ok: true, json: async () => estimate };
    if (u.includes('/visit-brief')) return { ok: true, json: async () => brief };
    return { ok: true, json: async () => ({}) };
  });
}

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('JobDrawer visit extras', () => {
  it('renders quoted lines, deposit state, access codes, and last-visit products', async () => {
    mockFetch({
      estimate: {
        linked: true,
        estimateSlug: 'EST-2026-0254',
        quotedTotal: 450,
        lines: [{ name: 'Quarterly Pest Control', perApplicationPrice: 115 }],
        deposit: { required: false, paid: 100, creditRemaining: 40, payerBilled: false },
        payment: null,
      },
      brief: {
        brief: null,
        facts: {
          access: {
            codes: { neighborhoodGate: null, propertyGate: '4482', garage: null, lockbox: null },
            pets: 'Two dogs in the back yard',
            alerts: [],
          },
          last_visit: { date: '2026-07-14', type: 'Quarterly Pest Control', products: [{ name: 'Talstar P' }, { name: 'Taurus SC' }] },
        },
      },
    });
    render(<JobDrawer jobId="svc-1" onClose={() => {}} />);
    expect(await screen.findByText('Quoted · EST-2026-0254')).toBeInTheDocument();
    expect(screen.getByText(/\$115 \/application/)).toBeInTheDocument();
    expect(screen.getByText('Total $450')).toBeInTheDocument();
    expect(screen.getByText(/Deposit paid \$100 · \$40 credit remaining/)).toBeInTheDocument();
    expect(screen.getByText('Property gate:')).toBeInTheDocument();
    expect(screen.getByText('4482')).toBeInTheDocument();
    expect(screen.getByText('Two dogs in the back yard')).toBeInTheDocument();
    expect(screen.getByText(/2026-07-14 · Quarterly Pest Control/)).toBeInTheDocument();
    expect(screen.getByText('Products: Talstar P, Taurus SC')).toBeInTheDocument();
  });

  it('hides every section when the estimate is unlinked and the brief is empty', async () => {
    mockFetch({ estimate: { linked: false }, brief: { brief: null } });
    render(<JobDrawer jobId="svc-1" onClose={() => {}} />);
    // Wait for hydration, then assert absence.
    expect(await screen.findByText('Quarterly Pest Control')).toBeInTheDocument();
    expect(screen.queryByText(/Quoted/)).not.toBeInTheDocument();
    expect(screen.queryByText('Access')).not.toBeInTheDocument();
    expect(screen.queryByText('Last Visit')).not.toBeInTheDocument();
  });
});
