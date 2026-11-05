// @vitest-environment jsdom
// A customer's text relayed to the technician carries a Reply that opens that
// customer's thread in Communications (owner 2026-11-04, C17).
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechNoticeFeed from './TechNoticeFeed';

const RELAYED = {
  id: 'n-relay', type: 'tech_line_sms', message: 'server message', created_at: '2026-11-04T18:41:00Z',
  payload: { headline: 'Text from your customer', customer_id: 'cust-123', customer_name: 'Pat Example', from: '+19415550123', body: 'Can you come after 3?', media_count: 0 },
};
const UNKNOWN = {
  id: 'n-unknown', type: 'tech_line_sms', message: 'server message', created_at: '2026-11-04T18:42:00Z',
  payload: { headline: 'Text on your line', customer_id: null, customer_name: '(941) 555-0188', from: '+19415550188', body: 'Hello', media_count: 0 },
};

function stubFeed(notifications) {
  vi.stubGlobal('fetch', vi.fn(async (_url, init = {}) => ({ ok: true, json: async () => (init.method ? {} : { notifications }) })));
}

describe('TechNoticeFeed text card Reply', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('links Reply to the number that texted, so a customer with two numbers gets the right conversation', async () => {
    stubFeed([RELAYED]);
    render(<MemoryRouter><TechNoticeFeed /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    const card = await screen.findByTestId('tech-line-text');
    expect(card).toHaveTextContent('Can you come after 3?');
    expect(screen.getByRole('link', { name: 'Reply' })).toHaveAttribute('href', '/admin/communications?phone=%2B19415550123');
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('falls back to the customer\'s thread when the notice has no number', async () => {
    stubFeed([{ ...RELAYED, payload: { ...RELAYED.payload, from: null } }]);
    render(<MemoryRouter><TechNoticeFeed /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    await screen.findByTestId('tech-line-text');
    expect(screen.getByRole('link', { name: 'Reply' })).toHaveAttribute('href', '/admin/communications?thread=cust-123');
  });

  it('offers no Reply when the text has no customer on it', async () => {
    stubFeed([UNKNOWN]);
    render(<MemoryRouter><TechNoticeFeed /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    await screen.findByTestId('tech-line-text');
    expect(screen.queryByRole('link', { name: 'Reply' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });
});
