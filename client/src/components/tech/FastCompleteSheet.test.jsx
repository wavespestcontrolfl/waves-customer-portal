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
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide' },
  { id: 'talstar', name: 'Talstar P', category: 'Insecticide' },
  { id: 'surfactant', name: 'Non-ionic Surfactant', category: 'adjuvant' },
  { id: 'extra', name: 'Advion Ant Bait Gel', category: 'Insecticide' },
];

function makeRequest() {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/pest-recap/context')) {
      return {
        ok: true,
        service: { id: 'svc-1', customerName: 'Pat Jones', hasPhone: false },
        products: CATALOG,
        existingRecord: null,
      };
    }
    if (path.endsWith('/complete')) {
      return { success: true };
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

    expect(await screen.findByRole('button', { name: /Taurus SC — 4 oz/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Talstar P — 4 oz/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Non-ionic Surfactant — 0.25 oz/ })).toBeTruthy();
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

  test('submit is blocked until a product, a pest and an activity are all selected', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    const submit = screen.getByRole('button', { name: 'Complete re-service' });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('Select at least one pest.')).toBeTruthy();

    // Deselect every default product — now nothing is selected at all.
    fireEvent.click(screen.getByRole('button', { name: /Taurus SC/ }));
    fireEvent.click(screen.getByRole('button', { name: /Talstar P/ }));
    fireEvent.click(screen.getByRole('button', { name: /Non-ionic Surfactant/ }));
    expect(screen.getByText('Select at least one product.')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    // Restore a product, add a pest — still missing activity.
    fireEvent.click(screen.getByRole('button', { name: /Taurus SC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    expect(screen.getByText('Select activity seen.')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(submit.disabled).toBe(false);
  });

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
    expect(body.areasServiced).toEqual(['Inside']);
    expect(body.clientPestRating).toBe(3); // moderate -> 3

    expect(body.products).toHaveLength(3);
    const taurus = body.products.find((p) => p.productId === 'taurus');
    expect(taurus).toMatchObject({ totalAmount: 4, amountUnit: 'oz', applicationMethod: 'spot_treatment' });
    expect(taurus.targets).toEqual(['Ants', 'Roaches']);
    // Where rides each product row for the application record.
    expect(taurus.applicationArea).toBe('Inside');
    const surfactant = body.products.find((p) => p.productId === 'surfactant');
    expect(surfactant.totalAmount).toBe(0.25);

    // Done view.
    expect(await screen.findByText('Re-service complete')).toBeTruthy();
    expect(screen.getByText(/123 Main St/)).toBeTruthy();
    expect(screen.getByText(/2:00 PM/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
    expect(await screen.findByText(/couldn't confirm it saved/)).toBeTruthy();

    // Edits are locked until the attempt resolves.
    const roaches = screen.getByRole('button', { name: 'Roaches' });
    expect(roaches.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(completeBodies(request)).toHaveLength(2));
    const [first, second] = completeBodies(request);
    expect(second).toEqual(first);
    expect(await screen.findByText('Re-service complete')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));

    expect(await screen.findByText('This visit was already saved.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalled();
  });

  test('an added product blocks Complete until its amount is entered; edited amounts and units are submitted', async () => {
    const request = makeRequest();
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);

    await screen.findByRole('button', { name: /Taurus SC/ });
    fireEvent.click(screen.getByRole('button', { name: '+ Add product' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Advion Ant Bait Gel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    const submit = screen.getByRole('button', { name: 'Complete re-service' });
    expect(screen.getByText('Enter the amount for Advion Ant Bait Gel.')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    // Adding a product opens the amount editor; the tech corrects the house
    // mix total too.
    fireEvent.change(screen.getByLabelText('Advion Ant Bait Gel'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Unit for Advion Ant Bait Gel'), { target: { value: 'g' } });
    fireEvent.change(screen.getByLabelText('Taurus SC'), { target: { value: '6' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true);
    });
    const body = JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
    expect(body.products.find((p) => p.productId === 'extra')).toMatchObject({ totalAmount: 30, amountUnit: 'g' });
    expect(body.products.find((p) => p.productId === 'taurus')).toMatchObject({ totalAmount: 6, amountUnit: 'oz' });
  });
});
