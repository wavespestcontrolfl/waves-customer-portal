// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomerPropertiesPanelV2 from './CustomerPropertiesPanelV2';

const PRIMARY = { id: 'p1', address_line1: '10 Palm Ave', city: 'Naples', state: 'FL', zip: '34102', is_primary: true, occupancy_type: 'rental_investment', label: null };
const SECOND = { id: 'p2', address_line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34103', is_primary: false, occupancy_type: 'rental_investment', label: 'Vacation rental' };

function jsonResponse(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('CustomerPropertiesPanelV2', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists properties and labels the primary as the DEFAULT address for a property manager', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ properties: [PRIMARY, SECOND] }));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('waves_admin_token', 't');

    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="property_manager" canEdit />);

    expect(await screen.findByText(/10 Palm Ave/)).toBeInTheDocument();
    expect(screen.getByText(/20 Oak St/)).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.queryByText('Primary')).not.toBeInTheDocument();
    expect(screen.getByText(/not a residence/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/customers/c1/properties');
  });

  it('labels the primary as PRIMARY for an owner and hides editing for non-admins', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ properties: [PRIMARY] })));
    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit={false} />);
    expect(await screen.findByText('Primary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add service address' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Occupancy for 10 Palm Ave')).toBeDisabled();
  });

  it('POSTs a new property with the required address fields and renders the server list', async () => {
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'POST') return jsonResponse({ propertyId: 'p2', properties: [PRIMARY, SECOND] }, 201);
      return jsonResponse({ properties: [PRIMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="property_manager" canEdit />);
    await screen.findByText(/10 Palm Ave/);

    fireEvent.click(screen.getByRole('button', { name: 'Add service address' }));
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '20 Oak St' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Naples' } });
    fireEvent.change(screen.getByLabelText('ZIP'), { target: { value: '34103' } });
    fireEvent.change(screen.getByLabelText('Occupancy'), { target: { value: 'rental_investment' } });
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'Vacation rental' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));

    await waitFor(() => expect(screen.getByText(/20 Oak St/)).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, o]) => o && o.method === 'POST');
    expect(post[0]).toBe('/api/admin/customers/c1/properties');
    expect(JSON.parse(post[1].body)).toEqual({
      address_line1: '20 Oak St', address_line2: null, city: 'Naples', state: 'FL', zip: '34103',
      occupancy_type: 'rental_investment', label: 'Vacation rental',
    });
    expect(screen.queryByLabelText('Street address')).not.toBeInTheDocument();
  });

  it('blocks a partial address client-side and surfaces the server 409 verbatim', async () => {
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'POST') return jsonResponse({ error: 'A property with that street already exists for this customer' }, 409);
      return jsonResponse({ properties: [PRIMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit />);
    await screen.findByText(/10 Palm Ave/);
    fireEvent.click(screen.getByRole('button', { name: 'Add service address' }));
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '10 Palm Ave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('Street, city and ZIP are required.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, o]) => o && o.method === 'POST')).toBe(false);

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Naples' } });
    fireEvent.change(screen.getByLabelText('ZIP'), { target: { value: '34102' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('A property with that street already exists for this customer')).toBeInTheDocument();
  });

  it('PATCHes occupancy from the row select', async () => {
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'PATCH') return jsonResponse({ properties: [{ ...PRIMARY, occupancy_type: 'seasonal' }] });
      return jsonResponse({ properties: [PRIMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit />);
    const select = await screen.findByLabelText('Occupancy for 10 Palm Ave');
    fireEvent.change(select, { target: { value: 'seasonal' } });
    await waitFor(() => expect(select.value).toBe('seasonal'));
    const patch = fetchMock.mock.calls.find(([, o]) => o && o.method === 'PATCH');
    expect(patch[0]).toBe('/api/admin/customers/c1/properties/p1');
    expect(JSON.parse(patch[1].body)).toEqual({ occupancy_type: 'seasonal' });
  });
});

