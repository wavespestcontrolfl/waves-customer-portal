// Public, token-gated player for the "Your Visit, in Motion" recap. Reached from
// the post-service SMS ("watch your recap" link). No auth — the report token gates
// it, and the server only serves the video once the tech has approved it. Warm
// Waves brand; falls back to the full report when no recap is ready.
import { useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { COLORS, FONTS } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';
import { useGlassSurface } from '../glass/glass-engine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function RecapViewPage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [status, setStatus] = useState('loading'); // loading | ready | notready | error
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/reports/${token}/recap`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setStatus(d && d.ready ? 'ready' : 'notready'); })
      .catch(() => { if (alive) setStatus('error'); });
    return () => { alive = false; };
  }, [token]);

  const pageUrl = typeof window !== 'undefined' ? window.location.href : '';
  const reportUrl = `/report/${token}`;
  const videoUrl = `${API_BASE}/reports/${token}/recap/video`;

  const share = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'My Waves service recap', url: pageUrl });
        return;
      }
    } catch { /* user canceled share sheet */ }
    try { await navigator.clipboard.writeText(pageUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };

  // The glass scene is LIGHT, so the root goes transparent with the dark-navy
  // text treatment the other glass pages use.
  const ink = COLORS.blueDeeper;
  // Root is top-aligned + scrollable; the content stack centers itself via
  // flex:1 when short. Keeps the footer out of the centered group so a tall
  // video + footer scrolls instead of pushing content above the viewport.
  const wrap = {
    minHeight: '100vh', background: 'transparent',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '28px 18px', fontFamily: FONTS.body, color: ink, textAlign: 'center',
  };
  const contentStack = {
    flex: 1, width: '100%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 18,
  };
  const wordmark = { fontFamily: FONTS.heading, fontWeight: 900, fontSize: 22, letterSpacing: 4, color: ink };
  const btn = (solid) => ({
    padding: '13px 22px', borderRadius: 999, fontSize: 15, fontWeight: 700, cursor: 'pointer',
    border: solid ? 'none' : `1.5px solid rgba(4,57,94,.5)`,
    background: solid ? COLORS.white : 'transparent', color: solid ? COLORS.blueDeeper : ink,
    fontFamily: FONTS.heading, textDecoration: 'none', display: 'inline-block',
  });

  return (
    <div style={wrap}>
      <div style={contentStack}>
      <div style={wordmark}>WAVES</div>
      {status === 'loading' && <div style={{ opacity: 0.8 }}>Loading your recap…</div>}

      {status === 'ready' && (
        <>
          <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: 24 }}>Your visit, in motion</div>
          <video
            src={videoUrl}
            controls
            autoPlay
            muted
            playsInline
            style={{ width: '100%', maxWidth: 360, maxHeight: '74vh', borderRadius: 18, background: '#000', boxShadow: '0 20px 60px rgba(0,0,0,.45)' }}
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button style={btn(true)} data-glass-accent="" onClick={share}>{copied ? 'Link copied' : 'Share'}</button>
            <a style={btn(false)} data-glass="chip" data-glass-pill="" href={reportUrl}>See your full report</a>
          </div>
          <div style={{ fontSize: 12, opacity: 0.65, maxWidth: 320 }}>From your Waves technician. Questions? Just reply to our text or call (941) 297-5749.</div>
        </>
      )}

      {(status === 'notready' || status === 'error') && (
        <>
          <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: 22 }}>Your recap isn’t ready yet</div>
          <div style={{ opacity: 0.85, maxWidth: 320 }}>Your full service report is ready in the meantime.</div>
          <a style={btn(true)} data-glass-accent="" href={reportUrl}>Open your service report</a>
        </>
      )}
      </div>

      <div style={{ width: '100%', maxWidth: 360 }}>
        <BrandFooter />
      </div>
    </div>
  );
}
