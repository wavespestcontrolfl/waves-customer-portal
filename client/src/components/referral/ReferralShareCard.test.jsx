// @vitest-environment jsdom
// The shared referral share module: headline + tap; the code and share copy
// arrive from the caller's fetch ON THE TAP (enrollment is a durable write),
// staff views never fetch, the beacon fires on every tap.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReferralShareCard from './ReferralShareCard';

afterEach(() => cleanup());

const referral = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };
const share = { code: 'WAVES-TEST01', link: 'https://wavespestcontrol.com/r/WAVES-TEST01', smsBody: 'sms text', emailSubject: 'subj', emailBody: 'email text' };

describe('ReferralShareCard', () => {
  it('renders nothing without a headline', () => {
    const { container } = render(<ReferralShareCard referral={null} fetchLink={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches on the tap and reveals code + prefilled Text/Email', async () => {
    const fetchLink = vi.fn().mockResolvedValue(share);
    const onTap = vi.fn();
    render(<ReferralShareCard referral={referral} fetchLink={fetchLink} onTap={onTap} />);
    expect(fetchLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send My Referral Link' }));
    expect(onTap).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('WAVES-TEST01')).toBeInTheDocument());
    expect(fetchLink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Text it' })).toHaveAttribute('href', 'sms:?&body=sms%20text');
    expect(screen.getByRole('link', { name: 'Email it' })).toHaveAttribute('href', 'mailto:?subject=subj&body=email%20text');
  });

  it('a failed fetch shows the retry line, never a fake module', async () => {
    render(<ReferralShareCard referral={referral} fetchLink={vi.fn().mockRejectedValue(new Error('503'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send My Referral Link' }));
    await waitFor(() => expect(screen.getByText(/didn't go through/)).toBeInTheDocument());
    expect(screen.queryByText('WAVES-TEST01')).not.toBeInTheDocument();
  });

  it('staff view fires the beacon but never fetches', () => {
    const fetchLink = vi.fn();
    const onTap = vi.fn();
    render(<ReferralShareCard referral={referral} fetchLink={fetchLink} onTap={onTap} staffView />);
    fireEvent.click(screen.getByRole('button', { name: 'Send My Referral Link' }));
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(fetchLink).not.toHaveBeenCalled();
    expect(screen.getByText(/Staff view/)).toBeInTheDocument();
  });
});
