// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReferralsPageV2 from './ReferralsPageV2';

vi.mock('../../components/admin/AdminCommandHeader', () => ({
  default: ({ sections = [], onSectionChange, secondarySections = [], onSecondaryChange }) => (
    <div>
      {sections.map((s) => (
        <button key={s.key} onClick={() => onSectionChange(s.key)}>{s.label}</button>
      ))}
      {secondarySections.map((s) => (
        <button key={s.key} onClick={() => onSecondaryChange(s.key)}>{s.label}</button>
      ))}
    </div>
  ),
}));
vi.mock('../../lib/adminAuth', () => ({ getAdminUser: () => ({ role: 'admin' }) }));

const json = (status, body) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

const CUSTOMER = { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', phone: '555-0100' };
const QUEUE = [{ id: 'r1', status: 'pending', referee_name: 'Pat Friend', referee_phone: '555-0199' }];
const PAYOUTS = [{ id: 'p1', status: 'pending', first_name: 'Sam', last_name: 'Promo', amount_cents: 2500, payout_method: 'credit' }];
const SETTINGS = { program_active: true, reward_amount: 25, base_url: 'x', invite_sms_template: 'hi' };

let routes;
function installFetch() {
  global.fetch = vi.fn((url, opts = {}) => {
    const path = String(url).replace(/^.*\/api/, '');
    const method = (opts.method || 'GET').toUpperCase();
    const hit = routes[`${method} ${path.split('?')[0]}`];
    if (!hit) return json(404, { error: `no mock for ${method} ${path}` });
    return hit(opts);
  });
}

beforeEach(() => {
  routes = {
    'GET /admin/referrals/stats': () => json(200, { activePromoters: 1, totalReferrals: 1, convertedReferrals: 0, pendingReferrals: 1 }),
    'GET /admin/referrals/promoters': () => json(200, { promoters: [] }),
    'GET /admin/referrals/queue': () => json(200, { referrals: QUEUE }),
    'GET /admin/referrals/payouts': () => json(200, { payouts: PAYOUTS }),
    'GET /admin/referrals/inbound': () => json(200, { enabled: false, items: [] }),
    'GET /admin/referrals/settings': () => json(200, { settings: SETTINGS }),
    'GET /admin/customers': () => json(200, { customers: [CUSTOMER] }),
  };
  installFetch();
});
afterEach(cleanup);

async function renderPage() {
  render(<MemoryRouter><ReferralsPageV2 /></MemoryRouter>);
  await screen.findByText('Dashboard');
}

describe('Referrals dialogs and payout feedback', () => {
  it('Convert: dialog semantics, keyboard-selectable result, 409 stays inside the open dialog', async () => {
    routes['POST /admin/referrals/r1/convert'] = () => json(409, { error: 'Customer already converted' });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Queue/ }));
    const opener = await screen.findByRole('button', { name: 'Convert' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Convert Referral');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole('combobox', { name: 'WaveGuard Tier' })).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Customer Search'), { target: { value: 'ada' } });
    const result = await within(dialog).findByRole('button', { name: /Ada Lovelace/ });
    expect(result.tagName).toBe('BUTTON');
    fireEvent.click(result);
    expect(within(dialog).getByLabelText('Customer Search')).toHaveValue('Ada Lovelace');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Customer already converted');
    // Dialog and its draft stay open; the primary action is usable again.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Customer Search')).toHaveValue('Ada Lovelace');
    expect(within(dialog).getByRole('button', { name: 'Convert' })).toBeEnabled();

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Convert' }));
  });

  it('Convert: primary action is disabled while the request is in flight', async () => {
    let release;
    routes['POST /admin/referrals/r1/convert'] = () =>
      new Promise((resolve) => { release = () => resolve(json(409, { error: 'nope' })); });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Queue/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert' }));
    const busy = await within(dialog).findByRole('button', { name: 'Converting...' });
    expect(busy).toBeDisabled();
    release();
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByRole('button', { name: 'Convert' })).toBeEnabled();
    expect(global.fetch.mock.calls.filter(([u]) => String(u).includes('/convert'))).toHaveLength(1);
  });

  it('Enroll: dialog semantics, keyboard result, 409 shown inside the dialog', async () => {
    routes['POST /admin/referrals/enroll'] = () => json(409, { error: 'Already a promoter' });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Promoters/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enroll Customer' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Enroll Customer as Promoter');
    fireEvent.change(within(dialog).getByLabelText('Search customers to enroll'), { target: { value: 'ada' } });
    const result = await within(dialog).findByRole('button', { name: /Ada Lovelace/ });
    expect(result.tagName).toBe('BUTTON');
    fireEvent.click(result);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Already a promoter');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Payout approval: shows the server message and blocks a second click while pending', async () => {
    let release;
    routes['POST /admin/referrals/payouts/p1/approve'] = () =>
      new Promise((resolve) => {
        release = () => resolve(json(400, { error: 'Insufficient promoter balance for this payout' }));
      });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Promoters/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Payouts' }));
    const approve = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(await screen.findByRole('button', { name: 'Approving...' })).toBeDisabled();
    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient promoter balance for this payout');
    expect(global.fetch.mock.calls.filter(([u]) => String(u).includes('/approve'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('Settings: captions are associated with their controls; toggles name setting and state', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(await screen.findByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Invite SMS')).toBeInTheDocument();
    expect(screen.getAllByRole('button').some((b) => /: (Enabled|Disabled)$/.test(b.getAttribute('aria-label') || ''))).toBe(true);
  });
});
