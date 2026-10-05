// @vitest-environment jsdom
/**
 * Customer 360 -> Property -> Access codes block.
 * Staff-only: asks GET /admin/access-codes?customerId= and renders nothing at
 * all when the section is off (404) or the viewer is not a full admin (403).
 * Active codes retire with an inline confirm; codes found in texts are saved
 * (optionally edited, with a visit for a one-visit code) or dismissed; the
 * office can add a code. Every name and code here is synthetic.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerAccessCodesBlock } from './Customer360ProfileV2';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null }));
vi.mock('./AuthenticatedCallAudio', () => ({ default: () => null }));
vi.mock('./CustomerRequestsPanel', () => ({ default: () => null }));
vi.mock('./CallBridgeLink', () => ({
  default: ({ children }) => <span>{children}</span>,
  callViaBridge: vi.fn(),
}));
vi.mock('../../pages/admin/SchedulePage', () => ({
  ZoneMarkingStep: () => null,
  StationMarkingStep: () => null,
}));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const LIST_URL = '/admin/access-codes?customerId=customer-a';

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const row = (over = {}) => ({
  id: 'c1', customerId: 'customer-a', propertyId: null, kind: 'lockbox', code: '1234', instructions: 'On the back fence',
  life: 'standing', scheduledServiceId: null, scheduledDate: null, status: 'active', sourceType: 'sms', sourceId: 'm1',
  sourceQuote: null, sourceAt: '2026-10-03T15:00:00.000Z', ...over,
});
const found = (over = {}) => row({
  id: 'f1', kind: 'door', code: '9876', instructions: null, status: 'found',
  sourceQuote: 'The door code is 9876 for tomorrow', sourceAt: '2026-10-03T15:00:00.000Z', ...over,
});

// Visits are day strings in the window that starts the day the text was sent.
const VISITS = [
  { id: 'v1', scheduled_date: '2026-10-08', service_type: 'Pest control', status: 'confirmed' },
  { id: 'v2', scheduled_date: '2026-12-25', service_type: 'Lawn care', status: 'scheduled' },
  { id: 'v3', scheduled_date: '2026-10-05', service_type: 'Mosquito', status: 'cancelled' },
];

let calls;
function stubFetch(handler) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    return handler(path, init);
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CustomerAccessCodesBlock', () => {
  it('lists active codes with kind, monospace code, directions, life and source, and found codes with the client sentence', async () => {
    stubFetch(() => response({
      active: [
        row(),
        row({ id: 'c2', kind: 'garage', code: '5555', instructions: null, life: 'visit', scheduledDate: '2026-10-08', sourceType: 'staff', sourceAt: null }),
      ],
      found: [found()],
    }));
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={VISITS} />);
    const code = await screen.findByText('1234');
    expect(code).toHaveClass('font-mono');
    const first = within(code.closest('.rounded-sm'));
    expect(first.getByText('On the back fence')).toBeInTheDocument();
    expect(first.getByText('Lockbox')).toBeInTheDocument();
    expect(first.getByText('Always')).toBeInTheDocument();
    expect(first.getByText('Text, Oct 3')).toBeInTheDocument();
    const second = within(screen.getByText('5555').closest('.rounded-sm'));
    expect(second.getByText('This visit: Oct 8')).toBeInTheDocument();
    expect(second.getByText('Added by office')).toBeInTheDocument();
    expect(screen.getByText('The door code is 9876 for tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Found in messages')).toBeInTheDocument();
    expect(calls[0].path).toBe(LIST_URL);
  });

  it.each([404, 403])('renders nothing at all on %i', async (status) => {
    stubFetch(() => response({ enabled: false }, status));
    const { container } = render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={[]} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('retire asks inline first (no browser dialog), then posts and reloads', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    let listed = 0;
    stubFetch((path, init) => {
      if (init.method === 'POST') return response({ accessCode: row({ status: 'retired' }) });
      listed += 1;
      return response({ active: listed === 1 ? [row()] : [], found: [] });
    });
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, retire' }));
    await waitFor(() => expect(screen.getByText('No access codes on file.')).toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST').path).toBe('/admin/access-codes/c1/retire');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Keep backs out of a retire without a request', async () => {
    stubFetch(() => response({ active: [row()], found: [] }));
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it('saves a found code with the office edits and shows the server message when a visit is needed', async () => {
    let attempt = 0;
    stubFetch((path, init) => {
      if (init.method === 'POST') {
        attempt += 1;
        if (attempt === 1) return response({ error: 'Choose the visit this code is for', code: 'visit_required' }, 400);
        return response({ accessCode: row({ id: 'f1', kind: 'garage', status: 'active' }) });
      }
      return response({ active: [], found: attempt >= 2 ? [] : [found()] });
    });
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={VISITS} />);
    await screen.findByText('The door code is 9876 for tomorrow');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'garage' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '4455' } });
    fireEvent.click(screen.getByRole('button', { name: 'This visit only' }));
    // Only an open visit inside 14 days of the text is offered.
    const picker = screen.getByLabelText('Visit');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a visit', 'Thu, Oct 8 · Pest control']);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the visit this code is for')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ kind: 'garage', life: 'visit', code: '4455', instructions: null });

    fireEvent.change(picker, { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('The door code is 9876 for tomorrow')).not.toBeInTheDocument());
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts[1].path).toBe('/admin/access-codes/f1/accept');
    expect(posts[1].body).toEqual({ kind: 'garage', life: 'visit', code: '4455', instructions: null, scheduledServiceId: 'v1' });
  });

  it.each([
    ['invalid_visit', 'scheduledServiceId must be a visit of this customer that has not ended'],
    ['expired', 'This one-visit code is more than 14 days old'],
    ['duplicate_active', 'That customer already has this code'],
  ])('shows the server message for %s', async (code, message) => {
    stubFetch((path, init) => (init.method === 'POST'
      ? response({ error: message, code }, 409)
      : response({ active: [], found: [found()] })));
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('Dismiss posts and the card goes away on reload', async () => {
    let dismissed = false;
    stubFetch((path, init) => {
      if (init.method === 'POST') { dismissed = true; return response({ accessCode: found({ status: 'dismissed' }) }); }
      return response({ active: [], found: dismissed ? [] : [found()] });
    });
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Found in messages')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST').path).toBe('/admin/access-codes/f1/dismiss');
  });

  it('Add a code posts the customer id and the typed fields', async () => {
    let added = false;
    stubFetch((path, init) => {
      if (init.method === 'POST') { added = true; return response({ accessCode: row({ id: 'n1', kind: 'call_box', code: '77' }) }); }
      return response({ active: added ? [row({ id: 'n1', kind: 'call_box', code: '77' })] : [], found: [] });
    });
    render(<CustomerAccessCodesBlock customerId="customer-a" upcomingScheduled={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a code' }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'call_box' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '77' } });
    fireEvent.change(screen.getByLabelText('Directions'), { target: { value: 'Press the star key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    await waitFor(() => expect(screen.getByText('Call box')).toBeInTheDocument());
    const post = calls.find((c) => c.method === 'POST');
    expect(post.path).toBe('/admin/access-codes');
    expect(post.body).toEqual({ customerId: 'customer-a', kind: 'call_box', life: 'standing', code: '77', instructions: 'Press the star key' });
  });
});

describe('visit picker dates', () => {
  it('reads a UTC-midnight date as that calendar day', async () => {
    const { visitChoices } = await import('./AccessCodePanels');
    const out = visitChoices([{ id: 'v1', scheduled_date: '2040-03-12T00:00:00.000Z', status: 'confirmed' }], '2040-03-12T14:00:00Z', '2040-03-12');
    expect(out.map((v) => v.id)).toEqual(['v1']);
    expect(out[0].label).toMatch(/Mar 12/);
  });
});
