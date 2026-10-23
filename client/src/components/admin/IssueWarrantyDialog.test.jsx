// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));
import { adminFetch } from '../../lib/adminFetch';
import IssueWarrantyDialog from './IssueWarrantyDialog';

const project = { id: 'abcd1234-0000', customer_id: 'cust-1', project_date: '2026-10-01' };
const findings = {
  treatment_date: '2026-10-01',
  treatment_address: '12 Test Lane, Bradenton, FL 34202',
  builder_contractor: 'Example Homes LLC',
  product_name: 'Termidor SC',
  active_ingredient: 'fipronil',
  concentration_pct: '0.06',
  gallons_applied: '180',
  square_footage: '1800',
  applicator_name: 'Sam Tester',
  applicator_fdacs_id: 'JF000000',
  warranty_type: 'Builder 1-year, renewable yearly to year 5',
};

function fillOfficeFields() {
  const set = (id, value) => fireEvent.change(document.getElementById(id), { target: { value } });
  set('warranty-basis-date', '09/01/2026');
  set('warranty-notice-date', '09/01/2026');
  set('warranty-treatment-price', '$1,250.00');
  set('warranty-renewal-fee', '$99.00');
  set('warranty-issuer-name', 'Pat Office');
  set('warranty-issuer-title', 'Office Manager');
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('IssueWarrantyDialog', () => {
  it('creates the warranty from the certificate plus the office fields, and sends nothing', async () => {
    adminFetch.mockResolvedValue({ ok: true, json: async () => ({ signingUrl: 'https://portal.example/sign/tok' }) });
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    const create = screen.getByRole('button', { name: 'Create warranty' });
    expect(create).toBeDisabled();
    fillOfficeFields();
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await screen.findByDisplayValue('https://portal.example/sign/tok');

    expect(adminFetch).toHaveBeenCalledTimes(1);
    const [path, init] = adminFetch.mock.calls[0];
    expect(path).toBe('/admin/document-templates/service_agreement.termite_new_construction_warranty/contracts');
    expect(init.body.customerId).toBe('cust-1');
    expect(init.body.propertyAddress).toBe('12 Test Lane, Bradenton, FL 34202');
    expect(init.body.values.warranty).toMatchObject({
      term_end: '10/01/2027',
      plan_price: 'Included in the treatment price',
      renewal_fee: '$99.00',
      contract_basis: 'Issued under the master agreement with Example Homes LLC dated 09/01/2026.',
    });
    expect(init.body.values.issuer).toEqual({ name: 'Pat Office', title: 'Office Manager' });
  });

  it('names the certificate fields the issue route found empty', async () => {
    adminFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Document has unresolved merge fields.', unresolvedVariables: ['treatment.product'] }) });
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    fillOfficeFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create warranty' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The certificate is missing: treatment.product'));
  });
});
