import { useEffect, useRef, useState } from 'react';
import { buildLawnShareCard, bareLink } from '../../lib/lawnShareCard';

// "Share your lawn" (GATE_REPORT_WEB_SHARE, owner 2026-10-20, idea 8). Shown by
// the web report only when the server sent `webShare` (lawn score 85 or more,
// a front photo, an active referral program). Customer-started: nothing is
// built or fetched until the tap, and nothing is sent by Waves. The tap enrolls
// the customer's referral link the same way the report's referral card does
// (staff views skip the enrolling fetch). The card holds the front photo, the
// score, the Waves logo and the referral link; never the address or the name.
const SHARE_TEXT = 'A look at my lawn, from Waves Pest Control.';

export default function ShareLawnCard({ token, score, apiBase, staffView = false, glass = false, onTap = null }) {
  // idle | building | shared | saved | failed
  const [state, setState] = useState('idle');
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const fetchLink = async () => {
    // A staff tap must not enroll anyone (the report card's rule).
    if (staffView) return 'https://wavespestcontrol.com';
    const response = await fetch(`${apiBase}/reports/${token}/referral-link`, { method: 'POST' });
    if (!response.ok) throw new Error(`referral link ${response.status}`);
    const body = await response.json();
    if (!body?.link) throw new Error('referral link empty');
    return body.link;
  };

  const share = async () => {
    if (state === 'building') return;
    if (typeof onTap === 'function') onTap();
    setState('building');
    try {
      const link = await fetchLink();
      const blob = await buildLawnShareCard({
        photoUrl: `${apiBase}/reports/${token}/share-photo`,
        logoUrl: '/waves-logo.png',
        score,
        link,
      });
      const file = new File([blob], 'my-lawn-waves.jpg', { type: 'image/jpeg' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: `${SHARE_TEXT} ${bareLink(link)}` });
          setState('shared');
        } catch (err) {
          // Closing the share sheet is not an error.
          setState(err && err.name === 'AbortError' ? 'idle' : 'failed');
        }
        return;
      }
      // No file sharing here: show the picture and offer the download.
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = URL.createObjectURL(blob);
      setPreview(previewRef.current);
      setState('saved');
    } catch {
      setState('failed');
    }
  };

  return (
    <div style={{ maxWidth: 760, margin: '12px auto 0', padding: '0 16px', boxSizing: 'border-box' }}>
    <section
      {...(glass ? { 'data-glass': 'card' } : {})}
      data-section="share-lawn"
      style={{ padding: '16px 18px', boxSizing: 'border-box', color: '#04395E', ...(glass ? {} : { background: '#fff', border: '1px solid rgba(4,57,94,0.16)', borderRadius: 14 }) }}
    >
      <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.25, fontWeight: 700 }}>Your lawn is looking great</h2>
      <p style={{ margin: '6px 0 12px', fontSize: 16, lineHeight: 1.45 }}>
        Share a picture card of your front yard with your score and your referral link.
      </p>
      <button
        type="button"
        onClick={share}
        disabled={state === 'building'}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 48, padding: '0 20px',
          border: 0, borderRadius: 12, background: '#04395E', color: '#fff', fontSize: 16, fontWeight: 700,
          cursor: state === 'building' ? 'default' : 'pointer', opacity: state === 'building' ? 0.7 : 1,
        }}
      >
        {state === 'building' ? 'Making your card...' : 'Share your lawn'}
      </button>
      <div aria-live="polite">
        {state === 'shared' ? <p style={{ margin: '10px 0 0', fontSize: 16 }}>Thank you for sharing.</p> : null}
        {state === 'failed' ? <p role="alert" style={{ margin: '10px 0 0', fontSize: 16 }}>We could not make your card. Please try again.</p> : null}
        {state === 'saved' && preview ? (
          <div style={{ marginTop: 12 }}>
            <img src={preview} alt="Your lawn card" style={{ display: 'block', width: '100%', maxWidth: 360, borderRadius: 12 }} />
            <p style={{ margin: '8px 0 0', fontSize: 16, lineHeight: 1.45 }}>
              <a href={preview} download="my-lawn-waves.jpg" style={{ color: '#04395E', fontWeight: 700 }}>Save the picture</a>
              {' '}or press and hold it to save.
            </p>
          </div>
        ) : null}
      </div>
    </section>
    </div>
  );
}
