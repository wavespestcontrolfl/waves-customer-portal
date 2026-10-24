// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PestReportViewPage from './PestReportViewPage';

function renderAt(token = 'abc123') {
  return render(
    <MemoryRouter initialEntries={[`/pest-report/${token}`]}>
      <Routes>
        <Route path="/pest-report/:token" element={<PestReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const REPORT = {
  first_name: 'Dana',
  city: 'Venice',
  identified: { label: 'Ghost Ants' },
  urgency: 'low',
  about: 'Ghost ants trail along counters looking for sweets and water.',
  safety: {},
};

function serve(body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PestReportViewPage shared customer header (GATE_REPORT_SHARED_TEMPLATE)', () => {
  it('shared template off (no key): the page keeps its own header', async () => {
    serve({ success: true, report: REPORT });
    const { container } = renderAt();
    expect(await screen.findByRole('heading', { level: 1, name: /Dana, here's what we identified/i })).toBeInTheDocument();
    expect(container.querySelector('.pest-report-page')).not.toHaveClass('customer-report-template');
    expect(container.querySelector('.report-header')).toBeNull();
  });

  it('shared template on (reportTemplate beside report): the template class and the shared header with the first name and city', async () => {
    serve({ success: true, report: REPORT, reportTemplate: true });
    const { container } = renderAt();
    expect(await screen.findByRole('heading', { level: 1, name: /Dana, here's what we identified/i })).toBeInTheDocument();
    expect(container.querySelector('.pest-report-page')).toHaveClass('customer-report-template');
    expect([...container.querySelectorAll('.report-header-contact > div')].map((line) => line.textContent)).toEqual(['Dana', 'Venice']);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
