// Consultation closeout — the technician's read of a Waves Assessment visit
// (warm / cold / lost, interests, a soft quote, a follow-up date). Shared by
// the tech portal (dark) and the admin appointment sheet (light).
//
// Backend: GET/POST /api/admin/consultations/:scheduledServiceId/outcome
// (server/routes/admin-consultations.js). `request(path, options)` is the
// caller's bearer-token fetch — it resolves parsed JSON and throws an Error
// carrying `status` on non-2xx.
//
// Won is never tapped: the server stamps it when a real booking or estimate
// accept closes, and refuses edits afterwards (409 ALREADY_WON). A no-show
// loss is set only by the visit's no-show status. Both render read-only.
// Everything here is internal — quote notes never reach the customer.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TIMEZONE } from '../lib/timezone';

export const OUTCOME_OPTIONS = [
  { value: 'warm', label: 'Warm', hint: 'Interested — wants a quote' },
  { value: 'cold', label: 'Cold', hint: 'Not now — follow up later' },
  { value: 'lost', label: 'Lost', hint: 'Not buying' },
];

export const LOST_REASON_OPTIONS = [
  { value: 'price', label: 'Price' },
  { value: 'competitor', label: 'Competitor' },
  { value: 'diy', label: 'DIY' },
  { value: 'not_ready', label: 'Not ready' },
  { value: 'other', label: 'Other' },
];

export const INTEREST_OPTIONS = [
  { value: 'pest_quarterly', label: 'Quarterly pest' },
  { value: 'pest_bimonthly', label: 'Bi-monthly pest' },
  { value: 'pest_monthly', label: 'Monthly pest' },
  { value: 'lawn', label: 'Lawn' },
  { value: 'mosquito', label: 'Mosquito' },
  { value: 'termite', label: 'Termite' },
  { value: 'rodent', label: 'Rodent' },
];

export const CADENCE_OPTIONS = [
  { value: 'month', label: '/ month' },
  { value: 'quarter', label: '/ quarter' },
  { value: 'visit', label: '/ visit' },
  { value: 'year', label: '/ year' },
];

const PALETTES = {
  dark: {
    overlay: 'rgba(2, 6, 23, 0.72)', bg: '#0f1923', card: '#1e293b', border: '#334155',
    text: '#e2e8f0', muted: '#94a3b8', accent: '#0ea5e9', accentText: '#0f1923',
    danger: '#f87171', inputBg: '#0f1923',
  },
  light: {
    overlay: 'rgba(24, 24, 27, 0.45)', bg: '#ffffff', card: '#fafafa', border: '#d4d4d8',
    text: '#18181b', muted: '#71717a', accent: '#18181b', accentText: '#ffffff',
    danger: '#b91c1c', inputBg: '#ffffff',
  },
};

