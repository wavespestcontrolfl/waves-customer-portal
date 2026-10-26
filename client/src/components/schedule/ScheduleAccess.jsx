// Gate and access codes on the office schedule (GATE_SCHEDULE_ACCESS_CODES,
// owner ruling 2026-10-26; lines from lib/schedule-access.js).
//   ScheduleAccessLine     — one line on the Schedule list row
//   ScheduleAccessSection  — "Access" in the Details sheet (variant "sheet",
//                            with Wrong code / Add gate code) and in the
//                            desktop side panel (variant "panel", read only)
// The section also lists the codes the office accepted for this stop (door,
// call box, visitor pass…) from GET /admin/access-codes/visits/:id, the read
// the tech app's stop brief uses; that answers 404 while the access codes
// section is off, and the block then shows the day feed's lines alone.
// Wrong code and Add gate code post to the routes the tech app uses
// (POST /admin/neighborhood-access/visits/:id/entries[/:entryId/wrong],
// GATE_NEIGHBORHOOD_TECH_ACTIONS); the row says when they apply
// (`neighborhoodGateActions`, and `neighborhoodEntryId` on a code line).

import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { adminFetch } from '../../utils/admin-fetch';
import { withPassLinks } from '../../pages/tech/passLinks';
import { ACCESS_KIND_LABELS, acceptedRowsFor, accessLinesOf, scheduleAccessOn } from '../../lib/schedule-access';

const WARN = { background: '#FEF3C7', border: '#FCD34D', text: '#854D0E' };

function lineTag(line) {
  if (!line.neighborhood) return null;
  return line.unconfirmed ? 'confirm on site' : 'neighborhood';
}

