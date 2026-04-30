import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const scoreColor = (v) => v >= 75 ? D.green : v >= 50 ? D.amber : D.red;
const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

// Resize phone photos before base64 upload — caps the long edge so a 4-8MB camera shot
// becomes ~200-400KB. Opus 4.7 vision works on the smaller image without loss for turf
// assessment, and the upload doesn't choke on slow LTE.
function resizeImage(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longEdge = Math.max(img.width, img.height);
      if (longEdge <= maxEdge) { resolve(dataUrl); return; }
      const scale = maxEdge / longEdge;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fall through with original on decode error
    img.src = dataUrl;
  });
}

export default function LawnAssessmentPanel() {
  const [step, setStep] = useState('select'); // select, capture, analyzing, review, history
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [search, setSearch] = useState('');
  const [photos, setPhotos] = useState([]); // { data, preview, file }
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState([]);
  const [showGuide, setShowGuide] = useState(() => !localStorage.getItem('lawn_guide_seen'));
  const fileRef = useRef(null);

  // Load customers
  useEffect(() => {
    adminFetch('/admin/lawn-assessment/customers').then(d => setCustomers(d.customers || [])).catch(() => {});
  }, []);

  // Server-side search when local results are empty
  useEffect(() => {
    if (!search.trim() || search.trim().length < 2) return;
    const t = setTimeout(() => {
      adminFetch(`/admin/lawn-assessment/customers?q=${encodeURIComponent(search.trim())}`)
        .then(d => {
          const serverResults = d.customers || [];
          setCustomers(prev => {
            const ids = new Set(prev.map(c => c.id));
            return [...prev, ...serverResults.filter(c => !ids.has(c.id))];
          });
        }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const filteredCustomers = customers.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${c.firstName} ${c.lastName}`.toLowerCase().includes(q)
      || (c.phone || '').includes(q)
      || (c.address || '').toLowerCase().includes(q);
  });

  const handlePhotoCapture = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(async (file) => {
      if (photos.length >= 3) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const resized = await resizeImage(ev.target.result, 1600, 0.85);
        setPhotos(prev => [...prev.slice(0, 2), { data: resized, preview: resized, file }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removePhoto = (idx) => setPhotos(prev => prev.filter((_, i) => i !== idx));

  const handleAnalyze = async () => {
    if (!selectedCustomer || photos.length === 0) return;
    setAnalyzing(true);
    setStep('analyzing');
    try {
      const photoData = photos.map(p => ({
        data: p.data.split(',')[1], // base64 without prefix
        mimeType: p.data.match(/data:([^;]+)/)?.[1] || 'image/jpeg',
      }));
      const r = await adminFetch('/admin/lawn-assessment/assess', {
        method: 'POST',
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          // serviceId is present when the picker showed today's scheduled
          // services; absent on the customer-only fallback path.
          serviceId: selectedCustomer.serviceId || undefined,
          photos: photoData,
        }),
      });
      setResult(r);
      setStep('review');
    } catch (e) {
      alert('Analysis failed: ' + e.message);
      setStep('capture');
    }
    setAnalyzing(false);
  };

  const handleConfirm = async () => {
    if (!result?.assessment?.id) return;
    setConfirming(true);
    try {
      await adminFetch('/admin/lawn-assessment/confirm', {
        method: 'POST',
        body: JSON.stringify({ assessmentId: result.assessment.id, adjustedScores: result.displayScores }),
      });
      alert('Assessment confirmed!');
      setStep('select');
      setPhotos([]);
      setResult(null);
      setSelectedCustomer(null);
    } catch (e) { alert('Confirm failed: ' + e.message); }
    setConfirming(false);
  };

  const loadHistory = async (customerId) => {
    try {
      const d = await adminFetch(`/admin/lawn-assessment/history/${customerId}`);
      setHistory(d.history || d.assessments || []);
      setStep('history');
    } catch { setHistory([]); }
  };

  // First-use guide
  if (showGuide) {
    return (
      <div style={{ ...cardStyle, maxWidth: 420, margin: '0 auto', textAlign: 'center', padding: 30 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>📸</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 8 }}>Lawn Assessment Guide</div>
        <div style={{ fontSize: 13, color: D.muted, lineHeight: 1.7, marginBottom: 20 }}>
          <p style={{ marginBottom: 8 }}>Stand upright, point camera at the turf at roughly 45°, capture a 6–8 ft area of lawn.</p>
          <p style={{ marginBottom: 8 }}>Avoid shadows and feet in frame.</p>
          <p>Take 1-3 photos per visit: front yard, side yard, trouble spots.</p>
        </div>
        <button onClick={() => { setShowGuide(false); localStorage.setItem('lawn_guide_seen', '1'); }} style={btnStyle(D.teal)}>Got It — Let's Go</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>Lawn Health Assessment</div>
        </div>
        {step !== 'select' && <button onClick={() => { setStep('select'); setPhotos([]); setResult(null); }} style={btnOutline}>← Back</button>}
      </div>

      {/* STEP 1: Select Customer */}
      {step === 'select' && (
        <div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search today's lawn customers..." style={inputStyle} />
          <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            {filteredCustomers.slice(0, 20).map(c => (
              // key uses serviceId when present so a customer with two
              // scheduled visits on the same day renders as two distinct
              // rows. Falls back to customer id on the no-services path.
              <div key={c.serviceId || c.id} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', cursor: 'pointer' }}
                onClick={() => { setSelectedCustomer(c); setStep('capture'); }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
                    {c.windowStart && <span style={{ color: D.teal, marginRight: 8 }}>{c.windowStart}</span>}
                    {c.firstName} {c.lastName}
                  </div>
                  <div style={{ fontSize: 11, color: D.muted }}>{c.address} · {c.phone}</div>
                  {c.serviceType && <div style={{ fontSize: 10, color: D.green, marginTop: 2 }}>{c.serviceType}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {c.lastAssessment && <span style={{ fontSize: 10, color: D.muted }}>Last: {new Date(c.lastAssessment).toLocaleDateString()}</span>}
                  <button onClick={e => { e.stopPropagation(); loadHistory(c.id); setSelectedCustomer(c); }} style={{ ...btnOutline, padding: '4px 8px', fontSize: 10 }}>History</button>
                </div>
              </div>
            ))}
            {filteredCustomers.length === 0 && <div style={{ color: D.muted, textAlign: 'center', padding: 30 }}>No lawn services scheduled today (or all assessed)</div>}
          </div>
        </div>
      )}

      {/* STEP 2: Capture Photos */}
      {step === 'capture' && selectedCustomer && (
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ ...cardStyle, textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.teal }}>{selectedCustomer.firstName} {selectedCustomer.lastName}</div>
            <div style={{ fontSize: 12, color: D.muted }}>{selectedCustomer.address}</div>
          </div>

          {/* Photo grid */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
            {photos.map((p, i) => (
              <div key={i} style={{ position: 'relative', aspectRatio: '4/3', borderRadius: 10, overflow: 'hidden', border: `1px solid ${D.border}` }}>
                <img src={p.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button onClick={() => removePhoto(i)} style={{ position: 'absolute', top: 4, right: 4, background: D.red, color: '#fff', border: 'none', borderRadius: '50%', width: 24, height: 24, fontSize: 12, cursor: 'pointer' }}>×</button>
              </div>
            ))}
            {photos.length < 3 && (
              <div onClick={() => fileRef.current?.click()} style={{ aspectRatio: '4/3', borderRadius: 10, border: `2px dashed ${D.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: D.muted }}>
                <span style={{ fontSize: 28 }}>+</span>
                <span style={{ fontSize: 11, marginTop: 4 }}>Add Photo</span>
              </div>
            )}
          </div>

          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple onChange={handlePhotoCapture} style={{ display: 'none' }} />

          <button onClick={handleAnalyze} disabled={photos.length === 0} style={{ ...btnStyle(D.green), width: '100%', padding: 14, fontSize: 15, opacity: photos.length === 0 ? 0.5 : 1 }}>
            📸 Analyze {photos.length} Photo{photos.length !== 1 ? 's' : ''} with AI
          </button>
        </div>
      )}

      {/* STEP 3: Analyzing */}
      {step === 'analyzing' && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>🔬</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 8 }}>Analyzing with Claude + Gemini...</div>
          <div style={{ fontSize: 12, color: D.muted }}>Running dual-model vision analysis for accuracy</div>
          <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'center' }}>
            {['Claude Sonnet', 'Gemini Flash'].map(m => (
              <div key={m} style={{ padding: '8px 16px', background: D.input, borderRadius: 8, fontSize: 12, color: D.teal }}>⏳ {m}</div>
            ))}
          </div>
        </div>
      )}

      {/* STEP 4: Review Scores */}
      {step === 'review' && result && (
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>AI Scorecard — {selectedCustomer?.firstName} {selectedCustomer?.lastName}</div>

            {/* Divergence summary — shown when Claude and Gemini disagreed on at least one metric.
                Multi-photo assessments emit one flag per photo, so dedupe by metric to match the
                number of highlighted tiles below. */}
            {(() => {
              const uniqueMetrics = new Set((result.divergenceFlags || []).map(f => f.metric));
              if (uniqueMetrics.size === 0) return null;
              return (
                <div style={{ marginBottom: 12, padding: 10, background: `${D.amber}15`, border: `1px solid ${D.amber}`, borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: D.amber, marginBottom: 4 }}>
                    ⚠ AI models disagreed on {uniqueMetrics.size} metric{uniqueMetrics.size === 1 ? '' : 's'}
                  </div>
                  <div style={{ fontSize: 11, color: D.muted, lineHeight: 1.5 }}>
                    Tiles below marked <span style={{ color: D.amber, fontWeight: 600 }}>DIVERGENCE</span> are where Claude and Gemini gave scores that differed by more than 20 points. Verify by eye before confirming.
                  </div>
                </div>
              );
            })()}

            {/* Scores */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 10 }}>
              {[
                { key: 'turf_density', label: 'Turf Density' },
                { key: 'weed_suppression', label: 'Weed Suppression' },
                { key: 'color_health', label: 'Color Health' },
                { key: 'fungus_control', label: 'Fungus Control' },
                { key: 'thatch_level', label: 'Thatch Level' },
              ].map(m => {
                const val = result.displayScores?.[m.key] || 0;
                const flag = (result.divergenceFlags || []).find(f => f.metric === m.key);
                return (
                  <div key={m.key} style={{ padding: 14, background: D.input, borderRadius: 10, textAlign: 'center', border: flag ? `2px solid ${D.amber}` : `1px solid ${D.border}` }}>
                    <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 800, color: scoreColor(val) }}>{val}%</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginTop: 2 }}>{m.label}</div>
                    {flag && (
                      <>
                        <div style={{ fontSize: 10, color: D.muted, marginTop: 4 }}>Claude: {flag.claude}% · Gemini: {flag.gemini}%</div>
                        <div style={{ fontSize: 9, color: D.amber, fontWeight: 700, marginTop: 2 }}>⚠ DIVERGENCE — verify</div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Observations */}
            {result.observations && (
              <div style={{ marginTop: 12, padding: 12, background: D.input, borderRadius: 8, fontSize: 12, color: D.muted, lineHeight: 1.6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: D.heading, marginBottom: 4 }}>AI Observations</div>
                {result.observations}
              </div>
            )}

            {/* Season badge */}
            <div style={{ marginTop: 12, fontSize: 11, color: D.muted }}>
              Season: <span style={{ color: D.teal, fontWeight: 600 }}>{result.season}</span>
              {result.isBaseline && <span style={{ color: D.amber, marginLeft: 8, fontWeight: 600 }}>📌 This is the baseline assessment</span>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleConfirm} disabled={confirming} style={{ ...btnStyle(D.green), flex: 1, padding: 14, fontSize: 15, opacity: confirming ? 0.5 : 1 }}>
              {confirming ? 'Confirming...' : '✓ Confirm Scores'}
            </button>
            <button onClick={() => setStep('capture')} style={{ ...btnOutline, padding: '14px 20px' }}>Retake</button>
          </div>
        </div>
      )}

      {/* HISTORY VIEW */}
      {step === 'history' && (
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{selectedCustomer?.firstName} {selectedCustomer?.lastName} — Assessment History</div>
          {history.length === 0 ? (
            <div style={{ ...cardStyle, textAlign: 'center', padding: 40, color: D.muted }}>No assessments yet</div>
          ) : history.map((a, i) => (
            <div key={a.id || i} style={{ ...cardStyle, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{new Date(a.service_date).toLocaleDateString()}</span>
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: `${D.teal}22`, color: D.teal }}>{a.season}</span>
                  {a.is_baseline && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: `${D.amber}22`, color: D.amber }}>Baseline</span>}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: isMobile ? 4 : 12, fontSize: 12 }}>
                {[
                  ['Turf', a.turf_density],
                  ['Weed', a.weed_suppression],
                  ['Color', a.color_health],
                  ['Fungus', a.fungus_control],
                  ['Thatch', a.thatch_level],
                ].map(([label, val]) => (
                  <div key={label} style={{ textAlign: 'center', minWidth: 0 }}>
                    <div style={{ fontFamily: MONO, fontSize: isMobile ? 13 : 16, fontWeight: 700, color: scoreColor(val || 0) }}>{val || 0}%</div>
                    <div style={{ fontSize: isMobile ? 9 : 10, color: D.muted }}>{label}</div>
                  </div>
                ))}
              </div>
              {a.observations && <div style={{ fontSize: 11, color: D.muted, marginTop: 8, lineHeight: 1.5 }}>{a.observations}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const cardStyle = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const btnStyle = (bg) => ({ padding: '8px 16px', background: bg, color: D.heading, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const btnOutline = { padding: '8px 16px', background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 8, color: D.muted, fontSize: 13, cursor: 'pointer' };
const inputStyle = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
