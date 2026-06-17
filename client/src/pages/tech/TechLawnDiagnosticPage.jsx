// client/src/pages/tech/TechLawnDiagnosticPage.jsx
//
// Tech portal Lawn Diagnostic capture flow (/tech/lawn-diagnostic).
// Mobile-first, dark palette + Montserrat headings (CLAUDE.md tech rule —
// NOT the customer warm tone or admin monochrome).
//
// Flow: capture photos -> AI diagnosis (analyze) -> review ->
//       save internally / send prospect report / save as lead.
//
// Endpoints (all staff-auth via techRequest):
//   POST /api/tech/lawn-diagnostic/analyze   (no persistence; tech's eyes)
//   POST /api/tech/lawn-diagnostic           (persist a draft)
//   POST /api/tech/lawn-diagnostic/:id/send  (contact-gated token + link)
//   POST /api/tech/lawn-diagnostic/:id/lead  (optional save as lead)

import { useState, useRef } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';
const MAX_PHOTOS = 5;

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};
const HEAD = "'Montserrat', system-ui, sans-serif";
const BODY = "'DM Sans', system-ui, sans-serif";

const SEVERITY_COLOR = { mild: D.green, moderate: D.amber, severe: D.red };
const MODE_LABEL = {
  standard: 'Standard', conservative: 'Conservative', label_limited: 'Label-limited', minimal: 'Minimal',
};

