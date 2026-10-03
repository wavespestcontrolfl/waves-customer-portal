// @vitest-environment jsdom
// Notice page v2: an annual rate review notice renders the letter as sent
// (per line old → new rate, change, effective date, the reason, the cost
// block, what stays the same); a legacy notice keeps the original page.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));

import PriceChangeNoticePage from './PriceChangeNoticePage';

const TOKEN = 'a'.repeat(32);

function renderWith(body) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => body });
  return render(
    <MemoryRouter initialEntries={[`/price-change/${TOKEN}`]}>
      <Routes><Route path="/price-change/:token" element={<PriceChangeNoticePage />} /></Routes>
    </MemoryRouter>,
  );
}

const legacy = { firstName: 'Testcust', currentPrice: '$39', newPrice: '$42', cadenceLabel: 'month', effectiveDate: 'December 10, 2026', supportPhone: '(941) 555-0100' };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('PriceChangeNoticePage v2', () => {
  it('renders an annual rate review notice from the frozen letter', async () => {
    renderWith({
      ...legacy,
      review: {
        firstName: 'Testcust', costBlock: 'Technician pay is up [test]%.', hasPrepay: false,
        lines: [{ service: 'Pest control', unit: 'application', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026', firstLabel: 'First application at the new rate', first: 'December 10, 2026', why: 'At $117 per application, that is below what we charge a new customer.' }],
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your rate from December 10, 2026' })).toBeInTheDocument();
    expect(screen.getByText('$121 / application')).toBeInTheDocument();
    expect(screen.getByText('$117 / application')).toBeInTheDocument();
    expect(screen.getByText('up $4')).toBeInTheDocument();
    // the policy floor is 30 days (a notice delivered exactly 30 days ahead is valid): never "more than"
    expect(document.body.textContent).toMatch(/written notice, at least 30 days ahead/);
    expect(document.body.textContent).not.toMatch(/more than 30 days/);
    expect(screen.getByText('Technician pay is up [test]%.')).toBeInTheDocument();
    expect(screen.getByText(/below what we charge a new customer/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open my portal' })).toHaveAttribute('href', '/');
    expect(document.body.textContent).not.toMatch(/per visit|monthly|An update to your recurring service/i);
  });

  it('prepaid lines show per year and per application', async () => {
    renderWith({
      ...legacy,
      review: {
        firstName: 'Testcust', costBlock: 'Costs.', hasPrepay: true,
        lines: [{ service: 'Pest control', unit: 'year', current: '$468', next: '$484', change: '$16', perApplicationCurrent: '$117', perApplicationNext: '$121', effectiveDate: 'May 15, 2027', firstLabel: 'Your current prepaid year', first: 'unchanged through May 14, 2027', why: 'This change keeps pace with the costs above.' }],
      },
    });
    expect(await screen.findByText('$484 / year ($121 / application)')).toBeInTheDocument();
    expect(screen.getByText('$468 / year ($117 / application)')).toBeInTheDocument();
    expect(screen.getByText('unchanged through May 14, 2027')).toBeInTheDocument();
  });

  it('a legacy notice keeps the original page', async () => {
    renderWith(legacy);
    expect(await screen.findByRole('heading', { level: 1, name: 'An update to your recurring service' })).toBeInTheDocument();
  });

  it.each([
    ['per application', { unit: 'application', firstLabel: 'First application at the new rate', first: 'on or after December 10, 2026' }, /Any application completed before the new-rate date is billed at your current rate\./],
    ['monthly dues', { unit: 'month', firstLabel: 'First month at the new rate', first: 'on or after December 15, 2026' }, /Your monthly dues stay at your current amount through the month before the new-rate date\./],
    ['prepaid until renewal', { unit: 'year', firstLabel: 'Your current prepaid year', first: 'unchanged through May 14, 2027', perApplicationCurrent: '$117', perApplicationNext: '$121' }, /Your prepaid plan stays exactly as it is until it renews\./],
  ])('the assurance is true for %s: copy by billing unit', async (_lane, line, expected) => {
    renderWith({
      ...legacy,
      review: { firstName: 'Testcust', costBlock: 'Costs.', hasPrepay: line.unit === 'year', lines: [{ service: 'Pest control', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026', why: 'Reason.', ...line }] },
    });
    await screen.findByRole('heading', { level: 1 });
    expect(document.body.textContent).toMatch(expected);
    if (line.unit !== 'application') expect(document.body.textContent).not.toMatch(/Any application completed before the new-rate date/);
  });

  it('a mixed letter (several lanes) gets the one sentence true for all three', async () => {
    renderWith({
      ...legacy,
      review: { firstName: 'Testcust', costBlock: 'Costs.', hasPrepay: true, lines: [
        { service: 'Pest control', unit: 'application', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026', why: 'R.', firstLabel: 'f', first: 'x' },
        { service: 'Lawn care', unit: 'month', current: '$40', next: '$44', change: '$4', effectiveDate: 'December 15, 2026', why: 'R.', firstLabel: 'f', first: 'x' },
      ] },
    });
    await screen.findByRole('heading', { level: 1 });
    expect(document.body.textContent).toMatch(/applications completed before it are billed at your current rate, monthly dues stay at your current amount through the month before it, and a prepaid plan stays exactly as it is until it renews/);
  });

  it('the heading does not claim one date for a letter whose lines start on different dates; a single-date letter keeps it', async () => {
    renderWith({
      ...legacy,
      review: { firstName: 'Testcust', costBlock: 'Costs.', hasPrepay: false, lines: [
        { service: 'Pest control', unit: 'application', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026', why: 'R.', firstLabel: 'f', first: 'x' },
        { service: 'Lawn care', unit: 'month', current: '$40', next: '$44', change: '$4', effectiveDate: 'December 20, 2026', why: 'R.', firstLabel: 'f', first: 'x' },
      ] },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your rates are changing' })).toBeInTheDocument();
    cleanup();
    renderWith({
      ...legacy,
      review: { firstName: 'Testcust', costBlock: 'Costs.', hasPrepay: false, lines: [
        { service: 'Pest control', unit: 'application', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026', why: 'R.', firstLabel: 'f', first: 'x' },
        { service: 'Lawn care', unit: 'application', current: '$40', next: '$44', change: '$4', effectiveDate: 'December 10, 2026', why: 'R.', firstLabel: 'f', first: 'x' },
      ] },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your rate from December 10, 2026' })).toBeInTheDocument();
  });
});
