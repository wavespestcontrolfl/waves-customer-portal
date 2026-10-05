// @vitest-environment jsdom
import React from 'react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import FastCompleteSheet from './FastCompleteSheet';
import FastCompleteLawnReserviceSheet from './FastCompleteLawnReserviceSheet';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';
import { getFastCompletionAttempt, putFastCompletionAttempt } from '../../lib/completion-resume-store';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

for (const [name, Sheet, reportFlow] of [
  ['report', FastCompleteSheet, true],
  ['lawn', FastCompleteLawnReserviceSheet, false],
  ['tree/shrub', FastCompleteTreeShrubSheet, false],
  ['lawn visit', FastCompleteLawnSheet, false],
]) {
  test.each(['receipt', 'already_saved'])(`${name} recovery shows the saved result for %s while context is unavailable`, async (outcome) => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    const request = vi.fn(async (path) => {
      if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
      if (outcome === 'already_saved') throw Object.assign(new Error('Already saved'), { status: 409, code: 'service_already_completed' });
      return { success: true, completionSmsStatus: 'deferred', invoiceId: 'invoice-a', invoiceStatus: 'paid' };
    });
    const completed = vi.fn();
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={completed} onFullForm={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: 'Retry', exact: true });
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
    fireEvent.click(retry);
    const next = await screen.findByRole('button', { name: 'Next stop' });
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/An unfinished completion/)).not.toBeInTheDocument();
    const posts = request.mock.calls.filter(([path]) => path.endsWith('/complete'));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual(body);
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
    if (reportFlow && outcome === 'receipt') {
      expect(screen.getByText(/report is queued/)).toBeInTheDocument();
      expect(screen.getByText('Bill: paid.')).toBeInTheDocument();
    }
    fireEvent.click(next);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  test(`${name} closes while a stalled device read is still checking (GitHub Codex P2 on #5972)`, async () => {
    // A storage open that never answers: the check never settles.
    globalThis.indexedDB = { open: () => ({}) };
    const onClose = vi.fn();
    const request = vi.fn(async () => { throw Object.assign(new Error('Context unavailable'), { status: 503 }); });
    render(<Sheet service={{ id: `visit-stall-${name}`, reportFlow }} operatorId="tech-stall" request={request}
      onClose={onClose} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    expect(await screen.findByText(/Checking for an unfinished completion/)).toBeInTheDocument();
    // The lawn visit sheet's header closes with Back.
    fireEvent.click(screen.getByRole('button', { name: Sheet === FastCompleteLawnSheet ? 'Back' : 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
  });

  test(`${name} keeps the server's refusal on screen when the visit cannot load and the copy cleared (GitHub Codex P2 on #5972)`, async () => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    const request = vi.fn(async (path) => {
      if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
      throw Object.assign(new Error('Changed'), { status: 409, code: 'idempotency_key_mismatch' });
    });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    expect(await screen.findByText(/Another completion for this visit/)).toBeInTheDocument();
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
    expect(screen.getByText(/Another completion for this visit/)).toBeInTheDocument();
  });

  test(`${name} waits on a saved attempt it cannot read, then shows it on Try again (GitHub Codex P2 on #6001)`, async () => {
    const body = { idempotencyKey: 'unread-key', technicianNotes: 'Unread work' };
    await putFastCompletionAttempt('visit-u', 'tech-a', { body, summary: 'Unread visit' });
    const store = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    const onFullForm = vi.fn();
    const request = vi.fn(async (path) => {
      if (path.endsWith('/complete')) return { success: true };
      throw Object.assign(new Error('Not this sheet'), { status: 404 });
    });
    render(<Sheet service={{ id: 'visit-u', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
    expect(await screen.findByText(/saved on this device but can’t be read right now/)).toBeInTheDocument();
    expect(onFullForm).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
    globalThis.indexedDB = store;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
  });

  test(`${name} shows a refused copy found after a reload to discard only, then a fresh form (GitHub Codex P2 on #5967)`, async () => {
    const body = { idempotencyKey: 'refused-key', technicianNotes: 'Refused work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Refused visit', refused: true });
    const request = vi.fn(async () => { throw Object.assign(new Error('Context unavailable'), { status: 503 }); });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    expect(await screen.findByText(/server refused this saved completion/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
    await waitFor(() => expect(screen.queryByText(/server refused this saved completion/)).not.toBeInTheDocument());
    expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
  });

  test(`${name} keeps a refused completion whose copy will not clear, to discard (GitHub Codex P2 on 102b99cb1b)`, async () => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    let refuse;
    const request = vi.fn((path) => {
      if (!path.endsWith('/complete')) return Promise.reject(Object.assign(new Error('Context unavailable'), { status: 503 }));
      return new Promise((_resolve, reject) => { refuse = () => reject(Object.assign(new Error('Changed'), { status: 409, code: 'idempotency_key_mismatch' })); });
    });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    await waitFor(() => expect(refuse).toBeTypeOf('function'));
    const store = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
      refuse();
      expect(await screen.findByText(/could not clear its saved copy of this completion/)).toBeInTheDocument();
    } finally { globalThis.indexedDB = store; }
    fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
    expect(screen.queryByRole('button', { name: 'Discard saved retry' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
  });

  test(`${name} says when this device could not clear the saved copy (GitHub Codex P2 on 0fdeda8a25)`, async () => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    let release;
    const request = vi.fn((path) => {
      if (!path.endsWith('/complete')) return Promise.reject(Object.assign(new Error('Context unavailable'), { status: 503 }));
      return new Promise((resolve) => { release = () => resolve({ success: true }); });
    });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const store = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
      release();
      expect(await screen.findByText(/could not clear its saved copy/)).toBeInTheDocument();
    } finally { globalThis.indexedDB = store; }
    expect(screen.getByRole('button', { name: 'Next stop' })).toBeInTheDocument();
    expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt.body).toEqual(body);
  });
}


test('recovered confirmation shows a failed discard and retains the saved attempt', async () => {
  const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained work' };
  await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit' });
  const request = vi.fn(async (path) => {
    if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
    throw Object.assign(new Error('Review report before sending'), { status: 409, code: 'report_rules_review' });
  });
  render(<FastCompleteSheet service={{ id: 'visit-a', reportFlow: true }} operatorId="tech-a"
    request={request} onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  const back = await screen.findByRole('button', { name: 'Go back' });
  const factory = globalThis.indexedDB;
  globalThis.indexedDB = undefined;
  try {
    fireEvent.click(back);
    expect(await screen.findByText(/Could not discard the saved completion/)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  } finally { globalThis.indexedDB = factory; }
  expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt.body).toEqual(body);
  fireEvent.click(back);
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});

test('the lawn visit sheet holds its full-form hand-off while a saved attempt is shown, and tags the attempt as its own', async () => {
  const body = { idempotencyKey: 'lawn-key', technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-l', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const request = vi.fn(async () => { throw Object.assign(new Error('Not this sheet'), { status: 404 }); });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={{ id: 'visit-l' }} operatorId="tech-a" request={request}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
  expect(onFullForm).not.toHaveBeenCalled();
  expect((await getFastCompletionAttempt('visit-l', 'tech-a')).attempt.sheet).toBe('lawn_visit');
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
  await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
});
