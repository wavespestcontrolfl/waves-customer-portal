// @vitest-environment jsdom
// Hook-level tests for the free "Send to Claude" idea button (GATE_IB_SEND_TO_CLAUDE): the composer's own marks and
// in-flight photos survive a send and its Undo (Codex P2s on #7548).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
import { adminFetch } from '../../utils/admin-fetch';
import { useSendToClaudeIdea, SENT_PASTED_NOTE } from './SendToClaudeIdea';

const IDEA_ID = '00000000-0000-4000-8000-0000000000b2';
const AT = '2026-11-03T20:00:00.000Z';

function setup(overrides = {}) {
  const pastedRef = { current: false };
  const dictationUsedRef = { current: false };
  const onSent = vi.fn(() => { pastedRef.current = false; dictationUsedRef.current = false; });
  const onRestore = vi.fn();
  const base = { open: true, prompt: 'An idea', attachments: [], attachmentsLoading: false, dictationPending: false,
    pastedRef, dictationUsedRef, pageData: {}, route: '/admin', onSent, onRestore, ...overrides };
  const hook = renderHook((props) => useSendToClaudeIdea(props), { initialProps: base });
  return { ...hook, base, pastedRef, dictationUsedRef, onSent, onRestore };
}

beforeEach(() => { adminFetch.mockReset(); });

describe('useSendToClaudeIdea', () => {
  it('a dictated idea keeps its dictation mark through Undo', async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url.endsWith('/status')) return { enabled: true };
      if (url.endsWith('/cancel')) return { cancelled: true };
      return { sent: true, id: IDEA_ID, at: AT };
    });
    const h = setup();
    h.dictationUsedRef.current = true;
    await act(async () => { await h.result.current.send(); });
    expect(h.onSent).toHaveBeenCalledTimes(1);
    expect(h.dictationUsedRef.current).toBe(false);
    h.rerender({ ...h.base, prompt: '' });
    await act(async () => { await h.result.current.undo(); });
    expect(h.onRestore).toHaveBeenCalledWith('An idea');
    expect(h.dictationUsedRef.current).toBe(true);
  });

  it('a pasted idea says it gets a plan only; a typed one says sent', async () => {
    adminFetch.mockImplementation(async (url) => (url.endsWith('/status') ? { enabled: true } : { sent: true, id: IDEA_ID, at: AT }));
    const pastedSend = setup();
    pastedSend.pastedRef.current = true;
    await act(async () => { await pastedSend.result.current.send(); });
    expect(pastedSend.result.current.note).toMatchObject({ kind: 'sent', text: SENT_PASTED_NOTE, pasted: true, undoable: true });
    expect(SENT_PASTED_NOTE).toBe('Sent to Claude. It has pasted text, so you get a plan only, in your bell.');
    const typedSend = setup();
    await act(async () => { await typedSend.result.current.send(); });
    expect(typedSend.result.current.note).toMatchObject({ kind: 'sent', text: 'Sent to Claude.', pasted: false });
  });

  it('keeps the box when a photo is still being converted as the send answers', async () => {
    let answer;
    adminFetch.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ enabled: true });
      return new Promise((resolve) => { answer = () => resolve({ sent: true, id: IDEA_ID, at: AT }); });
    });
    const h = setup();
    let pending;
    act(() => { pending = h.result.current.send(); });
    h.rerender({ ...h.base, attachmentsLoading: true });
    await act(async () => { answer(); await pending; });
    expect(h.onSent).not.toHaveBeenCalled();
    expect(h.result.current.note).toMatchObject({ kind: 'sent', undoable: true });
  });
});
