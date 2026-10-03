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

// The rate review is the same component on its own route, with rate lines
// shown as the label states them.
describe('ProductLabelReview rates', () => {
  const rateDraft = {
    id: 'rate-candidate-1',
    source: { productName: 'Synthetic product', registration: 'TEST-100', url: 'https://example.test/label.pdf' },
    facts: { directions: [
      { status: 'rate', useSite: 'Outdoor perimeter', targets: 'Ants, spiders', method: 'Coarse spray', basis: 'per_gallon', low: 0.2, high: 0.8, unit: 'fl_oz', maxApplicationsPerYear: 2, minIntervalDays: 21, quote: 'Synthetic label: 0.2 to 0.8 fl oz per gallon.', page: 4, note: '' },
      { status: 'conditional', useSite: 'Turf', targets: 'Listed pests', method: '', basis: 'other', low: null, high: null, unit: 'other', maxApplicationsPerYear: null, minIntervalDays: null, quote: 'Synthetic label: see rate table.', page: 7, note: 'Rate table by pest.' },
    ] },
  };
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => ({ ok: true, json: async () => (options.method === 'POST' ? {} : { review: { draft: rateDraft } }) })));
  });
  const mountRates = () => render(<UiSurface density="comfortable"><ProductLabelReview product={product} kind="rates" /></UiSurface>);

  it('shows each label line with its amount, limits and source page, and no amount for a conditional line', async () => {
    mountRates();
    expect(await screen.findByText('0.2–0.8 fl oz per gallon')).toBeInTheDocument();
    expect(screen.getByText('Ants, spiders · Coarse spray · Max 2 applications per year · At least 21 days apart')).toBeInTheDocument();
    expect(screen.getByText('CONDITIONAL')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source page 4' })).toHaveAttribute('href', 'https://example.test/label.pdf#page=4');
    expect(fetch.mock.calls[0][0]).toBe('/api/admin/inventory/fixture-product/label-rate-review');
  });

  it('approves on the rate route only after source confirmation', async () => {
    mountRates();
    const approve = await screen.findByRole('button', { name: 'Approve rate lines' });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(approve);
    await screen.findByText('Review saved.');
    const sent = fetch.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('/api/admin/inventory/fixture-product/label-rate-review/decision');
    expect(JSON.parse(sent[0][1].body)).toEqual({ candidateId: 'rate-candidate-1', decision: 'approve', identityConfirmed: true });
  });
});