describe('CustomerPropertiesPanelV2 — review-round behaviours', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('refetches when refreshToken changes (profile address save synced the primary row)', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ properties: [PRIMARY] }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit refreshToken="a" />);
    await screen.findByText(/10 Palm Ave/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit refreshToken="b" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('edits a label inline and PATCHes it (Enter commits; unchanged label is a no-op)', async () => {
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'PATCH') return jsonResponse({ properties: [{ ...PRIMARY, label: 'Main house' }] });
      return jsonResponse({ properties: [PRIMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit />);
    await screen.findByText(/10 Palm Ave/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit label for 10 Palm Ave' }));
    const input = screen.getByLabelText('Label for 10 Palm Ave');
    fireEvent.change(input, { target: { value: 'Main house' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit label for 10 Palm Ave' })).toHaveTextContent('Main house'));
    const patch = fetchMock.mock.calls.find(([, o]) => o && o.method === 'PATCH');
    expect(patch[0]).toBe('/api/admin/customers/c1/properties/p1');
    expect(JSON.parse(patch[1].body)).toEqual({ label: 'Main house' });

    // Re-open and commit the same value → no second PATCH.
    fireEvent.click(screen.getByRole('button', { name: 'Edit label for 10 Palm Ave' }));
    fireEvent.blur(screen.getByLabelText('Label for 10 Palm Ave'));
    await waitFor(() => expect(screen.queryByLabelText('Label for 10 Palm Ave')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([, o]) => o && o.method === 'PATCH')).toHaveLength(1);
  });

  it('serializes row edits: every row control is disabled while one PATCH is in flight', async () => {
    let resolvePatch;
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'PATCH') return new Promise((res) => { resolvePatch = () => res(new Response(JSON.stringify({ properties: [{ ...PRIMARY, occupancy_type: 'seasonal' }, SECOND] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
      return jsonResponse({ properties: [PRIMARY, SECOND] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit />);
    const first = await screen.findByLabelText('Occupancy for 10 Palm Ave');
    const second = screen.getByLabelText('Occupancy for 20 Oak St');
    fireEvent.change(first, { target: { value: 'seasonal' } });
    await waitFor(() => expect(second).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Edit label for 20 Oak St' })).toBeDisabled();
    // A second change while busy is ignored — still one PATCH.
    fireEvent.change(second, { target: { value: 'vacant' } });
    expect(fetchMock.mock.calls.filter(([, o]) => o && o.method === 'PATCH')).toHaveLength(1);
    resolvePatch();
    await waitFor(() => expect(second).not.toBeDisabled());
  });

  it('constrains state to a two-letter code client-side', async () => {
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'POST') return jsonResponse({ propertyId: 'p2', properties: [PRIMARY, SECOND] }, 201);
      return jsonResponse({ properties: [PRIMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit />);
    await screen.findByText(/10 Palm Ave/);
    fireEvent.click(screen.getByRole('button', { name: 'Add service address' }));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Florida' } });
    // Input sanitizes to the first two letters, uppercased.
    expect(screen.getByLabelText('State').value).toBe('FL');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'f' } });
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '20 Oak St' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Naples' } });
    fireEvent.change(screen.getByLabelText('ZIP'), { target: { value: '34103' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('State must be a two-letter code (e.g. FL).')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, o]) => o && o.method === 'POST')).toBe(false);
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'fl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o && o.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, o]) => o && o.method === 'POST');
    expect(JSON.parse(post[1].body).state).toBe('FL');
  });

  it('an in-flight add locks row edits too (one write lock), and Escape on a label edit does not bubble to the drawer', async () => {
    let resolvePost;
    const fetchMock = vi.fn((url, opts = {}) => {
      if (opts.method === 'POST') return new Promise((res) => { resolvePost = () => res(new Response(JSON.stringify({ propertyId: 'p2', properties: [PRIMARY, SECOND] }), { status: 201, headers: { 'Content-Type': 'application/json' } })); });
      return jsonResponse({ properties: [PRIMARY] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    try {
      render(<CustomerPropertiesPanelV2 customerId="c1" contactRole="owner" canEdit />);
      await screen.findByText(/10 Palm Ave/);

      // Escape while editing a label: editor closes, window listener never sees it.
      fireEvent.click(screen.getByRole('button', { name: 'Edit label for 10 Palm Ave' }));
      fireEvent.keyDown(screen.getByLabelText('Label for 10 Palm Ave'), { key: 'Escape' });
      expect(screen.queryByLabelText('Label for 10 Palm Ave')).not.toBeInTheDocument();
      expect(windowEscape).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Add service address' }));
      fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '20 Oak St' } });
      fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Naples' } });
      fireEvent.change(screen.getByLabelText('ZIP'), { target: { value: '34103' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
      const occ = screen.getByLabelText('Occupancy for 10 Palm Ave');
      await waitFor(() => expect(occ).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Edit label for 10 Palm Ave' })).toBeDisabled();
      fireEvent.change(occ, { target: { value: 'seasonal' } });
      expect(fetchMock.mock.calls.some(([, o]) => o && o.method === 'PATCH')).toBe(false);
      resolvePost();
      await screen.findByText(/20 Oak St/);
      await waitFor(() => expect(screen.getByLabelText('Occupancy for 10 Palm Ave')).not.toBeDisabled());
    } finally {
      window.removeEventListener('keydown', windowEscape);
    }
  });
});
