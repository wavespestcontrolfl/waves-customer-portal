// Standalone, tappable preview of the tech "capture for recap" flow (no app/auth/
// Capacitor). Simulates: tap Capture → record ~5s → one-tap action tag → background
// upload → clips strip → closeout review. Demonstrates the internal action tag →
// friendly customer caption translation. Tech-portal dark palette + Montserrat.
import { useState, useEffect, useRef } from 'react';

const D = {
  bg: '#0f1923', card: '#1e293b', card2: '#172033', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};
const H = "'Montserrat', system-ui, sans-serif";

// Action chips: techLabel (internal) → friendly customer caption. repellency etc.
// would ride the record; here we just show the friendly caption the customer sees.
const TOP = [
  { id: 'perimeter', techLabel: 'Spray — perimeter', caption: 'Sealing your perimeter barrier', tint: '#0ea5e9' },
  { id: 'eaves', techLabel: 'Spray — eaves/soffits', caption: 'Clearing the eaves up top', tint: '#0ea5e9' },
  { id: 'entry', techLabel: 'Spray — entry points', caption: 'Protecting your doors & windows', tint: '#0ea5e9' },
  { id: 'deweb', techLabel: 'De-web — eaves/corners', caption: 'Knocking down webs up top', tint: '#a855f7' },
  { id: 'sweep', techLabel: 'Sweep — lanai/pool cage', caption: 'Sweeping down your pool cage', tint: '#a855f7' },
  { id: 'bait', techLabel: 'Bait placement', caption: 'Placing bait at the hot spots', tint: '#f59e0b' },
  { id: 'granule', techLabel: 'Granule spread', caption: 'Spreading granules across the yard', tint: '#84cc16' },
  { id: 'pest', techLabel: 'Live pest (found)', caption: 'Live pest — caught on camera', tint: '#ef4444' },
];
const MORE = [
  { id: 'inside', techLabel: 'Spray — inside', caption: 'Treating along your baseboards', tint: '#0ea5e9' },
  { id: 'foundation', techLabel: 'Spray — foundation/weep holes', caption: 'Sealing the foundation & weep holes', tint: '#0ea5e9' },
  { id: 'garage', techLabel: 'Spray — garage', caption: 'Treating the garage', tint: '#0ea5e9' },
  { id: 'shrubs', techLabel: 'Spray — shrubs/beds', caption: 'Treating the beds where pests hide', tint: '#22c55e' },
  { id: 'dust', techLabel: 'Dust — crack & crevice', caption: 'Getting into the cracks & crevices', tint: '#f59e0b' },
  { id: 'wasp', techLabel: 'Wasp nest removal', caption: 'Removing a wasp nest', tint: '#eab308' },
  { id: 'acpad', techLabel: 'Treat AC pad', caption: 'Treating around the AC unit', tint: '#38bdf8' },
  { id: 'before', techLabel: 'Before', caption: 'Before', tint: '#64748b' },
  { id: 'after', techLabel: 'After', caption: 'After', tint: '#10b981' },
];

let CID = 0;

const Dot = ({ color, size = 9 }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
);
const CameraIcon = ({ size = 28, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="13" height="12" rx="2" /><path d="M15 10l6-3.5v11L15 14" />
  </svg>
);
const PlayTri = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="rgba(255,255,255,.9)"><path d="M8 5v14l11-7z" /></svg>
);

