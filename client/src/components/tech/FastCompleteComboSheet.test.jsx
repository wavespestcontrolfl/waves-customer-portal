// @vitest-environment jsdom
// The pest + lawn container (GATE_COMBO_FAST_COMPLETE): the onPrepared seq contract, "Complete stop" and its packet request,
// the confirm prompts, a lost response, a reload, and a server refusal. The two parts are stubs that hand up bodies the
// way the real sheets do (the sheets themselves are covered by their own suites). Synthetic ids only.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React, { useContext, useEffect, useRef, useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FastCompleteComboSheet from './FastCompleteComboSheet';
import { PartBusyContext } from './FastCompleteParts';
import { adminFetch } from '../../utils/admin-fetch';
import * as store from '../../lib/completion-resume-store';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({
  createCompletionIdempotencyKey: (id) => `key_${id}`,
  completionReconcilePrompt: (error) => (error.code === 'report_reconcile' ? 'Confirm recorded values' : null),
  completionReportRulesPrompt: (error) => (error.code === 'report_rules_review' ? 'Send report as is' : null),
  completionPromiseMarksPrompt: (error) => (error.code === 'promise_marks_changed' ? 'A promise you marked changed' : null),
}));
// A part: shows the shared note it was given, and hands bodies up on demand (and, like the real sheets, drops its body
// when told to by the test).
const partCalls = { pest: [], lawn: [] };
function stubPart(kind) {
  return function Part({ service, onPrepared, sharedNote, embedded, onFullForm }) {
    const [last, setLast] = useState('');
    const reportBusy = useContext(PartBusyContext);
    const send = async (body, seq) => {
      partCalls[kind].push({ body, seq });
      try { await onPrepared(service.id, body, seq); setLast(`ok ${seq}`); } catch (err) { setLast(`rejected: ${err.message}`); }
    };
    // Like the real pest part: once saved, a changed shared note makes the report stale, and the part un-saves itself.
    const saved = useRef(false);
    const seenNote = useRef(sharedNote);
    saved.current = partCalls[kind].some((call) => call.body) && !partCalls[kind].at(-1)?.unsaved;
    useEffect(() => {
      if (seenNote.current !== sharedNote && kind === 'pest' && saved.current) {
        partCalls[kind].push({ body: null, unsaved: true, seq: 0 });
        void onPrepared(service.id, null, window.__seq = (window.__seq || 0) + 1);
      }
      seenNote.current = sharedNote;
    });
    return (
      <div data-testid={`${kind}-part`} data-embedded={String(embedded)}>
        {kind} part sees note "{sharedNote}" {last}
        <button type="button" onClick={() => send({ visitOutcome: 'completed', kind, n: 1 }, window.__seq = (window.__seq || 0) + 1)}>{kind} save</button>
        <button type="button" onClick={() => send(null, window.__seq = (window.__seq || 0) + 1)}>{kind} unsave</button>
        <button type="button" onClick={() => send({ visitOutcome: 'completed', kind, n: 0 }, 1)}>{kind} late old</button>
        <button type="button" onClick={onFullForm}>{kind} needs full form</button>
        <button type="button" onClick={() => reportBusy(kind, true)}>{kind} busy on</button>
        <button type="button" onClick={() => reportBusy(kind, false)}>{kind} busy off</button>
      </div>
    );
  };
}
vi.mock('./FastCompleteSheet', () => ({ default: (props) => stubPart('pest')(props) }));
vi.mock('./FastCompleteLawnSheet', () => ({ default: (props) => stubPart('lawn')(props) }));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));
// The shared mic: a button that starts and stops "dictation in flight".
vi.mock('./DictationButton', () => ({ default: ({ onPendingChange }) => (
  <span>
    <button type="button" onClick={() => onPendingChange(true)}>mic start</button>
    <button type="button" onClick={() => onPendingChange(false)}>mic stop</button>
  </span>
) }));

