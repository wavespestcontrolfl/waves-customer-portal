// Tree & Shrub — exception-based tech closeout summary.
//
// After the AI scores the visit's photos, the tech reviews the flagged findings and
// taps once. Normal visit → no flags → one-tap "Complete + Send". Each AI-flagged
// SIGNAL gets three actions: Confirm monitor (keep it on the report, tech-confirmed),
// Hide (drop it — a false read), or Edit (tweak the wording). The tech NEVER writes a
// full narrative — the customer report is built by the system from the scores.
//
// Presentational + dark admin `D` palette (lives inside the tech/admin completion
// surface, not the warm customer surface). Driven by props + local decision state;
// emits the reviewed decisions on complete so CompletionPanel can submit them.

import { useState, useEffect } from 'react';

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};
const STATUS_COLOR = { ready: D.green, watch: D.amber, attention: D.red, pending: D.muted };

function Row({ ok, label, note, status }) {
  const color = status ? STATUS_COLOR[status] : (ok ? D.green : D.amber);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
      <span style={{
        width: 20, height: 20, borderRadius: 999, flex: 'none', display: 'grid', placeItems: 'center',
        background: ok ? `${D.green}22` : `${color}22`, color, fontSize: 13, fontWeight: 800,
      }}>{ok ? '✓' : '!'}</span>
      <span style={{ fontSize: 14, color: D.text, fontWeight: 600 }}>{label}</span>
      {note ? <span style={{ fontSize: 13, color: D.muted, marginLeft: 'auto' }}>{note}</span> : null}
    </div>
  );
}

function ActionBtn({ children, active, tone = D.teal, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '6px 11px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
      border: `1px solid ${active ? tone : D.border}`,
      background: active ? `${tone}22` : 'transparent',
      color: active ? tone : D.muted,
    }}>{children}</button>
  );
}

// One AI-flagged finding with Confirm monitor / Hide / Edit. action: monitor|confirmed|hidden.
function FindingCard({ finding, decision, onChange }) {
  const [editing, setEditing] = useState(false);
  const action = decision.action || 'monitor';
  const hidden = action === 'hidden';
  const tone = STATUS_COLOR[finding.status] || D.amber;
  return (
    <div style={{
      background: D.bg, border: `1px solid ${hidden ? D.border : tone + '55'}`, borderRadius: 10,
      padding: '10px 12px', marginBottom: 8, opacity: hidden ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: tone, flex: 'none' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: D.text, textDecoration: hidden ? 'line-through' : 'none' }}>{finding.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: action === 'confirmed' ? D.green : (hidden ? D.muted : tone) }}>
          {action === 'confirmed' ? 'Will monitor' : hidden ? 'Hidden' : 'Flagged'}
        </span>
      </div>
      {editing ? (
        <textarea
          value={decision.detail ?? finding.detail}
          onChange={(e) => onChange({ ...decision, detail: e.target.value })}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', background: D.card, color: D.text, border: `1px solid ${D.border}`, borderRadius: 8, padding: '7px 9px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', marginBottom: 8 }}
        />
      ) : (
        <div style={{ fontSize: 13, color: D.muted, lineHeight: 1.45, marginBottom: 8 }}>{decision.detail ?? finding.detail}</div>
      )}
      <div style={{ display: 'flex', gap: 7 }}>
        <ActionBtn active={action === 'confirmed'} tone={D.green} onClick={() => onChange({ ...decision, action: action === 'confirmed' ? 'monitor' : 'confirmed' })}>Confirm monitor</ActionBtn>
        <ActionBtn active={hidden} tone={D.red} onClick={() => onChange({ ...decision, action: hidden ? 'monitor' : 'hidden' })}>Hide</ActionBtn>
        <ActionBtn active={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit'}</ActionBtn>
      </div>
    </div>
  );
}

