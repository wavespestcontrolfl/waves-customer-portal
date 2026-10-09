// @vitest-environment jsdom
// The packet's client half shared by the long closeout form and the one-screen container: the operator scope, the
// display state of a stop (one precedence rule for both sheets), and what a refused send decides.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFinishedState, isOfficeReviewState, operatorScope, packetAfterSend, packetDisplayState } from './visit-closeout-packet';

vi.mock('../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../pages/admin/SchedulePage', () => ({
  createCompletionIdempotencyKey: (id) => `key_${id}`,
  completionReconcilePrompt: () => null, completionReportRulesPrompt: () => null, completionPromiseMarksPrompt: () => null,
}));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('operatorScope', () => {
  it('is the verified operator; only without one the cached profile; else the anonymous bucket', () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'cached' }));
    expect(operatorScope('verified')).toBe('verified');
    expect(operatorScope()).toBe('cached');
    expect(operatorScope('')).toBe('cached');
    localStorage.clear();
    expect(operatorScope('verified')).toBe('verified');
    expect(operatorScope()).toBe('');
  });
});

describe('packetDisplayState', () => {
  const packet = (extra) => ({ packet: { id: 'p', ...extra } });
  it.each([
    ['nothing yet', {}, 'idle'],
    ['a send in flight', { busy: true }, 'busy'],
    ['an answer: done', { result: { state: 'done' } }, 'done'],
    ['an answer: office required', { result: { state: 'office_required' } }, 'office_review'],
    ['an answer: effects still pending', { result: { state: 'service_effects_pending' } }, 'pending_resume'],
    ['a packet still processing', { detail: packet({ status: 'processing' }) }, 'pending_resume'],
    ['a finished packet', { detail: packet({ status: 'done' }) }, 'done'],
    ['a finished packet held for office review', { detail: packet({ status: 'done', officeReview: true }) }, 'office_review'],
    ['a failed packet', { detail: packet({ status: 'failed' }) }, 'failed'],
    // A rediscovered terminal packet beats an earlier pending answer once that answer is cleared (resolveSendFailure's `found`).
    ['a pending answer with the packet since finished (answer cleared)', { detail: packet({ status: 'done' }) }, 'done'],
    ['a pending answer, not yet cleared', { result: { state: 'service_effects_pending' }, detail: packet({ status: 'done' }) }, 'pending_resume'],
    ['an answer: done beats a busy resend', { result: { state: 'done' }, busy: true }, 'done'],
  ])('%s', (_label, input, expected) => {
    expect(packetDisplayState(input)).toBe(expected);
  });

  it('finished and office-review follow the state', () => {
    expect(['idle', 'busy', 'pending_resume'].map(isFinishedState)).toEqual([false, false, false]);
    expect(['done', 'office_review', 'failed'].map(isFinishedState)).toEqual([true, true, true]);
    expect(['done', 'idle'].map(isOfficeReviewState)).toEqual([false, false]);
    expect(['office_review', 'failed'].map(isOfficeReviewState)).toEqual([true, true]);
  });

  it('packetAfterSend marks a finished answer done and anything else processing', () => {
    expect(packetAfterSend({ packetId: 'p', state: 'done' })).toEqual({ id: 'p', status: 'done' });
    expect(packetAfterSend({ packetId: 'p', state: 'office_required' })).toEqual({ id: 'p', status: 'done' });
    expect(packetAfterSend({ packetId: 'p', state: 'service_effects_pending' })).toEqual({ id: 'p', status: 'processing' });
  });
});

describe('both closeout sheets use the shared rules', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const sheets = [read('../components/admin/VisitCloseoutSheet.jsx'), read('../hooks/useComboStop.js')];
  it.each([['packetDisplayState'], ['packetAfterSend'], ['resolveSendFailure'], ['postVisitPacket']])('%s is imported by the long form and the container hook', (name) => {
    for (const source of sheets) expect(source).toContain(name);
  });
  it('neither re-derives a terminal state itself', () => {
    for (const source of [...sheets, read('../components/tech/FastCompleteComboSheet.jsx')]) {
      expect(source).not.toMatch(/\['done', 'failed'\]\.includes/);
      expect(source).not.toMatch(/packet\?\.officeReview/);
    }
  });
});