// The list row: every code of the stop on one wrapping line, under the time.
// Amber when a neighborhood code is not confirmed yet. Rendered inside the
// row's button (phrasing content only), so a tap on it opens the stop.
export function ScheduleAccessLine({ service }) {
  const lines = accessLinesOf(service);
  if (!lines.length) return null;
  const warn = lines.some((l) => l.unconfirmed);
  return (
    <span
      data-testid="schedule-access-line"
      className={`flex items-center flex-wrap rounded-xs border-hairline border-solid ${warn ? '' : 'bg-zinc-50 border-zinc-200'}`}
      style={{
        marginTop: 8, padding: '6px 10px', gap: '4px 8px', fontSize: 14,
        ...(warn ? { background: WARN.background, borderColor: WARN.border } : {}),
      }}
    >
      <KeyRound size={15} strokeWidth={1.75} aria-hidden="true" style={{ color: warn ? WARN.text : '#52525B', flexShrink: 0 }} />
      {lines.map((line, i) => (
        <span key={line.key} className="inline-flex items-baseline flex-wrap" style={{ gap: 6 }}>
          {i > 0 && <span aria-hidden="true" className="text-ink-tertiary">·</span>}
          <span className="text-ink-secondary">{line.label}</span>
          <span className={line.codeLike ? 'font-mono font-medium text-zinc-900' : 'text-zinc-900'} style={{ fontSize: line.codeLike ? 15 : 14, overflowWrap: 'anywhere' }}>
            {line.value}
          </span>
          {lineTag(line) && (
            <span style={{ fontSize: 14, color: line.unconfirmed ? WARN.text : undefined, fontWeight: line.unconfirmed ? 500 : undefined }} className={line.unconfirmed ? '' : 'text-ink-secondary'}>
              {lineTag(line)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

const sheetButton = 'rounded-sm bg-white text-zinc-900 border border-hairline border-solid border-zinc-300 font-medium u-focus-ring disabled:opacity-50';
const darkButton = 'rounded-sm border-0 bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-50';

function useAcceptedCodes(service) {
  const on = scheduleAccessOn(service);
  const visitId = service?.id ? String(service.id) : '';
  const [loaded, setLoaded] = useState({ key: '', rows: [] });
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!on || !visitId) return undefined;
    let cancelled = false;
    setFailed(false);
    adminFetch(`/admin/access-codes/visits/${encodeURIComponent(visitId)}`)
      .then((data) => {
        if (!cancelled) setLoaded({ key: visitId, rows: Array.isArray(data?.accessCodes) ? data.accessCodes : [] });
      })
      .catch((err) => {
        if (cancelled) return;
        // Off (404) or not this login's visit (403): the day feed's lines alone.
        if (err && (err.status === 404 || err.status === 403)) setLoaded({ key: visitId, rows: [] });
        else setFailed(true);
      });
    return () => { cancelled = true; };
  }, [on, visitId, attempt]);
  // Rows read for another stop never show on this one.
  return { rows: loaded.key === visitId ? loaded.rows : [], failed, retry: () => setAttempt((n) => n + 1) };
}

// Wrong code and Add gate code for one visit. After a change the parent's
// `onChanged` refetches the day and resolves to the visit's fresh row, which
// `onFresh` hands to the section.
function useGateActions(visitId, onChanged, onFresh) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const refresh = async () => {
    try {
      const row = await onChanged?.();
      if (row) onFresh(row);
    } catch { /* the next load of the day shows it */ }
  };
  const post = async (suffix, body, ok) => {
    setBusy(true);
    setNote(null);
    try {
      await adminFetch(`/admin/neighborhood-access/visits/${encodeURIComponent(visitId)}/entries${suffix}`, {
        method: 'POST', body: JSON.stringify(body),
      });
      setNote({ ok });
      await refresh();
      return true;
    } catch (err) {
      setNote({ error: err?.message || 'Could not save. Try again.' });
      // The code changed under this screen: show the current one.
      if (err?.code === 'entry_changed') await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    note,
    clearNote: () => setNote(null),
    reportWrong: (line) => post(`/${encodeURIComponent(line.entryId)}/wrong`, { code: line.entryCode }, 'Reported. The office will check that code.'),
    add: (code) => post('', { code }, "Saved to this neighborhood's gate codes."),
  };
}

const valueClass = (codeLike) => (codeLike ? 'font-mono font-medium text-zinc-900' : 'text-zinc-900');

function PanelLine({ line }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap mt-1">
      <span className="text-14 text-ink-secondary">{line.label}</span>
      <span className={valueClass(line.codeLike)} style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{line.value}</span>
      {lineTag(line) && <span className="text-14" style={{ color: line.unconfirmed ? WARN.text : undefined }}>{lineTag(line)}</span>}
    </div>
  );
}

function WrongCodeControl({ line, actions, onAsk }) {
  if (line.reportedWrong) return <span className="text-ink-secondary" style={{ fontSize: 14, flexShrink: 0 }}>Reported wrong</span>;
  return (
    <button type="button" className={sheetButton} style={{ padding: '6px 12px', fontSize: 14, flexShrink: 0 }} disabled={actions.busy} onClick={onAsk}>
      Wrong code
    </button>
  );
}

// A wrong-code report is confirmed inside the sheet, never with
// window.confirm, so the operator reads the exact code before it is sent.
function WrongCodeConfirm({ line, actions, onDone }) {
  return (
    <div role="group" aria-label="Confirm wrong code" className="mt-2 rounded-sm border border-hairline border-solid border-zinc-300 bg-zinc-50" style={{ padding: '10px 12px' }}>
      <div className="text-zinc-900" style={{ fontSize: 14 }}>Report {line.value} as not working? The office will check it.</div>
      <div className="flex gap-2 mt-2">
        <button type="button" className={darkButton} style={{ padding: '8px 16px', fontSize: 14 }} disabled={actions.busy} onClick={() => { onDone(); actions.reportWrong(line); }}>
          Report
        </button>
        <button type="button" className={sheetButton} style={{ padding: '8px 16px', fontSize: 14 }} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function SheetLine({ line, actions, confirming, onConfirming }) {
  const label = [line.label, lineTag(line)].filter(Boolean).join(' · ');
  return (
    <div className="py-2 border-b border-hairline border-zinc-200">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ink-secondary" style={{ fontSize: 14, color: line.unconfirmed ? WARN.text : undefined }}>{label}</div>
          <div className={valueClass(line.codeLike)} style={{ fontSize: line.codeLike ? 18 : 15, overflowWrap: 'anywhere' }}>{line.value}</div>
        </div>
        {actions && line.entryId && <WrongCodeControl line={line} actions={actions} onAsk={() => onConfirming(line.key)} />}
      </div>
      {actions && confirming && <WrongCodeConfirm line={line} actions={actions} onDone={() => onConfirming(null)} />}
    </div>
  );
}

function AcceptedRow({ row, panel }) {
  const label = ACCESS_KIND_LABELS[row.kind] || 'Access code';
  const block = panel ? undefined : 'block';
  return (
    <div className={panel ? 'mt-1' : 'py-2 border-b border-hairline border-zinc-200'}>
      <div className={panel ? 'flex items-baseline gap-2 flex-wrap' : ''}>
        <span className="text-ink-secondary" style={{ fontSize: 14, display: block }}>{label}</span>
        {row.code && <span className="font-mono font-medium text-zinc-900" style={{ fontSize: panel ? 15 : 18, display: block }}>{row.code}</span>}
      </div>
      {row.instructions && (
        <div className="text-zinc-900" style={{ fontSize: 14, overflowWrap: 'anywhere' }}>
          {withPassLinks(row.instructions, { className: 'underline text-zinc-900' })}
        </div>
      )}
    </div>
  );
}

function AddGateCode({ actions }) {
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const typed = code.trim();
  const close = () => { setAdding(false); setCode(''); };
  const save = async (e) => {
    e.preventDefault();
    if (typed && !actions.busy && await actions.add(typed)) close();
  };
  if (!adding) {
    return (
      <button type="button" className={`w-full mt-3 ${sheetButton}`} style={{ padding: '13px 20px', fontSize: 15 }} disabled={actions.busy} onClick={() => { setAdding(true); actions.clearNote(); }}>
        Add gate code
      </button>
    );
  }
  return (
    <form onSubmit={save} className="flex flex-wrap gap-2 mt-3">
      <input
        aria-label="Neighborhood gate code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode="tel"
        autoComplete="off"
        maxLength={12}
        placeholder="Gate code"
        className="bg-white border-hairline border-zinc-300 rounded-sm px-3 text-ink-primary focus:outline-none focus:ring-2 focus:ring-zinc-900"
        style={{ fontSize: 16, flex: '1 1 140px', minWidth: 0, height: 44 }}
      />
      <button type="submit" className={darkButton} style={{ padding: '0 18px', fontSize: 14, height: 44 }} disabled={actions.busy || !typed}>
        {actions.busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className={sheetButton} style={{ padding: '0 14px', fontSize: 14, height: 44 }} disabled={actions.busy} onClick={() => { close(); actions.clearNote(); }}>
        Cancel
      </button>
    </form>
  );
}

function ActionNote({ note }) {
  if (note?.ok) return <div role="status" className="text-ink-secondary" style={{ fontSize: 14, marginTop: 8 }}>{note.ok}</div>;
  if (note?.error) return <div role="alert" className="text-alert-fg" style={{ fontSize: 14, marginTop: 8 }}>{note.error}</div>;
  return null;
}

function LoadFailed({ onRetry }) {
  return (
    <div role="alert" className="text-ink-secondary" style={{ fontSize: 14, marginTop: 6 }}>
      Could not load this stop's accepted codes.{' '}
      <button type="button" className="underline bg-transparent border-0 p-0 text-zinc-900" onClick={onRetry}>Try again</button>
    </div>
  );
}

// `onChanged` (Details only) refetches the day after a gate change and
// resolves to this stop's fresh row, or null; the section then shows the
// fresh row's codes while the sheet keeps its own snapshot.
export function ScheduleAccessSection({ service, variant = 'sheet', actions = false, onChanged }) {
  const [fresh, setFresh] = useState(null);
  const current = fresh && service && String(fresh.id) === String(service.id) ? fresh : service;
  const lines = accessLinesOf(current);
  const accepted = useAcceptedCodes(current);
  const gate = useGateActions(current?.id, onChanged, setFresh);
  const [confirming, setConfirming] = useState(null);
  const panel = variant === 'panel';
  const rows = acceptedRowsFor(current, accepted.rows, lines);
  const act = actions && !panel ? gate : null;
  const canAdd = !!act && current?.neighborhoodGateActions === true;

  if (!scheduleAccessOn(current)) return null;
  if (!lines.length && !rows.length && !canAdd && !accepted.failed && !gate.note) return null;

  const items = (
    <div data-testid={`schedule-access-${variant}`}>
      {lines.map((line) => (panel
        ? <PanelLine key={line.key} line={line} />
        : <SheetLine key={line.key} line={line} actions={act} confirming={confirming === line.key} onConfirming={setConfirming} />))}
      {rows.map((row) => <AcceptedRow key={row.id} row={row} panel={panel} />)}
      {accepted.failed && <LoadFailed onRetry={accepted.retry} />}
      {canAdd && <AddGateCode actions={gate} />}
      <ActionNote note={gate.note} />
    </div>
  );

  if (panel) {
    return (
      <div className="mt-4">
        <div className="u-label text-ink-tertiary mb-1">Access</div>
        {items}
      </div>
    );
  }
  return (
    <section className="mt-8" aria-label="Access">
      <div className="text-zinc-900 font-medium" style={{ fontSize: 20, marginBottom: 6 }}>Access</div>
      {items}
    </section>
  );
}
