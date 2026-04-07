import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a', blue: '#3b82f6', gray: '#6b7280' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });

// ── Number label mapping ──
const NUMBER_LABELS = {
  '+19413187612': 'Lakewood Ranch GBP',
  '+19412972817': 'Parrish GBP',
  '+19412972606': 'Sarasota GBP',
  '+19412973337': 'Venice GBP',
  '+19412975749': 'wavespestcontrol.com',
  '+19412838194': 'bradentonflexterminator.com',
  '+19413265011': 'bradentonflpestcontrol.com',
  '+19412972671': 'sarasotaflpestcontrol.com',
  '+19412135203': 'palmettoexterminator.com',
  '+19412943355': 'palmettoflpestcontrol.com',
  '+19419098995': 'parrishexterminator.com',
  '+19413187765': 'sarasotaflexterminator.com',
  '+19412998937': 'veniceexterminator.com',
  '+19412589109': 'portcharlotteflpestcontrol.com',
  '+19412402066': 'North Port Landing',
  '+19413041850': 'bradentonfllawncare.com',
  '+19412691692': 'sarasotafllawncare.com',
  '+19412077456': 'parrishfllawncare.com',
  '+19414131227': 'venicelawncare.com',
  '+19412413824': 'waveslawncare.com',
  '+19412412459': 'Van Wrap',
  '+18559260203': 'Customer Chat',
};

function getNumberLabel(phone) {
  return NUMBER_LABELS[phone] || phone;
}

// ── Classification logic ──
function getClassification(recording) {
  const extraction = parseExtraction(recording);
  if (recording.processing_status === 'spam' || extraction?.is_spam) return { label: 'Spam', color: D.gray, bg: `${D.gray}22` };
  if (recording.processing_status === 'voicemail' || extraction?.is_voicemail) return { label: 'Voicemail', color: D.amber, bg: `${D.amber}22` };
  if (recording.customer_id && recording.processing_status === 'processed') {
    // Check if existing customer (had a customer_id before processing, or lead_quality is not hot/warm)
    if (extraction?.lead_quality === 'cold' || extraction?.lead_quality === 'warm') return { label: 'Existing Customer', color: D.green, bg: `${D.green}22` };
    return { label: 'New Lead', color: D.blue, bg: `${D.blue}22` };
  }
  if (recording.processing_status === 'processed') return { label: 'New Lead', color: D.blue, bg: `${D.blue}22` };
  return null;
}

function getActionStatus(recording) {
  const extraction = parseExtraction(recording);
  if (!extraction || recording.processing_status !== 'processed') return null;
  if (extraction.is_spam) return { text: 'No action', icon: '', color: D.gray };
  if (recording.customer_id && extraction.appointment_confirmed) return { text: 'Lead created', icon: ' \u2713', color: D.green };
  if (recording.customer_id && !extraction.appointment_confirmed) return { text: 'Follow-up needed', icon: ' \u26A0\uFE0F', color: D.amber };
  if (!recording.customer_id && !extraction.is_spam && !extraction.is_voicemail) return { text: 'Follow-up needed', icon: ' \u26A0\uFE0F', color: D.amber };
  return { text: 'No action', icon: '', color: D.gray };
}

