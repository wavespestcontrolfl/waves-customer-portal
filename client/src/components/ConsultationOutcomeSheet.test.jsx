// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConsultationOutcomeSheet, { buildOutcomePayload, followUpPayload } from './ConsultationOutcomeSheet';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const notFound = () => Object.assign(new Error('No outcome recorded for that visit'), { status: 404 });

function makeRequest({ row = null, loadError = null, saveError = null } = {}) {
  return vi.fn(async (path, options = {}) => {
    if (!options.method) {
      if (loadError) throw loadError;
      if (!row) throw notFound();
      return { outcome: row };
    }
    if (saveError) throw saveError;
    return { outcome: { ...JSON.parse(options.body), id: 'row-1' } };
  });
}

function renderSheet(request, props = {}) {
  const onSaved = vi.fn();
  render(<ConsultationOutcomeSheet serviceId="svc-1" customerName="Pat Sample" request={request} onClose={vi.fn()} onSaved={onSaved} {...props} />);
  return { onSaved };
}

const lastPost = (request) => {
  const call = request.mock.calls.find(([, opts]) => opts?.method === 'POST');
  return { path: call[0], body: JSON.parse(call[1].body) };
};

describe('ConsultationOutcomeSheet', () => {
  it('a new consultation needs an outcome, then posts only what was entered', async () => {
    const request = makeRequest();
    const { onSaved } = renderSheet(request);
    const save = await screen.findByRole('button', { name: 'Pick warm, cold or lost' });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'Warm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastPost(request)).toEqual({
      path: '/admin/consultations/svc-1/outcome',
      body: {
        outcome: 'warm', lostReason: null, interests: [], quotedAmount: null,
        quotedCadence: null, quoteNotes: null, followUpAt: null,
      },
    });
  });

  it('lost requires a reason and drops the follow-up field', async () => {
    const request = makeRequest();
    renderSheet(request);
    fireEvent.click(await screen.findByRole('radio', { name: 'Lost' }));
    expect(screen.getByRole('button', { name: 'Pick why it was lost' })).toBeDisabled();
    expect(screen.queryByLabelText('Follow up on')).toBeNull();
    // no_show is set by the visit status only — never offered here.
    expect(screen.queryByRole('radio', { name: /no.?show/i })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Competitor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));
    await waitFor(() => expect(lastPost(request).body).toMatchObject({ outcome: 'lost', lostReason: 'competitor', followUpAt: null }));
  });

  it('sends interests, the quote and a picked follow-up day at 9 AM ET', async () => {
    const request = makeRequest();
    renderSheet(request);
    fireEvent.click(await screen.findByRole('radio', { name: 'Cold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quarterly pest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mosquito' }));
    fireEvent.change(screen.getByLabelText('Price quoted (optional)'), { target: { value: '$129.50' } });
    fireEvent.change(screen.getByLabelText('Quoted per'), { target: { value: 'quarter' } });
    fireEvent.change(screen.getByLabelText('Notes for the quote'), { target: { value: '  Side yard ants  ' } });
    fireEvent.change(screen.getByLabelText('Follow up on'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));

    await waitFor(() => expect(lastPost(request).body).toEqual({
      outcome: 'cold', lostReason: null, interests: ['pest_quarterly', 'mosquito'],
      quotedAmount: '129.50', quotedCadence: 'quarter', quoteNotes: 'Side yard ants',
      followUpAt: '2026-10-20T09:00',
    }));
  });

  it('prefills a recorded outcome and labels the save as an update', async () => {
    const row = {
      outcome: 'warm', lost_reason: null, interests: ['lawn'], quoted_amount: '89.00',
      quoted_cadence: 'month', quote_notes: 'Front beds', follow_up_at: '2026-09-28T13:00:00.000Z',
    };
    const request = makeRequest({ row });
    renderSheet(request);
    expect(await screen.findByRole('button', { name: 'Update outcome' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Warm' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Lawn' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Price quoted (optional)')).toHaveValue('89');
    expect(screen.getByLabelText('Follow up on')).toHaveValue('2026-09-28');
  });

  it('a won consultation is read-only', async () => {
    const request = makeRequest({ row: { outcome: 'won', won_at: '2026-09-20T15:00:00Z', won_via: 'estimate_accept' } });
    renderSheet(request);
    expect(await screen.findByText(/Won on 2026-09-20 \(estimate accept\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /outcome/i })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows the server refusal and keeps the form open', async () => {
    const request = makeRequest({ saveError: new Error('That consultation has not happened yet — record its outcome on or after the visit day') });
    const { onSaved } = renderSheet(request);
    fireEvent.click(await screen.findByRole('radio', { name: 'Warm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has not happened yet');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a load failure other than 404 is shown, not treated as a blank form', async () => {
    const request = makeRequest({ loadError: Object.assign(new Error('Not assigned to this consultation'), { status: 403 }) });
    renderSheet(request);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not assigned to this consultation');
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('followUpPayload', () => {
  const loadedRow = { outcome: 'warm', follow_up_at: '2026-09-28T13:00:00.000Z' };

  it('keeps the stored instant when neither the date nor the outcome changed', () => {
    expect(followUpPayload({ outcome: 'warm', followUpDate: '2026-09-28', followUpTouched: false, loadedRow }))
      .toBe('2026-09-28T13:00:00.000Z');
  });

  it('lets the server re-default when the outcome changed and the date was not touched', () => {
    expect(followUpPayload({ outcome: 'cold', followUpDate: '2026-09-28', followUpTouched: false, loadedRow })).toBeNull();
  });

  it('a cleared date re-defaults; lost never carries one', () => {
    expect(followUpPayload({ outcome: 'warm', followUpDate: '', followUpTouched: true, loadedRow })).toBeNull();
    expect(followUpPayload({ outcome: 'lost', followUpDate: '2026-10-01', followUpTouched: true, loadedRow })).toBeNull();
  });

  it('blank quote fields go out as null', () => {
    const body = buildOutcomePayload({
      outcome: 'warm', lostReason: 'price', interests: [], quotedAmount: '  ', quotedCadence: '', quoteNotes: ' ', followUpDate: '',
    });
    expect(body).toMatchObject({ lostReason: null, quotedAmount: null, quotedCadence: null, quoteNotes: null });
  });
});
