import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });

const STATUS_CONFIG = {
  processed: { label: 'Processed', color: D.green },
  pending: { label: 'Pending', color: D.amber },
  voicemail: { label: 'Voicemail', color: D.muted },
  spam: { label: 'Spam', color: D.red },
  extraction_failed: { label: 'Failed', color: D.red },
  no_transcription: { label: 'No Transcript', color: D.muted },
};

const SENTIMENT_CONFIG = {
  positive: { label: 'Positive', color: D.green },
  neutral: { label: 'Neutral', color: D.amber },
  negative: { label: 'Negative', color: D.red },
  frustrated: { label: 'Frustrated', color: D.red },
};

export default function CallRecordingsPanel() {
  const [stats, setStats] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState('');

  const loadData = useCallback(async () => {
    const [s, r] = await Promise.all([
      adminFetch('/admin/call-recordings/stats').catch(() => null),
      adminFetch('/admin/call-recordings/recordings?limit=30').catch(() => ({ recordings: [] })),
    ]);
    setStats(s);
    setRecordings(r.recordings || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  const processAll = async () => {
    setProcessing(true);
    try {
      const result = await adminFetch('/admin/call-recordings/process-all', { method: 'POST' });
      showToast(`Processed ${result.processed} recording(s)`);
      loadData();
    } catch (e) { showToast(`Failed: ${e.message}`); }
    setProcessing(false);
  };

  const processOne = async (callSid) => {
    try {
      await adminFetch(`/admin/call-recordings/process/${callSid}`, { method: 'POST' });
      showToast('Recording processed');
      loadData();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading call recordings...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: D.white }}>Call Recording Processor</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>AI transcription + customer extraction — replaces Zapier</div>
        </div>
        <button onClick={processAll} disabled={processing} style={{ ...sBtn(D.teal, D.white), opacity: processing ? 0.5 : 1 }}>
          {processing ? 'Processing...' : 'Process All Pending'}
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Recordings', value: stats.totalRecordings, color: D.white },
            { label: 'Processed', value: stats.processed, color: D.green },
            { label: 'Pending', value: stats.pending, color: D.amber },
            { label: 'Voicemail', value: stats.voicemail, color: D.muted },
            { label: 'Spam', value: stats.spam, color: D.red },
            { label: 'Appointments', value: stats.appointments, color: D.teal },
            { label: 'Last 7d', value: stats.last7d, color: D.purple },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, flex: '1 1 110px', minWidth: 110, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Recordings list + detail */}
      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
        <div>
          {recordings.length === 0 ? (
            <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No call recordings found</div>
          ) : recordings.map(r => {
            const st = STATUS_CONFIG[r.processing_status] || STATUS_CONFIG.pending;
            const extraction = r.ai_extraction ? (typeof r.ai_extraction === 'string' ? JSON.parse(r.ai_extraction) : r.ai_extraction) : null;
            return (
              <div key={r.id} onClick={() => setSelected(r)} style={{
                ...sCard, marginBottom: 8, cursor: 'pointer',
                borderColor: selected?.id === r.id ? D.teal : D.border,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>
                      {r.first_name ? `${r.first_name} ${r.last_name || ''}` : r.from_phone}
                    </div>
                    <div style={{ fontSize: 11, color: D.muted }}>{r.from_phone} → {r.to_phone}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span style={sBadge(`${st.color}22`, st.color)}>{st.label}</span>
                    {r.sentiment && (() => {
                      const sc = SENTIMENT_CONFIG[r.sentiment] || {};
                      return <span style={sBadge(`${sc.color}22`, sc.color)}>{r.sentiment}</span>;
                    })()}
                    {r.lead_quality && <span style={sBadge(`${D.purple}22`, D.purple)}>{r.lead_quality}</span>}
                  </div>
                </div>
                {r.call_summary && <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.5, marginBottom: 6 }}>{r.call_summary}</div>}
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: D.muted }}>
                  <span>{r.duration_seconds ? `${r.duration_seconds}s` : '—'}</span>
                  <span>{new Date(r.created_at).toLocaleString()}</span>
                  {extraction?.matched_service && <span style={{ color: D.teal }}>{extraction.matched_service}</span>}
                  {!r.processing_status || r.processing_status === 'pending' ? (
                    <button onClick={e => { e.stopPropagation(); processOne(r.twilio_call_sid); }} style={{ ...sBtn(D.teal, D.white), padding: '2px 8px', fontSize: 10 }}>Process</button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail panel */}
        {selected && <RecordingDetail recording={selected} onClose={() => setSelected(null)} />}
      </div>

      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

function RecordingDetail({ recording, onClose }) {
  const r = recording;
  const extraction = r.ai_extraction ? (typeof r.ai_extraction === 'string' ? JSON.parse(r.ai_extraction) : r.ai_extraction) : null;

  return (
    <div style={{ position: 'sticky', top: 20 }}>
      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Call Details</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        {/* Audio player */}
        {r.recording_url && (
          <div style={{ marginBottom: 16 }}>
            <audio controls src={r.recording_url} style={{ width: '100%', height: 36 }} />
          </div>
        )}

        {/* Extracted info */}
        {extraction && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Extracted Data</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 12, marginBottom: 16 }}>
              {[
                ['Name', `${extraction.first_name || ''} ${extraction.last_name || ''}`],
                ['Phone', extraction.phone],
                ['Email', extraction.email],
                ['Address', extraction.address_line1],
                ['City', `${extraction.city || ''}, ${extraction.state || 'FL'} ${extraction.zip || ''}`],
                ['Service', extraction.matched_service || extraction.requested_service],
                ['Appointment', extraction.appointment_confirmed ? `Yes — ${extraction.preferred_date_time}` : 'No'],
                ['Lead Quality', extraction.lead_quality],
                ['Sentiment', extraction.sentiment],
              ].map(([label, value]) => value && (
                <div key={label} style={{ display: 'contents' }}>
                  <span style={{ color: D.muted, padding: '4px 0' }}>{label}</span>
                  <span style={{ color: D.white, padding: '4px 0' }}>{value}</span>
                </div>
              ))}
            </div>

            {extraction.pain_points && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Pain Points</div>
                <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6, padding: 10, background: D.input, borderRadius: 8 }}>{extraction.pain_points}</div>
              </div>
            )}

            {extraction.call_summary && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Summary</div>
                <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6, padding: 10, background: D.input, borderRadius: 8 }}>{extraction.call_summary}</div>
              </div>
            )}
          </>
        )}

        {/* Transcription */}
        {r.transcription && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Transcription</div>
            <div style={{ fontSize: 11, color: D.muted, lineHeight: 1.7, padding: 10, background: D.input, borderRadius: 8, maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{r.transcription}</div>
          </div>
        )}
      </div>
    </div>
  );
}
