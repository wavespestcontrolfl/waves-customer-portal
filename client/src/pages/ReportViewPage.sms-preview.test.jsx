// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// GATE_REPORT_PHOTO_CONTENT (owner spec 2026-09-27): the MMS preview card
// (SmsReportPreview, mode=sms_preview) composites one photo thumbnail only
// when the server-set reportPhotoContentEnabled flag is true AND at least
// one resolvable photo is present — mirrors ReportViewPage.render.test.jsx's
// full-render pattern.
function renderPreview(payload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
  );
  // ReportViewPage reads its render mode from the REAL window.location.search
  // (not the router's own virtual location — see its `mode` useMemo), so the
  // query string has to be set on window directly; MemoryRouter only supplies
  // useParams()'s :token.
  window.history.pushState({}, '', '/report/test-legacy-lawn?mode=sms_preview');
  return render(
    <MemoryRouter initialEntries={['/report/test-legacy-lawn?mode=sms_preview']}>
      <Routes>
        <Route path="/report/:token" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch { /* jsdom localStorage may be unavailable in this runner */ }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SmsReportPreview photo thumbnail', () => {
  it('gate on + a photo present → renders the first photo as a thumbnail', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      photos: [
        { id: 'photo-1', url: 'https://cdn.example/photo-1.jpg', caption: 'Front bed treated.' },
        { id: 'photo-2', url: 'https://cdn.example/photo-2.jpg', caption: 'Back bed treated.' },
      ],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-photo img')).toBeTruthy());
    const img = document.querySelector('.sms-preview-photo img');
    expect(img.getAttribute('src')).toBe('https://cdn.example/photo-1.jpg');
    expect(screen.getByText('Front bed treated.')).toBeInTheDocument();
    expect(screen.queryByText('Back bed treated.')).toBeNull();
  });

  it('gate off → no thumbnail even with photos present', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: false,
      photos: [{ id: 'photo-1', url: 'https://cdn.example/photo-1.jpg', caption: 'Front bed treated.' }],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-card')).toBeTruthy());
    expect(document.querySelector('.sms-preview-photo')).toBeNull();
  });

  it('gate on + no photos → no thumbnail', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      photos: [],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-card')).toBeTruthy());
    expect(document.querySelector('.sms-preview-photo')).toBeNull();
  });

  it('gate on + only an unresolved photo URL → skips it rather than rendering a broken image', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      photos: [{ id: 'photo-1', url: null, caption: 'Front bed treated.' }],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-card')).toBeTruthy());
    expect(document.querySelector('.sms-preview-photo')).toBeNull();
  });
});
