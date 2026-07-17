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
    const { findAllByText } = renderProjectReport(payload('wdo_inspection'));
    await findAllByText(/wdo inspection/i);
    expect(document.documentElement).not.toHaveAttribute('data-glass-theme');
  });

  it('the pre-construction certificate stays the paper document', async () => {
    const { findAllByText } = renderProjectReport(payload('pre_treatment_termite_certificate'));
    await findAllByText(/Certificate of Compliance/i);
    expect(document.documentElement).not.toHaveAttribute('data-glass-theme');
  });

  it('a regular termite treatment report keeps the glass theme', async () => {
    renderProjectReport(payload('termite_treatment'));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-glass-theme');
    });
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
