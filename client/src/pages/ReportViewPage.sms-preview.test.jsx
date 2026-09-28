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
// when the server-set reportPhotoContentEnabled flag is true AND the
// server-computed previewPhoto field is present. previewPhoto is a
// SEPARATE, already-redacted field (reports-public.js) — the component must
// read ONLY previewPhoto for the thumbnail, never fall back to the raw
// (unredacted) photos array, even when photos[0] would otherwise look
// eligible. Mirrors ReportViewPage.render.test.jsx's full-render pattern.
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
  it('gate on + previewPhoto present → renders it as a thumbnail with its (already-redacted) caption', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      previewPhoto: { url: 'https://cdn.example/photo-1.jpg', caption: 'Front bed treated.' },
      // The full gallery may carry other/different photos — the thumbnail
      // must come from previewPhoto, never scan this array itself.
      photos: [
        { id: 'photo-2', url: 'https://cdn.example/photo-2.jpg', caption: 'Back bed treated.' },
      ],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-photo img')).toBeTruthy());
    const img = document.querySelector('.sms-preview-photo img');
    expect(img.getAttribute('src')).toBe('https://cdn.example/photo-1.jpg');
    expect(screen.getByText('Front bed treated.')).toBeInTheDocument();
    expect(screen.queryByText('Back bed treated.')).toBeNull();
  });

  it('gate on + previewPhoto.caption already redacted by the server → renders the redacted text verbatim, never the raw code', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      previewPhoto: { url: 'https://cdn.example/photo-1.jpg', caption: 'Lockbox [redacted] is by the front door.' },
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-photo img')).toBeTruthy());
    expect(screen.getByText('Lockbox [redacted] is by the front door.')).toBeInTheDocument();
  });

  it('gate off → no thumbnail even with previewPhoto present in the payload', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: false,
      previewPhoto: { url: 'https://cdn.example/photo-1.jpg', caption: 'Front bed treated.' },
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-card')).toBeTruthy());
    expect(document.querySelector('.sms-preview-photo')).toBeNull();
  });

  it('gate on + previewPhoto null (no eligible photo) → no thumbnail', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      previewPhoto: null,
      photos: [{ id: 'photo-1', url: 'https://cdn.example/photo-1.jpg', caption: 'Front bed treated.' }],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-card')).toBeTruthy());
    expect(document.querySelector('.sms-preview-photo')).toBeNull();
  });

  it('gate on + previewPhoto entirely absent from the payload → no thumbnail, no crash', async () => {
    renderPreview({
      ...legacyLawnReport,
      reportPhotoContentEnabled: true,
      photos: [{ id: 'photo-1', url: 'https://cdn.example/photo-1.jpg', caption: 'Front bed treated.' }],
    });
    await waitFor(() => expect(document.querySelector('.sms-preview-card')).toBeTruthy());
    expect(document.querySelector('.sms-preview-photo')).toBeNull();
  });
});
