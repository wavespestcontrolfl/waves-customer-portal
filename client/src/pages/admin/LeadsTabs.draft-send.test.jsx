// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadsSection } from './LeadsTabs';

const { openMessages, openEstimateSend } = vi.hoisted(() => ({
  openMessages: vi.fn(),
  openEstimateSend: vi.fn(),
}));

vi.mock('../../components/admin/customer360/CustomerSmsPanel', () => ({
  useCustomerSms: () => openMessages,
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));

vi.mock('../../components/admin/EstimateSendDialog', () => ({
  useEstimateSend: () => openEstimateSend,
  EstimateSendProvider: ({ children }) => children,
}));

const baseLead = {
  id: 'lead-draft-1',
  first_name: 'Pat',
  last_name: 'Homeowner',
  status: 'new',
  service_interest: 'Quarterly Pest Control',
  source_name: 'Website',
  urgency: 'normal',
  first_contact_at: new Date().toISOString(),
  estimate_id: 'est-draft-1',
  estimate_status: 'draft',
};

beforeEach(() => {
  openEstimateSend.mockReset();
  openEstimateSend.mockResolvedValue({ sent: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LeadsSection 1-tap draft quote actions', () => {
  it('shows Send Quote for a county-verified send-ready draft and calls useEstimateSend on click', async () => {
    const readyLead = {
      ...baseLead,
      estimate_preview: {
        status: 'draft',
        source: 'lead_webhook',
        monthly: 42,
        annual: 504,
        oneTime: 0,
        provisional: false,
        sendReady: true,
        sizeSource: 'county_assessed',
        measurements: { homeSqFt: 1850, lotSqFt: 9200, propertyType: 'Single Family', features: { poolCage: true, poolCageSqft: 500 } },
        quoteRequiredReason: null,
        reviewReasons: ['property_measurements_from_county'],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const body = String(url).includes('/admin/leads?') ? { leads: [readyLead], total: 1 } : { sources: [] };
      return { ok: true, json: async () => body };
    }));

    render(<MemoryRouter initialEntries={['/admin/pipeline']}><LeadsSection /></MemoryRouter>);
    expect(await screen.findByText('Draft ready · $42/mo')).toBeInTheDocument();
    expect(screen.getByText('1,850 sf · 9,200 lot · Cage 500 sf')).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: 'Send Quote' });
    fireEvent.click(btn);
    await waitFor(() => expect(openEstimateSend).toHaveBeenCalledWith('est-draft-1'));
  });

  it('shows Review and the hold reason for a parked large-cage draft (never Send Quote)', async () => {
    const heldLead = {
      ...baseLead,
      estimate_preview: {
        status: 'draft',
        source: 'lead_webhook',
        monthly: 48,
        annual: 576,
        oneTime: 0,
        provisional: true,
        sendReady: false,
        sizeSource: 'county_assessed',
        measurements: { homeSqFt: 2400, lotSqFt: 10000, features: { poolCage: true, poolCageSqft: 1200 } },
        quoteRequiredReason: 'large_pool_cage',
        reviewReasons: ['property_measurements_from_county'],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const body = String(url).includes('/admin/leads?') ? { leads: [heldLead], total: 1 } : { sources: [] };
      return { ok: true, json: async () => body };
    }));

    function LocationSpy() {
      const loc = useLocation();
      return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
    }
    render(<MemoryRouter initialEntries={['/admin/pipeline']}><LeadsSection /><LocationSpy /></MemoryRouter>);
    expect(await screen.findByText('Draft review · $48/mo')).toBeInTheDocument();
    expect(screen.getByText(/Large pool cage/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send Quote' })).not.toBeInTheDocument();
    const reviewBtn = screen.getByRole('button', { name: 'Review' });
    fireEvent.click(reviewBtn);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/admin/pipeline?tab=new&editEstimateId=est-draft-1'));
  });
});