const PEST = { id: 'svc-pest', customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Quarterly Pest Control', reportFlow: true };
const LAWN = { id: 'svc-lawn', customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Lawn Care' };
const members = [
  { id: 'svc-lawn', serviceType: 'Lawn Care', status: 'on_site', requiresForm: true },
  { id: 'svc-pest', serviceType: 'Quarterly Pest Control', status: 'on_site', requiresForm: true },
];
const rows = [{ id: 'svc-lawn', visitId: 'visit' }, { id: 'svc-pest', visitId: 'visit' }];
let detail;
let post;
const onSaved = vi.fn();
const onClose = vi.fn();
const onFullForm = vi.fn();

function mount(operatorId = 'op-1', extra = {}) {
  return render(<FastCompleteComboSheet visitId="visit" pest={{ service: PEST }} lawn={{ service: LAWN }} request={vi.fn()} operatorId={operatorId} catalog={[]} onClose={onClose} onSaved={onSaved} onFullForm={onFullForm} {...extra} />);
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));
const completeStop = () => screen.getByRole('button', { name: /Complete stop|Resume closeout/ });
// Readiness is immediate; the draft store is written behind it. A reload only finds what was written.
const bothPersisted = (operator = 'op-1') => waitFor(async () => {
  const stored = await store.getVisitCompletionDraft('combo:visit', operator);
  expect(Object.keys(stored?.forms || {}).sort()).toEqual(['svc-lawn', 'svc-pest']);
});
async function prepareBoth() {
  await screen.findByTestId('pest-part');
  click('pest save');
  click('lawn save');
  await waitFor(() => expect(completeStop()).toBeEnabled());
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'technician' }));
  window.__seq = 0;
  partCalls.pest = []; partCalls.lawn = [];
  detail = { visitId: 'visit', serviceDate: '2020-01-01', members, packet: null };
  post = vi.fn(async () => ({ packetId: 'packet', state: 'done' }));
  adminFetch.mockReset().mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return post(path, options);
    if (path.startsWith('/admin/schedule?')) return { services: rows };
    return detail;
  });
  onSaved.mockClear(); onClose.mockClear(); onFullForm.mockClear();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('the container', () => {
  it('embeds both parts, gives them the one note, and keeps Complete stop off until both are saved', async () => {
    mount();
    await screen.findByTestId('pest-part');
    expect(screen.getByTestId('pest-part')).toHaveAttribute('data-embedded', 'true');
    expect(screen.getByTestId('lawn-part')).toHaveAttribute('data-embedded', 'true');
    expect(completeStop()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Ants by the door, lawn thin' } });
    expect(screen.getByTestId('pest-part')).toHaveTextContent('Ants by the door, lawn thin');
    expect(screen.getByTestId('lawn-part')).toHaveTextContent('Ants by the door, lawn thin');
    click('pest save');
    await screen.findAllByText('Saved for this stop');
    expect(completeStop()).toBeDisabled();
    expect(screen.getByText(/Lawn part: not saved yet/)).toBeInTheDocument();
    click('lawn save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('a note edit after saving un-saves the pest part and says so plainly; Complete stop is blocked until it is saved again', async () => {
    mount();
    await prepareBoth();
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'A wasp nest by the garage' } });
    await waitFor(() => expect(completeStop()).toBeDisabled());
    expect(await screen.findByText(/Pest part: changed, save it again/)).toBeInTheDocument();
    expect(screen.getByText('Pest part changed. Save it again below.')).toBeInTheDocument();
    // The lawn part was saved under the old note: it is not ready either, whether or not it revokes itself.
    expect(screen.getByText('Note changed. Save this part again.')).toBeInTheDocument();
    click('pest save');
    await waitFor(() => expect(screen.getByText(/Lawn part: note changed, save it again/)).toBeInTheDocument());
    expect(completeStop()).toBeDisabled();
    click('lawn save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('applies a call only if its seq is greater than the last applied for that service; a null drops the body and blocks Complete stop', async () => {
    mount();
    await prepareBoth();
    // An older call arriving late changes nothing.
    click('pest late old');
    await waitFor(() => expect(partCalls.pest.at(-1).seq).toBe(1));
    const stored = await store.getVisitCompletionDraft('combo:visit', 'op-1');
    expect(stored.forms['svc-pest'].body).toMatchObject({ n: 1 });
    // A newer null drops it.
    click('pest unsave');
    await waitFor(() => expect(completeStop()).toBeDisabled());
    expect(await screen.findByText(/Pest part: changed, save it again/)).toBeInTheDocument();
    await waitFor(async () => expect((await store.getVisitCompletionDraft('combo:visit', 'op-1')).forms['svc-pest']).toBeUndefined());
    // Saving again brings it back.
    click('pest save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('a call that cannot be saved on the device rejects, and the part stays not ready', async () => {
    mount();
    await screen.findByTestId('pest-part');
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValueOnce(false);
    click('pest save');
    await screen.findByText(/rejected: Could not save this on this device/);
    click('lawn save');
    await waitFor(() => expect(screen.getByText(/Pest part: not saved yet/)).toBeInTheDocument());
    expect(completeStop()).toBeDisabled();
  });

  it('posts the stop once: { items } from the two saved bodies in member order, with the draft\'s idempotency key', async () => {
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, options] = post.mock.calls[0];
    expect(path).toBe('/admin/visit-closeouts/visit');
    expect(options.headers['Idempotency-Key']).toBe('key_visit');
    expect(JSON.parse(options.body)).toEqual({ items: [
      { serviceId: 'svc-lawn', body: { visitOutcome: 'completed', kind: 'lawn', n: 1 } },
      { serviceId: 'svc-pest', body: { visitOutcome: 'completed', kind: 'pest', n: 1 } },
    ] });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // Recorded: the saved draft is gone.
    await waitFor(async () => expect(await store.getVisitCompletionDraft('combo:visit', 'op-1')).toBeFalsy());
  });

  it('a lost response sends the same key and bodies again', async () => {
    post.mockRejectedValueOnce(Object.assign(new TypeError('Failed to fetch')));
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Connection interrupted/);
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(post.mock.calls[0][1].headers['Idempotency-Key']);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
  });

  it('a packet that started on the server turns the button into Resume closeout', async () => {
    post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    detail = { ...detail, packet: { id: 'packet', status: 'processing' } };
    click('Complete stop');
    await screen.findByRole('button', { name: 'Resume closeout' });
    click('Resume closeout');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toBe('/admin/visit-closeouts/visit/resume');
  });

  it.each([
    ['report_reconcile', 'reportReconcileConfirmed'],
    ['report_rules_review', 'reportRulesConfirmed'],
    ['promise_marks_changed', 'promiseMarksConfirmed'],
  ])('the %s prompt: OK sends that member again with %s under the same key', async (code, flag) => {
    post.mockRejectedValueOnce(Object.assign(new Error('review'), { code, details: { serviceId: 'svc-pest' } }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(post.mock.calls[1][1].body).items.find((item) => item.serviceId === 'svc-pest');
    expect(sent.body[flag]).toBe(true);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe('key_visit');
  });

  it('declining a changed-promise prompt puts that part back to be marked again', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('review'), { code: 'promise_marks_changed', details: { serviceId: 'svc-pest' } }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/A promise changed\. Open that service again/);
    expect(post).toHaveBeenCalledTimes(1);
    expect(completeStop()).toBeDisabled();
    expect((await store.getVisitCompletionDraft('combo:visit', 'op-1')).forms['svc-pest']).toBeUndefined();
  });

  it('a reload restores the saved bodies: the parts show as saved, Complete stop is on, and Edit this part drops one', async () => {
    const first = mount();
    await prepareBoth();
    await bothPersisted();
    first.unmount();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    expect(screen.queryByTestId('pest-part')).not.toBeInTheDocument();
    await waitFor(() => expect(completeStop()).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit this part' })[0]);
    await waitFor(() => expect(completeStop()).toBeDisabled());
    await screen.findByTestId('pest-part');
    expect(screen.queryByTestId('lawn-part')).not.toBeInTheDocument();
  });

  it('a server refusal shows its reason and Full form, and never leaves the tech stuck', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('This visit cannot be completed on the quick sheet.'), {
      code: 'lawn_fast_not_eligible', details: { reason: 'grouped_visit', serviceId: 'svc-lawn' },
    }));
    mount();
    await prepareBoth();
    click('Complete stop');
    await waitFor(() => expect(screen.getAllByRole('alert').some((node) => /cannot be completed on the quick sheet/.test(node.textContent))).toBe(true));
    expect(completeStop()).toBeDisabled();
    // The card beside the reason and the header both offer it.
    const buttons = screen.getAllByRole('button', { name: 'Full form' });
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    // The long form starts clean: the short screen's saved bodies are gone.
    expect(await store.getVisitCompletionDraft('combo:visit', 'op-1')).toBeFalsy();
  });

  it('a part that says it needs the long form shows the reason and Full form', async () => {
    mount();
    await screen.findByTestId('lawn-part');
    click('lawn needs full form');
    expect(await screen.findByRole('alert')).toHaveTextContent('needs the long form');
    expect(completeStop()).toBeDisabled();
  });

  it('a stop that is no longer exactly this pair goes to the long form', async () => {
    detail = { ...detail, members: [...members, { id: 'svc-third', serviceType: 'Mosquito', status: 'on_site', requiresForm: true }] };
    adminFetch.mockImplementation(async (path) => (path.startsWith('/admin/schedule?') ? { services: [...rows, { id: 'svc-third', visitId: 'visit' }] } : detail));
    mount();
    expect(await screen.findByText(/This stop changed since the schedule loaded/)).toBeInTheDocument();
    expect(screen.queryByTestId('pest-part')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Full form' }).length).toBeGreaterThan(0);
  });
});

