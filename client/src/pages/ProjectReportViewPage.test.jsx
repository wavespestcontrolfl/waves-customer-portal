// @vitest-environment jsdom
// Theme gate for /report/project — official compliance documents render as
// the plain navy/beige paper (owner ruling 2026-07-16): WDO inspection
// reports join the pre-construction termite certificate in never mounting
// the glass scene. Every other project type keeps glass.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectReportViewPage from './ProjectReportViewPage';

function payload(projectType, extra = {}) {
  return {
    projectType,
    status: 'sent',
    title: '',
    customerName: 'Test Customer',
    serviceAddress: '123 Test St, Testville, FL 34000',
    technicianName: 'Alex',
    projectDate: '2026-06-28',
    sentAt: '2026-06-28T18:30:00Z',
    fdacsPdfAvailable: false,
    recommendations: null,
    followupDate: null,
    followupFindings: null,
    followupCompletedAt: null,
    upcomingAppointment: null,
    findings: {},
    photos: [],
    ...extra,
  };
}

function renderProjectReport(data) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => data })));
  return render(
    <MemoryRouter initialEntries={['/report/project/test-token-000']}>
      <Routes>
        <Route path="/report/project/:token" element={<ProjectReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-glass-theme');
});

describe('ProjectReportViewPage theme gate', () => {
  it('WDO inspection reports render as the paper document (no glass scene)', async () => {
    const { findAllByText, queryByRole } = renderProjectReport(payload('wdo_inspection'));
    await findAllByText(/wdo inspection/i);
    expect(document.documentElement).not.toHaveAttribute('data-glass-theme');
    expect(queryByRole('region', { name: 'Share feedback' })).not.toBeInTheDocument();
  });

  it('the pre-construction certificate stays the paper document', async () => {
    const { findAllByText, queryByRole } = renderProjectReport(payload('pre_treatment_termite_certificate'));
    await findAllByText(/Certificate of Compliance/i);
    expect(document.documentElement).not.toHaveAttribute('data-glass-theme');
    expect(queryByRole('region', { name: 'Share feedback' })).not.toBeInTheDocument();
  });

  it('a regular termite treatment report keeps the glass theme', async () => {
    const { findByRole } = renderProjectReport(payload('termite_treatment'));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-glass-theme');
    });
    expect(await findByRole('heading', { level: 3, name: "How did today's visit go?" })).toBeInTheDocument();
    expect(await findByRole('region', { name: 'Share feedback' }))
      .toHaveAttribute('data-section', 'review-request-project');
  });
});

describe('ProjectReportViewPage action bar — same four boxes on every report (owner rule 2026-07-16)', () => {
  it('shows Download / Share / Print / Portal Login even with no filed PDF (print-dialog fallback)', async () => {
    const { findByRole, getByRole } = renderProjectReport(payload('wdo_inspection', { fdacsPdfAvailable: false }));
    const download = await findByRole('button', { name: /download pdf/i });
    expect(download).toBeInTheDocument();
    expect(getByRole('button', { name: /share/i })).toBeInTheDocument();
    expect(getByRole('button', { name: /print/i })).toBeInTheDocument();
    expect(getByRole('link', { name: /portal login/i })).toBeInTheDocument();
  });

  it('a filed WDO report downloads the real FDACS PDF', async () => {
    const { findByRole } = renderProjectReport(payload('wdo_inspection', { fdacsPdfAvailable: true }));
    const download = await findByRole('link', { name: /download pdf/i });
    expect(download).toHaveAttribute('href', expect.stringContaining('/fdacs-pdf'));
  });
});

describe('ProjectReportViewPage Poison Control (owner 2026-09-26)', () => {
  it.each([
    ['termite_treatment', { products_used: 'Termidor SC' }],
    ['flea', { treatment_completed: 'Interior flea treatment' }],
    ['bed_bug', { treatment_method: 'Chemical only' }],
    ['one_time_lawn_treatment', { work_completed: 'Fertilizer applied' }],
    ['rodent_bait_station', {}],
  ])('a %s report that recorded an application carries the tappable Poison Control line', async (projectType, findings) => {
    const { findByTestId } = renderProjectReport(payload(projectType, { findings }));
    const card = await findByTestId('project-poison-control');
    const link = card.querySelector('a[href="tel:+18002221222"]');
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('1-800-222-1222');
    // project findings list no products, so the line never points at one
    expect(card.textContent).not.toMatch(/names each product/);
  });

  it.each([
    ['flea', { treatment_completed: 'Inspection only' }],
    ['one_time_lawn_treatment', { work_completed: 'Inspection completed' }],
    ['bed_bug', { treatment_method: 'Heat only' }],
    ['wdo_inspection', {}],
    ['pre_treatment_termite_certificate', {}],
    ['termite_inspection', {}],
    ['pest_inspection', {}],
    ['rodent_exclusion', {}],
    ['termite_bait_station', {}],
  ])('a %s report without a recorded application carries no Poison Control line', async (projectType, findings) => {
    const { findAllByText, container } = renderProjectReport(payload(projectType, { findings }));
    await findAllByText(/this report is provided for your records|certificate of compliance/i);
    expect(container.querySelector('[data-testid="project-poison-control"]')).toBeNull();
    expect(container.querySelector('a[href="tel:+18002221222"]')).toBeNull();
  });

  it('prints the applicator FDACS ID card number in the Poison Control card', async () => {
    const { findByTestId } = renderProjectReport(payload('flea', {
      findings: { treatment_completed: 'Exterior flea treatment' },
      applicatorFdacsId: 'JE000001',
    }));
    expect((await findByTestId('project-applicator-id')).textContent).toBe('Applicator: Alex · FDACS ID card #JE000001');
  });
});
