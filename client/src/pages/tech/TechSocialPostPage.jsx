// client/src/pages/tech/TechSocialPostPage.jsx
//
// Tech portal Field Social Post flow (/tech/social-post).
// Mobile-first, dark palette + Montserrat headings (CLAUDE.md tech rule).
//
// Flow: snap ONE photo + type a couple words + confirm location ->
//       AI generates four platform-tailored captions -> review/edit ->
//       publish natively (Instagram / Facebook / Google Business) +
//       copy the TikTok caption (no TikTok posting API).
//
// Endpoints (staff-auth via techRequest):
//   GET  /api/tech/social/locations
//   POST /api/tech/social/generate   { photo, techNote, locationId, lat, lng }
//   POST /api/tech/social/publish    { photo, captions, platforms, locationId, techNote }

import { useState, useRef, useEffect } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};
const HEAD = "'Montserrat', system-ui, sans-serif";
const BODY = "'DM Sans', system-ui, sans-serif";

// Mirrors the server's PUBLISHABLE + PLATFORM_LIMITS. TikTok = copy-only (no API).
const PLATFORMS = [
  { key: 'instagram', label: 'Instagram', limit: 2200, publish: true },
  { key: 'facebook', label: 'Facebook', limit: 500, publish: true },
  { key: 'tiktok', label: 'TikTok', limit: 2200, publish: false, note: 'copy & paste — no posting API' },
  { key: 'gbp', label: 'Google Business', limit: 1500, publish: true, geo: true },
];

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

// Downscale phone photos before upload (same as the lawn diagnostic flow) — raw
// camera shots are several MB and stall on field LTE. Falls through on decode error.
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
  width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '8px 12px',
  background: '#0b131b', border: `1px solid ${D.border}`, borderRadius: 8,
  color: D.text, fontSize: 15, fontFamily: BODY, outline: 'none',
};

function Card({ children, style }) {
  return <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16, marginBottom: 14, ...style }}>{children}</div>;
}

