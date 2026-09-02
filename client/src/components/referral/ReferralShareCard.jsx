import { useState } from 'react';

/**
 * The customer-facing referral share module — one card for every public
 * surface that offers it (service report, estimate accepted / just-accepted
 * screens). Owner-approved 2026-08-11, redesigned 2026-08-13: headline +
 * button only; the tap reveals the same share module the portal's Refer tab
 * uses (code, prefilled text and email).
 *
 * Every word and amount is COMPOSED SERVER-SIDE from live referral program
 * settings (headline/cta ride the render payload as `referral`; code + share
 * copy come back from `fetchLink()` ON THE TAP), so the card never promises
 * a benefit the program no longer grants and no dollar figure is ever
 * hardcoded client-side. Fetching the code enrolls the customer as a
 * promoter (a durable row), which is why a render must never do it.
 *
 * Props:
 *   referral   — { headline, cta } from the render payload; null → renders nothing
 *   fetchLink  — async () => { code, link, smsBody, emailSubject, emailBody };
 *                the caller owns the endpoint (and any analytics beacon)
 *   staffView  — true suppresses the fetch entirely (a QA tap must not enroll)
 *   onTap      — optional beacon fired on EVERY tap (staff included), before
 *                the fetch decision — analytics, never enrollment
 *   className  — outer section class hook (the report page passes its
 *                report-card classes; the estimate page uses the glass card)
 *   styles     — optional inline style overrides { heading, button, link,
 *                code, copy } for surfaces without the report stylesheet
 */
export default function ReferralShareCard({ referral, fetchLink, staffView = false, onTap = null, className = '', dataSection = 'referral', style = null, styles = {} }) {
  // idle → loading → open | failed | staff
  const [shareState, setShareState] = useState('idle');
  const [share, setShare] = useState(null);
  if (!referral?.headline) return null;
  const openShare = async () => {
    if (shareState === 'loading' || shareState === 'open') return;
    if (typeof onTap === 'function') onTap();
    if (staffView) {
      setShare(null);
      setShareState('staff');
      return;
    }
    setShareState('loading');
    try {
      const body = await fetchLink();
      if (!body?.code) throw new Error('referral link empty');
      setShare(body);
      setShareState('open');
    } catch {
      setShareState('failed');
    }
  };
  const copyCode = async () => {
    try { await navigator.clipboard?.writeText?.(share.code); } catch { /* clipboard unavailable */ }
  };
  return (
    <section data-glass="card" className={className} data-section={dataSection} style={style || undefined}>
      <h2 style={styles.heading || undefined}>{referral.headline}</h2>
      {shareState === 'open' && share ? (
        <div className="referral-share">
          <div className="referral-code-chip">
            <span className="referral-code" style={styles.code || undefined}>{share.code}</span>
            <button type="button" className="referral-copy" onClick={copyCode} style={styles.copy || undefined}>Copy</button>
          </div>
          <div className="referral-share-row">
            <a data-glass-accent="" className="review-cta cross-sell-cta" style={styles.link || undefined} href={`sms:?&body=${encodeURIComponent(share.smsBody || '')}`}>Text it</a>
            <a data-glass-accent="" className="review-cta cross-sell-cta" style={styles.link || undefined} href={`mailto:?subject=${encodeURIComponent(share.emailSubject || '')}&body=${encodeURIComponent(share.emailBody || '')}`}>Email it</a>
          </div>
        </div>
      ) : shareState === 'staff' ? (
        <p className="cross-sell-confirm">Staff view — the share module renders for customers.</p>
      ) : (
        <div className="cross-sell-cta-row">
          <button
            type="button"
            data-glass-accent=""
            className="review-cta cross-sell-cta"
            style={styles.button || undefined}
            disabled={shareState === 'loading'}
            onClick={openShare}
          >
            {shareState === 'loading' ? 'One moment…' : referral.cta || 'Refer a friend'}
          </button>
        </div>
      )}
      {shareState === 'failed' && (
        <p className="cross-sell-fine cross-sell-error">
          That didn&apos;t go through — please try again, or call (941) 297-5749.
        </p>
      )}
    </section>
  );
}
