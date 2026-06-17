// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LawnReportViewPage from './LawnReportViewPage';

function renderAt(token = 'abc123') {
  return render(
    <MemoryRouter initialEntries={[`/lawn-report/${token}`]}>
      <Routes>
        <Route path="/lawn-report/:token" element={<LawnReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const REPORT = {
  first_name: 'Dana',
  city: 'Venice',
  overall_status: 'Keep an eye on it',
  summary: 'We saw stress along the sunny edge and treated it as suspected insect pressure.',
  primary_finding: 'Chinch bug pressure',
  confidence: 'moderate',
  findings: [{ name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', customer_note: 'Most consistent with suspected insect pressure.' }],
  watering: { customer_sequence: 'Water Wednesday and Saturday only.', restriction_summary: null },
  expectations: { weeds: null, fungus: null, insects: 'The key sign is whether the edge stops expanding.', turf_recovery: 'Thin turf recovers through new growth.' },
  watch_items: ['Watch the sunny edge for spread.'],
  seasonal_context: 'Peak season in SWFL.',
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LawnReportViewPage', () => {
  it('renders the prospect report from the public payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, report: REPORT }) })));
    renderAt();
    expect(await screen.findByText(/Here's what we saw at your Venice lawn/i)).toBeInTheDocument();
    expect(screen.getByText(REPORT.summary)).toBeInTheDocument();
    expect(screen.getByText('Chinch bug pressure')).toBeInTheDocument();
    expect(screen.getByText('Water Wednesday and Saturday only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /get my free lawn plan/i })).toBeInTheDocument();
  });

  it('shows a friendly not-available state on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Report not found' }) })));
    renderAt();
    expect(await screen.findByText(/isn't available/i)).toBeInTheDocument();
  });

  it('validates the quote form before submitting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, report: { ...REPORT, first_name: '' } }) })));
    renderAt();
    const btn = await screen.findByRole('button', { name: /get my free lawn plan/i });
    fireEvent.click(btn);
    expect(await screen.findByRole('alert')).toHaveTextContent(/add your name/i);
  });
});