// A stored timestamp → the ET calendar day a date input shows.
function etDateOf(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function parseInterests(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formFromRow(row) {
  return {
    outcome: row?.outcome || '',
    lostReason: row?.lost_reason || '',
    interests: parseInterests(row?.interests),
    quotedAmount: row?.quoted_amount != null ? String(Number(row.quoted_amount)) : '',
    quotedCadence: row?.quoted_cadence || '',
    quoteNotes: row?.quote_notes || '',
    followUpDate: etDateOf(row?.follow_up_at),
  };
}

// What the POST sends for follow_up_at:
//  - lost → nothing (a loss has no callback).
//  - a date the user picked → 9 AM ET that day (naive local time; the
//    server reads naive values as ET).
//  - untouched on an unchanged outcome → the stored instant, as-is.
//  - untouched after the outcome changed, or cleared → null, so the server
//    re-applies its default (warm +3 days, cold +30 days) for the NEW
//    outcome instead of carrying the old outcome's date across.
export function followUpPayload({ outcome, followUpDate, followUpTouched, loadedRow }) {
  if (outcome === 'lost') return null;
  if (followUpTouched) return followUpDate ? `${followUpDate}T09:00` : null;
  if (loadedRow && loadedRow.outcome === outcome && loadedRow.follow_up_at) {
    return new Date(loadedRow.follow_up_at).toISOString();
  }
  return null;
}

export function buildOutcomePayload(form, { followUpTouched = false, loadedRow = null } = {}) {
  return {
    outcome: form.outcome,
    lostReason: form.outcome === 'lost' ? form.lostReason || null : null,
    interests: form.interests,
    quotedAmount: form.quotedAmount.trim() === '' ? null : form.quotedAmount.trim(),
    quotedCadence: form.quotedCadence || null,
    quoteNotes: form.quoteNotes.trim() === '' ? null : form.quoteNotes.trim(),
    followUpAt: followUpPayload({
      outcome: form.outcome,
      followUpDate: form.followUpDate,
      followUpTouched,
      loadedRow,
    }),
  };
}

function readOnlyReason(row) {
  if (!row) return null;
  if (row.outcome === 'won') {
    const when = row.won_at ? ` on ${etDateOf(row.won_at)}` : '';
    const via = row.won_via ? ` (${String(row.won_via).replace(/_/g, ' ')})` : '';
    return `Won${when}${via}. This consultation converted, so its outcome is locked.`;
  }
  if (row.outcome === 'lost' && row.lost_reason === 'no_show') {
    return 'Lost — no-show. The visit was marked no-show, so there is nothing to record.';
  }
  return null;
}

function sheetStyles(c) {
  return {
    label: { display: 'block', fontSize: 14, fontWeight: 600, color: c.text, margin: '18px 0 8px' },
    hint: { fontSize: 14, color: c.muted, margin: '6px 0 0' },
    input: {
      width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '10px 12px', fontSize: 16,
      borderRadius: 6, border: `1px solid ${c.border}`, background: c.inputBg, color: c.text,
    },
    pill: (selected) => ({
      minHeight: 44, padding: '8px 14px', borderRadius: 999, fontSize: 14, fontWeight: 600,
      cursor: 'pointer', border: `1px solid ${selected ? c.accent : c.border}`,
      background: selected ? c.accent : 'transparent', color: selected ? c.accentText : c.text,
    }),
  };
}

function validationErrorOf(form) {
  if (!form.outcome) return 'Pick warm, cold or lost';
  if (form.outcome === 'lost' && !form.lostReason) return 'Pick why it was lost';
  return null;
}

function ChoiceGroup({ id, label, options, isSelected, onPick, radio, st, pillStyle }) {
  return (
    <>
      <span style={st.label} id={id}>{label}</span>
      <div role={radio ? 'radiogroup' : 'group'} aria-labelledby={id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            {...(radio ? { role: 'radio', 'aria-checked': isSelected(o.value) } : { 'aria-pressed': isSelected(o.value) })}
            onClick={() => onPick(o.value)}
            style={{ ...st.pill(isSelected(o.value)), ...pillStyle }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}

function OutcomeFields({ form, set, onFollowUpChange, st }) {
  const toggleInterest = (value) => set({
    interests: form.interests.includes(value)
      ? form.interests.filter((v) => v !== value)
      : [...form.interests, value],
  });
  const outcomeHint = OUTCOME_OPTIONS.find((o) => o.value === form.outcome)?.hint;
  return (
    <>
      <ChoiceGroup
        id="co-outcome-label" label="How did it go?" options={OUTCOME_OPTIONS} radio st={st}
        isSelected={(v) => form.outcome === v} onPick={(v) => set({ outcome: v })} pillStyle={{ flex: '1 1 30%' }}
      />
      {outcomeHint && <p style={st.hint}>{outcomeHint}</p>}
      <p style={st.hint}>Won is recorded automatically when they book or accept an estimate.</p>

      {form.outcome === 'lost' && (
        <ChoiceGroup
          id="co-lost-label" label="Why?" options={LOST_REASON_OPTIONS} radio st={st}
          isSelected={(v) => form.lostReason === v} onPick={(v) => set({ lostReason: v })}
        />
      )}

      <ChoiceGroup
        id="co-interests-label" label="Interested in" options={INTEREST_OPTIONS} st={st}
        isSelected={(v) => form.interests.includes(v)} onPick={toggleInterest}
      />

      <label style={st.label} htmlFor="co-quoted-amount">Price quoted (optional)</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id="co-quoted-amount"
          type="text"
          inputMode="decimal"
          placeholder="$"
          value={form.quotedAmount}
          onChange={(e) => set({ quotedAmount: e.target.value.replace(/[^0-9.]/g, '') })}
          style={{ ...st.input, flex: 1 }}
        />
        <select
          aria-label="Quoted per"
          value={form.quotedCadence}
          onChange={(e) => set({ quotedCadence: e.target.value })}
          style={{ ...st.input, flex: 1 }}
        >
          <option value="">per…</option>
          {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <label style={st.label} htmlFor="co-quote-notes">Notes for the quote</label>
      <textarea
        id="co-quote-notes"
        rows={3}
        value={form.quoteNotes}
        onChange={(e) => set({ quoteNotes: e.target.value })}
        style={{ ...st.input, resize: 'vertical' }}
      />
      <p style={st.hint}>Internal only. The customer never sees these.</p>

      {form.outcome !== 'lost' && (
        <>
          <label style={st.label} htmlFor="co-follow-up">Follow up on</label>
          <input
            id="co-follow-up"
            type="date"
            value={form.followUpDate}
            onChange={(e) => onFollowUpChange(e.target.value)}
            style={st.input}
          />
          <p style={st.hint}>Leave blank for the default: warm in 3 days, cold in 30.</p>
        </>
      )}
    </>
  );
}

// Loads the recorded outcome. A 404 means nothing is recorded yet (the save
// reports a missing visit itself); any other failure is shown, never
// silently treated as a blank form.
function useRecordedOutcome(serviceId, request) {
  const [state, setState] = useState({ loading: true, error: '', row: null });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', row: null });
    request(`/admin/consultations/${encodeURIComponent(serviceId)}/outcome`)
      .then((data) => { if (!cancelled) setState({ loading: false, error: '', row: data?.outcome || null }); })
      .catch((err) => {
        if (cancelled) return;
        setState(err?.status === 404
          ? { loading: false, error: '', row: null }
          : { loading: false, error: err?.message || 'Could not load this consultation', row: null });
      });
    return () => { cancelled = true; };
  }, [serviceId, request]);
  return state;
}

export default function ConsultationOutcomeSheet({
  serviceId,
  customerName,
  request,
  onClose,
  onSaved,
  theme = 'dark',
}) {
  const c = PALETTES[theme] || PALETTES.dark;
  const st = sheetStyles(c);
  const { loading, error: loadError, row: loadedRow } = useRecordedOutcome(serviceId, request);
  const [form, setForm] = useState(formFromRow(null));
  const [followUpTouched, setFollowUpTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => { setForm(formFromRow(loadedRow)); }, [loadedRow]);

  const locked = readOnlyReason(loadedRow);
  const set = (patch) => { setSaveError(''); setForm((f) => ({ ...f, ...patch })); };
  const validationError = validationErrorOf(form);
  const blocked = saving || !!validationError;

  const save = async () => {
    if (blocked || locked) return;
    setSaving(true);
    setSaveError('');
    try {
      const data = await request(`/admin/consultations/${encodeURIComponent(serviceId)}/outcome`, {
        method: 'POST',
        body: JSON.stringify(buildOutcomePayload(form, { followUpTouched, loadedRow })),
      });
      onSaved?.(data?.outcome || null);
    } catch (err) {
      setSaveError(err?.message || 'Save failed — try again');
    } finally {
      setSaving(false);
    }
  };

  const ready = !loading && !loadError;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Consultation outcome"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: c.overlay,
        display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
      }}
    >
      <div style={{
        background: c.bg, color: c.text, width: '100%', maxWidth: 560, maxHeight: '100%',
        overflowY: 'auto', borderRadius: '12px 12px 0 0', border: `1px solid ${c.border}`,
        padding: '16px 16px calc(24px + env(safe-area-inset-bottom, 0px))', boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Consultation outcome</p>
            {customerName && (
              <p style={{ margin: '2px 0 0', fontSize: 14, color: c.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {customerName}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} disabled={saving} style={{ ...st.pill(false), flexShrink: 0 }}>
            Close
          </button>
        </div>

        {loading && <p style={{ ...st.hint, marginTop: 20 }}>Loading…</p>}
        {loadError && <p role="alert" style={{ color: c.danger, fontSize: 14, marginTop: 20 }}>{loadError}</p>}
        {ready && locked && <p style={{ fontSize: 16, marginTop: 20, lineHeight: 1.5 }}>{locked}</p>}

        {ready && !locked && (
          <>
            <OutcomeFields
              form={form}
              set={set}
              st={st}
              onFollowUpChange={(value) => { setFollowUpTouched(true); set({ followUpDate: value }); }}
            />
            {saveError && <p role="alert" style={{ color: c.danger, fontSize: 14, marginTop: 16 }}>{saveError}</p>}
            <button
              type="button"
              onClick={save}
              disabled={blocked}
              style={{
                width: '100%', minHeight: 48, marginTop: 20, borderRadius: 6, border: 'none',
                fontSize: 16, fontWeight: 700, cursor: blocked ? 'default' : 'pointer',
                background: c.accent, color: c.accentText, opacity: blocked ? 0.55 : 1,
              }}
            >
              {saving ? 'Saving…' : validationError || (loadedRow ? 'Update outcome' : 'Save outcome')}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