async function techRequest(path, options = {}) {
  const token = getAdminAuthToken();
  const res = await fetch(`${API}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read photo'));
    reader.readAsDataURL(file);
  });
}

// Downscale phone photos before upload (mirrors the admin lawn assessment flow).
// Raw camera shots are several MB each; five originals can blow the server's JSON
// limit or stall on field LTE before /analyze. Falls through with the original on
// decode error so capture never hard-fails.
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
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function mimeFromDataUrl(dataUrl, fallback = 'image/jpeg') {
  const m = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''));
  return m ? m[1] : fallback;
}

function btn(bg, fg = D.white, disabled = false) {
  return {
    minHeight: 46, padding: '0 16px', border: 'none', borderRadius: 10,
    background: bg, color: fg, fontFamily: HEAD, fontWeight: 700, fontSize: 15,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
  };
}
const inputStyle = {
  width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0 12px',
  background: '#0b131b', border: `1px solid ${D.border}`, borderRadius: 8,
  color: D.text, fontSize: 15, fontFamily: BODY, outline: 'none',
};

function Card({ children, style }) {
  return <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16, marginBottom: 14, ...style }}>{children}</div>;
}

export default function TechLawnDiagnosticPage() {
  const [photos, setPhotos] = useState([]); // { id, dataUrl, base64, mimeType }
  const [contact, setContact] = useState({ name: '', email: '', phone: '' });
  const [address, setAddress] = useState({ line1: '', city: '', state: '', zip: '' });
  const [showProspect, setShowProspect] = useState(false);
  const [analysis, setAnalysis] = useState(null); // reportContract
  const [meta, setMeta] = useState({ releaseMode: null, findingsSource: null, provenance: null });
  const [diagnosticId, setDiagnosticId] = useState(null);
  const [sendResult, setSendResult] = useState(null);
  const [leadId, setLeadId] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  const step = analysis ? 'review' : 'capture';
  const findings = analysis?.diagnosis?.findings || [];
  // Gate on having an analyzed report, NOT on findings — a minimal (no-diagnosis)
  // report is still a valid, sendable service summary (the no-block path).
  const canActOnReport = !!analysis;

  const addPhotos = async (fileList) => {
    setError('');
    const files = Array.from(fileList || []).slice(0, MAX_PHOTOS - photos.length);
    try {
      const added = await Promise.all(files.map(async (file, i) => {
        const original = await fileToDataUrl(file);
        const dataUrl = await resizeImage(original, 1600, 0.85);
        return { id: `${Date.now()}-${i}`, dataUrl, base64: dataUrl.split(',')[1] || '', mimeType: mimeFromDataUrl(dataUrl, file.type || 'image/jpeg') };
      }));
      setPhotos((p) => [...p, ...added].slice(0, MAX_PHOTOS));
    } catch (err) {
      setError(err.message);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const cleanContact = () => {
    const out = {};
    if (contact.name.trim()) out.name = contact.name.trim();
    if (contact.email.trim()) out.email = contact.email.trim();
    if (contact.phone.trim()) out.phone = contact.phone.trim();
    return Object.keys(out).length ? out : null;
  };
  const cleanAddress = () => {
    const out = {};
    ['line1', 'city', 'state', 'zip'].forEach((k) => { if (address[k].trim()) out[k] = address[k].trim(); });
    return Object.keys(out).length ? out : null;
  };

  const analyze = async () => {
    if (!photos.length) { setError('Add at least one photo first.'); return; }
    setBusy('analyze'); setError(''); setNotice('');
    try {
      const data = await techRequest('/tech/lawn-diagnostic/analyze', {
        method: 'POST',
        body: JSON.stringify({ photos: photos.map((p) => ({ data: p.base64, mimeType: p.mimeType })) }),
      });
      setAnalysis(data.reportContract || null);
      setMeta({ releaseMode: data.releaseMode || null, findingsSource: data.findingsSource || null, provenance: data.provenance || null });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const ensurePersisted = async (mode) => {
    if (diagnosticId) return diagnosticId;
    // Send the same inputs the analyze step used so the server rebuilds the SAME
    // contract. Without photo metadata the persist route sees zero photos and
    // classifies the report 'minimal', wiping the diagnosis the tech just saw.
    // Carry the analyzed photo quality so the server rebuild doesn't default photos to
    // 'poor' → minimal → wipe the diagnosis the tech just reviewed.
    const reviewedQuality = analysis?.input_assessment?.photo_quality || 'limited';
    const reviewedLimitations = analysis?.input_assessment?.photo_limitations || [];
    const data = await techRequest('/tech/lawn-diagnostic', {
      method: 'POST',
      body: JSON.stringify({
        mode,
        findings,
        photos: photos.map((p) => ({ photo_id: p.id, quality: reviewedQuality, limitations: reviewedLimitations })),
        appliedProducts: [],
        compliance: {},
        // Forward provenance so the server can re-run the GPT-5.5 writer on the rebuilt
        // contract ONLY when the original analysis was fully challenged (multimodel).
        provenance: meta?.provenance || null,
        contact: cleanContact(),
        address: cleanAddress(),
      }),
    });
    setDiagnosticId(data.id);
    return data.id;
  };

  const saveInternal = async () => {
    setBusy('save'); setError(''); setNotice('');
    try { await ensurePersisted('internal'); setNotice('Saved to your diagnostics.'); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  };

  const sendReport = async () => {
    setBusy('send'); setError(''); setNotice('');
    try {
      const id = await ensurePersisted('prospect');
      const data = await techRequest(`/tech/lawn-diagnostic/${id}/send`, {
        method: 'POST',
        body: JSON.stringify({ contact: cleanContact(), address: cleanAddress() }),
      });
      const url = `${window.location.origin}${data.url || `/lawn-report/${data.token}`}`;
      setSendResult({ url, expiresAt: data.expiresAt });
    } catch (err) {
      setError(err.message);
    } finally { setBusy(''); }
  };

  const saveAsLead = async () => {
    setBusy('lead'); setError(''); setNotice('');
    try {
      const id = await ensurePersisted(cleanContact() || cleanAddress() ? 'prospect' : 'internal');
      const data = await techRequest(`/tech/lawn-diagnostic/${id}/lead`, {
        method: 'POST',
        body: JSON.stringify({ contact: cleanContact(), address: cleanAddress() }),
      });
      setLeadId(data.leadId || null);
      setNotice('Saved as a lead in the pipeline.');
    } catch (err) {
      setError(err.message);
    } finally { setBusy(''); }
  };

  const reset = () => {
    setPhotos([]); setContact({ name: '', email: '', phone: '' }); setAddress({ line1: '', city: '', state: '', zip: '' });
    setShowProspect(false); setAnalysis(null); setMeta({ releaseMode: null, findingsSource: null, provenance: null });
    setDiagnosticId(null); setSendResult(null); setLeadId(null); setError(''); setNotice('');
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(sendResult.url); setNotice('Link copied.'); }
    catch { setNotice('Copy failed — long-press the link to copy.'); }
  };

  // Shared prospect contact/address inputs. Rendered in capture (collapsible) AND on
  // the review step, so a tech who analyzed before filling contact details can still
  // enter them inline before sending instead of dead-ending on the send 422.
  const prospectInputs = (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <input style={inputStyle} placeholder="Name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
      <input style={inputStyle} placeholder="Email" type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
      <input style={inputStyle} placeholder="Phone" type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
      <input style={inputStyle} placeholder="Street address" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
        <input style={inputStyle} placeholder="City" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
        <input style={inputStyle} placeholder="State" value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />
        <input style={inputStyle} placeholder="ZIP" value={address.zip} onChange={(e) => setAddress({ ...address, zip: e.target.value })} />
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: D.bg, color: D.text, fontFamily: BODY, padding: 16 }}>
      <h1 style={{ fontFamily: HEAD, fontSize: 24, fontWeight: 700, color: D.white, margin: '4px 0 16px' }}>Lawn Diagnostic</h1>

      {error ? <Card style={{ borderColor: D.red, background: '#2a1416' }}><span style={{ color: D.red }}>{error}</span></Card> : null}
      {notice ? <Card style={{ borderColor: D.green, background: '#0f2a1c' }}><span style={{ color: D.green }}>{notice}</span></Card> : null}

      {step === 'capture' ? (
        <>
          <Card>
            <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 16, color: D.white, marginBottom: 10 }}>Photos ({photos.length}/{MAX_PHOTOS})</div>
            {photos.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 8, marginBottom: 12 }}>
                {photos.map((p) => (
                  <div key={p.id} style={{ position: 'relative' }}>
                    <img src={p.dataUrl} alt="lawn" style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8, border: `1px solid ${D.border}` }} />
                    <button onClick={() => setPhotos((arr) => arr.filter((x) => x.id !== p.id))} aria-label="Remove photo"
                      style={{ position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,0.6)', color: D.white, cursor: 'pointer', fontSize: 14, lineHeight: '24px', padding: 0 }}>×</button>
                  </div>
                ))}
              </div>
            ) : null}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple onChange={(e) => addPhotos(e.target.files)} style={{ display: 'none' }} />
            {photos.length < MAX_PHOTOS ? (
              <button onClick={() => fileRef.current?.click()} style={btn('#0b131b', D.teal)}>+ Add photo</button>
            ) : null}
          </Card>

          <Card>
            <button onClick={() => setShowProspect((s) => !s)} style={{ ...btn('transparent', D.muted), padding: 0, minHeight: 0, fontWeight: 600 }}>
              {showProspect ? '▾' : '▸'} Prospect details (for sending a report)
            </button>
            {showProspect ? prospectInputs : null}
          </Card>

          <button onClick={analyze} disabled={busy === 'analyze' || !photos.length} style={{ ...btn(D.teal), width: '100%' }}>
            {busy === 'analyze' ? 'Analyzing…' : 'Analyze lawn'}
          </button>
        </>
      ) : (
        <>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 16, color: D.white }}>Diagnosis</div>
              {meta.releaseMode ? (
                <span style={{ padding: '4px 10px', borderRadius: 999, background: '#0b131b', border: `1px solid ${D.border}`, color: D.muted, fontSize: 12, fontWeight: 700, fontFamily: HEAD }}>
                  {MODE_LABEL[meta.releaseMode] || meta.releaseMode}
                </span>
              ) : null}
            </div>
            {analysis?.customer_summary ? <p style={{ margin: '0 0 12px', color: D.text, fontSize: 14, lineHeight: 1.55 }}>{analysis.customer_summary}</p> : null}
            {findings.length ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {findings.map((f, i) => (
                  <div key={`${f.name}-${i}`} style={{ background: '#0b131b', border: `1px solid ${D.border}`, borderLeft: `4px solid ${SEVERITY_COLOR[f.severity] || D.teal}`, borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 14, color: D.white }}>{f.name}</span>
                      <span style={{ color: D.muted, fontSize: 12 }}>{f.confidence}</span>
                    </div>
                    {f.customer_wording ? <div style={{ color: D.muted, fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{f.customer_wording}</div> : null}
                    {f.confirmation_step ? <div style={{ color: D.amber, fontSize: 12, marginTop: 4 }}>Confirm: {f.confirmation_step}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: D.muted, fontSize: 14, margin: 0 }}>No defensible finding from these photos — capture clearer or closer shots for a diagnosis you can send.</p>
            )}
            {analysis?.watering?.customer_sequence ? (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${D.border}` }}>
                <div style={{ color: D.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Watering</div>
                <div style={{ color: D.text, fontSize: 13, lineHeight: 1.5 }}>{analysis.watering.customer_sequence}</div>
              </div>
            ) : null}
          </Card>

          {sendResult ? (
            <Card style={{ borderColor: D.green }}>
              <div style={{ fontFamily: HEAD, fontWeight: 700, color: D.white, marginBottom: 8 }}>Report link ready</div>
              <div style={{ wordBreak: 'break-all', color: D.teal, fontSize: 13, marginBottom: 10 }}>{sendResult.url}</div>
              <button onClick={copyLink} style={btn(D.green)}>Copy link</button>
            </Card>
          ) : null}

          <Card>
            <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 16, color: D.white }}>Prospect details</div>
            <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>A name plus an email or address is required to send a report.</div>
            {prospectInputs}
          </Card>

          <div style={{ display: 'grid', gap: 8 }}>
            <button onClick={saveInternal} disabled={!!busy || !canActOnReport} style={btn('#0b131b', D.teal, !!busy || !canActOnReport)}>
              {busy === 'save' ? 'Saving…' : 'Save internally'}
            </button>
            <button onClick={sendReport} disabled={!!busy || !canActOnReport} style={btn(D.teal, D.white, !!busy || !canActOnReport)}>
              {busy === 'send' ? 'Sending…' : sendResult ? 'Re-send report' : 'Send prospect report'}
            </button>
            <button onClick={saveAsLead} disabled={!!busy || !!leadId} style={btn('#0b131b', D.green, !!busy || !!leadId)}>
              {busy === 'lead' ? 'Saving…' : leadId ? 'Saved as lead ✓' : 'Save as lead'}
            </button>
            <button onClick={reset} disabled={!!busy} style={btn('transparent', D.muted, !!busy)}>Start over</button>
          </div>
          {analysis && !findings.length ? <p style={{ color: D.muted, fontSize: 12, marginTop: 10 }}>No specific diagnosis from these photos — you can still send a calm service-summary report.</p> : null}
        </>
      )}
    </div>
  );
}
