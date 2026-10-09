// @vitest-environment jsdom
// GATE_COMBO_FAST_COMPLETE (PR 1): the pest sheet's report flow as one part of a grouped stop. With
// `onPrepared` its final action hands over the body it would have posted and posts nothing; with
// `sharedNote` the stop's one note drives the sheet's own note logic (voice fill read, Generate). The
// sheet's other suites pin that without the props nothing changed. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteSheet from './FastCompleteSheet';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => null }));

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [{ id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' }];
const REGULAR = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-01', address: { line1: '123 Main St' },
  serviceKey: 'pest_general_quarterly', status: 'confirmed',
};
const REPORT = 'WHAT WE FOUND\nGhost ants, light.\n\nWHAT WE DID AND WHY\nWe baited the counter edge.\n\nWHAT TO EXPECT\nA few more ants for a few days.\n\nWHAT\'S NEXT\nKeep counters wiped.';
const NOTE = 'Ghost ants on the kitchen counter, light. Baited the counter edge.';
const FACTS = { available: true, status: 'read', areas: ['Inside', 'Outside'], pests: ['ghost ants'] };
const SERVICE = { id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Quarterly Pest Control', address: '123 Main St', timeLabel: '9:00 AM', reportFlow: true, traceEligible: true };

function makeRequest({ service = REGULAR } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    const bare = path.split('?')[0];
    if (bare.endsWith('/pest-recap/context')) return { ok: true, eligible: true, reportFlow: true, service, products: CATALOG };
    if (bare.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
    if (bare.endsWith('/tech-tips')) return { available: false };
    if (bare.endsWith('/promises')) return { available: false, promises: [] };
    if (bare.endsWith('/blog-posts')) return { available: false, posts: [] };
    if (bare.endsWith('/photos')) return { photos: [] };
    if (bare.endsWith('/treatment-zone/last')) return { available: false };
    if (bare.endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (bare === '/admin/schedule/generate-report') return { report: REPORT };
    if (bare.endsWith('/voice-facts')) return FACTS;
    if (bare.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  return request;
}

async function openSheet(request, props = {}, service = SERVICE) {
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} {...props} />);
  await screen.findByText(/Taurus SC 4 fl oz/);
}

// Rating, then Generate, and the report on screen. The note is typed unless the stop's note drives the sheet.
async function generate({ type = true } = {}) {
  if (type) fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
  fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
}

const withoutKey = ({ idempotencyKey: _key, ...rest }) => rest;

describe('prepare mode (a part of a grouped stop)', () => {
  test('hands over the exact body a normal completion posts, and posts no /complete', async () => {
    const normal = makeRequest();
    await openSheet(normal);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [posted] = normal.bodies('/complete');
    cleanup();

    const onPrepared = vi.fn();
    const prepared = makeRequest();
    await openSheet(prepared, { onPrepared, sharedNote: NOTE });
    await generate({ type: false });
    fireEvent.click(screen.getByRole('button', { name: 'Save for this stop' }));
    await screen.findByText('Saved for this stop');
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(onPrepared.mock.calls[0][0]).toBe('svc-1');
    expect(withoutKey(onPrepared.mock.calls[0][1])).toEqual(withoutKey(posted));
    expect(prepared.bodies('/complete')).toHaveLength(0);
    expect(screen.queryByTestId('fast-complete-sent')).toBeNull();
  });

  test('the stop\'s note drives the voice-facts read and the report, and the sheet\'s note box is hidden', async () => {
    const request = makeRequest();
    await openSheet(request, { onPrepared: vi.fn(), sharedNote: NOTE });
    expect(screen.queryByLabelText('Tell me about the visit')).toBeNull();
    await generate({ type: false });
    expect(request.bodies('/voice-facts')[0]).toEqual({ note: NOTE });
    expect(JSON.stringify(request.bodies('/admin/schedule/generate-report')[0])).toContain('Ghost ants on the kitchen counter');
  });

  test('an edited stop note after the report makes the report stale, as its own note box does', async () => {
    const request = makeRequest();
    const { rerender } = render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} onPrepared={vi.fn()} sharedNote={NOTE} />);
    await screen.findByText(/Taurus SC 4 fl oz/);
    await generate({ type: false });
    rerender(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} onPrepared={vi.fn()} sharedNote={`${NOTE} Also a wasp nest.`} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save for this stop' })).toBeNull());
  });

  test('preparing again after an edit hands over a new body and keeps the sheet editable', async () => {
    const onPrepared = vi.fn();
    const request = makeRequest();
    await openSheet(request, { onPrepared, sharedNote: NOTE });
    await generate({ type: false });
    fireEvent.click(screen.getByRole('button', { name: 'Save for this stop' }));
    await screen.findByText('Saved for this stop');
    fireEvent.click(screen.getByRole('button', { name: 'Update for this stop' }));
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(2));
    expect(request.bodies('/complete')).toHaveLength(0);
  });

  test('a change after the handoff revokes it and tells the container; the footer asks to save again', async () => {
    const onPrepared = vi.fn();
    await openSheet(makeRequest(), { onPrepared, sharedNote: NOTE });
    await generate({ type: false });
    fireEvent.click(screen.getByRole('button', { name: 'Save for this stop' }));
    await screen.findByText('Saved for this stop');
    expect(onPrepared).toHaveBeenCalledTimes(1);
    // Going back to the visit and returning changes nothing: still prepared, container not told.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    await screen.findByLabelText('Pest activity', { selector: 'div' }).catch(() => null);
    expect(onPrepared).toHaveBeenCalledTimes(1);
    // The customer-home tap changes the body: revoked, container told.
    fireEvent.click(screen.getByRole('button', { name: 'Not home — partial access' }));
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(2));
    expect(onPrepared).toHaveBeenLastCalledWith('svc-1', null);
  });

  test('a visit that is not the plain pest report flow refuses to prepare and never posts', async () => {
    const onPrepared = vi.fn();
    const request = makeRequest({ service: { ...REGULAR, serviceType: 'Pest Control Re-Service', serviceKey: 'pest_re_service' } });
    render(<FastCompleteSheet service={{ ...SERVICE, serviceType: 'Pest Control Re-Service', reportFlow: undefined }} request={request} onClose={() => {}} onCompleted={() => {}} onPrepared={onPrepared} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    const complete = document.querySelector('.tech-visit-footer .tech-visit-complete');
    await waitFor(() => expect(complete.disabled).toBe(false));
    fireEvent.click(complete);
    await screen.findByText('This visit cannot be part of a combined stop. Use the full form.');
    expect(onPrepared).not.toHaveBeenCalled();
    expect(request.bodies('/complete')).toHaveLength(0);
  });
});