describe('Details (owner 2026-10-09: every Fast Complete sheet)', () => {
  it('shows once the stop is loaded and still this pair, waits for work in flight, and is absent without a handler', async () => {
    const onViewDetails = vi.fn();
    mount('op-1', { onViewDetails });
    await screen.findByTestId('pest-part');
    click('Details');
    expect(onViewDetails).toHaveBeenCalledTimes(1);
    click('pest busy on');
    expect(screen.getByRole('button', { name: 'Details' })).toBeDisabled();
    cleanup();
    mount();
    await screen.findByTestId('pest-part');
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });

  it('is withheld while the stop loads and when it is no longer this pair', async () => {
    let release;
    adminFetch.mockImplementation((path) => (path.startsWith('/admin/schedule?') ? Promise.resolve({ services: rows }) : new Promise((resolve) => { release = () => resolve(detail); })));
    mount('op-1', { onViewDetails: vi.fn() });
    expect(await screen.findByText('Loading the stop…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
    await act(async () => { release?.(); });
    cleanup();
    detail = { ...detail, members: [...members, { id: 'svc-third', serviceType: 'Mosquito', status: 'on_site', requiresForm: true }] };
    adminFetch.mockImplementation(async (path) => (path.startsWith('/admin/schedule?') ? { services: [...rows, { id: 'svc-third', visitId: 'visit' }] } : detail));
    mount('op-1', { onViewDetails: vi.fn() });
    expect(await screen.findByText(/This stop changed since the schedule loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });

  it('suspended, it stays mounted but hidden and inert, and comes back with what was entered', async () => {
    const { rerender } = mount('op-1', { onViewDetails: vi.fn() });
    await screen.findByTestId('pest-part');
    click('pest save');
    await waitFor(() => expect(screen.getByTestId('pest-part')).toHaveTextContent('ok 1'));
    const props = { visitId: 'visit', pest: { service: PEST }, lawn: { service: LAWN }, request: vi.fn(), operatorId: 'op-1', catalog: [], onClose, onSaved, onFullForm, onViewDetails: vi.fn() };
    rerender(<FastCompleteComboSheet {...props} suspended />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<FastCompleteComboSheet {...props} />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('pest-part')).toHaveTextContent('ok 1');
  });
});

describe('restored state obeys the rules live state does', () => {
  it('a reload brings the note back with the parts; editing it un-readies both, nothing is posted', async () => {
    const first = mount();
    await screen.findByTestId('pest-part');
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Ants by the door' } });
    click('pest save');
    click('lawn save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    await bothPersisted();
    first.unmount();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    expect(screen.getByLabelText('Tell me about the visit')).toHaveValue('Ants by the door');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Ants by the door and a wasp nest' } });
    await waitFor(() => expect(completeStop()).toBeDisabled());
    expect(screen.getAllByText('Note changed. Save this part again.')).toHaveLength(2);
    // The stale summaries give way to editable parts.
    await screen.findByTestId('pest-part');
    await screen.findByTestId('lawn-part');
    expect(post).not.toHaveBeenCalled();
  });

  it('Edit this part takes effect at once: Complete stop is off before the write finishes, and stays off when the write fails', async () => {
    const first = mount();
    await prepareBoth();
    await bothPersisted();
    first.unmount();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValue(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit this part' })[0]);
    expect(completeStop()).toBeDisabled();
    await screen.findByText(/Could not save this on this device/);
    expect(completeStop()).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('drafts belong to the verified operator', () => {
  it('two operators on one device never see each other\'s forms, with or without the cached profile', async () => {
    for (const cached of [true, false]) {
      localStorage.clear();
      globalThis.indexedDB = new IDBFactory();
      if (cached) localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-a', role: 'technician' }));
      const first = mount('op-a');
      await prepareBoth();
      await bothPersisted('op-a');
      first.unmount();
      // Another operator opens the same stop: nothing of op-a's comes back.
      const other = mount('op-b');
      await screen.findByTestId('pest-part');
      expect(screen.queryAllByText('Saved earlier on this device. Edit it to change anything.')).toHaveLength(0);
      expect(completeStop()).toBeDisabled();
      expect(screen.getByLabelText('Tell me about the visit')).toHaveValue('');
      other.unmount();
      // The first operator's own draft is still theirs.
      mount('op-a');
      await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
      expect(await store.getVisitCompletionDraft('combo:visit', 'op-a')).toBeTruthy();
      expect(await store.getVisitCompletionDraft('visit', 'op-a')).toBeFalsy();
      expect(await store.getVisitCompletionDraft('combo:visit', 'op-b')).toBeFalsy();
      expect(await store.getVisitCompletionDraft('combo:visit', '')).toBeFalsy();
      cleanup();
    }
  });
});

describe('the packet lifecycle comes from the shared rule', () => {
  const pending = { packetId: 'packet', state: 'service_effects_pending' };

  it.each([
    ['done', { packet: { id: 'packet', status: 'done' } }, /^Stop recorded\.$/],
    ['failed', { packet: { id: 'packet', status: 'failed' } }, /review the closeout/],
    ['done with office review', { packet: { id: 'packet', status: 'done', officeReview: true } }, /review the closeout/],
  ])('a rediscovered %s packet beats an earlier pending result', async (_label, found, wording) => {
    post.mockResolvedValueOnce(pending).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByRole('button', { name: 'Resume closeout' });
    // The resume's response is lost; the server says the packet is finished.
    detail = { ...detail, ...found };
    click('Resume closeout');
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resume closeout|Complete stop/ })).not.toBeInTheDocument();
    expect(screen.getByText(wording)).toBeInTheDocument();
  });

  it('a restored packet closed for office review shows the office-review words, not the plain recorded line', async () => {
    detail = { ...detail, packet: { id: 'packet', status: 'done', officeReview: true } };
    mount();
    expect(await screen.findByText(/review the closeout, billing, or delivery/)).toBeInTheDocument();
  });
});

describe('navigation waits for work in flight', () => {
  const blocked = () => {
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Full form' })[0]).toBeDisabled();
    expect(completeStop()).toBeDisabled();
  };

  it('Close, Full form and Complete stop wait while the shared mic records', async () => {
    mount();
    await prepareBoth();
    click('mic start');
    blocked();
    click('mic stop');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  it.each(['pest', 'lawn'])('they wait while the %s part reports work in flight', async (kind) => {
    mount();
    await prepareBoth();
    click(`${kind} busy on`);
    blocked();
    click(`${kind} busy off`);
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('the backdrop and Escape do not close it while work is in flight', async () => {
    mount();
    await prepareBoth();
    click('pest busy on');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    click('pest busy off');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled());
  });
});

describe('hydration happens before anything editable renders', () => {
  it('a fresh stop keeps the first thing typed right after it loads', async () => {
    mount();
    const box = await screen.findByLabelText('Tell me about the visit');
    fireEvent.change(box, { target: { value: 'Typed at once' } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(screen.getByLabelText('Tell me about the visit')).toHaveValue('Typed at once');
    expect(screen.getByTestId('pest-part')).toHaveTextContent('Typed at once');
  });

  it('a saved note is in the box and in both parts on their very first render', async () => {
    await store.putVisitCompletionDraft('combo:visit', { visitId: 'visit', key: 'key_visit', note: 'Saved note', forms: {} }, 'op-1');
    mount();
    // findBy returns on the first render that has the box: it must already hold the saved note.
    const box = await screen.findByLabelText('Tell me about the visit');
    expect(box.value).toBe('Saved note');
    expect(screen.getByTestId('pest-part')).toHaveTextContent('Saved note');
  });
});

describe('one serialized writer persists the current map', () => {
  const realPut = store.putVisitCompletionDraft;
  const stored = async () => Object.keys((await store.getVisitCompletionDraft('combo:visit', 'op-1'))?.forms || {}).sort();

  it('A fails while B succeeds: only B comes back after a reload', async () => {
    let calls = 0;
    const spy = vi.spyOn(store, 'putVisitCompletionDraft').mockImplementation((...args) => {
      calls += 1;
      return calls === 1 ? new Promise((resolve) => setTimeout(() => resolve(false), 30)) : realPut(...args);
    });
    const first = mount();
    await screen.findByTestId('pest-part');
    // Two overlapping saves: the first write fails while the second is queued.
    click('pest save');
    click('lawn save');
    await screen.findByText(/rejected: Could not save this on this device/);
    await waitFor(async () => expect(await stored()).toEqual(['svc-lawn']));
    expect(screen.getByText(/Pest part: not saved yet/)).toBeInTheDocument();
    expect(completeStop()).toBeDisabled();
    first.unmount();
    spy.mockRestore();
    mount();
    await screen.findByTestId('pest-part');
    expect(screen.getAllByText('Saved earlier on this device. Edit it to change anything.')).toHaveLength(1);
    expect(screen.queryByTestId('lawn-part')).not.toBeInTheDocument();
  });

  it('A then B both succeed: both are saved and ready', async () => {
    mount();
    await prepareBoth();
    await bothPersisted();
    expect(await stored()).toEqual(['svc-lawn', 'svc-pest']);
  });

  it('a failed compensating write leaves both not ready with the error shown', async () => {
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValue(false);
    mount();
    await screen.findByTestId('pest-part');
    click('pest save');
    click('lawn save');
    await waitFor(() => expect(screen.getAllByText(/rejected: Could not save this on this device/)).toHaveLength(2));
    expect(screen.getByText(/Pest part: not saved yet · Lawn part: not saved yet/)).toBeInTheDocument();
    expect(await screen.findAllByText(/Could not save this on this device/)).not.toHaveLength(0);
    expect(completeStop()).toBeDisabled();
  });
});

describe('Full form waits for the saved forms to be deleted', () => {
  it('a delete that resolves false keeps the tech here with an error and a retry; the long form never reads the combo draft', async () => {
    mount();
    await prepareBoth();
    await bothPersisted();
    expect(await store.getVisitCompletionDraft('visit', 'op-1')).toBeFalsy();
    const real = store.deleteVisitCompletionDraft;
    const spy = vi.spyOn(store, 'deleteVisitCompletionDraft').mockResolvedValueOnce(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Full form' })[0]);
    await screen.findByText(/Could not discard the saved forms/);
    expect(onFullForm).not.toHaveBeenCalled();
    expect(await store.getVisitCompletionDraft('combo:visit', 'op-1')).toBeTruthy();
    spy.mockImplementation(real);
    fireEvent.click(screen.getAllByRole('button', { name: 'Full form' })[0]);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    expect(await store.getVisitCompletionDraft('combo:visit', 'op-1')).toBeFalsy();
  });

  it('a delete that rejects is handled the same way', async () => {
    mount();
    await screen.findByTestId('pest-part');
    vi.spyOn(store, 'deleteVisitCompletionDraft').mockRejectedValueOnce(new Error('idb gone'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Full form' })[0]);
    await screen.findByText(/Could not discard the saved forms/);
    expect(onFullForm).not.toHaveBeenCalled();
  });
});

describe('a rollback only ever makes a part less ready', () => {
  const stored = async () => Object.keys((await store.getVisitCompletionDraft('combo:visit', 'op-1'))?.forms || {}).sort();

  it('a failed revocation leaves the part not ready, Complete stop off and nothing posted; Try again does not bring the old body back', async () => {
    mount();
    await prepareBoth();
    await bothPersisted();
    const spy = vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValue(false);
    click('pest unsave');
    await screen.findByText(/rejected: Could not save this on this device/);
    expect(completeStop()).toBeDisabled();
    expect(screen.getByText(/Pest part: changed, save it again/)).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(post).not.toHaveBeenCalled();
    // The store failed again: still not ready, still blocked.
    fireEvent.click(retry);
    await waitFor(() => expect(completeStop()).toBeDisabled());
    // The store works again: the retry lands, the part is STILL not ready until it is saved again.
    spy.mockRestore();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument());
    expect(completeStop()).toBeDisabled();
    expect(await stored()).toEqual(['svc-lawn']);
    click('pest save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('a failed new save of an already saved part leaves it not ready (the earlier body is not put back)', async () => {
    mount();
    await prepareBoth();
    await bothPersisted();
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValue(false);
    click('pest save');
    await screen.findByText(/rejected: Could not save this on this device/);
    expect(completeStop()).toBeDisabled();
    expect(screen.getByText(/Pest part: /)).toBeInTheDocument();
  });

  it('after a crash with a failed revocation the store still holds the old body, but a reload does not trust it', async () => {
    const first = mount();
    await prepareBoth();
    await bothPersisted();
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValue(false);
    click('pest unsave');
    await screen.findByText(/rejected: Could not save this on this device/);
    first.unmount();
    vi.restoreAllMocks();
    adminFetch.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return post(path, options);
      if (path.startsWith('/admin/schedule?')) return { services: rows };
      return detail;
    });
    // The remaining exposure, stated: the store itself still has both bodies...
    expect(await stored()).toEqual(['svc-lawn', 'svc-pest']);
    mount();
    // ...but the revocation marker keeps the pest part from coming back as saved.
    await screen.findByTestId('pest-part');
    expect(screen.getAllByText('Saved earlier on this device. Edit it to change anything.')).toHaveLength(1);
    expect(completeStop()).toBeDisabled();
  });
});

