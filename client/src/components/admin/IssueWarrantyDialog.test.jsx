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
  // The dialog opens on a builder lot, which runs from the final treatment.
  final_exterior_date: '2026-10-20',
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

// The consumer-notices list loads when the dialog opens: it answers 404 while
// GATE_WARRANTY_13692_CHECK is off. `replies` answer the other calls in order.
function mockApi({ notices = null, replies = [] } = {}) {
  const queue = [...replies];
  adminFetch.mockImplementation(async (path) => {
    if (isNoticeList(path)) {
      return notices ? { ok: true, json: async () => ({ enabled: true, graceEnd: '2026-11-24', notices }) } : { ok: false, json: async () => ({}) };
    }
    return queue.shift();
  });
}
const isNoticeList = (path) => path.endsWith('/consumer-notices');
const apiCalls = () => adminFetch.mock.calls.filter(([path]) => !isNoticeList(path));

describe('IssueWarrantyDialog', () => {
  it('shows the full text, needs the review tick, then saves a draft with the previewed hash and sends nothing', async () => {
    mockApi({
      replies: [
        { ok: true, json: async () => ({ body: 'WARRANTY TEXT FOR REVIEW', renderHash: 'h1' }) },
        { ok: true, json: async () => ({ signingUrl: null, contract: { status: 'draft' } }) },
      ],
    });
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
    await screen.findByText(/Warranty saved as a draft. Nothing has gone to the owner yet./);
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();

    expect(apiCalls()).toHaveLength(2);
    expect(apiCalls()[0][0]).toBe('/admin/document-templates/service_agreement.termite_new_construction_warranty/issue-preview');
    const [path, init] = apiCalls()[1];
    expect(path).toBe('/admin/document-templates/service_agreement.termite_new_construction_warranty/contracts');
    expect(init.body.confirmedRenderHash).toBe('h1');
    expect(apiCalls()[0][1].body.values).toEqual(init.body.values);
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

  it('gate on, notice on file: shows it, hides the typed date and sends none', async () => {
    mockApi({
      notices: [{ source: 'paper', id: 'p1', usable: true, signedOn: '08/20/2026' }, { source: 'esign', id: 'e1', usable: true, signedOn: '09/20/2026' }],
      replies: [{ ok: true, json: async () => ({ body: 'WARRANTY TEXT', renderHash: 'h2', warnings: [] }) }],
    });
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    fillOfficeFields();
    // The 09/20 notice is after the 09/01 contract basis; the 08/20 paper scan counts.
    await screen.findByText(/FDACS-13692 on file: paper, signed 08\/20\/2026/);
    expect(document.getElementById('warranty-notice-date')).toBeNull();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview warranty' }));
    await screen.findByText('WARRANTY TEXT');
    expect(apiCalls()[0][1].body.values.warranty).not.toHaveProperty('consumer_notice_date');
  });

  it('gate on, none on file: warns with the grace end, keeps the typed date, shows server warnings, uploads a scan and reloads', async () => {
    mockApi({
      notices: [],
      replies: [
        { ok: true, json: async () => ({}) },
        { ok: true, json: async () => ({ body: 'WARRANTY TEXT', renderHash: 'h3', warnings: ['No signed FDACS-13692 consumer notice is on file for this customer.'] }) },
      ],
    });
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    await screen.findByText(/Until 11\/24\/2026 you can type the date it was signed/);
    expect(document.getElementById('warranty-notice-date')).not.toBeNull();
    fillOfficeFields();
    const file = new File(['%PDF-1.4 test'], 'notice.pdf', { type: 'application/pdf' });
    fireEvent.change(document.getElementById('warranty-notice-file'), { target: { files: [file] } });
    fireEvent.change(document.getElementById('warranty-notice-file-date'), { target: { value: '08/20/2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload paper FDACS-13692' }));
    await waitFor(() => expect(apiCalls()).toHaveLength(1));
    const [path, init] = apiCalls()[0];
    expect(path).toBe('/admin/customers/cust-1/consumer-notices/paper');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('signedOn')).toBe('08/20/2026');
    expect(init.body.get('file')).toBe(file);
    fireEvent.click(screen.getByRole('button', { name: 'Preview warranty' }));
    await screen.findByText('No signed FDACS-13692 consumer notice is on file for this customer.');
    expect(apiCalls()[1][1].body.values.warranty.consumer_notice_date).toBe('09/01/2026');
  });

  it('gate off: no notice panel, the typed date as before', () => {
    mockApi();
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={findings} />);
    expect(document.getElementById('warranty-notice-date')).not.toBeNull();
    expect(document.getElementById('warranty-notice-file')).toBeNull();
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
  it('blocks a builder lot until the final treatment date is recorded, and names the $149.00 cap', () => {
    render(<IssueWarrantyDialog open onClose={() => {}} project={project} findings={{ ...findings, final_exterior_date: '' }} />);
    fillOfficeFields();
    expect(screen.getByRole('button', { name: 'Preview warranty' })).toBeDisabled();
    expect(screen.getByText(/A builder lot warranty runs from the final exterior treatment/)).toBeInTheDocument();
    expect(screen.getByLabelText(/not more than \$149.00/)).toBeInTheDocument();
  });
});



describe('IssueWarrantyAction', () => {
  // A sent certificate carries its as-sent copy; the button reads that copy.
  const sentAs = (sentFindings) => ({
    ...project,
    project_type: 'pre_treatment_termite_certificate',
    pretreat_sent_snapshot: { findings: sentFindings, project_date: '2026-10-01' },
  });
  const certificate = sentAs(findings);
  const action = (props) => <IssueWarrantyAction findings={findings} allowed blocked={false} buttonStyle={{}} {...props} />;

  it('shows for a sent certificate with a warranty plan, not for an addition, a borate job or without a customer', () => {
    const { rerender } = render(action({ project: certificate }));
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeEnabled();
    rerender(action({ project: sentAs({ ...findings, warranty_type: 'Addition to an existing building (no warranty required)' }) }));
    expect(screen.queryByRole('button', { name: 'Issue warranty' })).toBeNull();
    rerender(action({ project: { ...certificate, customer_id: null } }));
    expect(screen.queryByRole('button', { name: 'Issue warranty' })).toBeNull();
    rerender(action({ project: sentAs({ ...findings, treatment_method: 'Wood treatment (borate)' }) }));
    expect(screen.queryByRole('button', { name: 'Issue warranty' })).toBeNull();
  });

  it('reads the certificate as sent: a later live edit neither hides nor blocks it; no copy = disabled', () => {
    const { rerender } = render(action({
      project: certificate,
      findings: { ...findings, additional_applications: [{ treatment_method: 'Wood treatment (borate)', product_name: 'Bora-Care' }] },
    }));
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeEnabled();
    // A partial combined send: the copy exists without a sent stamp.
    rerender(action({ project: { ...certificate, sent_at: null, status: 'in_progress' } }));
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeEnabled();
    rerender(action({ project: { ...certificate, pretreat_sent_snapshot: null } }));
    expect(screen.getByRole('button', { name: 'Issue warranty' })).toBeDisabled();
  });
});

