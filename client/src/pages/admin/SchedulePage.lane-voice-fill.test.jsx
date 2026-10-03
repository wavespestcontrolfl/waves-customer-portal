// @vitest-environment jsdom
// Lane voice fill on the office Complete Service form (GATE_LANE_VOICE_FILL,
// Fast Complete step 2, owner "ok go" 2026-10-02 on the mockup v8): with the
// schedule's per-visit flag on, Generate AI report first reads the notes for
// the visit's own record (POST /admin/dispatch/:id/lane-facts) and fills
// only what nobody picked, the way a tap does, each field showing the words
// it came from; the report is then written from the filled record. A value
// that clashes with a pick is left for a person, and a failed read fills
// nothing and generates anyway. Off, Generate is exactly as before.
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

const BED_BUG = {
  id: 'lane-visit', customerId: 'lane-customer', customerName: 'Synthetic Customer',
  serviceType: 'Bed Bug Treatment', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
  completionProfile: { serviceKey: 'bed_bug_treatment' }, laneVoiceFillEnabled: true,
};
const FIRE_ANT = { ...BED_BUG, serviceType: 'Fire Ant Treatment', completionProfile: { serviceKey: 'fire_ant' } };
const NOTE = 'Second treatment. Treated the master bedroom and the living room couch, live ones on the couch seams. They had everything bagged.';
const READ = {
  available: true,
  status: 'read',
  lane: 'bed_bug_treatment',
  areas: [
    { area: 'Primary bedroom', quote: 'treated the master bedroom' },
    { area: 'Furniture / upholstery', quote: 'the living room couch' },
  ],
  findings: [
    { group: 'bed_bug_visit_stage', value: 'Scheduled follow-up treatment', quote: 'second treatment' },
    { group: 'bed_bug_evidence', value: 'Live adults', quote: 'live ones on the couch seams' },
    { group: 'bed_bug_prep', value: 'Preparation complete', quote: 'they had everything bagged' },
  ],
  unclearGroups: [],
};

let calls;
let laneAnswer;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  calls = [];
  laneAnswer = () => ({ ok: true, json: async () => READ });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('/lane-facts')) {
      calls.push({ kind: 'lane', body: JSON.parse(options.body) });
      return laneAnswer();
    }
    if (url.includes('generate-report')) {
      calls.push({ kind: 'generate', body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ report: 'WHAT WE DID\n\nTreated the bedroom.\n\nWHAT WE FOUND\n\nLive bed bugs.' }) };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openForm(service) {
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={vi.fn().mockResolvedValue({})} />);
  const notes = await screen.findByPlaceholderText('Notes about this service...');
  fireEvent.change(notes, { target: { value: NOTE } });
}
const groupSelect = (key) => document.getElementById(`cp-${key}`) || document.getElementById(`cp-${key}-mobile`);
async function generate() {
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(calls.some((call) => call.kind === 'generate')).toBe(true));
}
const generated = () => calls.find((call) => call.kind === 'generate').body;

