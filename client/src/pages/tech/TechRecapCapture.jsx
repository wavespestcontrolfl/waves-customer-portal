import { useState, useEffect, useRef } from 'react';

// During-visit recap clip capture for the tech portal ("Your Visit, in Motion", P4b).
// Native camera -> tag the action -> presigned PUT to S3 -> lands in the customer's
// recap. All optional; rendered only on the active (on_site) PEST job behind the
// pest-recap-v1 flag. Mirrors the admin closeout RecapCapture but uses the tech
// bearer-token `request` helper + the tech dark palette.
const C = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9',
  text: '#e2e8f0', muted: '#94a3b8', red: '#ef4444', green: '#22c55e',
};

// role keys must match server ROLE_MAP (recap-media.js).
const CHIPS_TOP = [
  { role: 'perimeter', label: 'Spray — perimeter' },
  { role: 'eaves', label: 'Spray — eaves/soffits' },
  { role: 'entry', label: 'Spray — entry points' },
  { role: 'deweb', label: 'De-web — eaves/corners' },
  { role: 'sweep', label: 'Sweep — lanai/pool cage' },
  { role: 'bait', label: 'Bait placement' },
  { role: 'granule', label: 'Granule spread' },
  { role: 'pest', label: 'Live pest (found)' },
];
const CHIPS_MORE = [
  { role: 'inside', label: 'Spray — inside' },
  { role: 'foundation', label: 'Spray — foundation/weep holes' },
  { role: 'garage', label: 'Spray — garage' },
  { role: 'shrubs', label: 'Spray — shrubs/beds' },
  { role: 'dust', label: 'Dust — crack & crevice' },
  { role: 'wasp', label: 'Wasp nest removal' },
  { role: 'acpad', label: 'Treat AC pad' },
  { role: 'before', label: 'Before' },
  { role: 'after', label: 'After' },
];

function readVideoDurationMs(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null); };
      v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      v.src = url;
    } catch { resolve(null); }
  });
}

export default function TechRecapCapture({ service, request }) {
  const serviceId = service?.id;
  const [items, setItems] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const refresh = () => request(`/tech/services/${serviceId}/recap-media`)
    .then((d) => setItems(d?.items || [])).catch(() => {});
  useEffect(() => { if (serviceId) refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serviceId]);

  const onPick = (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = '';
    if (file) { setPendingFile(file); setShowMore(false); }
  };

  const tag = async (role) => {
    const file = pendingFile;
    setPendingFile(null);
    setShowMore(false);
    if (!file) return;
    setUploading((n) => n + 1);
    setErr(null);
    try {
      const mediaType = file.type.startsWith('image/') ? 'image' : 'video';
      const durationMs = mediaType === 'video' ? await readVideoDurationMs(file) : null;
      const { mediaId, uploadUrl } = await request(`/tech/services/${serviceId}/recap-media/presign`, {
        method: 'POST',
        body: JSON.stringify({ role, mediaType, contentType: file.type || (mediaType === 'image' ? 'image/jpeg' : 'video/mp4') }),
      });
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await request(`/tech/services/${serviceId}/recap-media/${mediaId}/confirm`, {
        method: 'POST', body: JSON.stringify({ durationMs }),
      });
      await refresh();
    } catch (e) {
      // Surface the server reason (unsupported format, too long, etc.) — don't drop silently.
      setErr(e?.message || 'Couldn’t add that clip — try a shorter clip or a photo.');
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  };

  const remove = async (id) => {
    try { await request(`/tech/services/${serviceId}/recap-media/${id}`, { method: 'DELETE' }); await refresh(); } catch { /* ignore */ }
  };

  if (!serviceId) return null;

  const chip = { display: 'flex', alignItems: 'center', gap: 7, padding: '12px 10px', borderRadius: 11, background: C.bg, border: `1px solid ${C.border}`, color: C.text, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left' };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, color: C.text }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.teal }} /> Recap clips
        </span>
        <span style={{ fontSize: 12, color: C.muted }}>{items.length ? `${items.length} captured` : 'optional'}</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, margin: '6px 0 10px', lineHeight: 1.45 }}>
        Grab a few 5-sec clips while you work — live pests, spraying, the lanai sweep. They play in the customer’s recap. Skip it and the recap still generates.
      </div>

      <input ref={fileRef} type="file" accept="video/*,image/*" capture="environment" onChange={onPick} style={{ display: 'none' }} />

      {items.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
          {items.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 8 }}>
              <div style={{ width: 38, height: 38, borderRadius: 7, background: 'linear-gradient(135deg,#0ea5e9,#0b1220)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, textTransform: 'capitalize' }}>{m.role}</div>
                <div style={{ fontSize: 11.5, color: C.teal }}>“{m.caption}”</div>
              </div>
              <span style={{ fontSize: 10.5, color: m.status === 'ready' ? C.green : C.muted, fontWeight: 700 }}>{m.status === 'ready' ? 'Uploaded' : m.status}</span>
              <button onClick={() => remove(m.id)} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: C.red, margin: '0 0 8px', lineHeight: 1.4 }}>{err}</div>}
      <button type="button" onClick={() => fileRef.current && fileRef.current.click()} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: C.teal, color: '#04240f', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
        {uploading ? `Uploading… (${uploading})` : '+ Capture recap clip'}
      </button>

      {pendingFile && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,13,.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }} onClick={() => setPendingFile(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: C.card, borderRadius: '18px 18px 0 0', border: `1px solid ${C.border}`, padding: '16px 14px 22px', maxHeight: '82%', overflowY: 'auto' }}>
            <div style={{ width: 40, height: 4, background: C.border, borderRadius: 3, margin: '0 auto 12px' }} />
            <div style={{ fontWeight: 800, fontSize: 16, color: C.text, textAlign: 'center' }}>What were you doing?</div>
            <div style={{ fontSize: 12, color: C.muted, textAlign: 'center', margin: '4px 0 12px' }}>One tap. We caption it for the customer.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(showMore ? [...CHIPS_TOP, ...CHIPS_MORE] : CHIPS_TOP).map((c) => (
                <button type="button" key={c.role} onClick={() => tag(c.role)} style={chip}><span style={{ width: 9, height: 9, borderRadius: '50%', background: C.teal, flexShrink: 0 }} />{c.label}</button>
              ))}
            </div>
            {!showMore && <button type="button" onClick={() => setShowMore(true)} style={{ marginTop: 9, width: '100%', padding: 10, borderRadius: 9, background: 'none', border: `1px solid ${C.border}`, color: C.muted, fontSize: 12.5, cursor: 'pointer' }}>More actions…</button>}
          </div>
        </div>
      )}
    </div>
  );
}
