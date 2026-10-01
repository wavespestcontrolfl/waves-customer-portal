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
});