export default function TechSocialPostPage() {
  const [photo, setPhoto] = useState(null); // { dataUrl, base64, mimeType }
  const [techNote, setTechNote] = useState('');
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState(''); // '' = auto-detect nearest
  const [coords, setCoords] = useState(null);

  const [captions, setCaptions] = useState(null); // { instagram, facebook, tiktok, gbp }
  const [validation, setValidation] = useState({});
  const [resolvedLocation, setResolvedLocation] = useState(null);
  const [genModel, setGenModel] = useState(null); // actual caption model, for the audit row
  const [publishId, setPublishId] = useState(null); // idempotency key per generated caption set
  const [selected, setSelected] = useState(() => new Set(PLATFORMS.filter((p) => p.publish).map((p) => p.key)));
  const [posted, setPosted] = useState(() => new Set()); // platforms already published — never re-send
  const [publishResults, setPublishResults] = useState(null);
  const [enabled, setEnabled] = useState(null); // backend readiness (TECH_SOCIAL_ENABLED); null = loading

  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  const step = captions ? 'review' : 'capture';

  // Locations for the picker + best-effort device location for nearest auto-detect.
  useEffect(() => {
    techRequest('/tech/social/locations')
      .then((d) => { setLocations(d.locations || []); setEnabled(d.enabled !== false); })
      .catch(() => {});
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {}, { timeout: 6000, maximumAge: 600000 },
      );
    }
  }, []);

  const addPhoto = async (fileList) => {
    setError('');
    const file = (fileList || [])[0];
    if (!file) return;
    try {
      const original = await fileToDataUrl(file);
      const dataUrl = await resizeImage(original, 1600, 0.85);
      setPhoto({ dataUrl, base64: dataUrl.split(',')[1] || '', mimeType: mimeFromDataUrl(dataUrl, file.type || 'image/jpeg') });
    } catch (err) {
      setError(err.message);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const generate = async () => {
    if (!photo) { setError('Add a photo first.'); return; }
    setBusy('generate'); setError(''); setNotice('');
    try {
      const data = await techRequest('/tech/social/generate', {
        method: 'POST',
        body: JSON.stringify({
          photo: { data: photo.base64, mimeType: photo.mimeType },
          techNote,
          locationId: locationId || undefined,
          lat: coords?.lat, lng: coords?.lng,
        }),
      });
      setCaptions(data.captions || null);
      setValidation(data.validation || {});
      setResolvedLocation(data.location || null);
      setGenModel(data.model || null);
      // Fresh idempotency key for this caption set — reused across publish retries.
      setPublishId((typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `pub-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    const platforms = PLATFORMS.filter((p) => selected.has(p.key)).map((p) => p.key);
    if (!platforms.length) { setError('Pick at least one platform.'); return; }
    setBusy('publish'); setError(''); setNotice('');
    try {
      const data = await techRequest('/tech/social/publish', {
        method: 'POST',
        body: JSON.stringify({
          photo: { data: photo.base64, mimeType: photo.mimeType },
          captions, platforms, locationId: resolvedLocation?.id, techNote, model: genModel, publishId,
        }),
      });
      setPublishResults(data);
      // No backend idempotency key — never let a second tap re-post a platform
      // that already succeeded. Mark succeeded as posted and drop them from the
      // selection so a follow-up Publish only retries the ones that failed.
      const succeeded = new Set((data.results || []).filter((r) => r.success).map((r) => r.platform));
      if (succeeded.size) {
        setPosted((prev) => new Set([...prev, ...succeeded]));
        setSelected((prev) => new Set([...prev].filter((k) => !succeeded.has(k))));
      }
      const ok = (data.results || []).filter((r) => r.success).length;
      setNotice(ok ? `Published to ${ok} platform${ok > 1 ? 's' : ''}.` : 'Nothing published — see results below.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const copyCaption = async (key) => {
    setError(''); setNotice('');
    try {
      // Validate before copying — for TikTok the copy IS the delivery path, so the
      // brand rules (pricing/safety/phone/length) must gate it like a native publish.
      const v = await techRequest('/tech/social/validate', {
        method: 'POST',
        body: JSON.stringify({ caption: captions[key] || '', platform: key }),
      });
      if (!v.valid) { setError(`${key}: ${(v.issues || []).join('; ') || 'caption needs a fix before copying'}`); return; }
      await navigator.clipboard.writeText(captions[key] || '');
      setNotice(`${key} caption copied.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const reset = () => {
    setPhoto(null); setTechNote(''); setLocationId(''); setCaptions(null); setValidation({});
    setResolvedLocation(null); setGenModel(null); setPublishId(null);
    setSelected(new Set(PLATFORMS.filter((p) => p.publish).map((p) => p.key)));
    setPosted(new Set()); setPublishResults(null); setError(''); setNotice('');
  };

  const toggle = (key) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const resultFor = (key) => (publishResults?.results || []).find((r) => r.platform === key);
  // Publishable platforms still selected (not yet posted) — drives the Publish button.
  const nativeRemaining = PLATFORMS.filter((p) => p.publish && selected.has(p.key)).length;

  return (
    <div style={{ minHeight: '100vh', background: D.bg, color: D.text, fontFamily: BODY, padding: 16 }}>
      <h1 style={{ fontFamily: HEAD, fontSize: 24, fontWeight: 700, color: D.white, margin: '4px 0 16px' }}>Field Social Post</h1>

      {error ? <Card style={{ borderColor: D.red, background: '#2a1416' }}><span style={{ color: D.red }}>{error}</span></Card> : null}
      {notice ? <Card style={{ borderColor: D.green, background: '#0f2a1c' }}><span style={{ color: D.green }}>{notice}</span></Card> : null}

      {enabled === false ? (
        <Card style={{ borderColor: D.amber }}>
          <span style={{ color: D.amber }}>Field social posting isn’t turned on yet. Ask an admin to enable it.</span>
        </Card>
      ) : step === 'capture' ? (
        <>
          <Card>
            <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 16, color: D.white, marginBottom: 10 }}>Photo</div>
            {photo ? (
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <img src={photo.dataUrl} alt="field" style={{ width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 8, border: `1px solid ${D.border}` }} />
                <button onClick={() => setPhoto(null)} aria-label="Remove photo"
                  style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,0.65)', color: D.white, cursor: 'pointer', fontSize: 16, lineHeight: '28px', padding: 0 }}>×</button>
              </div>
            ) : null}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={(e) => addPhoto(e.target.files)} style={{ display: 'none' }} />
            <button onClick={() => fileRef.current?.click()} style={btn('#0b131b', D.teal)}>{photo ? 'Retake photo' : '+ Take photo'}</button>
          </Card>

          <Card>
            <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 16, color: D.white, marginBottom: 8 }}>A couple words</div>
            <textarea
              style={{ ...inputStyle, minHeight: 70, resize: 'vertical', fontFamily: BODY }}
              placeholder="e.g. german roach behind the dishwasher — sealed it up"
              value={techNote}
              onChange={(e) => setTechNote(e.target.value)}
              maxLength={500}
            />
            <div style={{ color: D.muted, fontSize: 12, marginTop: 6 }}>Optional — the AI reads the photo, your words steer the angle.</div>
          </Card>

          <Card>
            <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 16, color: D.white, marginBottom: 8 }}>Location (for Google Business)</div>
            <select style={{ ...inputStyle, appearance: 'auto' }} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Auto — nearest to me</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.area})</option>)}
            </select>
          </Card>

          <button onClick={generate} disabled={busy === 'generate' || !photo} style={{ ...btn(D.teal), width: '100%' }}>
            {busy === 'generate' ? 'Generating…' : 'Generate captions'}
          </button>
        </>
      ) : (
        <>
          <Card>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {photo ? <img src={photo.dataUrl} alt="field" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${D.border}` }} /> : null}
              <div style={{ fontSize: 13, color: D.muted }}>
                Google Business posts to <span style={{ color: D.text, fontWeight: 700 }}>{resolvedLocation?.name || '—'}</span>.
                <button onClick={reset} style={{ ...btn('transparent', D.teal), padding: 0, minHeight: 0, fontSize: 13, marginLeft: 6 }}>Change</button>
              </div>
            </div>
          </Card>

          {PLATFORMS.map((p) => {
            const text = captions?.[p.key] || '';
            const issues = validation?.[p.key] || [];
            const over = text.length > p.limit;
            const res = resultFor(p.key);
            return (
              <Card key={p.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: HEAD, fontWeight: 700, color: D.white, fontSize: 15 }}>
                    {p.publish ? (
                      <input type="checkbox" checked={selected.has(p.key)} disabled={posted.has(p.key)} onChange={() => toggle(p.key)} style={{ width: 18, height: 18 }} />
                    ) : null}
                    {p.label}
                    {!p.publish ? <span style={{ color: D.amber, fontSize: 11, fontWeight: 600 }}>{p.note}</span> : null}
                  </label>
                  <span style={{ color: over ? D.amber : D.muted, fontSize: 12, fontFamily: BODY }}>{text.length}/{p.limit}</span>
                </div>
                <textarea
                  style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontFamily: BODY, lineHeight: 1.5 }}
                  value={text}
                  onChange={(e) => setCaptions({ ...captions, [p.key]: e.target.value })}
                />
                {issues.length ? <div style={{ color: D.amber, fontSize: 12, marginTop: 6 }}>⚠ {issues.join('; ')}</div> : null}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={() => copyCaption(p.key)} style={{ ...btn('#0b131b', D.teal), minHeight: 38, fontSize: 13 }}>Copy</button>
                  {posted.has(p.key) ? (
                    <span style={{ alignSelf: 'center', fontSize: 13, color: D.green }}>✓ posted</span>
                  ) : res ? (
                    <span style={{ alignSelf: 'center', fontSize: 13, color: res.success ? D.green : res.skipped ? D.muted : res.dryRun ? D.amber : D.red }}>
                      {res.success ? '✓ posted' : res.dryRun ? 'dry run' : res.skipped ? `skipped: ${res.skipped}` : `✗ ${res.error || 'failed'}`}
                    </span>
                  ) : null}
                </div>
              </Card>
            );
          })}

          <div style={{ display: 'grid', gap: 8 }}>
            <button onClick={publish} disabled={busy === 'publish' || nativeRemaining === 0} style={btn(D.teal, D.white, busy === 'publish' || nativeRemaining === 0)}>
              {busy === 'publish' ? 'Publishing…' : posted.size > 0 ? 'Publish remaining' : 'Publish selected'}
            </button>
            <button onClick={reset} disabled={!!busy} style={btn('transparent', D.muted, !!busy)}>Start over</button>
          </div>
        </>
      )}
    </div>
  );
}
