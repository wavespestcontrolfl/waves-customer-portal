// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/admin-fetch', () => ({
  adminFetch: vi.fn(),
}));

import { adminFetch } from '../../utils/admin-fetch';
import { CustomerAccountPanel, LearningPanel, answerSendGate } from './AgentEstimatePage';

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

describe('send gates answered once (answerSendGate)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const gateError = (code, message) => Object.assign(new Error(message), { code });

  it('asks the review acknowledgment, then the typed satellite palm count, and rethrows anything else', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const prompt = vi.fn(() => ' 12 ');
    vi.stubGlobal('prompt', prompt);
    const palms = gateError('PALM_COUNT_REQUIRED', 'This quote priced 14 palms from the satellite image.');
    let answers = answerSendGate(gateError('ENGINE_REVIEW_REQUIRED', 'flagged'), {});
    expect(answers).toEqual({ acknowledgeEngineReview: true });
    answers = answerSendGate(palms, answers);
    expect(answers).toEqual({ acknowledgeEngineReview: true, confirmedPalmCount: 12 });
    expect(prompt.mock.calls[0][0]).toMatch(/a clump or a multi-trunk palm is one palm/);
    // Each gate is asked once; a repeat or a mismatch goes back to the caller.
    expect(() => answerSendGate(palms, answers)).toThrow(palms);
    const mismatch = gateError('PALM_COUNT_MISMATCH', 'You counted 12 palms, but this quote priced 14.');
    expect(() => answerSendGate(mismatch, answers)).toThrow(mismatch);
  });

  it('a cancelled review or a blank or non-number palm answer cancels the send', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    expect(() => answerSendGate(gateError('ENGINE_REVIEW_REQUIRED', 'flagged'), {})).toThrow(/review the flagged reasons/);
    const palms = gateError('PALM_COUNT_REQUIRED', 'priced 14 palms');
    for (const reply of ['twelve', '', null]) {
      vi.stubGlobal('prompt', vi.fn(() => reply));
      expect(() => answerSendGate(palms, {})).toThrow(/type the palm count/);
    }
  });
});
