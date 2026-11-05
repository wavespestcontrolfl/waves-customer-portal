// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CustomerSameFamilySection from './CustomerSameFamilySection';
import CustomerPropertiesPanelV2 from './CustomerPropertiesPanelV2';

let fetchMock;
let familyState;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const self = { id: 'c1', name: 'Sample Example', address: '1 Example Way, Sarasota, FL 34231', active: true, isSelf: true };
const son = { id: 'c2', name: 'Sample Son', address: '2 Example Way, Venice, FL 34285', active: true, isSelf: false };
const found = { id: 'c3', firstName: 'Third', lastName: 'Example', address: '3 Example Way, Sarasota, FL 34231' };

beforeEach(() => {
  familyState = { familyId: 'f1', members: [self, son] };
  fetchMock = vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/multi-home-family')) {
      if (options.method === 'DELETE') { familyState = { familyId: null, members: [] }; return json(familyState); }
      if (options.method === 'POST') {
        familyState = { familyId: 'f1', members: [self, son, { ...son, id: 'c3', name: 'Third Example', address: found.address }] };
        return json(familyState);
      }
      return json(familyState);
    }
    if (u.includes('/admin/customers?search=')) return json({ customers: [{ id: 'c1', firstName: 'Sample', lastName: 'Example' }, found] });
    return json({ properties: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the heading, the help text and the other members with an Unlink button', async () => {
  render(<CustomerSameFamilySection customerId="c1" />);
  expect(await screen.findByText('Sample Son')).toBeInTheDocument();
  expect(screen.getByText('Same family')).toBeInTheDocument();
  expect(screen.getByText(/count as one family for the 10% Multi-Home Discount\. Linking sends nothing and changes no price\./)).toBeInTheDocument();
  expect(screen.getByText('2 Example Way, Venice, FL 34285')).toBeInTheDocument();
  expect(screen.queryByText('Sample Example')).not.toBeInTheDocument();
});

it('unlink asks inline first, and only the confirm sends DELETE', async () => {
  render(<CustomerSameFamilySection customerId="c1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
  expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);
  expect(screen.getByText('Remove this profile from the family?')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(true));
  expect(await screen.findByText('Not linked to another profile.')).toBeInTheDocument();
});

it('searches, leaves this customer out of the results, and links the picked profile', async () => {
  familyState = { familyId: null, members: [] };
  render(<CustomerSameFamilySection customerId="c1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Link a profile' }));
  fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'Exam' } });
  const row = await screen.findByText(/Third Example/);
  expect(screen.queryByText(/^Sample Example/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
  fireEvent.click(row);
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true));
  const post = fetchMock.mock.calls.find(([, o]) => o?.method === 'POST');
  expect(JSON.parse(post[1].body)).toEqual({ otherCustomerId: 'c3' });
  expect(await screen.findByText('Third Example')).toBeInTheDocument();
});

it('shows a server refusal inline', async () => {
  familyState = { familyId: null, members: [] };
  const base = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options = {}) => (options.method === 'POST'
    ? json({ error: 'Both profiles are already in different families. Unlink one first.' }, 409)
    : base(url, options)));
  render(<CustomerSameFamilySection customerId="c1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Link a profile' }));
  fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'Third' } });
  fireEvent.click(await screen.findByText(/Third Example/));
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('different families');
});

it('the properties panel mounts the section for an editor and nothing for a viewer', async () => {
  const { unmount } = render(<CustomerPropertiesPanelV2 customerId="c1" canEdit={false} />);
  await screen.findByTestId('customer-properties-panel');
  expect(screen.queryByTestId('same-family-section')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/multi-home-family'))).toBe(false);
  unmount();
  render(<CustomerPropertiesPanelV2 customerId="c1" canEdit />);
  expect(await screen.findByTestId('same-family-section')).toBeInTheDocument();
});
