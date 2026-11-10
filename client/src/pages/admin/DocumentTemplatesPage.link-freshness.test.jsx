// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentTemplatesPage from './DocumentTemplatesPage';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const template = { templateKey: 'agreement.synthetic', name: 'Synthetic Agreement', category: 'service_agreement', documentType: 'service_agreement', status: 'active', requiresSignature: true, variables: [], tags: [] };
const customers = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', firstName: 'Synthetic', lastName: 'Alpha' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', firstName: 'Synthetic', lastName: 'Beta' },
];
const linkFor = (customerId) => `https://example.invalid/sign/${customerId.slice(0, 8)}-synthetic-token`;
const CHANGED = 'The customer or document changed while the link was being created. Create the link again.';
const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

let creates;
let holdFirst;

function installFetch() {
  creates = [];
  adminFetch.mockImplementation(async (path, options = {}) => {
    if (path.startsWith('/admin/document-templates?')) return ok({ templates: [template] });
    if (path === '/admin/document-templates/agreement.synthetic') return ok({ template: { ...template, activeVersion: { versionNumber: 1, title: 'Synthetic Agreement', body: 'Hello {{customer.name}}' } }, versions: [] });
    if (path.startsWith('/admin/customers?')) return ok({ customers: path.includes('Alpha') ? [customers[0]] : [customers[1]] });
    if (path.endsWith('/contracts') && options.method === 'POST') {
      creates.push(options.body);
      const customerId = options.body.customerId;
      if (holdFirst && creates.length === 1) await holdFirst.promise;
      return ok({ signingUrl: linkFor(customerId), rendered: { title: 'Synthetic Agreement', body: 'Hello', unresolvedVariables: [] } });
    }
    throw new Error(`Unexpected synthetic request ${path}`);
  });
}

async function pickCustomer(term, label) {
  fireEvent.change(screen.getByLabelText('Customer'), { target: { value: term } });
  fireEvent.click(await screen.findByRole('button', { name: label }));
}

async function createFor(term, label) {
  await pickCustomer(term, label);
  fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
}

beforeEach(async () => {
  holdFirst = null;
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  installFetch();
  render(<DocumentTemplatesPage />);
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Synthetic Agreement'));
});
afterEach(() => {
  cleanup(); vi.resetAllMocks(); vi.restoreAllMocks();
  if (clipboardBefore) Object.defineProperty(navigator, 'clipboard', clipboardBefore);
  else delete navigator.clipboard;
});

describe('Documents page link freshness', () => {
  it('names the customer, then hides the link and Copy once another customer is picked', async () => {
    await createFor('Alpha', 'Synthetic Alpha');
    expect(await screen.findByText('Document link ready for Synthetic Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear selected customer' }));
    expect(screen.queryByText(/Document link ready/)).not.toBeInTheDocument();
    await pickCustomer('Beta', 'Synthetic Beta');
    expect(screen.queryByText(/Document link ready/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy', exact: true })).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('Document link ready for Synthetic Beta')).toBeInTheDocument();
    expect(creates).toHaveLength(2);
    expect(creates[1].customerId).toBe(customers[1].id);
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(linkFor(customers[1].id)));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(linkFor(customers[0].id));
  });

  it('hides the link when the customer box is typed in', async () => {
    await createFor('Alpha', 'Synthetic Alpha');
    expect(await screen.findByText('Document link ready for Synthetic Alpha')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'Synthetic Alph' } });
    expect(screen.queryByText(/Document link ready/)).not.toBeInTheDocument();
  });

  it.each([
    ['Values', () => fireEvent.change(screen.getByLabelText('Values'), { target: { value: '{"scope":"changed"}' } })],
    ['Property address', () => fireEvent.change(screen.getByLabelText('Property address (optional)'), { target: { value: '1 Synthetic Way' } })],
    ['Allow unresolved fields', () => fireEvent.click(screen.getByLabelText('Allow unresolved fields'))],
  ])('hides the link when %s changes', async (_name, change) => {
    await createFor('Alpha', 'Synthetic Alpha');
    expect(await screen.findByText('Document link ready for Synthetic Alpha')).toBeInTheDocument();
    change();
    expect(screen.queryByText(/Document link ready/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy', exact: true })).not.toBeInTheDocument();
  });

  it('drops a create response that lands after the customer changed', async () => {
    let release;
    holdFirst = { promise: new Promise((resolve) => { release = resolve; }) };
    await createFor('Alpha', 'Synthetic Alpha');
    await waitFor(() => expect(creates).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Clear selected customer' }));
    await pickCustomer('Beta', 'Synthetic Beta');
    release();

    expect(await screen.findByText(CHANGED)).toBeInTheDocument();
    expect(screen.queryByText(/Document link ready/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy', exact: true })).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
