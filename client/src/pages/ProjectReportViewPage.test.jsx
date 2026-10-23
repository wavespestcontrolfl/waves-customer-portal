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

describe('ProjectReportViewPage greeting', () => {
  it('greets a blank-first-name customer "Hi there", not their surname', async () => {
    const { findByRole } = renderProjectReport(payload('termite_treatment', { customerName: 'Example', customerFirstName: null }));
    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/^Hi there,/);
    expect(heading.textContent).not.toContain('Example');
  });

  it('greets by the customer\'s own first name', async () => {
    const { findByRole } = renderProjectReport(payload('termite_treatment', { customerName: 'Sample Example', customerFirstName: 'Sample' }));
    expect((await findByRole('heading', { level: 1 })).textContent).toMatch(/^Hi Sample,/);
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
  it.each(['termite_treatment', 'flea', 'rodent_bait_station'])(
    'a %s report the server marks poisonControl carries the tappable Poison Control line',
    async (projectType) => {
      const { findByTestId } = renderProjectReport(payload(projectType, { poisonControl: true }));
      const card = await findByTestId('project-poison-control');
      const link = card.querySelector('a[href="tel:+18002221222"]');
      expect(link).not.toBeNull();
      expect(link.textContent).toBe('1-800-222-1222');
      // project findings list no products, so the line never points at one
      expect(card.textContent).not.toMatch(/names each product/);
    },
  );

  it.each([
    ['flea', { poisonControl: false }],
    ['termite_treatment', {}],
    ['wdo_inspection', {}],
    ['pre_treatment_termite_certificate', {}],
  ])('a %s report without the server verdict carries no Poison Control line', async (projectType, extra) => {
    const { findAllByText, container } = renderProjectReport(payload(projectType, extra));
    await findAllByText(/this report is provided for your records|certificate of compliance/i);
    expect(container.querySelector('[data-testid="project-poison-control"]')).toBeNull();
    expect(container.querySelector('a[href="tel:+18002221222"]')).toBeNull();
  });

  it('names the tech who performed the visit, not the project creator, beside the FDACS ID', async () => {
    const { findByTestId } = renderProjectReport(payload('flea', {
      poisonControl: true,
      technicianName: 'Office Admin',
      applicatorName: 'Alex',
      applicatorFdacsId: 'JE000001',
    }));
    expect((await findByTestId('project-applicator-id')).textContent).toBe('Applicator: Alex · FDACS ID card #JE000001');
  });

  it('prints no applicator line when the server withholds the number', async () => {
    const { findByTestId, container } = renderProjectReport(payload('flea', { poisonControl: true, applicatorFdacsId: null }));
    await findByTestId('project-poison-control');
    expect(container.querySelector('[data-testid="project-applicator-id"]')).toBeNull();
  });

  // Owner ask 2026-09-28: every report links to the public Products & Safety
  // page from its closing strip, treatment evidence or not.
  it.each([true, false])('links to the public Products & Safety page (poisonControl %s)', async (poisonControl) => {
    const { findByRole } = renderProjectReport(payload('flea', { poisonControl }));
    const link = await findByRole('link', { name: /see every product we use and our safety protocol/i });
    expect(link.closest('footer')).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://www.wavespestcontrol.com/products-and-safety/#safety-protocol');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('ProjectReportViewPage pre-treat sticker (GATE_PRETREAT_STICKER_REPORT)', () => {
  const findings = {
    treatment_address: '100 Sample Way, Testville, FL 34000',
    lot_block: 'Lot 3',
    permit_number: 'TEST-PERMIT-1',
    treatment_date: '2026-06-28',
    product_name: 'Termidor SC',
    active_ingredient: 'Fipronil',
    epa_registration: '7969-210',
    square_footage: '2450',
    gallons_applied: '392',
    concentration_pct: '0.06',
    applicator_name: 'Alex Tester',
    applicator_fdacs_id: 'JE000000',
  };

  it('gate off: the field-grid certificate renders and no sticker', async () => {
    const { findAllByText, queryByTestId } = renderProjectReport(
      payload('pre_treatment_termite_certificate', { findings }),
    );
    await findAllByText(/Pre-Construction Termite Protection/i);
    expect(queryByTestId('termite-notice-sticker')).not.toBeInTheDocument();
  });

  it('gate on: the notice fills the label blanks; slab-day final exterior line stays empty', async () => {
    const { findByTestId, getByText, queryByText } = renderProjectReport(
      payload('pre_treatment_termite_certificate', { findings, pretreatStickerReport: true }),
    );
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).toHaveTextContent('Notice of Termite Protection');
    expect(sticker).toHaveTextContent('06/28/2026');
    expect(sticker).toHaveTextContent('Termidor SC / Fipronil');
    expect(sticker).toHaveTextContent('2,450 sq ft');
    expect(sticker).toHaveTextContent('392 gal');
    expect(sticker).toHaveTextContent('0.06%');
    expect(sticker).not.toHaveTextContent('Date of WDO Inspection');
    // The details block keeps what the label has no blank for.
    expect(getByText('Treatment Record Details')).toBeInTheDocument();
    expect(getByText(/EPA Reg\. 7969-210/)).toBeInTheDocument();
    expect(queryByText('Pre-Construction Termite Protection')).not.toBeInTheDocument();
  });

  it('gate on: a recorded final exterior visit prints on its own line', async () => {
    const { findByTestId } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: {
        ...findings,
        final_exterior_date: '2026-09-14',
        final_exterior_product: 'Termidor SC',
        final_exterior_active_ingredient: 'Fipronil',
      },
    }));
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).toHaveTextContent('09/14/2026');
  });

  it('gate on: the notice carries its WV-001 form stamp and the retreatment-contract clause', async () => {
    const { findByTestId } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: { ...findings, warranty_type: 'Renewable 5-year retreatment bond' },
    }));
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).toHaveTextContent('WV-001');
    expect(sticker).toHaveTextContent('placed under a retreatment contract');
    expect(sticker).toHaveTextContent('Activate your termite warranty');
  });

  it('gate on: the builder 1-year renewable to year 5 (Rule 5E-14.105(3)) states the renewable contract', async () => {
    const { findByTestId } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: { ...findings, warranty_type: 'Builder 1-year, renewable yearly to year 5' },
    }));
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).toHaveTextContent('placed under a retreatment contract renewable by payment of an annual fee');
    expect(sticker).toHaveTextContent('Activate your termite warranty');
  });

  it('gate on: a legacy builder 1-year warranty keeps the call to action but makes no renewable-contract claim', async () => {
    const { findByTestId } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: { ...findings, warranty_type: 'Builder 1-year' },
    }));
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).not.toHaveTextContent('retreatment contract');
    expect(sticker).toHaveTextContent('Activate your termite warranty');
  });

  it('gate off: the certificate stays today\'s document even with final exterior values stored', async () => {
    const { findAllByText, queryByText } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      findings: {
        ...findings,
        applicator_attestation: 'I am the licensed Florida applicator who performed the treatment described above.',
        final_exterior_date: '2026-09-14',
        final_exterior_product: 'Termidor SC',
      },
    }));
    await findAllByText(/Pre-Construction Termite Protection/i);
    expect(queryByText(/Final exterior treatment/i)).not.toBeInTheDocument();
    expect(queryByText(/covers the initial treatment only/)).not.toBeInTheDocument();
  });

  it('gate on: "No warranty" drops the contract clause and the warranty call to action', async () => {
    const { findByTestId } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: { ...findings, warranty_type: 'No warranty' },
    }));
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).not.toHaveTextContent('retreatment contract');
    expect(sticker).not.toHaveTextContent('Activate your termite warranty');
    expect(sticker).not.toHaveTextContent('wavespestcontrol.com/register');
    // FBC 105.11: every notice names the need for reinspection and contract renewal.
    expect(sticker).toHaveTextContent('Annual reinspection and renewal of the treatment contract are needed');
    expect(sticker).toHaveTextContent('Posted per FL Building Code 105.11');
  });

  it('gate on: an addition to an existing building reads like "No warranty" (Rule 5E-14.105(3)(d))', async () => {
    const { findByTestId } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: { ...findings, warranty_type: 'Addition to an existing building (no warranty required)' },
    }));
    const sticker = await findByTestId('termite-notice-sticker');
    expect(sticker).not.toHaveTextContent('retreatment contract');
    expect(sticker).not.toHaveTextContent('Activate your termite warranty');
    expect(sticker).not.toHaveTextContent('wavespestcontrol.com/register');
  });

  it('gate on: a later exterior visit gets its own record line and the signature is scoped to the initial treatment', async () => {
    const { findByText, getByText } = renderProjectReport(payload('pre_treatment_termite_certificate', {
      pretreatStickerReport: true,
      findings: {
        ...findings,
        applicator_attestation: 'I am the licensed Florida applicator who performed the treatment described above.',
        final_exterior_date: '2026-09-14',
        final_exterior_time: '09:30',
        final_exterior_product: 'Termidor SC',
        final_exterior_active_ingredient: 'Fipronil',
        final_exterior_applicator_name: 'Sam Example',
      },
    }));
    expect(await findByText('09/14/2026 9:30 AM · Termidor SC / Fipronil · applied by Sam Example')).toBeInTheDocument();
    expect(getByText(/This signature covers the initial treatment only\./)).toBeInTheDocument();
  });
});
