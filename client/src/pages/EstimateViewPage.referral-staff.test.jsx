// @vitest-environment jsdom
// Staff previews never enroll: the estimate referral card in staffView renders
// the staff state and makes no fetch (GH codex P1 on #3710).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EstimateReferralCard } from './EstimateViewPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const referral = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };

describe('EstimateReferralCard', () => {
  it('customer view: the tap fetches the link from the estimate route', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ code: 'WAVES-1', link: 'https://x', smsBody: 's', emailSubject: 'e', emailBody: 'b' }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateReferralCard referral={referral} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send My Referral Link' }));
    await screen.findByText('WAVES-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/estimates\/tok\/referral-link$/);
  });

  it('staff view: the tap never fetches and shows the staff state', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateReferralCard referral={referral} token="tok" staffView />);
    fireEvent.click(screen.getByRole('button', { name: 'Send My Referral Link' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Staff view/i)).toBeInTheDocument();
  });
});
