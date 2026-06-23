// Lawn Report V2 — fast tech closeout (Phase 3).
//
// Exception-based closeout: for a normal visit the tech confirms defaults and taps
// once. The customer report's charts/insights are built by the system from the
// structured data the tech already captured — the tech NEVER builds or edits the
// narrative here. Only genuine exceptions need a tap.
//
// Presentational + dark admin `D` palette (this lives inside CompletionPanel, an
// admin/tech surface — not the warm customer surface). Driven entirely by props so
// it can be unit-previewed and dropped into CompletionPanel without rewiring submit.

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

export default function FastCloseoutSummary({ summary = {}, onAddIssue, onComplete, completing = false }) {
  const {
    productsReady = false, protocolReady = false, photosReady = false,
    smsEnabled = true, aiAnalysisStatus = 'pending', // complete|pending|failed|not_required
    aiInsights = [], suggestedCustomerAction = '', exceptions = [], canComplete = false,
  } = summary;

  const aiNote = { complete: 'Analyzed', pending: 'Analyzing…', failed: 'Will finalize after', not_required: 'Not needed' }[aiAnalysisStatus];
  const activeExceptions = (exceptions || []).filter((e) => e.active);

  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: D.white, marginBottom: 10 }}>Ready to complete</div>

      <div style={{ display: 'grid', gap: 2, marginBottom: 12 }}>
        <Row ok={productsReady} label="Products" note={productsReady ? 'Default plan applied' : 'Add products'} />
        <Row ok={protocolReady} label="Protocol checks" note={protocolReady ? 'Complete' : 'Incomplete'} />
        <Row ok={photosReady} label="Photos" note={photosReady ? 'Captured' : 'Add photos'} />
        <Row ok={aiAnalysisStatus === 'complete' || aiAnalysisStatus === 'not_required'} label="AI analysis" note={aiNote} status={aiAnalysisStatus === 'complete' ? 'ready' : 'pending'} />
        <Row ok={smsEnabled} label="Customer report" note={smsEnabled ? 'Will send' : 'Send off'} />
      </div>

      {aiInsights.length ? (
        <div style={{ background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.07em', color: D.muted, fontWeight: 700, marginBottom: 6 }}>AI insight</div>
          {aiInsights.map((i, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: D.text, padding: '2px 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_COLOR[i.status] || D.muted, flex: 'none' }} />
              <span>{i.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 700, color: STATUS_COLOR[i.status] || D.muted, textTransform: 'capitalize' }}>{i.status}</span>
            </div>
          ))}
          {suggestedCustomerAction ? (
            <div style={{ marginTop: 8, fontSize: 13, color: D.muted, lineHeight: 1.45 }}>
              <span style={{ color: D.text, fontWeight: 700 }}>Customer next step: </span>{suggestedCustomerAction}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Exception chips — tap to attach a structured finding. Default is "No issues". */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
        {(exceptions || []).map((e) => (
          <button key={e.key} type="button" onClick={() => onAddIssue && onAddIssue(e.key)}
            style={{
              padding: '6px 11px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              border: `1px solid ${e.active ? STATUS_COLOR[e.status || 'watch'] : D.border}`,
              background: e.active ? `${STATUS_COLOR[e.status || 'watch']}22` : 'transparent',
              color: e.active ? STATUS_COLOR[e.status || 'watch'] : D.muted,
            }}>{e.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" onClick={onComplete} disabled={!canComplete || completing}
          style={{
            flex: 1, minHeight: 46, border: 'none', borderRadius: 10, cursor: canComplete && !completing ? 'pointer' : 'not-allowed',
            background: canComplete ? D.green : D.border, color: canComplete ? '#04150c' : D.muted,
            fontSize: 15, fontWeight: 800, opacity: completing ? 0.6 : 1,
          }}>
          {completing ? 'Completing…' : (activeExceptions.length ? `Complete + Send (${activeExceptions.length} issue${activeExceptions.length > 1 ? 's' : ''})` : 'Complete + Send')}
        </button>
        <button type="button" onClick={() => onAddIssue && onAddIssue(null)}
          style={{ minHeight: 46, padding: '0 14px', borderRadius: 10, cursor: 'pointer', background: 'transparent', border: `1px solid ${D.border}`, color: D.text, fontSize: 14, fontWeight: 700 }}>
          Advanced
        </button>
      </div>
      {aiAnalysisStatus === 'pending' ? (
        <div style={{ marginTop: 8, fontSize: 12, color: D.muted, lineHeight: 1.4 }}>
          AI analysis is still running — you can complete now and the report finalizes automatically when it’s done.
        </div>
      ) : null}
    </div>
  );
}