function parseExtraction(recording) {
  if (!recording.ai_extraction) return null;
  try {
    return typeof recording.ai_extraction === 'string' ? JSON.parse(recording.ai_extraction) : recording.ai_extraction;
  } catch { return null; }
}

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
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.white }}>Call Recording Processor</div>
            <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>AI transcription + customer extraction -- replaces Zapier</div>
          </div>
          <span style={{ ...sBadge(`${D.green}22`, D.green), fontSize: 11, padding: '4px 10px' }}>Auto-processing enabled</span>
        </div>
        <button onClick={processAll} disabled={processing} style={{ ...sBtn(D.teal, D.white), opacity: processing ? 0.5 : 1 }}>
          {processing ? 'Processing...' : 'Process All Pending'}
        </button>
      </div>

      {/* Stats — reframed as value metrics */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Leads Extracted', value: stats.leadsExtracted ?? 0, color: D.blue },
            { label: 'Appointments', value: stats.appointments, color: D.green },
            { label: 'Pending', value: stats.pending, color: D.amber },
            { label: 'Spam Filtered', value: stats.spam, color: D.gray },
            { label: 'Voicemail', value: stats.voicemail, color: D.muted },
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
            const extraction = parseExtraction(r);
            const classification = getClassification(r);
            const action = getActionStatus(r);
            const callerName = extraction?.first_name
              ? `${extraction.first_name} ${extraction.last_name || ''}`.trim()
              : (r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : null);
            const isPending = !r.processing_status || r.processing_status === 'pending';

            return (
              <div key={r.id} onClick={() => setSelected(r)} style={{
                ...sCard, marginBottom: 8, cursor: 'pointer',
                borderColor: selected?.id === r.id ? D.teal : D.border,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>
                      {callerName || (isPending ? r.from_phone : 'Unknown -- potential lead')}
                    </div>
                    <div style={{ fontSize: 11, color: D.muted }}>
                      {r.from_phone} {' -> '} {getNumberLabel(r.to_phone)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    {classification && <span style={sBadge(classification.bg, classification.color)}>{classification.label}</span>}
                    {r.sentiment && (() => {
                      const sc = SENTIMENT_CONFIG[r.sentiment] || {};
                      return <span style={sBadge(`${sc.color}22`, sc.color)}>{r.sentiment}</span>;
                    })()}
                    {r.lead_quality && <span style={sBadge(`${D.purple}22`, D.purple)}>{r.lead_quality}</span>}
                  </div>
                </div>

                {/* One-line AI summary */}
                {extraction?.call_summary && (
                  <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.5, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {extraction.call_summary}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: D.muted, alignItems: 'center' }}>
                  <span>{r.duration_seconds ? `${r.duration_seconds}s` : '--'}</span>
                  <span>{new Date(r.created_at).toLocaleString()}</span>
                  {extraction?.matched_service && <span style={{ color: D.teal }}>{extraction.matched_service}</span>}
                  {action && (
                    <span style={{ color: action.color, fontWeight: 600 }}>{action.text}{action.icon}</span>
                  )}
                  {isPending && (
                    <button onClick={e => { e.stopPropagation(); processOne(r.twilio_call_sid); }} style={{ ...sBtn(D.teal, D.white), padding: '2px 8px', fontSize: 10 }}>Process</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail panel */}
        {selected && <RecordingDetail recording={selected} onClose={() => setSelected(null)} />}
      </div>

      {/* Source Analytics Section */}
      {stats?.sourceBreakdown && stats.sourceBreakdown.length > 0 && (
        <div style={{ ...sCard, marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Source Analytics</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 13, color: D.text }}>
            {stats.sourceBreakdown.map((s, i) => (
              <span key={s.number} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontWeight: 600, color: D.white }}>{getNumberLabel(s.number)}:</span>
                <span style={{ color: D.teal }}>{s.count}</span>
                {i < stats.sourceBreakdown.length - 1 && <span style={{ color: D.border, margin: '0 4px' }}>|</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Toast notification */}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>{'\u2713'}</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

function RecordingDetail({ recording, onClose }) {
  const r = recording;
  const extraction = parseExtraction(r);
  const classification = getClassification(r);
  const action = getActionStatus(r);

  return (
    <div style={{ position: 'sticky', top: 20 }}>
      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Call Details</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>{'\u00D7'}</button>
        </div>

        {/* Classification + action badges */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {classification && <span style={sBadge(classification.bg, classification.color)}>{classification.label}</span>}
          {action && <span style={sBadge(action.color === D.green ? `${D.green}22` : `${action.color}22`, action.color)}>{action.text}{action.icon}</span>}
        </div>

        {/* Receiving number label */}
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
          Receiving line: <span style={{ color: D.white, fontWeight: 600 }}>{getNumberLabel(r.to_phone)}</span>
        </div>

        {/* Audio player */}
        {(r.recording_url || r.recording_sid) && (
          <div style={{ marginBottom: 16 }}>
            <audio controls src={`${API_BASE}/admin/call-recordings/audio/${r.recording_sid || r.id}`} style={{ width: '100%', height: 36 }} />
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
                ['Appointment', extraction.appointment_confirmed ? `Yes -- ${extraction.preferred_date_time}` : 'No'],
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
