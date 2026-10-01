// @vitest-environment jsdom
/**
 * "Customer's words" on a pest/lawn re-service (GATE_RESERVICE_OFFICE_REQUEST).
 * The section renders only for a re-service line AND a live gate (the
 * suggestion route's {enabled}); "Use this" fills the box; the POST carries
 * `customerRequest: { text, suggestionId, suggestionKind }` — never a source
 * (the server decides that) — and nothing when the box is empty.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDiscountStackingState } from '../../hooks/useDiscountStacking';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, {
  customerRequestBodyField,
  isOfficeRequestLine,
  suggestionSourceLabel,
} from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };
const SUGGESTION = { id: '00000000-0000-4000-8000-000000000001', kind: 'text', text: 'Ants are back in the kitchen', at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function installFetch({ serviceKey = 'pest_re_service', serviceName = 'Pest Re-Service', probe = { enabled: true, suggestion: SUGGESTION }, probeFails = false } = {}) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      return Promise.resolve(json({ services: [{ id: 'svc-1', service_key: serviceKey, name: serviceName, billing_type: 'one_time', base_price: 0, default_duration_minutes: 30 }] }));
    }
    if (url.includes('/reservice-request-suggestion')) {
      return probeFails ? Promise.reject(new Error('boom')) : Promise.resolve(json(probe));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return Promise.resolve(json({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function mountWithService(query = 'Re-Service') {
  render(<CreateAppointmentModal
    defaultCustomer={CUSTOMER}
    defaultDate={futureDate()}
    defaultWindowStart="09:00"
    onClose={vi.fn()}
    onCreated={vi.fn()}
    onChange={vi.fn()}
  />);
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: query } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(query, 'i') }));
}

const suggestionCalls = (fetcher) => fetcher.mock.calls.filter(([u]) => String(u).includes('/reservice-request-suggestion'));
const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST');

describe('Customer\'s words section', () => {
  it('renders for a pest re-service with the gate live, labels the suggestion, and Use this fills the box', async () => {
    const fetcher = installFetch();
    await mountWithService();
    expect(await screen.findByText("Customer's words")).toBeTruthy();
    expect(screen.getByText('Text, 3 h ago')).toBeTruthy();
    expect(screen.getByText('Ants are back in the kitchen')).toBeTruthy();
    expect(suggestionCalls(fetcher)[0][0]).toContain('customerId=customer-a');

    const box = document.getElementById('customer-words-input');
    expect(box.value).toBe('');
    expect(box.maxLength).toBe(400);
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    expect(box.value).toBe('Ants are back in the kitchen');
  });

  it('is absent when the gate is dark ({enabled:false})', async () => {
    installFetch({ probe: { enabled: false, suggestion: null } });
    await mountWithService();
    await waitFor(() => expect(screen.queryByText("Customer's words")).toBeNull());
    expect(document.getElementById('customer-words-input')).toBeNull();
  });

  it('is absent when the probe fails', async () => {
    const fetcher = installFetch({ probeFails: true });
    await mountWithService();
    await waitFor(() => expect(suggestionCalls(fetcher)).toHaveLength(1));
    expect(screen.queryByText("Customer's words")).toBeNull();
  });

  it('is absent for a service that is not a pest/lawn re-service, and never probes', async () => {
    const fetcher = installFetch({ serviceKey: 'pest_control_quarterly', serviceName: 'Quarterly Pest Control' });
    await mountWithService('Quarterly');
    await screen.findByRole('button', { name: 'Schedule appointment' });
    expect(screen.queryByText("Customer's words")).toBeNull();
    expect(suggestionCalls(fetcher)).toHaveLength(0);
  });

  it('shows the box with no suggestion card when there is nothing to suggest', async () => {
    installFetch({ probe: { enabled: true, suggestion: null } });
    await mountWithService();
    expect(await screen.findByText("Customer's words")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this' })).toBeNull();
  });

  it('POSTs the suggestion id/kind with the text when Use this was clicked — never a source', async () => {
    const fetcher = installFetch();
    await mountWithService();
    fireEvent.click(await screen.findByRole('button', { name: 'Use this' }));
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    const body = JSON.parse(schedulePosts(fetcher)[0][1].body);
    expect(body.customerRequest).toEqual({
      text: 'Ants are back in the kitchen',
      suggestionId: SUGGESTION.id,
      suggestionKind: 'text',
    });
    expect(JSON.stringify(body)).not.toMatch(/"source"/);
  });

  it('typed words post text only; an empty box posts no customerRequest', async () => {
    const fetcher = installFetch({ probe: { enabled: true, suggestion: null } });
    await mountWithService();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.change(await screen.findByPlaceholderText(/Optional/), { target: { value: '  Spiders on the lanai  ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).customerRequest).toEqual({ text: 'Spiders on the lanai' });
  });

  it('an empty box leaves the POST body without customerRequest', async () => {
    const fetcher = installFetch();
    await mountWithService();
    await screen.findByText("Customer's words");
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body)).not.toHaveProperty('customerRequest');
  });
});

describe('helpers', () => {
  it('customerRequestBodyField: inactive or empty sends nothing, text is trimmed and capped', () => {
    expect(customerRequestBodyField({ active: false, text: 'x' })).toEqual({});
    expect(customerRequestBodyField({ active: true, text: '   ' })).toEqual({});
    expect(customerRequestBodyField({ active: true, text: ' hi ' })).toEqual({ customerRequest: { text: 'hi' } });
    expect(customerRequestBodyField({ active: true, text: 'a'.repeat(900) }).customerRequest.text).toHaveLength(400);
    expect(customerRequestBodyField({ active: true, text: 'hi', usedSuggestion: { id: 'x', kind: 'call', text: 'hi' } }))
      .toEqual({ customerRequest: { text: 'hi', suggestionId: 'x', suggestionKind: 'call' } });
  });

  it('suggestionSourceLabel reads "Text, 3 h ago" / "Call, yesterday"', () => {
    const now = Date.parse('2026-10-01T16:00:00Z');
    const ago = (h) => new Date(now - h * 3600 * 1000).toISOString();
    expect(suggestionSourceLabel({ kind: 'text', at: ago(3) }, now)).toBe('Text, 3 h ago');
    expect(suggestionSourceLabel({ kind: 'call', at: ago(30) }, now)).toBe('Call, yesterday');
    expect(suggestionSourceLabel({ kind: 'call', at: ago(0.2) }, now)).toBe('Call, just now');
    expect(suggestionSourceLabel({ kind: 'text', at: ago(60) }, now)).toBe('Text, 2 days ago');
  });

  it('only pest_re_service / lawn_re_service lines qualify', () => {
    expect(isOfficeRequestLine({ service_key: 'pest_re_service' })).toBe(true);
    expect(isOfficeRequestLine({ serviceKey: 'lawn_re_service' })).toBe(true);
    expect(isOfficeRequestLine({ service_key: 'pest_control_quarterly' })).toBe(false);
    expect(isOfficeRequestLine(null)).toBe(false);
  });
});
