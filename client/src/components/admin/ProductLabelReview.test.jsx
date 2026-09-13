// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import ProductLabelReview from './ProductLabelReview';
import { UiSurface } from '../ui';
const product = { id: 'fixture-product', name: 'Synthetic product', formulation: 'Liquid', epaRegNumber: 'TEST-100' };
const draft = { id: 'candidate-1', source: { productName: 'Synthetic product', registration: 'TEST-100', url: 'https://example.test/label.pdf' }, facts: Object.fromEntries(['minTempF','maxTempF','maxWindMph','rainFreeHours'].map(key => [key, { status: 'not_stated' }])) };
let failWrite;
beforeEach(() => {
  failWrite = false;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options.method === 'POST' && failWrite) return { ok: false, json: async () => ({ error: 'Synthetic review failed' }) };
    return { ok: true, json: async () => options.method === 'POST' ? {} : ({ review: { draft } }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<UiSurface density="comfortable"><ProductLabelReview product={product} /></UiSurface>);
const posts = () => fetch.mock.calls.filter(([,options]) => options.method === 'POST');
describe('ProductLabelReview decisions', () => {
  it('requires source confirmation and sends the same explicit approval payload', async () => {
    mount();
    const approve = await screen.findByRole('button', { name: 'Approve weather facts' });
    expect(approve).toBeDisabled();
    fireEvent.click(approve); expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(approve);
    await screen.findByText(/Review saved/);
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe('/api/admin/inventory/fixture-product/label-review/decision');
    expect(JSON.parse(posts()[0][1].body)).toEqual({ candidateId: 'candidate-1', decision: 'approve', identityConfirmed: true });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
  it('retains confirmation and candidate after a failed approval so retry remains deliberate', async () => {
    failWrite = true; mount();
    const approve = await screen.findByRole('button', { name: 'Approve weather facts' });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(approve);
    await screen.findByRole('alert');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByText('CANDIDATE · NOT YET ACTIVE')).toBeInTheDocument();
    failWrite = false; fireEvent.click(approve);
    await screen.findByText(/Review saved/); expect(posts()).toHaveLength(2);
  });
  it('rejects the candidate without incorrectly asserting identity confirmation', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Reject candidate' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ candidateId: 'candidate-1', decision: 'reject' });
  });
});
