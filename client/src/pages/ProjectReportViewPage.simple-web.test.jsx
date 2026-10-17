// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectReportViewPage from './ProjectReportViewPage';

// GATE_REPORT_SIMPLE_WEB (owner 2026-10-17: "skip wdo, and pre treatment, but for everything else the
// simple layout"): the server sets simpleWebReport on a project payload only while the gate is live and
// the type is not one of the two paper documents. The page then shows the work-order document.

const NARRATIVE = [
  'WHAT WE INSPECTED',
  'We checked the attic and the garage.',
  '',
  'WHAT WE FOUND',
  'Signs of activity near the garage door.',
  '',
  'WHAT WE RECOMMEND',
  'A follow-up visit to confirm the treatment held.',
].join('\n');

function payload(projectType, extra = {}) {
  return {
    projectType,
    simpleWebReport: true,
    status: 'sent',
    title: 'Synthetic project',
    customerName: 'Pat Tester',
    customerEmail: 'pat@example.test',
    customerPhone: '9415550100',
    customerAddress: '1 Test Way, Testville, FL 34000',
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-glass-theme');
});

describe('the simple project report', () => {
  it('shows the work-order document: title heading, customer and service blocks, footer, no glass', async () => {
    const { container } = renderProjectReport(payload('pest_inspection', {
      findings: { evidence_type: 'Droppings by the garage door', species: 'roof rat' },
    }));
    expect(await screen.findByRole('heading', { level: 1, name: 'PEST INSPECTION REPORT' })).toBeInTheDocument();
    expect(container.querySelector('.project-report-document')).not.toBeNull();
    expect(document.documentElement).not.toHaveAttribute('data-glass-theme');
    expect(screen.getByRole('heading', { level: 2, name: 'Customer' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Service' })).toBeInTheDocument();
    expect(container.textContent).toMatch(/Pat Tester/);
    expect(container.textContent).toMatch(/\(941\) 555-0100/);
    expect(container.textContent).toMatch(/pat@example\.test/);
    expect(container.textContent).toMatch(/Technician\s*Alex/);
    // findings, with the roof-rat note kept
    expect(screen.getByRole('heading', { level: 2, name: 'Findings' })).toBeInTheDocument();
    expect(container.textContent).toMatch(/Droppings by the garage door/);
    expect(container.textContent).toMatch(/Roof Rat/);
    expect(container.textContent).toMatch(/Roof rats are common climbers/);
    expect(container.textContent).toMatch(/This report is provided for your records/);
    // no Ask Waves, no review ask, no old hero
    expect(screen.queryByRole('region', { name: 'Share feedback' })).toBeNull();
    expect(container.textContent).not.toMatch(/Ask Waves/);
    expect(container.querySelector('.project-report-page')).toBeNull();
  });

  it('the print button calls window.print', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    renderProjectReport(payload('bed_bug'));
    fireEvent.click(await screen.findByRole('button', { name: /Print \/ Save as PDF/ }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('the narrative becomes section headings and replaces the raw findings list', async () => {
    const { container } = renderProjectReport(payload('pest_inspection', {
      recommendations: NARRATIVE,
      findings: { evidence_type: 'Raw finding text' },
    }));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('heading', { level: 2, name: 'What We Found' })).toBeInTheDocument();
    expect(container.textContent).toMatch(/Signs of activity near the garage door/);
    expect(container.textContent).not.toMatch(/Raw finding text/);
    expect(screen.queryByRole('heading', { level: 2, name: 'Findings' })).toBeNull();
  });

  it('the termite compliance block survives the narrative suppression', async () => {
    const { container } = renderProjectReport(payload('termite_treatment', {
      recommendations: NARRATIVE,
      findings: { percent_solution: '0.06%', epa_registration: '1234-56', posted_notice: 'Yes', treatment_method: 'Raw method text' },
    }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Application record' })).toBeInTheDocument();
    expect(container.textContent).toMatch(/Solution strength/);
    expect(container.textContent).toMatch(/0\.06%/);
    expect(container.textContent).toMatch(/EPA registration no\./);
    expect(container.textContent).not.toMatch(/Raw method text/);
  });

  it('internal finding keys never print', async () => {
    const { container } = renderProjectReport(payload('pest_inspection', {
      findings: { evidence_type: 'Synthetic evidence', inspection_fee: '$250' },
    }));
    await screen.findByRole('heading', { level: 1 });
    expect(container.textContent).toMatch(/Synthetic evidence/);
    expect(container.textContent).not.toMatch(/Inspection fee/);
  });

  it('prints Poison Control and the applicator line only when the server flags it', async () => {
    const flagged = renderProjectReport(payload('termite_treatment', { poisonControl: true, applicatorName: 'Alex', applicatorFdacsId: 'JE000000' }));
    expect(await screen.findByTestId('project-poison-control')).toBeInTheDocument();
    expect(screen.getByTestId('project-applicator-id')).toHaveTextContent('Applicator: Alex · FDACS ID card #JE000000');
    flagged.unmount();
    renderProjectReport(payload('termite_treatment'));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('project-poison-control')).toBeNull();
  });

  it('shows photos and the follow-up visit with its date and findings', async () => {
    const { container } = renderProjectReport(payload('bed_bug', {
      photos: [
        { id: 'a', category: 'damage', caption: 'Seam of the mattress', visit: 'primary', url: 'https://img.example.test/a.jpg' },
        { id: 'b', category: 'damage', caption: 'Headboard recheck', visit: 'followup', url: 'https://img.example.test/b.jpg' },
      ],
      followupCompletedAt: '2026-07-12T14:00:00Z',
      followupFindings: { evidence_level: 'None seen' },
    }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByAltText('Seam of the mattress')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Follow-up visit' })).toBeInTheDocument();
    expect(screen.getByAltText('Headboard recheck')).toBeInTheDocument();
    expect(container.textContent).toMatch(/July 12, 2026/);
    expect(container.textContent).toMatch(/Evidence level/);
    expect(container.textContent).toMatch(/None seen/);
  });

  it('keeps the upcoming appointment line', async () => {
    const { container } = renderProjectReport(payload('pest_inspection', {
      recommendations: NARRATIVE,
      upcomingAppointment: { serviceType: 'Follow-up', scheduledDate: '2026-07-20', windowStart: '09:00', technicianName: 'Alex' },
    }));
    await screen.findByRole('heading', { level: 1 });
    expect(container.textContent).toMatch(/Upcoming appointment:/);
    expect(container.textContent).toMatch(/Follow-up/);
  });
});

describe('the project report without the simple layout', () => {
  it('without the key: the glass page renders, as before', async () => {
    const { container } = renderProjectReport(payload('termite_treatment', { simpleWebReport: undefined }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-glass-theme'));
    expect(await screen.findByRole('heading', { level: 3, name: "How did today's visit go?" })).toBeInTheDocument();
    expect(container.querySelector('.project-report-document')).toBeNull();
  });

  it.each(['wdo_inspection', 'pre_treatment_termite_certificate'])('%s with the key still renders the old page', async (projectType) => {
    const { container } = renderProjectReport(payload(projectType));
    await screen.findAllByText(projectType === 'wdo_inspection' ? /wdo inspection/i : /Certificate of Compliance/i);
    expect(container.querySelector('.project-report-document')).toBeNull();
    expect(container.querySelector('.project-report-page')).not.toBeNull();
    expect(document.documentElement).not.toHaveAttribute('data-glass-theme');
  });
});
