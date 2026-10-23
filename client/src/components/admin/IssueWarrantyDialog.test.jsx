// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));
import { adminFetch } from '../../lib/adminFetch';
import IssueWarrantyDialog, { IssueWarrantyAction } from './IssueWarrantyDialog';

const project = { id: 'abcd1234-0000', customer_id: 'cust-1', project_date: '2026-10-01' };
const findings = {
  treatment_date: '2026-10-01',
  treatment_method: 'Soil barrier (chemical)',
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
  wdo_target: ['Subterranean termites'],
};

function fillOfficeFields() {
  const set = (id, value) => fireEvent.change(document.getElementById(id), { target: { value } });
  set('warranty-basis-date', '09/01/2026');
  set('warranty-notice-date', '09/01/2026');
  set('warranty-treatment-price', '$1,250.00');
  set('warranty-renewal-fee', '$99.00');
  set('warranty-issuer-name', 'Pat Office');
  set('warranty-issuer-title', 'Office Manager');
  set('warranty-notice-location', 'on the wall beside the electric panel in the garage');
  set('warranty-payer', 'Example Homes LLC');
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('IssueWarrantyDialog', () => {
  it('shows the full text, needs the review tick, then creates with the previewed hash and sends nothing', async () => {
    adminFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ body: 'WARRANTY TEXT FOR REVIEW', renderHash: 'h1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ signingUrl: 'https://portal.example/sign/tok' }) });
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    const previewButton = screen.getByRole('button', { name: 'Preview warranty' });
    expect(previewButton).toBeDisabled();
    fillOfficeFields();
    expect(previewButton).toBeEnabled();
    fireEvent.click(previewButton);
    await screen.findByText('WARRANTY TEXT FOR REVIEW');
    const create = screen.getByRole('button', { name: 'Create warranty' });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(create);
    await screen.findByDisplayValue('https://portal.example/sign/tok');

    expect(adminFetch).toHaveBeenCalledTimes(2);
    expect(adminFetch.mock.calls[0][0]).toBe('/admin/document-templates/service_agreement.termite_new_construction_warranty/issue-preview');
    const [path, init] = adminFetch.mock.calls[1];
    expect(path).toBe('/admin/document-templates/service_agreement.termite_new_construction_warranty/contracts');
    expect(init.body.confirmedRenderHash).toBe('h1');
    expect(adminFetch.mock.calls[0][1].body.values).toEqual(init.body.values);
    expect(init.body.customerId).toBe('cust-1');
    expect(init.body.projectId).toBe('abcd1234-0000');
    expect(init.body.propertyAddress).toBeUndefined();
    expect(init.body.values.warranty).toEqual({
      structures: 'The new home and its attached garage on this lot.',
      notice_location: 'on the wall beside the electric panel in the garage',
      payer: 'Example Homes LLC',
      treatment_price: '$1,250.00',
      plan_price: 'Included in the treatment price',
      renewal_fee: '$99.00',
      consumer_notice_date: '09/01/2026',
    });
    expect(init.body.values.basis).toEqual({ kind: 'master', date: '09/01/2026' });
    expect(init.body.values.issuer).toEqual({ name: 'Pat Office', title: 'Office Manager' });
  });

  it('keeps Preview disabled while the contract basis date is after treatment', () => {
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    fillOfficeFields();
    fireEvent.change(document.getElementById('warranty-basis-date'), { target: { value: '10/05/2026' } });
    expect(screen.getByText('This date must be on or before the treatment date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview warranty' })).toBeDisabled();
  });

  it('names the certificate fields the issue route found empty', async () => {
    adminFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Document has unresolved merge fields.', unresolvedVariables: ['treatment.product'] }) });
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    fillOfficeFields();
    fireEvent.click(screen.getByRole('button', { name: 'Preview warranty' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The certificate is missing: treatment.product'));
  });
});


describe('IssueWarrantyAction', () => {
  const certificate = { ...project, project_type: 'pre_treatment_termite_certificate', sent_at: '2026-10-02T12:00:00Z' };
  it('shows for a certificate with a warranty plan, not for an addition or without a customer', () => {
    const { rerender } = render(<IssueWarrantyAction project={certificate} findings={findings} allowed blocked={false} unsaved={false} buttonStyle={{}} />);
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeEnabled();
    rerender(<IssueWarrantyAction project={certificate} findings={{ ...findings, warranty_type: 'Addition to an existing building (no warranty required)' }} allowed blocked={false} unsaved={false} buttonStyle={{}} />);
    expect(screen.queryByRole('button', { name: 'Issue warranty' })).toBeNull();
    rerender(<IssueWarrantyAction project={{ ...certificate, customer_id: null }} findings={findings} allowed blocked={false} unsaved={false} buttonStyle={{}} />);
    expect(screen.queryByRole('button', { name: 'Issue warranty' })).toBeNull();
    rerender(<IssueWarrantyAction project={certificate} findings={{ ...findings, treatment_method: 'Wood treatment (borate)' }} allowed blocked={false} unsaved={false} buttonStyle={{}} />);
    expect(screen.queryByRole('button', { name: 'Issue warranty' })).toBeNull();
    rerender(<IssueWarrantyAction project={certificate} findings={findings} allowed blocked={false} unsaved buttonStyle={{}} />);
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeDisabled();
    rerender(<IssueWarrantyAction project={{ ...certificate, sent_at: null, status: 'draft' }} findings={findings} allowed blocked={false} unsaved={false} buttonStyle={{}} />);
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeDisabled();
  });
});
