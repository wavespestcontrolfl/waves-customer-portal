// @vitest-environment jsdom
// Fast Complete (PR C): the one-screen completion sheet for pest re-service
// (callback) visits. These tests pin the prefilled default mix, the
// toggle-off/toggle-on behavior, submit validation, the request body shape
// sent to the FULL completion endpoint, and the done view.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteSheet from './FastCompleteSheet';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Catalog carrying the exact house pest mix (lib/pest-default-mix.js) plus
// one extra product the tech can add manually.
const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  // House mix names per the 2026-09-27 ruling (#5049): Talstar P → Atticus
  // Talak 7.9 F, bare surfactant → LESCO 90/10. Ids kept so assertions hold.
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
  { id: 'extra', name: 'Advion Ant Bait Gel', category: 'Bait' },
];

// The context's visit identity (what recapVisitIdentity reads).
const CONTEXT_SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', hasPhone: false,
  customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};

function makeRequest({ rating = { allowed: true, scaleLabels: null }, service = CONTEXT_SERVICE, eligible = true, products = CATALOG, completeResponse = { success: true } } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.split('?')[0].endsWith('/pest-recap/context')) {
      return {
        ok: true,
        eligible,
        service,
        products,
        existingRecord: null,
      };
    }
    if (path.endsWith('/tech-rating-allowed')) return rating;
    if (path.endsWith('/complete')) {
      return completeResponse;
    }
    return {};
  });
  request.calls = calls;
  return request;
}

const SERVICE = { id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Pest Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };

