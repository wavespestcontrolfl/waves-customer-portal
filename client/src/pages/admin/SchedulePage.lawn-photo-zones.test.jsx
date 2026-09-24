// @vitest-environment jsdom
// Owner ruling 2026-09-24: the lawn completion photo capture gets an
// optional per-photo slot picker (Front / Close-up / Trouble / watch area).
// All optional, no count requirement; only one photo may hold "front" at a
// time. Kept in its own file (rather than the large SchedulePage.lawn-closeout
// suite) so it doesn't need that file's full treatment-plan fetch harness.
// CompletionPanel renders through a portal (createPortal), so queries go
// through `screen` (bound to document.body), never `render()`'s `container`.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompletionPanel } from './SchedulePage';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const service = {
  id: 'zone-test-visit',
  customerId: 'zone-test-property',
  serviceType: 'One-Time Lawn Care Service',
  completionProfile: { serviceKey: 'lawn', requiresProducts: true },
  scheduledDate: '2026-09-24',
  waveguardTier: null,
  status: 'on_site',
  price: 0,
};

let assessRequests;

class FixtureFileReader {
  readAsDataURL() {
    // readLawnAssessmentPhoto reads `reader.result` directly (not the event
    // argument), so the fixture must set it on the instance.
    this.result = 'data:image/jpeg;base64,cGhvdG8=';
    this.onload({ target: { result: this.result } });
  }
}
class FixtureImage {
  set src(_value) {
    this.width = 800;
    this.height = 600;
    this.onload();
  }
}

beforeEach(async () => {
  assessRequests = [];
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('FileReader', FixtureFileReader);
  vi.stubGlobal('Image', FixtureImage);
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: {} };
    if (url.includes('turf-profile')) data = { profile: {} };
    // No existing assessment — the photo capture UI (not the score cards)
    // is what's under test here.
    if (url.includes('lawn-assessment/service/')) data = {};
    if (url.includes('lawn-assessment/history')) data = { history: [] };
    if (url.includes('lawn-assessment/assess')) {
      assessRequests.push(JSON.parse(options.body));
      data = {
        success: true,
        assessment: { id: 'assessment-zone-test' },
        visitAssessment: { status: 'complete', findings: [], photoQuality: [] },
        adjustedScores: { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 },
        observations: 'Synthetic observations',
      };
    }
    if (url.includes('treatment-plans')) data = { plan: { protocol: {} } };
    if (url.includes('tech-tips')) data = { available: false, groups: [] };
    if (url.includes('completion-actions')) data = { actions: [] };
    if (url.includes('property-map')) data = { available: false, stationsLoaded: true };
    return { ok: true, json: async () => data };
  }));
  await refetchFlags();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = () => render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={vi.fn()} />);

it('offers Front / Close-up / Trouble on each photo, all optional', async () => {
  mount();
  const fileInput = await screen.findByLabelText('Add turf photos');
  const file = new File(['photo'], 'lawn.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [file] } });
  const select = await screen.findByLabelText('Slot for photo 1');
  expect(Array.from(select.options).map((option) => option.textContent))
    .toEqual(['No slot', 'Front', 'Close-up', 'Trouble / watch area']);
  expect(select.value).toBe('');
});

it('only one photo may hold the Front slot at a time', async () => {
  mount();
  const fileInput = await screen.findByLabelText('Add turf photos');
  const files = [
    new File(['photo1'], 'a.jpg', { type: 'image/jpeg' }),
    new File(['photo2'], 'b.jpg', { type: 'image/jpeg' }),
  ];
  fireEvent.change(fileInput, { target: { files } });
  const select1 = await screen.findByLabelText('Slot for photo 1');
  const select2 = await screen.findByLabelText('Slot for photo 2');
  fireEvent.change(select1, { target: { value: 'front' } });
  expect(select1.value).toBe('front');
  fireEvent.change(select2, { target: { value: 'front' } });
  expect(select2.value).toBe('front');
  expect(select1.value).toBe('');
});

it('sends zone only for photos with a picked slot, and omits it otherwise', async () => {
  mount();
  const fileInput = await screen.findByLabelText('Add turf photos');
  const files = [
    new File(['photo1'], 'a.jpg', { type: 'image/jpeg' }),
    new File(['photo2'], 'b.jpg', { type: 'image/jpeg' }),
  ];
  fireEvent.change(fileInput, { target: { files } });
  fireEvent.change(await screen.findByLabelText('Slot for photo 1'), { target: { value: 'trouble' } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
  await waitFor(() => expect(assessRequests).toHaveLength(1));
  expect(assessRequests[0].photos).toEqual([
    { data: 'cGhvdG8=', mimeType: 'image/jpeg', zone: 'trouble' },
    { data: 'cGhvdG8=', mimeType: 'image/jpeg' },
  ]);
});
