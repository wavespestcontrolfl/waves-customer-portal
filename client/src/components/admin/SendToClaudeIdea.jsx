/**
 * "Send to Claude (free)" beside Ask in the Intelligence Bar box (owner 2026-11-03: "it should be for any issue, even ones
 * that dont have an issue mid day, but ideas"; GATE_IB_SEND_TO_CLAUDE).
 *
 * The button makes NO model call: it posts the typed or dictated idea to /admin/claude-ideas, which writes one admin
 * notification into Claude's queue (a Mac launcher opens a Claude tab for it). It never touches the Ask path: not
 * /intelligence-bar/query, not the thread, not the recent prompts, not the request identity. Ten seconds of Undo follow a send.
 *
 * Shared by the desktop modal and the mobile sheet in GlobalCommandPalette.jsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '../../utils/admin-fetch';

const UNDO_MS = 10000;
export const IDEA_HELP = 'Ask uses the paid AI. Send to Claude opens a tab on the Mac at no cost.';
const ID_KEYS = ['customer_id', 'property_id', 'estimate_id', 'appointment_id', 'product_id', 'viewed_date'];

const pickIds = (pageData) => Object.fromEntries(ID_KEYS.filter((key) => pageData?.[key]).map((key) => [key, pageData[key]]));

// The send button's state for one palette. `onSent` clears the composer (prompt, attachments, paste mark) after a send.
export function useSendToClaudeIdea({ open, prompt, attachments, attachmentsLoading, dictationPending, pastedRef, dictationUsedRef, pageData, route, onSent, onRestore }) {
  // Whether the box offers the button: asked once per session (kept once answered); a failed ask reads as hidden and is
  // asked again the next time the box opens.
  const [enabled, setEnabled] = useState(false);
  // GATE_IB_ANSWER_SEND_TO_CLAUDE: the status also says whether a stuck bar answer carries its own line or button.
  const [answerButton, setAnswerButton] = useState(false);
  const askedRef = useRef(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // { kind: 'sent' | 'duplicate' | 'error' | 'cancelled', text, id?, at?, undoable? }
  const [note, setNote] = useState(null);
  const timerRef = useRef(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const attachmentsLoadingRef = useRef(attachmentsLoading);
  attachmentsLoadingRef.current = attachmentsLoading;

  useEffect(() => {
    if (!open || askedRef.current) return;
    askedRef.current = true;
    adminFetch('/admin/claude-ideas/status')
      .then((out) => { setEnabled(out?.enabled === true); setAnswerButton(out?.enabled === true && out?.answerButton === true); })
      .catch(() => { askedRef.current = false; setEnabled(false); setAnswerButton(false); });
  }, [open]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // An error or duplicate line goes when the box changes; "Sent to Claude." keeps its Undo until it runs out, and "Cancelled." stays.
  useEffect(() => {
    setNote((now) => (now && (now.kind === 'error' || now.kind === 'duplicate') ? null : now));
  }, [prompt, attachments.length]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sendingRef.current || attachmentsLoading || dictationPending) return;
    if (attachments.length) {
      setNote({ kind: 'error', text: "Photos can't go to Claude yet. Describe it in words." });
      return;
    }
    sendingRef.current = true;
    setSending(true);
    // The box as it was sent, read BEFORE the request: the paste mark and the text an Undo puts back. The box stays
    // editable while the request runs, so what it holds afterwards can differ.
    const raw = prompt;
    const pasted = pastedRef.current === true;
    const dictated = dictationUsedRef?.current === true;
    try {
      const out = await adminFetch('/admin/claude-ideas', {
        method: 'POST',
        body: JSON.stringify({ text: raw, page: { route }, ids: pickIds(pageData), pasted }),
      });
      if (out?.duplicate) {
        setNote({ kind: 'duplicate', text: 'You already sent this idea. Claude has it.' });
      } else if (out?.sent) {
        // Clear the box only while it still holds exactly what was sent: words or photos added while the request ran stay,
        // including a photo still being converted.
        if (promptRef.current === raw && !attachmentsRef.current.length && !attachmentsLoadingRef.current) onSent();
        // `raw` and `pasted` are the box as the owner sent it, for an Undo to put back.
        setNote({ kind: 'sent', text: 'Sent to Claude.', id: out.id, at: out.at, undoable: true, raw, pasted, dictated });
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setNote((now) => (now?.kind === 'sent' ? { ...now, undoable: false } : now)), UNDO_MS);
      } else {
        setNote({ kind: 'error', text: "Couldn't send it. Try again." });
      }
    } catch {
      setNote({ kind: 'error', text: "Couldn't send it. Try again." });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [prompt, attachments, attachmentsLoading, dictationPending, pastedRef, dictationUsedRef, pageData, route, onSent]);

  const undo = useCallback(async () => {
    if (!note?.undoable || sendingRef.current) return;
    sendingRef.current = true;
    clearTimeout(timerRef.current);
    try {
      await adminFetch(`/admin/claude-ideas/${encodeURIComponent(note.id)}/cancel`, { method: 'POST', body: JSON.stringify({ at: note.at }) });
      // The typed text comes back only into an empty box: words typed since the send are never overwritten.
      const restore = !promptRef.current.trim();
      if (restore) {
        pastedRef.current = note.pasted === true;
        if (dictationUsedRef) dictationUsedRef.current = note.dictated === true;
        onRestore(note.raw);
      }
      setNote({ kind: 'cancelled', text: restore ? 'Cancelled. Your text is back in the box.' : 'Cancelled.' });
    } catch (err) {
      const started = err?.status === 409 && err?.details?.error === 'started';
      setNote({ kind: 'error', text: started ? 'Claude already started on it.' : "Couldn't cancel. Claude has it." });
    } finally {
      sendingRef.current = false;
    }
  }, [note, pastedRef, dictationUsedRef, onRestore]);

  return { enabled, answerButton, sending, note, send, undo, canSend: Boolean(prompt.trim()) && !sending && !attachmentsLoading && !dictationPending };
}

const LOOK = {
  desktop: { border: '#E2E8F0', text: '#334155', muted: '#64748B', pad: '6px 12px', min: 0 },
  mobile: { border: '#E4E4E7', text: '#18181B', muted: '#52525B', pad: '12px 16px', min: 44 },
};

// The button itself (beside Ask).
export function SendToClaudeButton({ claude, variant = 'desktop', hidden = false }) {
  if (!claude?.enabled || hidden) return null;
  const look = LOOK[variant];
  return (
    <button
      type="button"
      onClick={claude.send}
      disabled={!claude.canSend}
      style={{
        flex: variant === 'mobile' ? 1 : undefined,
        padding: look.pad,
        minHeight: look.min || undefined,
        borderRadius: variant === 'mobile' ? 10 : 8,
        border: `1px solid ${look.border}`,
        background: '#FFFFFF',
        color: claude.canSend ? look.text : '#A1A1AA',
        fontSize: 14,
        fontWeight: 500,
        fontFamily: 'Roboto, Arial, sans-serif',
        cursor: claude.canSend ? 'pointer' : 'not-allowed',
        whiteSpace: 'nowrap',
      }}
    >
      {claude.sending ? 'Sending…' : 'Send to Claude (free)'}
    </button>
  );
}

// The answer to the last tap, with Undo for ten seconds after a send; and the one-line help.
export function SendToClaudeNote({ claude, variant = 'desktop', showHelp = true }) {
  if (!claude?.enabled) return null;
  const look = LOOK[variant];
  const { note } = claude;
  return (
    <>
      {showHelp && <div style={{ fontSize: 14, color: look.muted, paddingTop: 6 }}>{IDEA_HELP}</div>}
      {note && (
        <div role="status" style={{ fontSize: 14, color: look.text, paddingTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{note.text}</span>
          {note.undoable && (
            <button
              type="button"
              onClick={claude.undo}
              style={{
                padding: '2px 10px', minHeight: variant === 'mobile' ? 32 : undefined, borderRadius: 6, border: `1px solid ${look.border}`,
                background: '#FFFFFF', color: look.text, fontSize: 14, fontWeight: 500, cursor: 'pointer',
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </>
  );
}

// The desktop modal's row under the composer: the button, the help line and the answer to the last tap.
export function SendToClaudeRow({ claude, hidden = false }) {
  if (!claude?.enabled || hidden) return null;
  return (
    <div style={{ padding: '8px 18px 0' }}>
      <SendToClaudeButton claude={claude} variant="desktop" />
      <SendToClaudeNote claude={claude} variant="desktop" />
    </div>
  );
}

// A stuck bar answer's one-tap send (GATE_IB_ANSWER_SEND_TO_CLAUDE). Same route and body shape as the box button, but the text
// is a GIVEN one: the owner's own question for that answer, captured when he pressed Ask. Nothing the bar or a tool wrote
// ever goes through here. Ten seconds of Undo follow a send; an Undo has no composer text to put back.
// `exchange` names the answer the send belongs to: a new one clears the last note.
export function useSendAnswerToClaude({ pageData, route, exchange }) {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [note, setNote] = useState(null); // { kind: 'sent' | 'duplicate' | 'error' | 'cancelled', text, id?, at?, undoable? }
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => { clearTimeout(timerRef.current); setNote(null); }, [exchange]);

  const send = useCallback(async (question, pasted) => {
    if (typeof question !== 'string' || !question.trim() || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const out = await adminFetch('/admin/claude-ideas', {
        method: 'POST',
        body: JSON.stringify({ text: question, page: { route }, ids: pickIds(pageData), pasted: pasted === true }),
      });
      if (out?.duplicate) {
        setNote({ kind: 'duplicate', text: 'You already sent this idea. Claude has it.' });
      } else if (out?.sent) {
        setNote({ kind: 'sent', text: 'Sent to Claude.', id: out.id, at: out.at, undoable: true });
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setNote((now) => (now?.kind === 'sent' ? { ...now, undoable: false } : now)), UNDO_MS);
      } else {
        setNote({ kind: 'error', text: "Couldn't send it. Try again." });
      }
    } catch {
      setNote({ kind: 'error', text: "Couldn't send it. Try again." });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [pageData, route]);

  const undo = useCallback(async () => {
    if (!note?.undoable || sendingRef.current) return;
    sendingRef.current = true;
    clearTimeout(timerRef.current);
    try {
      await adminFetch(`/admin/claude-ideas/${encodeURIComponent(note.id)}/cancel`, { method: 'POST', body: JSON.stringify({ at: note.at }) });
      setNote({ kind: 'cancelled', text: 'Cancelled.' });
    } catch (err) {
      const started = err?.status === 409 && err?.details?.error === 'started';
      setNote({ kind: 'error', text: started ? 'Claude already started on it.' : "Couldn't cancel. Claude has it." });
    } finally {
      sendingRef.current = false;
    }
  }, [note]);

  return { sending, note, send, undo };
}

// Under a stuck answer. `answer`: { gapId, question, pasted }; `claude`: useSendAnswerToClaude's result. A gap row exists:
// a muted line, no button (the Mac gap launcher already opens a Claude tab for it). Otherwise the button, when the owner's
// own question was captured.
export function SendAnswerToClaude({ answer, claude, variant = 'desktop' }) {
  const look = LOOK[variant];
  if (!answer) return null;
  if (answer.gapId !== null && answer.gapId !== undefined) {
    return <div style={{ fontSize: 14, color: look.muted, paddingTop: 10 }}>Claude has this as gap #{answer.gapId}.</div>;
  }
  if (!answer.question) return null;
  const { note } = claude;
  const showButton = !note || note.kind === 'error' || note.kind === 'cancelled';
  return (
    <div style={{ paddingTop: 10 }}>
      {showButton && (
        <span style={{ fontSize: 14, color: look.muted, marginRight: 10 }}>Bar couldn't do it?</span>
      )}
      {showButton && (
        <button
          type="button"
          data-testid="answer-send-to-claude"
          onClick={() => claude.send(answer.question, answer.pasted)}
          disabled={claude.sending}
          style={{
            padding: look.pad,
            minHeight: look.min || undefined,
            borderRadius: variant === 'mobile' ? 10 : 8,
            border: `1px solid ${look.border}`,
            background: '#FFFFFF',
            color: claude.sending ? '#A1A1AA' : look.text,
            fontSize: 14,
            fontWeight: 500,
            fontFamily: 'Roboto, Arial, sans-serif',
            cursor: claude.sending ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {claude.sending ? 'Sending…' : 'Send to Claude (free)'}
        </button>
      )}
      {note && (
        <div role="status" style={{ fontSize: 14, color: look.text, paddingTop: showButton ? 6 : 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{note.text}</span>
          {note.undoable && (
            <button
              type="button"
              onClick={claude.undo}
              style={{
                padding: '2px 10px', minHeight: variant === 'mobile' ? 44 : undefined, borderRadius: 6, border: `1px solid ${look.border}`,
                background: '#FFFFFF', color: look.text, fontSize: 14, fontWeight: 500, cursor: 'pointer',
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