describe('lane voice fill on Generate', () => {
  it('fills the record from the notes, shows the words, and writes the report from the filled record', async () => {
    await openForm(BED_BUG);
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['lane', 'generate']);
    expect(calls[0].body).toEqual({ note: NOTE });
    expect(generated().observations).toEqual(expect.arrayContaining(['Scheduled follow-up treatment', 'Live adults', 'Preparation complete']));
    expect(generated().areasServiced).toEqual(['Primary bedroom', 'Furniture / upholstery']);
    expect(groupSelect('bed_bug_evidence').value).toBe('Live adults');
    expect(screen.getByText('Heard: “live ones on the couch seams”')).toBeTruthy();
    expect(screen.getByText('Heard: “treated the master bedroom” · “the living room couch”')).toBeTruthy();
  });

  it('never overwrites a pick: a picked group and picked areas stay as they are', async () => {
    await openForm(BED_BUG);
    fireEvent.change(groupSelect('bed_bug_visit_stage'), { target: { value: 'Initial treatment' } });
    await generate();
    expect(generated().observations).toEqual(expect.arrayContaining(['Initial treatment', 'Live adults', 'Preparation complete']));
    expect(generated().observations).not.toContain('Scheduled follow-up treatment');
    expect(screen.queryByText('Heard: “second treatment”')).toBeNull();
  });

  it('a person\'s pick drops the words a fill stood on, even when the filled value is picked again', async () => {
    await openForm(BED_BUG);
    await generate();
    expect(screen.getByText('Heard: “live ones on the couch seams”')).toBeTruthy();
    fireEvent.change(groupSelect('bed_bug_evidence'), { target: { value: 'Live nymphs' } });
    fireEvent.change(groupSelect('bed_bug_evidence'), { target: { value: 'Live adults' } });
    await waitFor(() => expect(groupSelect('bed_bug_evidence').value).toBe('Live adults'));
    expect(screen.queryByText('Heard: “live ones on the couch seams”')).toBeNull();
    // A group nobody touched keeps its words.
    expect(screen.getByText('Heard: “they had everything bagged”')).toBeTruthy();
  });

  it('a person\'s tick drops the words the fill heard for that place', async () => {
    await openForm(BED_BUG);
    await generate();
    const areas = document.getElementById('cp-areas-treated-desktop') || document.getElementById('cp-areas-treated-mobile');
    fireEvent.click(areas);
    fireEvent.click(within(areas.parentElement).getByRole('button', { name: 'Primary bedroom', exact: true }));
    fireEvent.click(within(areas.parentElement).getByRole('button', { name: 'Primary bedroom', exact: true }));
    await waitFor(() => expect(screen.getByText('Heard: “the living room couch”')).toBeTruthy());
    expect(screen.queryByText(/treated the master bedroom/)).toBeNull();
  });

  it('the unclear asks follow the latest Generate: a later read that answers nothing clears them', async () => {
    laneAnswer = () => ({ ok: true, json: async () => ({ ...READ, findings: READ.findings.filter((entry) => entry.group !== 'bed_bug_prep'), unclearGroups: ['bed_bug_prep'] }) });
    await openForm(BED_BUG);
    await generate();
    await waitFor(() => expect(screen.getAllByText('The notes didn’t make this clear. Pick one.').length).toBeGreaterThan(0));
    laneAnswer = () => ({ ok: true, json: async () => ({ available: true, status: 'failed', lane: 'bed_bug_treatment', areas: [], findings: [], unclearGroups: [] }) });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'lane')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('The notes didn’t make this clear. Pick one.')).toBeNull());
  });

  it('a request that fails answers nothing: the asks an earlier read left stay asked', async () => {
    laneAnswer = () => ({ ok: true, json: async () => ({ ...READ, findings: READ.findings.filter((entry) => entry.group !== 'bed_bug_prep'), unclearGroups: ['bed_bug_prep'] }) });
    await openForm(BED_BUG);
    await generate();
    await waitFor(() => expect(screen.getAllByText('The notes didn’t make this clear. Pick one.').length).toBeGreaterThan(0));
    laneAnswer = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'lane')).toHaveLength(2));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'generate')).toHaveLength(2));
    expect(screen.getAllByText('The notes didn’t make this clear. Pick one.').length).toBeGreaterThan(0);
  });

  it('a value that clashes with a pick is left for a person, with an ask to pick', async () => {
    laneAnswer = () => ({
      ok: true,
      json: async () => ({
        available: true, status: 'read', lane: 'fire_ant', areas: [], unclearGroups: [],
        findings: [{ group: 'fire_ant_evidence', value: 'No active fire ants observed', quote: 'no active mounds' }],
      }),
    });
    await openForm(FIRE_ANT);
    fireEvent.change(groupSelect('fire_ant_distribution'), { target: { value: 'Widespread activity' } });
    await generate();
    expect(generated().observations).toContain('Widespread activity');
    expect(generated().observations).not.toContain('No active fire ants observed');
    expect(screen.getByText('The notes didn’t make this clear. Pick one.')).toBeTruthy();
  });

  it('a second Generate reads the tech\'s notes, never the report the first one wrote (pre-push P1)', async () => {
    await openForm(BED_BUG);
    await generate();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'lane')).toHaveLength(2));
    const reads = calls.filter((call) => call.kind === 'lane');
    expect(reads[1].body).toEqual({ note: NOTE });
  });

  it('a group filled by a second Generate keeps its pick through a later edit (pre-push P1)', async () => {
    let reads = 0;
    laneAnswer = () => {
      reads += 1;
      const findings = reads === 1 ? READ.findings.filter((entry) => entry.group !== 'bed_bug_prep') : READ.findings.filter((entry) => entry.group === 'bed_bug_prep');
      return { ok: true, json: async () => ({ ...READ, areas: reads === 1 ? READ.areas : [], findings }) };
    };
    await openForm(BED_BUG);
    await generate();
    expect(groupSelect('bed_bug_prep').value).toBe('');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'generate')).toHaveLength(2));
    await waitFor(() => expect(groupSelect('bed_bug_prep').value).toBe('Preparation complete'));
    expect(calls.filter((call) => call.kind === 'generate')[1].body.observations).toContain('Preparation complete');
    // An edit after the report: the restored notes still carry the fill's pick.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    fireEvent.change(groupSelect('bed_bug_visit_stage'), { target: { value: 'Initial treatment' } });
    await waitFor(() => expect(groupSelect('bed_bug_visit_stage').value).toBe('Initial treatment'));
    expect(groupSelect('bed_bug_prep').value).toBe('Preparation complete');
    expect(groupSelect('bed_bug_evidence').value).toBe('Live adults');
  });

  it('an edited report, then a Generate that fills another group: a later edit keeps the fill (codex local r1 on #5628)', async () => {
    let reads = 0;
    laneAnswer = () => {
      reads += 1;
      const findings = reads === 1 ? READ.findings.filter((entry) => entry.group !== 'bed_bug_prep') : READ.findings.filter((entry) => entry.group === 'bed_bug_prep');
      return { ok: true, json: async () => ({ ...READ, areas: reads === 1 ? READ.areas : [], findings }) };
    };
    await openForm(BED_BUG);
    await generate();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    const notes = document.querySelector('textarea');
    fireEvent.change(notes, { target: { value: `${notes.value}\n\nCustomer asked about the couch cover.` } });
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'generate')).toHaveLength(2));
    await waitFor(() => expect(groupSelect('bed_bug_prep').value).toBe('Preparation complete'));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    fireEvent.change(groupSelect('bed_bug_visit_stage'), { target: { value: 'Initial treatment' } });
    await waitFor(() => expect(groupSelect('bed_bug_visit_stage').value).toBe('Initial treatment'));
    expect(groupSelect('bed_bug_prep').value).toBe('Preparation complete');
    expect(groupSelect('bed_bug_evidence').value).toBe('Live adults');
  });

  it('a second Generate with nothing new to fill keeps the words beside the values still standing (codex local r1 on #5628)', async () => {
    await openForm(BED_BUG);
    await generate();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /generate ai/i })[0].disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'generate')).toHaveLength(2));
    expect(screen.getByText('Heard: “live ones on the couch seams”')).toBeTruthy();
    expect(screen.getByText('Heard: “treated the master bedroom” · “the living room couch”')).toBeTruthy();
  });

  it('a failed read fills nothing and the report is still written', async () => {
    laneAnswer = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await openForm(BED_BUG);
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['lane', 'generate']);
    expect(generated().observations).not.toContain('Live adults');
  });

  it('off: Generate never reads the notes for the record', async () => {
    await openForm({ ...BED_BUG, laneVoiceFillEnabled: false });
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['generate']);
  });
});
