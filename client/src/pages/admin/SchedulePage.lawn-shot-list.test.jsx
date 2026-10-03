// @vitest-environment jsdom
// GATE_LAWN_SHOT_LIST (lawn report rebuild P18) on the lawn completion photo
// step. Gate on (the existing-assessment lookup answers shotListEnabled): the
// eight named shots with their one-line instruction, up to 8 photos, every
// photo tagged with its shot key, and a soft-minimum hint that never blocks.
// Gate off: the original three slots and 3-photo cap. Synthetic data only.
// CompletionPanel renders through a portal, so queries go through `screen`.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi, describe } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompletionPanel } from './SchedulePage';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const service = {
  id: 'shot-list-visit',
  customerId: 'shot-list-property',
  serviceType: 'One-Time Lawn Care Service',
  completionProfile: { serviceKey: 'lawn', requiresProducts: true },
  scheduledDate: '2026-10-03',
  waveguardTier: null,
  status: 'on_site',
  price: 0,
};

let assessRequests;
let shotListEnabled;

class FixtureFileReader {
  readAsDataURL() {
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
    // No assessment on file; the server only adds shotListEnabled when the gate is live.
    if (url.includes('lawn-assessment/service/')) data = shotListEnabled ? { shotListEnabled: true, assessment: null } : { assessment: null };
    if (url.includes('lawn-assessment/history')) data = { history: [] };
    if (url.includes('lawn-assessment/assess')) {
      assessRequests.push(JSON.parse(options.body));
      data = {
        success: true,
        assessment: { id: 'assessment-shot-list' },
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
const file = (name) => new File([name], `${name}.jpg`, { type: 'image/jpeg' });
const addFiles = async (names) => {
  const input = await screen.findByLabelText('Add turf photos');
  fireEvent.change(input, { target: { files: names.map(file) } });
};

describe('gate on', () => {
  beforeEach(() => { shotListEnabled = true; });

  it('lists the eight shots with their instruction, in order, before any photo is added', async () => {
    mount();
    const list = await screen.findByTestId('lawn-shot-list');
    const rows = Array.from(list.querySelectorAll('li'));
    expect(rows.map((row) => row.querySelector('div > div').textContent)).toEqual([
      'Front overview', 'Back overview', 'Side overview', 'Canopy close-up',
      'Blade and crown', 'Hot edge', 'Shadiest turf', 'Problem area',
    ]);
    expect(screen.getByTestId('lawn-shot-front').textContent).toMatch(/mailbox or driveway apron/);
    expect(screen.getByTestId('lawn-shot-blade_crown').textContent).toMatch(/Part the grass, 4 to 6 inches away/);
    expect(screen.getByText('0/8')).toBeTruthy();
  });

  it('shows the soft-minimum hint, names what is missing, and never blocks Analyze', async () => {
    mount();
    const hint = await screen.findByTestId('lawn-shot-list-hint');
    expect(hint.textContent).toBe(
      'Aim for at least 4 photos: front, back or side, canopy close-up, and blade and crown. Still needed: Front overview, Back overview or Side overview, Canopy close-up, Blade and crown. This is a guide only, and Analyze lawn works at any time.',
    );
    expect(screen.queryByTestId('lawn-photo-nudge')).toBeNull();
    await addFiles(['a']);
    await screen.findByLabelText('Slot for photo 1');
    // One untagged photo, minimum not met, and Analyze is still enabled.
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Slot for photo 1'), { target: { value: 'front' } });
    expect(screen.getByTestId('lawn-shot-list-hint').textContent).toMatch(/Still needed: Back overview or Side overview, Canopy close-up, Blade and crown\./);
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).disabled).toBe(false);
  });

  it('drops the hint once the four minimum shots are tagged', async () => {
    mount();
    await addFiles(['a', 'b', 'c', 'd']);
    await screen.findByLabelText('Slot for photo 4');
    ['front', 'side', 'close_up', 'blade_crown'].forEach((zone, i) => {
      fireEvent.change(screen.getByLabelText(`Slot for photo ${i + 1}`), { target: { value: zone } });
    });
    expect(screen.queryByTestId('lawn-shot-list-hint')).toBeNull();
    expect(screen.getByTestId('lawn-shot-front').textContent).toMatch(/\(added\)/);
    expect(screen.getByTestId('lawn-shot-back').textContent).not.toMatch(/\(added\)/);
  });

  it('offers the eight shots in each photo slot picker', async () => {
    mount();
    await addFiles(['a']);
    const select = await screen.findByLabelText('Slot for photo 1');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'No slot', 'Front overview', 'Back overview', 'Side overview', 'Canopy close-up',
      'Blade and crown', 'Hot edge', 'Shadiest turf', 'Problem area',
    ]);
  });

  it('accepts up to 8 photos and then stops adding', async () => {
    mount();
    await addFiles(['a', 'b', 'c', 'd', 'e']);
    await screen.findByLabelText('Slot for photo 5');
    expect(screen.getByText('5/8')).toBeTruthy();
    await addFiles(['f', 'g', 'h', 'i', 'j']);
    await screen.findByLabelText('Slot for photo 8');
    expect(screen.queryByLabelText('Slot for photo 9')).toBeNull();
    expect(screen.getByText('8/8')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add turf photos' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add photo for Front overview' }).disabled).toBe(true);
  });

  it("a shot's Add button brings the photo in already tagged with that shot", async () => {
    mount();
    const addBack = await screen.findByRole('button', { name: 'Add photo for Back overview' });
    const input = screen.getByLabelText('Add turf photos');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(addBack);
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [file('a')] } });
    const select = await screen.findByLabelText('Slot for photo 1');
    expect(select.value).toBe('back');
    // That shot now holds its photo, so its Add button is done.
    expect(screen.getByRole('button', { name: 'Add photo for Back overview' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add photo for Side overview' }).disabled).toBe(false);
  });

  it('one photo per shot (the newest pick wins) but two for a problem area', async () => {
    mount();
    await addFiles(['a', 'b', 'c']);
    await screen.findByLabelText('Slot for photo 3');
    fireEvent.change(screen.getByLabelText('Slot for photo 1'), { target: { value: 'back' } });
    fireEvent.change(screen.getByLabelText('Slot for photo 2'), { target: { value: 'back' } });
    expect(screen.getByLabelText('Slot for photo 1').value).toBe('');
    expect(screen.getByLabelText('Slot for photo 2').value).toBe('back');
    fireEvent.change(screen.getByLabelText('Slot for photo 1'), { target: { value: 'trouble' } });
    fireEvent.change(screen.getByLabelText('Slot for photo 3'), { target: { value: 'trouble' } });
    expect(screen.getByLabelText('Slot for photo 1').value).toBe('trouble');
    expect(screen.getByLabelText('Slot for photo 3').value).toBe('trouble');
  });

  it('sends every photo with its shot key and omits the zone on untagged photos', async () => {
    mount();
    await addFiles(['a', 'b', 'c', 'd', 'e']);
    await screen.findByLabelText('Slot for photo 5');
    fireEvent.change(screen.getByLabelText('Slot for photo 1'), { target: { value: 'front' } });
    fireEvent.change(screen.getByLabelText('Slot for photo 2'), { target: { value: 'hot_edge' } });
    fireEvent.change(screen.getByLabelText('Slot for photo 3'), { target: { value: 'blade_crown' } });
    fireEvent.change(screen.getByLabelText('Slot for photo 4'), { target: { value: 'shade' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await waitFor(() => expect(assessRequests).toHaveLength(1));
    expect(assessRequests[0].photos).toEqual([
      { data: 'cGhvdG8=', mimeType: 'image/jpeg', zone: 'front' },
      { data: 'cGhvdG8=', mimeType: 'image/jpeg', zone: 'hot_edge' },
      { data: 'cGhvdG8=', mimeType: 'image/jpeg', zone: 'blade_crown' },
      { data: 'cGhvdG8=', mimeType: 'image/jpeg', zone: 'shade' },
      { data: 'cGhvdG8=', mimeType: 'image/jpeg' },
    ]);
  });
});

describe('gate off', () => {
  beforeEach(() => { shotListEnabled = false; });

  it('keeps the original three slots, the 3-photo cap and the old nudge; no shot list', async () => {
    mount();
    await addFiles(['a']);
    const select = await screen.findByLabelText('Slot for photo 1');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['No slot', 'Front', 'Close-up', 'Trouble / watch area']);
    expect(screen.queryByTestId('lawn-shot-list')).toBeNull();
    expect(screen.queryByTestId('lawn-shot-list-hint')).toBeNull();
    expect(screen.getByTestId('lawn-photo-nudge').textContent).toMatch(/2 or 3 photos work best/);
    expect(screen.getByText('1/3')).toBeTruthy();
    await addFiles(['b', 'c', 'd', 'e']);
    await screen.findByLabelText('Slot for photo 3');
    expect(screen.queryByLabelText('Slot for photo 4')).toBeNull();
    expect(screen.getByText('3/3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add turf photos' }).disabled).toBe(true);
  });

  it('sends the same payload as before (zone only on a picked slot)', async () => {
    mount();
    await addFiles(['a', 'b']);
    fireEvent.change(await screen.findByLabelText('Slot for photo 1'), { target: { value: 'trouble' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await waitFor(() => expect(assessRequests).toHaveLength(1));
    expect(assessRequests[0].photos).toEqual([
      { data: 'cGhvdG8=', mimeType: 'image/jpeg', zone: 'trouble' },
      { data: 'cGhvdG8=', mimeType: 'image/jpeg' },
    ]);
  });
});
