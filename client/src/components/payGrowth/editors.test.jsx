// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { etDateString } from '../../lib/timezone';
import { request } from './common';
import PayOverview from './PayOverview';
import Growth from './Growth';
import ProgramSetup from './ProgramSetup';
import ServiceScore from './ServiceScore';
import ServiceEvidence from './ServiceEvidence';
import EvidenceEditor from './EvidenceEditor';
import BusinessEditor from './BusinessEditor';

vi.mock('./common', async () => ({ ...await vi.importActual('./common'), request: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

const ROLES = [
  { key: 'trainee', title: 'Trainee', hourlyCents: null, annualBaseCents: null, targetIncentiveCents: null },
  { key: 'technician_i', title: 'Technician I', hourlyCents: 2300, annualBaseCents: 4784000, targetIncentiveCents: 2016000 },
  { key: 'technician_ii', title: 'Technician II', hourlyCents: 2500, annualBaseCents: 5200000, targetIncentiveCents: 2760000 },
  { key: 'service_manager', title: 'Service Manager', hourlyCents: null, annualBaseCents: 6500000, targetIncentiveCents: 2500000 },
  { key: 'general_manager', title: 'General Manager', hourlyCents: null, annualBaseCents: 8500000, targetIncentiveCents: 3500000 },
];

function view(overrides = {}) {
  return {
    person: { id: 'tech-a', pay_rate: '22.00', job_title: 'Technician', employment_status: 'active' },
    month: '2026-04',
    can_manage: true,
    program: { roles: ROLES },
    level: { role_key: 'technician_i' },
    levels: [],
    simulation: {
      production: { amount_cents: 12000, calculated: 3, needs_evidence: 1 },
      rework: { status: 'not_enough_evidence', amount_cents: null, observed: 0, unresolved: 0, immature: 0, reason: null },
      handoff: { status: 'not_enough_evidence', amount_cents: null, observed: 0, unresolved: 0, immature: 0, reason: null },
      as_of_date: '2026-04-15', period_closed: false,
    },
    reviews: [], business: [], statements: [], entries: [], missing: [], assessments: [],
    ...overrides,
  };
}

// Route-dependent components (Link) must render inside a Router.
const withRouter = ui => <MemoryRouter>{ui}</MemoryRouter>;

function lastCallBody(path) {
  const call = request.mock.calls.find(([p]) => p === path);
  return call?.[1]?.body;
}

describe('EvidenceEditor', () => {
  const people = [{ id: 'tech-a', name: 'Tech A' }];
  const visitsResult = { visits: [{ id: 'visit-1', scheduled_date: '2026-04-05', service_type: 'General Pest', status: 'completed' }] };
  function baseDetail(overrides = {}) {
    return {
      visit: {
        id: 'visit-1', technician_id: 'tech-a', customer_id: 'cust-1', property_id: 'prop-1',
        service_key: 'pest_general_quarterly', service_date: '2026-04-05', service_type: 'General Pest',
        status: 'completed', is_callback: false,
      },
      revisions: [],
      allocations: [{ id: 'alloc-1', coverage_start: '2026-04-01', coverage_end: '2026-06-30', net_value_cents: 60000, planned_visits: 4 }],
      returns: [],
      ...overrides,
    };
  }

  async function selectVisit() {
    const select = screen.getByLabelText('Performed service');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'visit-1' } });
  }

  it('submits a fresh evidence review with the default participant share and null optional fields', async () => {
    const detail = baseDetail();
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    const allocationSelect = await screen.findByLabelText('Service-value allocation');
    fireEvent.change(allocationSelect, { target: { value: 'alloc-1' } });
    fireEvent.change(screen.getByLabelText('Service and credited-value evidence'), { target: { value: 'Confirmed on invoice #900.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain service evidence' }));
    await waitFor(() => expect(lastCallBody('/service-evidence')).toBeTruthy());
    const body = lastCallBody('/service-evidence');
    expect(body.ordinal).toBe(1);
    expect(body.ordinal).toEqual(expect.any(Number));
    expect(body.allocation_id).toBe('alloc-1');
    expect(body.cutoff_at).toBeNull();
    expect(body.complete_at_cutoff).toBeNull();
    expect(body.return_service_id).toBeNull();
    expect(body.same_issue_confirmed).toBe(false);
    expect(body.participants).toEqual([{ technician_id: 'tech-a', share_bps: 10000 }]);
    expect(body.base_id).toBeNull();
    expect(body.provenance).toBe('verified');
    expect(body.exclusion).toBe('none');
    expect(body.repair_reason).toBe('unresolved');
    expect(body.rework_outcome).toBe('unobserved');
  });

  it('never offers or submits an allocation for a callback visit', async () => {
    const detail = baseDetail({ visit: { ...baseDetail().visit, is_callback: true } });
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByText(/Callback visits are corrective/);
    expect(screen.queryByRole('button', { name: 'Add accepted value allocation' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service-value allocation')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Production exclusion')).toHaveValue('corrective');
    fireEvent.change(screen.getByLabelText('Service and credited-value evidence'), { target: { value: 'Callback reviewed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain service evidence' }));
    await waitFor(() => expect(lastCallBody('/service-evidence')).toBeTruthy());
    expect(lastCallBody('/service-evidence').allocation_id).toBeNull();
    expect(lastCallBody('/service-evidence').ordinal).toBeNull();
  });

  it('never offers or submits an allocation when the server resolves a forced follow-up exclusion', async () => {
    const detail = baseDetail({ visit: { ...baseDetail().visit, is_callback: false, forced_exclusion: 'planned_followup' } });
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByText(/included follow-up or an always-free visit type/);
    expect(screen.queryByRole('button', { name: 'Add accepted value allocation' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service-value allocation')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Production exclusion')).toHaveValue('planned_followup');
    fireEvent.change(screen.getByLabelText('Service and credited-value evidence'), { target: { value: 'Follow-up reviewed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain service evidence' }));
    await waitFor(() => expect(lastCallBody('/service-evidence')).toBeTruthy());
    expect(lastCallBody('/service-evidence').allocation_id).toBeNull();
    expect(lastCallBody('/service-evidence').ordinal).toBeNull();
  });

  it('keeps a retained allocation on a revision after the visit is reclassified as a callback', async () => {
    const detail = baseDetail({
      visit: { ...baseDetail().visit, is_callback: true, forced_exclusion: 'corrective' },
      revisions: [{
        id: 'rev-1', allocation_id: 'alloc-1', ordinal: 2,
        facts: { participants: [{ technician_id: 'tech-a', share_bps: 10000 }], provenance: 'verified', source_reference: 'Previously confirmed.', exclusion: 'none', cutoff_at: null, complete_at_cutoff: null, repair_reason: 'unresolved', repair_reference: '', rework_outcome: 'unobserved', return_service_id: null, same_issue_confirmed: false, rework_reference: '' },
      }],
    });
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByText(/Callback visits are corrective/);
    expect(screen.queryByRole('button', { name: 'Add accepted value allocation' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Service-value allocation')).toBeDisabled();
    expect(screen.getByLabelText('Production exclusion')).toHaveValue('corrective');
    fireEvent.click(screen.getByRole('button', { name: 'Retain service evidence' }));
    await waitFor(() => expect(lastCallBody('/service-evidence')).toBeTruthy());
    expect(lastCallBody('/service-evidence').allocation_id).toBe('alloc-1');
    expect(lastCallBody('/service-evidence').ordinal).toBe(2);
    expect(lastCallBody('/service-evidence').base_id).toBe('rev-1');
  });

  it('withdraws allocation controls once the reviewer selects an exclusion, and submits no allocation', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(baseDetail());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByRole('button', { name: 'Add accepted value allocation' });
    fireEvent.change(screen.getByLabelText('Production exclusion'), { target: { value: 'inspection' } });
    expect(screen.queryByRole('button', { name: 'Add accepted value allocation' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service-value allocation')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Service and credited-value evidence'), { target: { value: 'Inspection only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain service evidence' }));
    await waitFor(() => expect(lastCallBody('/service-evidence')).toBeTruthy());
    expect(lastCallBody('/service-evidence').exclusion).toBe('inspection');
    expect(lastCallBody('/service-evidence').allocation_id).toBeNull();
    expect(lastCallBody('/service-evidence').ordinal).toBeNull();
  });

  it('keeps a retained manual exclusion on a free visit instead of the forced follow-up default', async () => {
    const detail = baseDetail({
      visit: { ...baseDetail().visit, forced_exclusion: 'planned_followup' },
      revisions: [{ id: 'rev-1', allocation_id: null, ordinal: null, facts: { participants: [{ technician_id: 'tech-a', share_bps: 10000 }], provenance: 'verified', source_reference: 'Duplicate stop.', exclusion: 'duplicate', cutoff_at: null, complete_at_cutoff: null, repair_reason: 'unresolved', repair_reference: '', rework_outcome: 'unobserved', return_service_id: null, same_issue_confirmed: false, rework_reference: '' } }],
    });
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByText(/included follow-up or an always-free visit type/);
    expect(screen.getByLabelText('Production exclusion')).toHaveValue('duplicate');
  });

  it('locks the service selector while an allocation save is pending and selects the saved allocation', async () => {
    const detail = baseDetail({ allocations: [] });
    let resolveAllocation;
    request.mockImplementation((path, options = {}) => {
      if (path === '/allocations') return new Promise(resolve => { resolveAllocation = resolve; });
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    fireEvent.click(await screen.findByRole('button', { name: 'Add accepted value allocation' }));
    fireEvent.change(screen.getByLabelText('Accepted net service-line value ($)'), { target: { value: '600' } });
    fireEvent.change(screen.getByLabelText('Accepted scope / price evidence'), { target: { value: 'Accepted annual scope.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain allocation' }));
    await waitFor(() => expect(lastCallBody('/allocations')).toBeTruthy());
    expect(lastCallBody('/allocations').net_value_cents).toBe(60000);
    expect(screen.getByLabelText('Performed service')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close review' })).toBeDisabled();
    resolveAllocation({ id: 'alloc-new', coverage_start: '2026-04-05', coverage_end: '2026-04-05', net_value_cents: 60000, planned_visits: 1 });
    await waitFor(() => expect(screen.getByLabelText('Service-value allocation')).toHaveValue('alloc-new'));
    expect(screen.getByLabelText('Application number in original allocation')).toHaveValue(1);
    // The retained allocation must be claimed by this review: neither the selector, an exclusion, nor leaving can strand it.
    expect(screen.getByLabelText('Service-value allocation')).toBeDisabled();
    expect(screen.getByLabelText('Production exclusion')).toBeDisabled();
    expect(screen.getByText(/must claim the allocation it retained/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByLabelText('Performed service')).toBeDisabled();
  });

  it('offers only allocations whose coverage contains the service date', async () => {
    const detail = baseDetail({ allocations: [
      { id: 'alloc-old', coverage_start: '2025-01-01', coverage_end: '2025-12-31', net_value_cents: 50000, planned_visits: 4 },
      { id: 'alloc-1', coverage_start: '2026-04-01', coverage_end: '2026-06-30', net_value_cents: 60000, planned_visits: 4 },
    ] });
    request.mockImplementation((path, options = {}) => {
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    const values = Array.from((await screen.findByLabelText('Service-value allocation')).querySelectorAll('option')).map(option => option.value);
    expect(values).toEqual(['', 'alloc-1']);
  });

  it('locks the exclusion while a pre-existing allocation is selected, until it is cleared', async () => {
    request.mockImplementation((path, options = {}) => {
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(baseDetail());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    fireEvent.change(await screen.findByLabelText('Service-value allocation'), { target: { value: 'alloc-1' } });
    expect(screen.getByLabelText('Production exclusion')).toBeDisabled();
    expect(screen.getByText(/Clear the allocation to record an exclusion/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Service-value allocation'), { target: { value: '' } });
    expect(screen.getByLabelText('Production exclusion')).not.toBeDisabled();
  });

  it('disables allocation controls and participant shares once a revision is retained, and carries base_id forward', async () => {
    const detail = baseDetail({
      revisions: [{
        id: 'rev-1', allocation_id: 'alloc-1', ordinal: 1,
        facts: {
          participants: [{ technician_id: 'tech-a', share_bps: 10000 }],
          provenance: 'verified', source_reference: 'Previously confirmed.', exclusion: 'none',
          cutoff_at: null, complete_at_cutoff: null, repair_reason: 'unresolved', repair_reference: '',
          rework_outcome: 'unobserved', return_service_id: null, same_issue_confirmed: false, rework_reference: '',
        },
      }],
    });
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByLabelText('Service-value allocation');
    expect(screen.getByLabelText('Service-value allocation')).toBeDisabled();
    expect(screen.getByLabelText('Application number in original allocation')).toBeDisabled();
    expect(screen.getByLabelText('Employee 1')).toBeDisabled();
    expect(screen.getByLabelText('Employee 1 share (%)')).toBeDisabled();
    // The classification of an allocated revision can still be corrected; the allocation and ordinal ride along unchanged.
    expect(screen.getByLabelText('Production exclusion')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Production exclusion'), { target: { value: 'duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain service evidence' }));
    await waitFor(() => expect(lastCallBody('/service-evidence')).toBeTruthy());
    expect(lastCallBody('/service-evidence').base_id).toBe('rev-1');
    expect(lastCallBody('/service-evidence').exclusion).toBe('duplicate');
    expect(lastCallBody('/service-evidence').allocation_id).toBe('alloc-1');
    expect(lastCallBody('/service-evidence').ordinal).toBe(1);
  });

  it('disables the form and warns when the service is not marked complete', async () => {
    const detail = baseDetail({ visit: { ...baseDetail().visit, status: 'on_site' } });
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/visits?')) return Promise.resolve(visitsResult);
      if (path === '/services/visit-1/evidence') return Promise.resolve(detail);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<EvidenceEditor technicianId="tech-a" month="2026-04" people={people} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await selectVisit();
    await screen.findByText(/is not marked complete/);
    expect(screen.getByLabelText('Service and credited-value evidence')).toBeDisabled();
  });
});

describe('BusinessEditor', () => {
  it('posts baseline, accepted net, and derived nulls for a fresh origination', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/estimates?')) return Promise.resolve({ estimates: [{ id: 'est-1', accepted_at: '2026-04-02T16:00:00.000Z', customer_name: 'QA' }] });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<BusinessEditor technicianId="tech-a" month="2026-04" initial={null} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const estimateSelect = await screen.findByLabelText('Accepted estimate');
    await waitFor(() => expect(estimateSelect.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(estimateSelect, { target: { value: 'est-1' } });
    fireEvent.change(screen.getByLabelText('Original revenue baseline ($)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Accepted net value, including baseline ($)'), { target: { value: '600' } });
    fireEvent.change(screen.getByLabelText('Origination and incremental-value evidence'), { target: { value: 'Estimate accepted; see attached signature.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new-business evidence' }));
    await waitFor(() => expect(lastCallBody('/new-business')).toBeTruthy());
    const body = lastCallBody('/new-business');
    expect(body.baseline_cents).toBe(10000);
    expect(body.accepted_net_cents).toBe(60000);
    expect(body.activation_date).toBeNull();
    expect(body.retained_at_90).toBeNull();
    expect(body.base_id).toBeNull();
    expect(body.technician_id).toBe('tech-a');
    expect(body.estimate_id).toBe('est-1');
  });

  it('locks the estimate to the initial row and carries its id as base_id on a milestone review', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      if (path.startsWith('/estimates?')) return Promise.resolve({ estimates: [{ id: 'est-1', accepted_at: '2026-04-02T16:00:00.000Z', customer_name: 'QA' }] });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const initial = {
      id: 'biz-1', estimate_id: 'est-1', accepted_date: '2026-04-02',
      facts: { baseline_cents: 10000, accepted_net_cents: 60000, source_reference: 'Prior evidence.', activation_date: null, payment_reference: '', retained_at_90: null, retention_reference: '' },
    };
    render(<BusinessEditor technicianId="tech-a" month="2026-04" initial={initial} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText('Commission milestone review');
    expect(screen.getByLabelText('Accepted estimate')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save new-business evidence' }));
    await waitFor(() => expect(lastCallBody('/new-business')).toBeTruthy());
    expect(lastCallBody('/new-business').base_id).toBe('biz-1');
  });
});

describe('ProgramSetup', () => {
  const setup = { people: [], services: [{ service_key: 'pest_general_quarterly', name: 'Quarterly' }], rules: [], program: { roles: ROLES } };

  it('posts a service rule list, null minimums, and a converted activation share, with no activation_share key', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<ProgramSetup setup={setup} view={view()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Add an eligible service key'), { target: { value: 'pest_general_quarterly' } });
    fireEvent.change(screen.getByLabelText('Activation share of commission (%)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save simulation definition' }));
    await waitFor(() => expect(lastCallBody('/rules')).toBeTruthy());
    const body = lastCallBody('/rules');
    expect(body.service_rules).toEqual([{ service_key: 'pest_general_quarterly', credit_type: 'routine', rework_window_days: null }]);
    expect(body.rework_minimum).toBeNull();
    expect(body.handoff_minimum).toBeNull();
    expect(body.activation_share_bps).toBe(4000);
    expect(body).not.toHaveProperty('activation_share');
  });

  it('posts a simulation level with the technician id and chosen effective date', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<ProgramSetup setup={setup} view={view()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save simulation level' }));
    await waitFor(() => expect(lastCallBody('/levels')).toBeTruthy());
    const body = lastCallBody('/levels');
    expect(body.technician_id).toBe('tech-a');
    expect(body.role_key).toBe('technician_i');
    expect(body.effective_date).toBe(etDateString(new Date()));
    expect(body).toHaveProperty('id');
  });

  it('defaults the next level after the newest retained level and resets the draft when the employee changes', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const today = etDateString(new Date());
    const shift = (day, count) => { const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + count); return next.toISOString().slice(0, 10); };
    const newest = shift(today, 10);
    const levels = [{ id: 'l0', role_key: 'technician_i', effective_date: '2026-01-15' }, { id: 'l1', role_key: 'technician_ii', effective_date: newest }];
    const { rerender } = render(<ProgramSetup setup={setup} view={view({ levels, level: levels[0] })} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Simulation role')).toHaveValue('technician_ii');
    expect(screen.getByLabelText('Level effective date')).toHaveValue(shift(newest, 1));
    expect(screen.getByLabelText('Level effective date')).toHaveAttribute('min', shift(newest, 1));
    fireEvent.change(screen.getByLabelText('Simulation role'), { target: { value: 'service_manager' } });
    rerender(<ProgramSetup setup={setup} view={view({ person: { id: 'tech-b', pay_rate: '20.00', job_title: 'Technician', employment_status: 'active' }, level: { role_key: 'trainee' } })} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Simulation role')).toHaveValue('trainee');
    expect(screen.getByLabelText('Level effective date')).toHaveValue(today);
    fireEvent.click(screen.getByRole('button', { name: 'Save simulation level' }));
    await waitFor(() => expect(lastCallBody('/levels')).toBeTruthy());
    expect(lastCallBody('/levels').technician_id).toBe('tech-b');
    expect(lastCallBody('/levels').role_key).toBe('trainee');
  });

  it('keeps simulation levels read-only for an inactive employee', () => {
    render(<ProgramSetup setup={setup} view={view({ person: { id: 'tech-a', pay_rate: '22.00', job_title: 'Technician', employment_status: 'inactive' } })} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save simulation level' })).toBeDisabled();
    expect(screen.getByLabelText('Simulation role')).toBeDisabled();
    expect(screen.getByText(/read-only for former employees/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save simulation definition' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save simulation level' }));
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Growth', () => {
  it('hides the assessment action for a non-manager', () => {
    render(<Growth view={view()} manage={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Record assessment' })).not.toBeInTheDocument();
  });

  it('steps the assessment target from a chosen role and posts the assessment body', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const levels = [{ id: 'l1', role_key: 'technician_ii', effective_date: '2026-01-15' }];
    render(<Growth view={view({ levels, level: levels[0] })} manage onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record assessment' }));
    expect(screen.getByLabelText('Assess from role')).toHaveValue('technician_ii');
    expect(screen.getByLabelText('Assess from role')).toBeDisabled();
    expect(screen.getByLabelText('Next step')).toHaveValue('Service Manager');
    expect(screen.getByLabelText('Management position available')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Rubric version / reference'), { target: { value: 'Rubric v3' } });
    fireEvent.change(screen.getByLabelText('Item 1 evidence'), { target: { value: 'Observed diagnosis and calibration on three stops.' } });
    fireEvent.change(screen.getByLabelText('Verified outcome evidence / observation period'), { target: { value: 'Six months of clean handoffs.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain assessment' }));
    await waitFor(() => expect(lastCallBody('/assessments')).toBeTruthy());
    const body = lastCallBody('/assessments');
    expect(body.to_role).toBe('service_manager');
    expect(body.previous_id).toBeNull();
    expect(body.position_available).toBeNull();
    expect(body.items[0].critical).toBe(true);
  });

  it('fixes the starting role to the level in effect on the assessed date and blocks the top of the ladder', () => {
    const today = etDateString(new Date());
    const levels = [{ id: 'l2', role_key: 'general_manager', effective_date: today }, { id: 'l1', role_key: 'technician_i', effective_date: '2026-01-15' }];
    render(<Growth view={view({ levels, level: levels[0] })} manage onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record assessment' }));
    expect(screen.getByLabelText('Assess from role')).toBeDisabled();
    expect(screen.getByLabelText('Assess from role')).toHaveValue('general_manager');
    expect(screen.getByRole('button', { name: 'Retain assessment' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Assessment date'), { target: { value: '2026-02-01' } });
    expect(screen.getByLabelText('Assess from role')).toHaveValue('technician_i');
    expect(screen.getByLabelText('Next step')).toHaveValue('Technician II');
    expect(screen.getByRole('button', { name: 'Retain assessment' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Assessment date'), { target: { value: '2026-01-01' } });
    expect(screen.getByLabelText('Assess from role')).toHaveValue('');
    expect(screen.getByText(/Record the employee’s simulation level/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retain assessment' })).toBeDisabled();
  });

  it('drops an open assessment draft when the selected employee changes', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const levels = [{ id: 'l1', role_key: 'technician_i', effective_date: '2026-01-15' }];
    const { rerender } = render(<Growth view={view({ levels, level: levels[0] })} manage onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record assessment' }));
    fireEvent.change(screen.getByLabelText('Rubric version / reference'), { target: { value: 'Rubric v3' } });
    rerender(<Growth view={view({ person: { id: 'tech-b', pay_rate: '20.00', job_title: 'Technician', employment_status: 'active' }, levels, level: levels[0] })} manage onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Rubric version / reference')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Rubric version / reference'), { target: { value: 'Rubric v3' } });
    fireEvent.change(screen.getByLabelText('Item 1 evidence'), { target: { value: 'Observed.' } });
    fireEvent.change(screen.getByLabelText('Verified outcome evidence / observation period'), { target: { value: 'Three months.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain assessment' }));
    await waitFor(() => expect(lastCallBody('/assessments')).toBeTruthy());
    expect(lastCallBody('/assessments').technician_id).toBe('tech-b');
  });

  it('blocks a reassessment on dates where the original starting role is no longer in effect', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const levels = [{ id: 'l2', role_key: 'technician_ii', effective_date: '2026-03-01' }, { id: 'l1', role_key: 'technician_i', effective_date: '2026-01-15' }];
    const previous = { id: 'a1', previous_id: null, from_role: 'technician_i', to_role: 'technician_ii', assessed_date: '2026-02-10', assessor_name: 'Owner', rubric_version: 'Rubric v2',
      assessment: { items: [{ label: 'Calibration', critical: true, result: 'needs_work', evidence: 'Missed a dose.' }], sustained_results: 'needs_work', outcome_reference: 'One month.' }, result: { status: 'needs_work', management: false } };
    render(<Growth view={view({ levels, level: levels[0], assessments: [previous] })} manage onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record reassessment' }));
    expect(screen.getByLabelText('Assess from role')).toHaveValue('technician_ii');
    expect(screen.getByLabelText('Next step')).toHaveValue('Technician II');
    expect(screen.getByText(/simulation level is Technician II, not Technician I/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retain assessment' })).toBeDisabled();
    expect(screen.getByLabelText('Assessment date')).toHaveAttribute('min', '2026-02-10');
    fireEvent.change(screen.getByLabelText('Assessment date'), { target: { value: '2026-02-20' } });
    expect(screen.getByLabelText('Assess from role')).toHaveValue('technician_i');
    expect(screen.getByLabelText('Next step')).toHaveValue('Technician II');
    expect(screen.getByRole('button', { name: 'Retain assessment' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rubric version / reference'), { target: { value: 'Rubric v2' } });
    fireEvent.change(screen.getByLabelText('Item 1 evidence'), { target: { value: 'Calibrated correctly on four stops.' } });
    fireEvent.change(screen.getByLabelText('Verified outcome evidence / observation period'), { target: { value: 'Two weeks.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retain assessment' }));
    await waitFor(() => expect(lastCallBody('/assessments')).toBeTruthy());
    const body = lastCallBody('/assessments');
    expect(body.previous_id).toBe('a1');
    expect(body.from_role).toBe('technician_i');
    expect(body.to_role).toBe('technician_ii');
    expect(body.assessed_date).toBe('2026-02-20');
  });
});

describe('PayOverview', () => {
  it('drops an open origination draft when the employee or month changes', () => {
    request.mockImplementation(path => path.startsWith('/estimates?') ? Promise.resolve({ estimates: [] }) : Promise.reject(new Error(`unexpected path ${path}`)));
    const { rerender } = render(withRouter(<PayOverview view={view()} manage onSaved={vi.fn()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Record origination' }));
    fireEvent.change(screen.getByLabelText('Accepted net value, including baseline ($)'), { target: { value: '1500' } });
    expect(screen.getByLabelText('Accepted net value, including baseline ($)')).toHaveValue(1500);
    rerender(withRouter(<PayOverview view={view({ month: '2026-05' })} manage onSaved={vi.fn()} />));
    expect(screen.getByLabelText('Accepted net value, including baseline ($)')).toHaveValue(null);
  });

  it('carries the active visit into the technician documents link', () => {
    render(<MemoryRouter initialEntries={['/tech/pay-growth?visit=visit%2F42']}><PayOverview view={view()} manage={false} onSaved={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Staff documents' })).toHaveAttribute('href', '/tech/documents?visit=visit%2F42');
  });

  it('hides manager-only actions for a non-manager', () => {
    render(withRouter(<PayOverview view={view()} manage={false} onSaved={vi.fn()} />));
    expect(screen.queryByRole('button', { name: 'Save simulation statement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record origination' })).not.toBeInTheDocument();
  });

  it('saves a simulation statement for the technician and month, and notifies the caller', async () => {
    request.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const onSaved = vi.fn();
    render(withRouter(<PayOverview view={view()} manage onSaved={onSaved} />));
    fireEvent.click(screen.getByRole('button', { name: 'Save simulation statement' }));
    await waitFor(() => expect(lastCallBody('/statements')).toBeTruthy());
    expect(lastCallBody('/statements')).toEqual({ technician_id: 'tech-a', month: '2026-04' });
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('ServiceScore', () => {
  const entry = {
    id: 'entry-1', service_label: 'Quarterly Pest', service_date: '2026-04-05', revision: 1, service_key: 'pest_general_quarterly',
    calculation: { status: 'verified', amount_cents: 5000, value_cents: 5000, rate_bps: 600, reason: null },
    facts: {
      participants: [{ share_bps: 10000 }], source_reference: 'Confirmed on invoice.', complete_at_cutoff: null, cutoff_at: null,
      repair_reason: 'unresolved', repair_reference: '', rework_outcome: 'unobserved', rework_reference: '',
    },
    workweek_start: '2026-04-06', reviewer_name: 'Adam', created_at: '2026-04-06T12:00:00Z',
  };

  it('renders entries from the score endpoint and re-requests on retry after an error', async () => {
    request.mockImplementationOnce(() => Promise.reject(new Error('Score unavailable.')));
    request.mockImplementationOnce(() => Promise.resolve({ entries: [entry], can_manage: false }));
    render(withRouter(<ServiceScore serviceId="svc-1" />));
    expect(await screen.findByRole('alert')).toHaveTextContent('Score unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry score' }));
    expect(await screen.findByText('Quarterly Pest')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe('/services/svc-1/score');
    expect(request.mock.calls[1][0]).toBe('/services/svc-1/score');
  });

  it('takes the viewer role from the caller, never from the score payload', async () => {
    request.mockResolvedValue({ entries: [entry], can_manage: true });
    const { container, unmount } = render(withRouter(<ServiceScore serviceId="svc-1" />));
    await screen.findByText('Quarterly Pest');
    expect(container.querySelector('.pay-growth').hasAttribute('data-admin')).toBe(false);
    expect(screen.getByRole('link', { name: 'Open Pay & Growth' })).toHaveAttribute('href', '/tech/pay-growth');
    unmount();
    request.mockImplementation(() => new Promise(() => {}));
    const admin = render(withRouter(<ServiceScore serviceId="svc-1" manage />));
    expect(admin.container.querySelector('.pay-growth').hasAttribute('data-admin')).toBe(true);
    expect(screen.getByRole('link', { name: 'Open Pay & Growth' })).toHaveAttribute('href', '/admin/timetracking?tab=pay-growth');
  });
});

describe('ServiceEvidence', () => {
  it('links a "still needs evidence" review action into the evidence editor', () => {
    const missingView = view({ missing: [{ id: 'visit-2', scheduled_date: '2026-04-08', service_type: 'General Pest', status: 'completed' }] });
    request.mockImplementation(() => new Promise(() => {})); // EvidenceEditor's own fetches never need to resolve here.
    render(<ServiceEvidence view={missingView} manage people={[{ id: 'tech-a', name: 'Tech A' }]} onSaved={vi.fn()} />);
    expect(screen.getByText('Still needs evidence')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('heading', { name: 'Review service evidence' })).toBeInTheDocument();
  });
});
