// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

vi.mock('../../utils/admin-fetch', () => ({
  adminFetch: vi.fn(),
  adminLoginUrl: vi.fn(() => '/admin/login'),
}));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: true, ready: true }),
}));

import { adminFetch } from '../../utils/admin-fetch';
import AgentEstimatePage, { CustomerAccountPanel, LearningPanel } from './AgentEstimatePage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Agent Estimate recognized customer account', () => {
  it('shows the current tier and paid price for each existing service', () => {
    render(<CustomerAccountPanel account={{
      recognized: true,
      active_plan: true,
      current_tier: 'Silver',
      current_discount_pct: 10,
      current_services: [
        {
          key: 'pest_control',
          label: 'Pest Control',
          currentPerVisit: 99,
          spendSource: 'last_paid_invoice',
          lastPaidAt: '2026-07-15',
          qualifiesForWaveGuard: true,
        },
        {
          key: 'lawn_care',
          label: 'Lawn Care',
          currentPerVisit: 67,
          spendSource: 'last_paid_invoice',
          lastPaidAt: '2026-07-10',
          qualifiesForWaveGuard: true,
        },
      ],
    }} />);

    expect(screen.getByText(/Silver · 10% current discount/)).toBeInTheDocument();
    expect(screen.getByText('Pest Control')).toBeInTheDocument();
    expect(screen.getByText('$99')).toBeInTheDocument();
    expect(screen.getByText('Lawn Care')).toBeInTheDocument();
    expect(screen.getByText('$67')).toBeInTheDocument();
    expect(screen.getAllByText(/last paid invoice/)).toHaveLength(2);
    expect(screen.getByText(/Current services and their paid prices stay unchanged/)).toBeInTheDocument();
  });

  it('labels a scheduled price as fallback instead of actual paid spend', () => {
    render(<CustomerAccountPanel account={{
      recognized: true,
      active_plan: true,
      current_tier: 'Bronze',
      current_discount_pct: 0,
      current_services: [{
        key: 'pest_control',
        label: 'Pest Control',
        currentPerVisit: 117,
        spendSource: 'scheduled_estimate',
        qualifiesForWaveGuard: true,
      }],
    }} />);

    expect(screen.getByText('Bronze')).toBeInTheDocument();
    expect(screen.getByText('$117')).toBeInTheDocument();
    expect(screen.getByText('scheduled price fallback')).toBeInTheDocument();
  });
});

describe('LearningPanel memory review', () => {
  const pendingMemory = {
    id: 'mem-1',
    rule_text: 'For this HOA, verify irrigated turf area separately.',
    status: 'pending',
  };

  it('surfaces an approve failure and leaves the rule pending', async () => {
    adminFetch.mockRejectedValueOnce(new Error('Rate limited — please slow down for a moment.'));
    const onReload = vi.fn();

    render(<LearningPanel leadId="" user={{ role: 'admin' }} memories={[pendingMemory]} onReload={onReload} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Rate limited — please slow down for a moment.');
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
    // The reviewer can retry: both buttons are re-enabled after the failure.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('reloads memories on a successful review without showing an error', async () => {
    adminFetch.mockResolvedValueOnce({});
    const onReload = vi.fn(() => Promise.resolve());

    render(<LearningPanel leadId="" user={{ role: 'admin' }} memories={[pendingMemory]} onReload={onReload} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(adminFetch).toHaveBeenCalledWith('/admin/agent-estimate/memory/mem-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'rejected' }),
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AgentEstimatePage canonical send flow and blocked Add photo', () => {
  afterEach(() => vi.unstubAllGlobals());

  const mountPage = (leadId = 'lead-1') => render(
    <MemoryRouter initialEntries={[`/admin/agent-estimate?leadId=${leadId}`]}>
      <Routes>
        <Route element={<Outlet context={{ user: { id: 'admin-1', role: 'admin' } }} />}>
          <Route path="/admin/agent-estimate" element={<AgentEstimatePage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  it('routes draft sending through EstimateSendDialog review instead of direct POST /send', async () => {
    const draft = {
      id: 'est-1',
      status: 'draft',
      editable_here: true,
      customer_phone: '+19415550100',
      customer_email: 'qa@example.invalid',
      address: '100 Main St',
      monthly_total: 99,
      annual_total: 1188,
      onetime_total: 0,
    };
    adminFetch.mockImplementation(async (path) => {
      if (path.startsWith('/admin/agent-estimate/lead/')) {
        return {
          context: {
            lead: { id: 'lead-1', name: 'QA Lead', status: 'new', phone: '+19415550100', email: 'qa@example.invalid', address: '100 Main St' },
            current_estimate: draft,
          },
        };
      }
      if (path === '/admin/agent-estimate/memory') return { memories: [] };
      if (path.startsWith('/admin/leads')) return { leads: [] };
      return {};
    });
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/send-preview')
        ? {
          id: 'est-1',
          status: 'draft',
          editVersion: 'v1',
          updatedAt: '2026-01-01T12:00:00Z',
          customerName: 'QA Lead',
          customerPhone: '+19415550100',
          customerEmail: 'qa@example.invalid',
          address: '100 Main St',
          previewPath: '/estimate/tok?adminPreview=1',
          messageVersion: 'msg-v1',
          messages: { sms: 'Preview SMS text', email: { subject: 'Estimate', text: 'Preview email text' } },
        }
        : { sent: true, channels: { sms: { ok: true, real: true } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    mountPage();
    const reviewBtn = await screen.findByRole('button', { name: /Review & send/i });
    fireEvent.click(reviewBtn);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/send-preview'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/send') && opts?.method === 'POST')).toBe(false);
    expect(adminFetch.mock.calls.some(([path]) => String(path).endsWith('/send'))).toBe(false);
  });

  it('disables Add photo when the selected lead is closed', async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.startsWith('/admin/agent-estimate/lead/')) {
        return {
          context: {
            lead: { id: 'lead-closed', name: 'Closed Lead', status: 'won', phone: '+19415550100' },
            current_estimate: null,
          },
        };
      }
      if (path === '/admin/agent-estimate/memory') return { memories: [] };
      if (path.startsWith('/admin/leads')) return { leads: [] };
      return {};
    });

    mountPage('lead-closed');
    expect(await screen.findByText(/Agent Estimate drafting works on open leads only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add photo/i })).toBeDisabled();
  });
});
