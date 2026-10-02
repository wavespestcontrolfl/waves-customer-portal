// @vitest-environment jsdom
// Waves Assistant buttons: the chat renders only the buttons the server built
// (a self-serve reschedule page or a known portal tab), and says the team was
// notified only when the server says the bell rang.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false }));
vi.mock('../native/platform', async (importOriginal) => ({ ...await importOriginal(), isNativeApp: () => native.enabled }));
vi.mock('../native/nativeFile', () => ({ canSaveNative: () => false, canShareNative: () => true, saveBlobNative: vi.fn(), saveUrlNative: vi.fn(), shareUrlNative: vi.fn(async () => true) }));

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { ChatWidget } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat' };
const NOTIFIED_LINE = 'A team member has been notified and will follow up shortly.';
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
  native.enabled = false;
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => cleanup());

async function ask(reply, onNavigate = vi.fn()) {
  api.request.mockResolvedValue(reply);
  render(<ChatWidget customer={customer} initialQuestion="Reschedule my visit" onClose={() => {}} onNavigate={onNavigate} />);
  await settle();
  return onNavigate;
}

describe('assistant reply buttons', () => {
  it('renders a reschedule link and a portal tab button, and drops anything else', async () => {
    const onNavigate = await ask({
      reply: 'Tap the button to pick a new time.',
      actions: [
        { type: 'link', label: 'Reschedule Pest Control, Oct 9', href: '/reschedule/tok_one' },
        { type: 'link', label: 'Elsewhere', href: 'https://example.com/reschedule/tok' },
        { type: 'link', label: 'Admin', href: '/admin/customers' },
        { type: 'tab', label: 'Open Billing', tab: 'billing' },
        { type: 'tab', label: 'Open Admin', tab: 'admin' },
      ],
    });

    expect(screen.getByRole('link', { name: 'Reschedule Pest Control, Oct 9' })).toHaveAttribute('href', '/reschedule/tok_one');
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(screen.queryByText('Open Admin')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Billing' }));
    expect(onNavigate).toHaveBeenCalledWith('billing');
  });

  it('a reply with no actions renders no buttons', async () => {
    await ask({ reply: 'Ghost ants follow moisture.' });
    expect(screen.getByText('Ghost ants follow moisture.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('payment card', () => {
  it('renders the server-rendered rows and only Waves receipt links', async () => {
    await ask({
      reply: 'The card below has your recent payments.',
      cards: [{ type: 'payments', title: 'Your last 2 payments', rows: [
        { id: 'p1', description: 'Invoice WV-1042', dateLabel: 'Sep 28, 2026', amountLabel: '$129.00', statusLabel: 'Paid', methodLabel: 'Visa ending in 4242', receiptUrl: '/receipt/tok_abc' },
        { id: 'p2', description: 'Silver WaveGuard Monthly', dateLabel: 'Aug 28, 2026', amountLabel: '$1,250.50', statusLabel: 'Failed', methodLabel: '', receiptUrl: 'https://evil.example/receipt/x' },
      ] }, { type: 'unknown', rows: [{ id: 'z' }] }],
    });
    expect(screen.getByText('Your last 2 payments')).toBeInTheDocument();
    expect(screen.getByText('$129.00')).toBeInTheDocument();
    expect(screen.getByText('Sep 28, 2026 · Visa ending in 4242 · Paid')).toBeInTheDocument();
    expect(screen.getByText('Aug 28, 2026 · Failed')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'View receipt' });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toMatch(/\/receipt\/tok_abc$/);
  });
});

describe('visits card', () => {
  it('renders each visit with its summary and only Waves report links', async () => {
    await ask({
      reply: 'Your last visit was Sep 28.',
      cards: [{ type: 'visits', title: 'Your last 2 visits', rows: [
        { id: 's1', service: 'Quarterly Pest Control', dateLabel: 'Sep 28, 2026', technician: 'Jordan', summary: 'Treated the lanai.', reportUrl: '/report/tok_r' },
        { id: 's2', service: 'Lawn Care', dateLabel: 'Aug 20, 2026', technician: null, summary: null, reportUrl: 'https://evil.example/report/x' },
      ] }],
    });
    expect(screen.getByText('Your last 2 visits')).toBeInTheDocument();
    expect(screen.getByText('Sep 28, 2026 · Jordan')).toBeInTheDocument();
    expect(screen.getByText('Treated the lanai.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'View report' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/report/tok_r');
  });
});

describe('payment card in the native app', () => {
  it('hands the receipt to the share sheet instead of a blank-target link', async () => {
    native.enabled = true;
    const { shareUrlNative } = await import('../native/nativeFile');
    await ask({ reply: 'Here.', cards: [{ type: 'payments', title: 'Your most recent payment', rows: [
      { id: 'p1', description: 'Invoice WV-1', dateLabel: 'Sep 28, 2026', amountLabel: '$129.00', statusLabel: 'Paid', methodLabel: '', receiptUrl: '/receipt/tok_abc' },
    ] }] });
    expect(screen.queryByRole('link', { name: 'View receipt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));
    await settle();
    expect(shareUrlNative).toHaveBeenCalledWith(expect.stringMatching(/\/receipt\/tok_abc$/), 'Waves receipt');
  });
});

describe('hand-off notice', () => {
  it('is shown when the server rang the bell', async () => {
    await ask({ reply: "I've sent this to our team.", escalated: true, teamNotified: true });
    expect(screen.getByText(NOTIFIED_LINE)).toBeInTheDocument();
  });

  it('is not shown when nobody was paged', async () => {
    await ask({ reply: "I've saved your request for our team.", escalated: true, teamNotified: false });
    expect(screen.queryByText(NOTIFIED_LINE)).toBeNull();
  });

  it('keeps the earlier behavior for a server that sends no teamNotified field', async () => {
    await ask({ reply: "I'm connecting you with our team right now.", escalated: true });
    expect(screen.getByText(NOTIFIED_LINE)).toBeInTheDocument();
  });
});