describe('FastCompleteSheet', () => {
  test('renders the prefilled house pest mix', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    expect(await screen.findByRole('button', { name: /Taurus SC — 4 fl oz/ })).toBeTruthy();
    // A liquid's bare "oz" is a fluid ounce, and a dose under 1 fl oz reads in
    // measuring spoons (0.25 fl oz = 1½ tsp) — never in mL.
    expect(screen.getByRole('button', { name: /Atticus Talak 7\.9 F — 4 fl oz/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /LESCO 90\/10 Nonionic Surfactant — 1½ tsp/ })).toBeTruthy();
  });

  test('tapping a prefilled tile strikes it through (off) instead of removing it; tapping again restores it', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    const taurus = await screen.findByRole('button', { name: /Taurus SC/ });
    expect(taurus.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(taurus);
    expect(taurus.getAttribute('aria-pressed')).toBe('false');
    // Still rendered — struck through, not gone.
    expect(screen.getByRole('button', { name: /Taurus SC/ })).toBeTruthy();

    fireEvent.click(taurus);
    expect(taurus.getAttribute('aria-pressed')).toBe('true');
  });

  test('submit is blocked until product, pest, where and activity are all set', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    const submit = screen.getByRole('button', { name: 'Complete re-service' });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('Select at least one pest.')).toBeTruthy();

    // Deselect every default product — now nothing is selected at all.
    fireEvent.click(screen.getByRole('button', { name: /Taurus SC/ }));
    fireEvent.click(screen.getByRole('button', { name: /Atticus Talak 7\.9 F/ }));
    fireEvent.click(screen.getByRole('button', { name: /LESCO 90\/10 Nonionic Surfactant/ }));
    expect(screen.getByText('Select at least one product.')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    // Restore a product, add a pest — still missing where, then activity.
    fireEvent.click(screen.getByRole('button', { name: /Taurus SC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    expect(screen.getByText('Select where you treated.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.getByText('Select activity seen.')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(submit.disabled).toBe(false);
  });

  test('a perimeter spray records its linear feet and the house rate; Other needs a name', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    expect(screen.getByText('Name the other pest.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Which pest?'), { target: { value: 'Palmetto bugs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Perimeter spray' }));
    expect(screen.getByText('Enter the linear feet you sprayed.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Linear ft sprayed'), { target: { value: '140' } });
    fireEvent.click(screen.getByRole('button', { name: 'Heavy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));

    await waitFor(() => {
      expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true);
    });
    const body = JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
    const taurus = body.products.find((p) => p.productId === 'taurus');
    expect(taurus).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 140, areaUnit: 'linear_ft', applicationArea: 'Outside' });
    // At perimeter spray the shared resolver gives the 4-oz house default
    // rate — what the full form seeds. The amount keeps the fl oz the tile
    // showed: a liquid is never recorded in a bare oz.
    expect(taurus).toMatchObject({ rate: 4, rateUnit: 'oz', amountUnit: 'fl_oz' });
    expect(taurus.targets).toEqual(['Ants', 'Palmetto bugs']);
    expect(body.products.map((p) => p.productId).sort()).toEqual(['surfactant', 'talstar', 'taurus']);
  }, 15000);

  test('submits the full-completion body shape and shows the done view', async () => {
    const request = makeRequest();
    const onCompleted = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={onCompleted} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Roaches' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));

    await waitFor(() => {
      expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true);
    });
    const submit = request.calls.find((c) => c.path.endsWith('/complete'));
    expect(submit.path).toBe('/admin/dispatch/svc-1/complete');
    expect(submit.options.method).toBe('POST');
    const body = JSON.parse(submit.options.body);

    expect(body.visitOutcome).toBe('completed');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
    expect(body.sendCompletionSms).toBe(false);
    expect(body.requestReview).toBe(false);
    expect(body.includePayLink).toBe(false);
    // Gate off is today's body: no review timing and no client-written recap.
    expect('reviewTiming' in body).toBe(false);
    expect('customerRecap' in body).toBe(false);
    expect('customerRecapMode' in body).toBe(false);
    expect(screen.queryByTestId('fast-complete-text-result')).toBeNull();
    expect(body.areasServiced).toEqual(['Inside']);
    expect(body.clientPestRating).toBe(3); // moderate -> 3

    expect(body.products).toHaveLength(3);
    const taurus = body.products.find((p) => p.productId === 'taurus');
    // The unit follows the method, as the full form's resolver seeds it: at
    // spot treatment Taurus's per-basis label (fl oz/gal) records fl oz.
    expect(taurus).toMatchObject({ totalAmount: 4, amountUnit: 'fl_oz', applicationMethod: 'spot_treatment' });
    // The rate is resolved at the method actually sent: spot treatment
    // takes the catalog label band's low end in its own unit.
    expect(taurus).toMatchObject({ rate: 0.2, rateUnit: 'fl_oz/gal' });
    expect(body.expectedVisit).toEqual({
      customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
      serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
    });
    expect(taurus.targets).toEqual(['Ants', 'Roaches']);
    // Where rides each product row for the application record.
    expect(taurus.applicationArea).toBe('Inside');
    const surfactant = body.products.find((p) => p.productId === 'surfactant');
    expect(surfactant.totalAmount).toBe(0.25);

    // Done view.
    expect(await screen.findByText('Re-service complete')).toBeTruthy();
    // The done card names the visit (the header also shows its live address).
    expect(screen.getByText('123 Main St · 2:00 PM')).toBeTruthy();
    // The saved sheet can simply be dismissed, not only moved on from, and
    // dismissing it refreshes the schedule the same way Next stop does.
    expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCompleted).toHaveBeenCalledTimes(1);
    onCompleted.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalled();
  });

  function failFirstComplete(request, status) {
    const base = request.getMockImplementation();
    let failed = false;
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete') && !failed) {
        failed = true;
        request.calls.push({ path, options });
        throw Object.assign(new Error('Completion failed.'), { status });
      }
      return base(path, options);
    });
  }
  const completeBodies = (request) => request.calls
    .filter((c) => c.path.endsWith('/complete'))
    .map((c) => JSON.parse(c.options.body));

  test('a definitive rejection (422) lets the tech correct the form and resubmit under a fresh key', async () => {
    const request = makeRequest();
    failFirstComplete(request, 422);
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    expect(await screen.findByText('Completion failed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Roaches' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    await waitFor(() => expect(completeBodies(request)).toHaveLength(2));
    const [first, second] = completeBodies(request);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.products[0].targets).toEqual(['Ants', 'Roaches']);
  });

  test('an uncertain failure (503) locks the form and Retry resends the identical body and key', async () => {
    const request = makeRequest();
    failFirstComplete(request, 503);
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    expect(await screen.findByText(/couldn't confirm it saved/)).toBeTruthy();

    // Edits and switching forms are locked until the attempt resolves.
    const roaches = screen.getByRole('button', { name: 'Roaches' });
    expect(roaches.disabled).toBe(true);
    // The recap form can't resume this attempt; closing is fine.
    expect(screen.getByRole('button', { name: 'Full form' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(completeBodies(request)).toHaveLength(2));
    const [first, second] = completeBodies(request);
    expect(second).toEqual(first);
    expect(await screen.findByText('Re-service complete')).toBeTruthy();
  });

  test('closing after an unresolved attempt asks for a schedule refresh (it may have saved)', async () => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete')) {
        request.calls.push({ path, options });
        throw Object.assign(new Error('Completion failed.'), { status: 503 });
      }
      return base(path, options);
    });
    const onClose = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={onClose} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
  });

  test('a 409 service_already_completed is treated as saved, not retried', async () => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete')) {
        request.calls.push({ path, options });
        throw Object.assign(new Error('Service has already been completed.'), { status: 409, code: 'service_already_completed' });
      }
      return base(path, options);
    });
    const onCompleted = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={onCompleted} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));

    expect(await screen.findByText(/This visit was already saved/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalled();
  });

  test.each([
    ['completion_resume_payload_mismatch'],
  ])('a 409 %s means an earlier attempt saved the visit', async (code) => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete')) {
        request.calls.push({ path, options });
        throw Object.assign(new Error('Conflict.'), { status: 409, code });
      }
      return base(path, options);
    });
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    expect(await screen.findByText(/already saved. The office will finish anything still pending/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('a 409 idempotency_key_mismatch is a recoverable conflict, never shown as saved', async () => {
    // The server also answers it for pending/failed attempts with no record.
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete')) {
        request.calls.push({ path, options });
        throw Object.assign(new Error('Idempotency key reused with a different completion payload.'), { status: 409, code: 'idempotency_key_mismatch' });
      }
      return base(path, options);
    });
    const onClose = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={onClose} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));

    expect(await screen.findByText(/Close and reopen it from the schedule to see where it stands/)).toBeTruthy();
    expect(screen.queryByText('Re-service complete')).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete re-service' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  test('a conflict no retry can fix (future-dated visit) shows the reason and lets the tech leave', async () => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete')) {
        request.calls.push({ path, options });
        throw Object.assign(new Error('This visit is scheduled for a future date.'), { status: 409, code: 'future_scheduled_date' });
      }
      return base(path, options);
    });
    const onClose = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={onClose} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));

    expect(await screen.findByText('This visit is scheduled for a future date.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete re-service' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  test('the activity row follows the server rating contract', async () => {
    const off = makeRequest({ rating: { allowed: false, scaleLabels: null } });
    const { unmount } = render(<FastCompleteSheet service={SERVICE} request={off} onClose={() => {}} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
    expect(screen.queryByText('Activity seen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    await waitFor(() => {
      expect(off.calls.some((c) => c.path.endsWith('/complete'))).toBe(true);
    });
    const body = JSON.parse(off.calls.find((c) => c.path.endsWith('/complete')).options.body);
    expect('clientPestRating' in body).toBe(false);
    unmount();

    const labelled = makeRequest({ rating: { allowed: true, scaleLabels: ['None', 'Very low', 'Low', 'Moderate', 'Elevated', 'High'] } });
    render(<FastCompleteSheet service={SERVICE} request={labelled} onClose={() => {}} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
    expect(screen.getByRole('button', { name: 'Low' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
  });

  test('the 4-oz house default at perimeter spray is never flagged over the label', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Perimeter spray' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    // The house default is 4 oz in the tank, not Taurus's 0.2-0.8 fl oz per
    // gallon label, so there is no label maximum to be over.
    expect(screen.getByLabelText('Taurus SC rate').value).toBe('4');
    expect(screen.queryByText(/label max/)).toBeNull();
  });

  test('an edited rate above the label maximum shows the recap editor\'s warning', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    // Spot treatment resolves Taurus's label band 0.2-0.8 fl oz/gal.
    expect(screen.getByLabelText('Taurus SC rate').value).toBe('0.2');
    expect(screen.queryByText(/label max/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Taurus SC rate'), { target: { value: '1.2' } });
    expect(screen.getByText('> label max 0.8')).toBeTruthy();
  });

  test('only the house mix starts on the sheet; with no product list, + Other product opens the full form', async () => {
    const request = makeRequest();
    const { unmount } = render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
    expect(screen.queryByRole('button', { name: /Advion/ })).toBeNull();
    unmount();

    // The picker has nothing to offer when the catalog did not load, so the
    // button keeps its old way out (FastCompleteSheet.products.test.jsx pins
    // the picker itself).
    const onFullForm = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={makeRequest({ products: [] })} onClose={() => {}} onFullForm={onFullForm} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Other product' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
  });

  test('a schedule row that went stale (another customer) is not completed here, and closing asks for a refresh', async () => {
    const request = makeRequest();
    const onClose = vi.fn();
    render(<FastCompleteSheet service={{ ...SERVICE, routedCustomerId: 'cust-other' }} request={request} onClose={onClose} />);

    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete re-service' })).toBeNull();
    // Reopening must route from the live schedule, not the same stale row.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
  });

  test('a visit moved to another property of the same customer is not completed here', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet
      service={{ ...SERVICE, routedCustomerId: 'cust-1', routedPropertyId: 'prop-2', routedAddress: '9 Other Rd, Parrish, FL 34219' }}
      request={request}
      onClose={() => {}}
    />);

    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete re-service' })).toBeNull();
  });

  test('a visit moved to another unit at the same street is not completed here', async () => {
    // Same street, city and ZIP; only the unit (and so the property) differs.
    const request = makeRequest({ service: { ...CONTEXT_SERVICE, propertyId: 'prop-apt-5', address: { line1: '100 Bay Dr', line2: 'Apt 5', city: 'Bradenton', state: 'FL', zip: '34211' } } });
    render(<FastCompleteSheet
      service={{ ...SERVICE, routedCustomerId: 'cust-1', routedPropertyId: 'prop-apt-4', routedAddress: '100 Bay Dr Apt 4, Bradenton, FL 34211' }}
      request={request}
      onClose={() => {}}
    />);

    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete re-service' })).toBeNull();
    // The header names the live unit, so the tech sees where the visit went.
    expect(screen.getByText('100 Bay Dr Apt 5, Bradenton')).toBeTruthy();
  });

  test('a unit move on a visit with no property is caught by the full address', async () => {
    const request = makeRequest({ service: { ...CONTEXT_SERVICE, propertyId: null, address: { line1: '100 Bay Dr', line2: 'Apt 5', city: 'Bradenton', state: 'FL', zip: '34211' } } });
    render(<FastCompleteSheet
      service={{ ...SERVICE, routedCustomerId: 'cust-1', routedPropertyId: null, routedAddress: '100 Bay Dr Apt 4, Bradenton, FL 34211' }}
      request={request}
      onClose={() => {}}
    />);

    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete re-service' })).toBeNull();
  });

  test('a row with no property is stale once the live visit has one', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet
      service={{ ...SERVICE, routedCustomerId: 'cust-1', routedPropertyId: null, routedAddress: '123 Main St' }}
      request={request}
      onClose={() => {}}
    />);

    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
  });

  test('the same property is completed normally', async () => {
    // The property id decides: the row's SQL-built line may not match the
    // context's fields character for character.
    const request = makeRequest({ service: { ...CONTEXT_SERVICE, address: { line1: '123 Main St', line2: 'Unit 2', city: 'Bradenton', state: 'FL', zip: '34211' } } });
    render(<FastCompleteSheet
      service={{ ...SERVICE, routedCustomerId: 'cust-1', routedPropertyId: 'prop-1', routedAddress: '123 Main St, Bradenton, FL 34211' }}
      request={request}
      onClose={() => {}}
    />);

    expect(await screen.findByRole('button', { name: 'Complete re-service' })).toBeTruthy();
    expect(screen.queryByText(/changed since your schedule loaded/)).toBeNull();
  });

  test('a visit with no property at the same address, unit included, is completed normally', async () => {
    const request = makeRequest({ service: { ...CONTEXT_SERVICE, propertyId: null, address: { line1: '100 Bay Dr', line2: 'Apt 4', city: 'Bradenton', state: 'FL', zip: '34211' } } });
    render(<FastCompleteSheet
      // Spacing and punctuation differ from the live fields; the address does not.
      service={{ ...SERVICE, routedCustomerId: 'cust-1', routedPropertyId: null, routedAddress: '100 Bay Dr  Apt 4 , Bradenton, FL 34211' }}
      request={request}
      onClose={() => {}}
    />);

    expect(await screen.findByRole('button', { name: 'Complete re-service' })).toBeTruthy();
    expect(screen.queryByText(/changed since your schedule loaded/)).toBeNull();
  });

  // GATE_FAST_COMPLETE_RECAP (dark): the schedule row's flag reaches the sheet
  // as service.recapEnabled. On, the body asks for the server's ONE fixed
  // re-service text (customerRecapMode) with the review ask and pay link off;
  // the server writes the words, and after Complete the tech sees them.
  const completeRe = async (service, request = makeRequest()) => {
    render(<FastCompleteSheet service={service} request={request} onClose={() => {}} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
    return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
  };

  test('recap gate on: asks for the fixed re-service text, no review ask, no pay link, no client wording', async () => {
    const body = await completeRe({ ...SERVICE, recapEnabled: true });

    expect(body.sendCompletionSms).toBe(true);
    expect(body.customerRecapMode).toBe('reservice_fixed');
    expect(body.requestReview).toBe(false);
    expect(body.includePayLink).toBe(false);
    expect('reviewTiming' in body).toBe(false);
    // The server composes the text from the recorded facts; the client writes none.
    expect('customerRecap' in body).toBe(false);
    // The facts that text is built from still ride the body.
    expect(body.areasServiced).toEqual(['Inside']);
    expect(body.products.find((p) => p.productId === 'taurus').targets).toEqual(['Ants']);
    expect(body.products.find((p) => p.productId === 'taurus').applicationMethod).toBe('spot_treatment');
  });

  test('recap gate on: shows the exact text the server sent after Complete', async () => {
    const sent = 'Your re-service at 123 Main St is done. We treated inside for ants. Keep kids and pets off treated areas until dry. Details: https://example.test/r/abc';
    const request = makeRequest({ completeResponse: { success: true, customerText: { sent: true, body: sent, reason: null } } });
    await completeRe({ ...SERVICE, recapEnabled: true }, request);

    expect(await screen.findByText('Re-service complete')).toBeTruthy();
    expect(screen.getByText('Text sent to the customer:')).toBeTruthy();
    expect(screen.getByTestId('fast-complete-text-body').textContent).toBe(sent);
  });

  test('recap gate on: the recorded channel decides the wording (app vs text)', async () => {
    const body = 'Your re-service is done. Details: x.test/r/1';
    const request = makeRequest({ completeResponse: { success: true, customerText: { sent: true, channel: 'push', body, reason: null } } });
    await completeRe({ ...SERVICE, recapEnabled: true }, request);
    expect(await screen.findByText("Sent to the customer's app:")).toBeTruthy();
    expect(screen.queryByText('Text sent to the customer:')).toBeNull();
    expect(screen.getByTestId('fast-complete-text-body').textContent).toBe(body);
    cleanup();
    const sms = makeRequest({ completeResponse: { success: true, customerText: { sent: true, channel: 'sms', body, reason: null } } });
    await completeRe({ ...SERVICE, recapEnabled: true }, sms);
    expect(await screen.findByText('Text sent to the customer:')).toBeTruthy();
  }, 20000);

  test('recap gate on: says why no text went (no phone, opted out, gate off)', async () => {
    for (const reason of ['no phone number on file', "the customer can't be texted (opted out or blocked)", 'the customer text is turned off for this visit']) {
      const request = makeRequest({ completeResponse: { success: true, customerText: { sent: false, body: null, reason } } });
      await completeRe({ ...SERVICE, recapEnabled: true }, request);
      expect(await screen.findByText(`No text sent: ${reason}.`)).toBeTruthy();
      expect(screen.queryByTestId('fast-complete-text-body')).toBeNull();
      cleanup();
    }
  }, 30000);

  test('recap gate on: a text held for the send window is shown as queued with its words', async () => {
    const request = makeRequest({ completeResponse: { success: true, customerText: { sent: false, queued: true, body: 'Your re-service is done. Details: https://x.test/r/1', reason: 'held until the morning send window, then it goes out' } } });
    await completeRe({ ...SERVICE, recapEnabled: true }, request);
    expect(await screen.findByText('Text queued: held until the morning send window, then it goes out.')).toBeTruthy();
    expect(screen.getByTestId('fast-complete-text-body').textContent).toContain('Your re-service is done.');
  });

  test('gate off: the done view shows nothing about a customer text', async () => {
    await completeRe({ ...SERVICE });
    expect(await screen.findByText('Re-service complete')).toBeTruthy();
    expect(screen.queryByTestId('fast-complete-text-result')).toBeNull();
  });

  test('recap flag that is not exactly true leaves today\'s body', async () => {
    for (const recapEnabled of [false, undefined, 'true', 1]) {
      const body = await completeRe({ ...SERVICE, recapEnabled });
      expect([body.sendCompletionSms, body.requestReview, body.includePayLink]).toEqual([false, false, false]);
      expect('reviewTiming' in body).toBe(false);
      expect('customerRecapMode' in body).toBe(false);
      cleanup();
    }
  }, 20000);

  test('a visit the server no longer allows on the short form is sent to the full form', async () => {
    const request = makeRequest({ eligible: false });
    render(<FastCompleteSheet service={{ ...SERVICE, routedCustomerId: 'cust-1' }} request={request} onClose={() => {}} />);

    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete re-service' })).toBeNull();
  });

  test('the header shows the live visit\'s customer and address once loaded', async () => {
    const request = makeRequest({ service: { ...CONTEXT_SERVICE, customerName: 'Live Customer', address: { line1: '9 Live Ln', city: 'Parrish' } } });
    render(<FastCompleteSheet service={{ ...SERVICE, routedCustomerId: 'cust-1' }} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    expect(screen.getByText(/Live Customer/)).toBeTruthy();
    expect(screen.getByText('9 Live Ln, Parrish')).toBeTruthy();
  });

  test('a visit reclassified since the schedule loaded is not completed here', async () => {
    const request = makeRequest({ service: { ...CONTEXT_SERVICE, serviceKey: 'general_pest_control' } });
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    expect(await screen.findByText('This visit is no longer a pest re-service. Use the full form.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete re-service' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Full form' }).disabled).toBe(false);
  });

});
