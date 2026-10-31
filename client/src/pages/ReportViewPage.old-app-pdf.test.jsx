// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import pestReportV2 from './__fixtures__/pest-report-v2.json';

// Regression: in an app built before the Filesystem/Share plugins (2026-07-07)
// the report's Download PDF was a bare <a download> that covered the app with
// the PDF and left no way back.
const shell = vi.hoisted(() => ({ native: false, plugins: false }));
vi.mock('../native/nativeFile', async (importOriginal) => ({
  ...(await importOriginal()),
  isNativeApp: () => shell.native,
  canSaveNative: () => shell.native && shell.plugins,
}));

function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/test-old-app-pdf']}>
      <Routes>
        <Route path="/report/:token" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // jsdom in this runner ships without a usable localStorage; the page reads a
  // staff token from it on mount.
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cases = [
  ['a web browser shows it', false, false, true],
  ['the current app shows it', true, true, true],
  ['an app built before the save plugins hides it', true, false, false],
];

describe('ReportViewPage Download PDF in the report tools', () => {
  it.each(cases)('%s', async (_label, native, plugins, shown) => {
    shell.native = native;
    shell.plugins = plugins;
    renderReport({ ...structuredClone(pestReportV2), pdfUrl: '/api/reports/test-old-app-pdf/pdf' });
    const tools = await screen.findByRole('region', { name: 'Report tools' });
    const download = within(tools).queryByRole('link', { name: 'Download PDF' });
    if (shown) expect(download).toBeInTheDocument();
    else {
      expect(download).not.toBeInTheDocument();
      expect(within(tools).queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
    }
  });
});

describe('ReportViewPage Download PDF on an older (pre-v1) report', () => {
  it.each(cases)('%s', async (_label, native, plugins, shown) => {
    shell.native = native;
    shell.plugins = plugins;
    renderReport({ serviceType: 'Pest Control', serviceDate: '2026-10-01', customerName: 'Pat Example', technicianName: 'Sam' });
    await screen.findByText('Report details');
    const download = screen.queryByRole('link', { name: 'Download PDF' });
    if (shown) expect(download).toBeInTheDocument();
    else expect(download).not.toBeInTheDocument();
  });
});