export default function TreeShrubCloseoutSummary({ summary = {}, onComplete, onDecisionsChange, reviewKey = '', completing = false }) {
  const {
    productsReady = false, protocolReady = false, photoCount = 0,
    areasTreated = '', smsEnabled = true, aiAnalysisStatus = 'pending',
    aiSummary = '', suggestedCustomerAction = '', findings = [], canComplete = false,
  } = summary;

  // Per-finding decision state, seeded from the AI defaults.
  const [decisions, setDecisions] = useState(() => {
    const m = {};
    for (const f of findings) m[f.key] = { action: f.defaultAction || 'monitor', detail: f.detail };
    return m;
  });
  const setOne = (key, next) => setDecisions((d) => ({ ...d, [key]: next }));

  // Reset decisions whenever a NEW preview arrives (the tech swapped photos) —
  // otherwise a prior "hide" on a same-key finding would silently carry to the new
  // signal. Keyed primarily on the per-preview reviewKey (photo fingerprint), and on
  // key+score+status as a fallback, since the detail text is a fixed category string
  // and wouldn't change when only the score/status of the same category changes.
  const findingsSig = findings.map((f) => `${f.key}:${f.status || ''}:${f.score ?? ''}`).join('|');
  useEffect(() => {
    const m = {};
    for (const f of findings) m[f.key] = { action: f.defaultAction || 'monitor', detail: f.detail };
    setDecisions(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewKey, findingsSig]);

  const aiNote = { complete: 'Complete', pending: 'Analyzing…', failed: 'Will finalize after', not_required: 'Not needed' }[aiAnalysisStatus];
  const photosReady = photoCount >= 2;
  const kept = findings.filter((f) => (decisions[f.key]?.action || 'monitor') !== 'hidden');
  const customerAction = kept.length ? suggestedCustomerAction : 'No action needed';

  const currentDecisions = findings.map((f) => ({
    key: f.key,
    action: decisions[f.key]?.action || 'monitor',
    detail: decisions[f.key]?.detail ?? f.detail,
  }));

  // Report decisions to the parent on every change so they're captured even when the
  // tech completes via the panel's always-visible sticky footer (not this button).
  useEffect(() => {
    if (onDecisionsChange) onDecisionsChange(currentDecisions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions, findings]);

  const handleComplete = () => {
    if (onComplete) onComplete({ findings: currentDecisions });
  };

  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: D.white, marginBottom: 10 }}>Tree &amp; Shrub complete</div>

      <div style={{ display: 'grid', gap: 2, marginBottom: 12 }}>
        <Row ok={productsReady} label="Products" note={productsReady ? 'Default plan applied' : 'Add products'} />
        {areasTreated ? <Row ok label="Areas treated" note={areasTreated} /> : null}
        <Row ok={photosReady} label="Photos uploaded" note={String(photoCount)} />
        <Row ok={aiAnalysisStatus === 'complete' || aiAnalysisStatus === 'not_required'} label="AI photo review" note={aiNote} status={aiAnalysisStatus === 'complete' ? 'ready' : 'pending'} />
        <Row ok={protocolReady} label="Protocol" note={protocolReady ? 'Complete' : 'Incomplete'} />
        <Row ok={smsEnabled} label="Customer report" note={smsEnabled ? 'Will send' : 'Send off'} />
      </div>

      {/* AI summary line */}
      {aiSummary ? (
        <div style={{ background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: '9px 12px', marginBottom: findings.length ? 10 : 12 }}>
          <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.07em', color: D.muted, fontWeight: 700 }}>AI summary </span>
          <span style={{ fontSize: 13.5, color: D.text }}>{aiSummary}</span>
        </div>
      ) : null}

      {/* Flagged findings — confirm / hide / edit each. Empty on a clean visit. */}
      {findings.map((f) => (
        <FindingCard key={f.key} finding={f} decision={decisions[f.key] || { action: 'monitor', detail: f.detail }} onChange={(next) => setOne(f.key, next)} />
      ))}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '6px 0 14px' }}>
        <span style={{ fontSize: 12.5, color: D.muted, fontWeight: 700 }}>Customer action:</span>
        <span style={{ fontSize: 13.5, color: D.text }}>{customerAction}</span>
      </div>

      <button type="button" onClick={handleComplete} disabled={!canComplete || completing}
        style={{
          width: '100%', minHeight: 46, border: 'none', borderRadius: 10, cursor: canComplete && !completing ? 'pointer' : 'not-allowed',
          background: canComplete ? D.green : D.border, color: canComplete ? '#04150c' : D.muted,
          fontSize: 15, fontWeight: 800, opacity: completing ? 0.6 : 1,
        }}>
        {completing ? 'Completing…' : 'Complete + Send'}
      </button>
      {aiAnalysisStatus === 'pending' ? (
        <div style={{ marginTop: 8, fontSize: 12, color: D.muted, lineHeight: 1.4 }}>
          AI photo review is still running — you can complete now and the report finalizes automatically when it’s done.
        </div>
      ) : null}
    </div>
  );
}
