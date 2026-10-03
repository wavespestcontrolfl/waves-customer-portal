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