export default function TechCapturePreview() {
  const [mode, setMode] = useState('idle'); // idle | recording | tagging
  const [sec, setSec] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [clips, setClips] = useState([]);
  const [closeout, setCloseout] = useState(false);
  const recTimer = useRef(null);

  useEffect(() => {
    if (mode !== 'recording') return undefined;
    setSec(0);
    recTimer.current = setInterval(() => {
      setSec((s) => {
        if (s + 1 >= 5) { clearInterval(recTimer.current); setMode('tagging'); return 5; }
        return s + 1;
      });
    }, 700);
    return () => clearInterval(recTimer.current);
  }, [mode]);

  const stopRec = () => { clearInterval(recTimer.current); setMode('tagging'); };

  const addClip = (chip) => {
    const id = ++CID;
    setClips((c) => [...c, { ...chip, cid: id, status: 'uploading' }]);
    setShowMore(false);
    setMode('idle');
    setTimeout(() => setClips((c) => c.map((x) => (x.cid === id ? { ...x, status: 'ready' } : x))), 1900);
  };
  const removeClip = (cid) => setClips((c) => c.filter((x) => x.cid !== cid));
  const readyCount = clips.length;

  return (
    <div style={{ minHeight: '100vh', background: '#0a0f17', display: 'flex', justifyContent: 'center', padding: 20, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ width: 390, maxWidth: '100%', background: D.bg, borderRadius: 28, overflow: 'hidden', position: 'relative', boxShadow: '0 30px 80px rgba(0,0,0,.5)', border: `1px solid ${D.border}`, minHeight: 780 }}>

        {/* Job header */}
        <div style={{ padding: '20px 18px 16px', background: 'linear-gradient(180deg,#13243a,#0f1923)', borderBottom: `1px solid ${D.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: D.green, textTransform: 'uppercase' }}><Dot color={D.green} size={7} /> Service in progress</span>
            <span style={{ fontSize: 12, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>00:23:14</span>
          </div>
          <div style={{ fontFamily: H, fontWeight: 800, fontSize: 22, color: D.white, marginTop: 8 }}>Tony Martinez</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>1240 Lucaya Dr · Monthly Pest Control</div>
        </div>

        {/* Recap capture section */}
        <div style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: H, fontWeight: 700, fontSize: 15, color: D.text }}>Recap clips</div>
            <div style={{ fontSize: 12, color: D.muted }}>{clips.length ? `${clips.length} captured` : 'optional'}</div>
          </div>
          <div style={{ fontSize: 12.5, color: D.muted, marginTop: 4, lineHeight: 1.45 }}>
            Grab a few 5-sec clips of the work — they’ll play in Tony’s recap video. Skip it and the recap still generates.
          </div>

          {/* clips strip */}
          <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
            {clips.length === 0 ? (
              <div style={{ border: `1.5px dashed ${D.border}`, borderRadius: 14, padding: '26px 16px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                No clips yet — tap <strong style={{ color: D.teal }}>Capture</strong> below
              </div>
            ) : clips.map((c) => (
              <div key={c.cid} style={{ display: 'flex', alignItems: 'center', gap: 12, background: D.card, border: `1px solid ${D.border}`, borderRadius: 14, padding: 10 }}>
                <div style={{ width: 54, height: 54, borderRadius: 10, background: `linear-gradient(135deg, ${c.tint}, #0b1220)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><PlayTri /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: D.white }}>{c.techLabel}</div>
                  <div style={{ fontSize: 12, color: D.teal, marginTop: 1 }}>“{c.caption}”</div>
                  {c.status === 'uploading' ? (
                    <div style={{ height: 4, background: '#0b1220', borderRadius: 3, marginTop: 7, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: D.teal, borderRadius: 3, animation: 'fillbar 1.9s linear forwards' }} />
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: D.green, marginTop: 5, fontWeight: 700 }}>Uploaded</div>
                  )}
                </div>
                <button onClick={() => removeClip(c.cid)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 20, cursor: 'pointer', padding: 4 }}>×</button>
              </div>
            ))}
          </div>

          {clips.length > 0 && (
            <button onClick={() => setCloseout(true)} style={{ marginTop: 16, width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: D.green, color: '#04240f', fontFamily: H, fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
              Finish & review ({readyCount})
            </button>
          )}
        </div>

        {/* Floating capture button */}
        {mode === 'idle' && !closeout && (
          <button onClick={() => setMode('recording')} aria-label="Capture" style={{ position: 'absolute', bottom: 22, right: 22, width: 68, height: 68, borderRadius: '50%', border: '3px solid #0a0f17', background: D.teal, cursor: 'pointer', boxShadow: '0 10px 30px rgba(14,165,233,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CameraIcon /></button>
        )}

        {/* Recording overlay */}
        {mode === 'recording' && (
          <div style={overlay}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: "'JetBrains Mono', monospace", color: D.red, fontWeight: 700, fontSize: 14, letterSpacing: 1 }}><Dot color={D.red} size={9} /> REC  0:0{sec}</div>
            <div style={{ width: 150, height: 150, borderRadius: '50%', border: `4px solid ${D.red}`, margin: '22px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: -4, borderRadius: '50%', border: `4px solid ${D.teal}`, clipPath: `inset(0 ${100 - sec / 5 * 100}% 0 0)`, transition: 'clip-path .6s linear' }} />
              <CameraIcon size={50} color={D.teal} />
            </div>
            <div style={{ color: D.muted, fontSize: 13, marginBottom: 20 }}>Auto-stops at 5 seconds</div>
            <button onClick={stopRec} style={{ width: 64, height: 64, borderRadius: 16, background: D.red, border: '4px solid #fff', cursor: 'pointer' }} aria-label="Stop" />
          </div>
        )}

        {/* Tag sheet */}
        {mode === 'tagging' && (
          <div style={{ ...overlay, justifyContent: 'flex-end', padding: 0, background: 'rgba(5,8,13,.7)' }}>
            <div style={{ width: '100%', background: D.card2, borderRadius: '22px 22px 0 0', border: `1px solid ${D.border}`, padding: '18px 16px 22px', maxHeight: '82%', overflowY: 'auto' }}>
              <div style={{ width: 40, height: 4, background: D.border, borderRadius: 3, margin: '0 auto 14px' }} />
              <div style={{ fontFamily: H, fontWeight: 800, fontSize: 17, color: D.white, textAlign: 'center' }}>What were you doing?</div>
              <div style={{ fontSize: 12, color: D.muted, textAlign: 'center', margin: '4px 0 14px' }}>One tap. We caption it for the customer.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                {(showMore ? [...TOP, ...MORE] : TOP).map((chip) => (
                  <button key={chip.id} onClick={() => addClip(chip)} style={chipStyle}>
                    <Dot color={chip.tint} size={10} />
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: D.text, lineHeight: 1.25 }}>{chip.techLabel}</span>
                  </button>
                ))}
              </div>
              {!showMore && (
                <button onClick={() => setShowMore(true)} style={{ marginTop: 10, width: '100%', padding: 11, borderRadius: 10, background: 'none', border: `1px solid ${D.border}`, color: D.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>More actions…</button>
              )}
              <button onClick={() => setMode('idle')} style={{ marginTop: 8, width: '100%', padding: 11, borderRadius: 10, background: 'none', border: 'none', color: D.muted, fontSize: 13, cursor: 'pointer' }}>Skip — tag later</button>
            </div>
          </div>
        )}

        {/* Closeout review */}
        {closeout && (
          <div style={{ ...overlay, justifyContent: 'flex-start', padding: 18, overflowY: 'auto' }}>
            <div style={{ fontFamily: H, fontWeight: 800, fontSize: 19, color: D.white, marginTop: 8 }}>Closeout · Recap</div>
            <div style={{ fontSize: 13, color: D.muted, margin: '6px 0 16px' }}>These clips play in Tony’s recap. Delete any you don’t want, then complete.</div>
            <div style={{ width: '100%', display: 'grid', gap: 9 }}>
              {clips.map((c) => (
                <div key={c.cid} style={{ display: 'flex', alignItems: 'center', gap: 10, background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 9 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 8, background: `linear-gradient(135deg, ${c.tint}, #0b1220)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><PlayTri /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: D.white }}>{c.techLabel}</div>
                    <div style={{ fontSize: 11.5, color: D.teal }}>“{c.caption}”</div>
                  </div>
                  <button onClick={() => removeClip(c.cid)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ width: '100%', background: 'rgba(14,165,233,.1)', border: `1px solid ${D.teal}`, borderRadius: 12, padding: 12, marginTop: 16, fontSize: 12.5, color: D.text, display: 'flex', gap: 10 }}>
              <Dot color={D.teal} size={9} />
              <span>After you tap Complete, Tony’s ~28-sec recap renders automatically — you’ll preview & approve it before it sends.</span>
            </div>
            <button style={{ marginTop: 14, width: '100%', padding: 14, borderRadius: 12, border: 'none', background: D.green, color: '#04240f', fontFamily: H, fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>Complete & queue recap</button>
            <button onClick={() => setCloseout(false)} style={{ marginTop: 8, width: '100%', padding: 11, background: 'none', border: 'none', color: D.muted, fontSize: 13, cursor: 'pointer' }}>Back to job</button>
          </div>
        )}

        <style>{`@keyframes fillbar { from { width:0 } to { width:100% } }`}</style>
      </div>
    </div>
  );
}

const overlay = {
  position: 'absolute', inset: 0, background: 'rgba(5,8,13,.96)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24,
};
const chipStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center',
  padding: '14px 8px', borderRadius: 13, background: '#0f1923', border: '1px solid #334155',
  cursor: 'pointer', minHeight: 78, justifyContent: 'center',
};
