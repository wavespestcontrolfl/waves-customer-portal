import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import Icon from '../components/Icon';
import PublicLoadError from '../components/PublicLoadError';
import { CustomerColumn } from '../components/brand';
import { useGlassSurface } from '../glass/glass-engine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PAGE_BG = '#FAF8F3';
const CARD_BORDER = '#E7E2D7';
const INPUT_BORDER = '#CFE7F5';
const INPUT_BG = '#F8FCFE';
const TEXT = COLORS.glassNavy;
const BODY = '#3F4A65';
const MUTED = CUSTOMER_SURFACE.muted;

const primaryActionStyle = {
  minHeight: 46,
  border: 'none',
  borderRadius: 10,
  background: COLORS.glassNavy,
  color: COLORS.white,
  fontSize: 16,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  textDecoration: 'none',
  boxShadow: 'none',
  textTransform: 'none',
  letterSpacing: 0,
};

const inputBaseStyle = {
  width: '100%',
  padding: '12px 14px',
  border: `1px solid ${INPUT_BORDER}`,
  borderRadius: 10,
  background: INPUT_BG,
  fontSize: 14,
  color: TEXT,
  boxSizing: 'border-box',
};

const QUICK_STANDOUT_OPTIONS = ['On time', 'Professional', 'Thorough', 'Friendly'];

export default function RatePage() {
  const { token } = useParams();
  useGlassSurface(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // null | notfound | temporary
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [score, setScore] = useState(null);
  const [scoreHover, setScoreHover] = useState(0);
  const [screen, setScreen] = useState('rating'); // rating, feedback, success
  const [selectedStandouts, setSelectedStandouts] = useState([]);
  // Set from a successful /submit; the success screen offers the same Google
  // button only for a submission made in this session (an already-submitted
  // link never re-solicits).
  const [submittedGoogleUrl, setSubmittedGoogleUrl] = useState('');
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Score taps are saved separately from final feedback submission so quick
  // bounces are still captured without locking the token before corrections.
  const scoreSavePromiseRef = useRef(Promise.resolve());
  const submitPromiseRef = useRef(null);
  // Synchronous single-flight latch for handleSubmit — `submitting` is React state, so a double-tap in the same frame reads the
  // stale false twice and double-POSTs /submit. Same live-ref reasoning as
  // submitPromiseRef above; flips before any await.
  const submittingRef = useRef(false);
  const [openingGoogle, setOpeningGoogle] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/rate/${token}`)
      .then(r => {
        if (r.status === 404 || r.status === 410) { const err = new Error('notfound'); err.notFound = true; throw err; }
        if (!r.ok) throw new Error('temporary');
        return r.json();
      })
      .then(d => {
        setData(d);
        if (d?.alreadySubmitted) setScreen('success');
        setLoading(false);
      })
      .catch(e => { setError(e.notFound ? 'notfound' : 'temporary'); setLoading(false); });
  }, [token, loadAttempt]);

  const saveScoreDraft = (nextScore, nextHighlights = selectedStandouts) => {
    const savePromise = scoreSavePromiseRef.current
      .catch(() => {})
      .then(() => fetch(`${API_BASE}/rate/${token}/score`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: nextScore, highlights: nextHighlights }),
      }))
      .then((r) => {
        if (!r.ok && r.status !== 409) throw new Error('Unable to save rating');
        return r.json().catch(() => ({}));
      })
      .catch(() => ({}));

    scoreSavePromiseRef.current = savePromise;
    return savePromise;
  };

  const handleScore = (s) => {
    setScore(s);
    saveScoreDraft(s, s >= 8 ? selectedStandouts : []);
    submitPromiseRef.current = null;
    // 8–10 stays on the rating screen and shows the quick standout chips;
    // 1–7 goes to the private feedback form. Every score is offered the same
    // Google review button (owner ruling 2026-09-29: neutral asks, no
    // filtering by satisfaction) — going to Google is always the customer's tap.
    setScreen(s >= 8 ? 'rating' : 'feedback');
  };

  const toggleStandout = (s) => {
    setSelectedStandouts(prev => {
      let next;
      if (prev.includes(s)) next = prev.filter(x => x !== s);
      else if (prev.length >= 3) next = prev; // max 3
      else next = [...prev, s];
      if (score >= 8 && next !== prev) saveScoreDraft(score, next);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      await scoreSavePromiseRef.current;
      const r = await fetch(`${API_BASE}/rate/${token}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, feedback, highlights: [] }),
      });
      // 409 = the server already has this feedback (first POST committed but
      // the response was lost, or a second tab submitted). Retrying forever
      // would trap saved feedback behind an error — it's a success.
      if (r.status === 409) {
        setScreen('success');
        return;
      }
      if (!r.ok) throw new Error(`Submit failed (${r.status})`);
      const result = await r.json();
      setSubmittedGoogleUrl(result.googleReviewUrl || '');
      setScreen('success');
    } catch {
      // Keep the feedback on screen — a false "Thank you!" here silently
      // discarded a detractor's complaint with no retry.
      setSubmitError("We couldn't send your feedback. Please check your connection and tap Send again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // Commits the score (and any typed note) once, whichever button gets there
  // first. The server treats the submit as final and runs the same office
  // alerts for a low score whether or not the customer goes on to Google.
  const ensureSubmitted = async () => {
    await scoreSavePromiseRef.current;

    if (submitPromiseRef.current) {
      await submitPromiseRef.current;
      return;
    }

    const submitPromise = fetch(`${API_BASE}/rate/${token}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, feedback, highlights: score >= 8 ? selectedStandouts : [] }),
    }).then((r) => {
      // 409 = already committed (this session or another tab): proceed.
      if (!r.ok && r.status !== 409) throw new Error('Unable to save rating');
      return r.json().catch(() => ({}));
    });

    submitPromiseRef.current = submitPromise;
    try {
      await submitPromise;
    } catch (err) {
      // Drop the rejected promise so the next attempt re-submits instead of
      // replaying this failure forever.
      if (submitPromiseRef.current === submitPromise) submitPromiseRef.current = null;
      throw err;
    }
  };

  // The one Google review button, the same for every score. Opens in the same
  // tab: new tabs get orphaned on mobile Safari, which is the main browser
  // these review links open on.
  const handleOpenGoogle = async () => {
    const url = submittedGoogleUrl || data?.googleReviewUrl;
    if (!url || openingGoogle) return;
    setOpeningGoogle(true);
    try {
      if (!submittedGoogleUrl) {
        try { await ensureSubmitted(); } catch { await saveScoreDraft(score, score >= 8 ? selectedStandouts : []); }
      }
      window.location.href = url;
    } finally {
      setOpeningGoogle(false);
    }
  };

  const firstName = data?.firstName || 'there';
  const techName = data?.techName || 'your technician';
  const techPhotoUrl = data?.techPhotoUrl || null;
  const googleReviewAction = (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 14, lineHeight: 1.45, color: MUTED, textAlign: 'center' }}>
        Public Google reviews help local neighbors choose a provider.
      </div>
      <button onClick={handleOpenGoogle} disabled={openingGoogle} data-glass-accent="" style={{
        ...primaryActionStyle,
        width: '100%', marginTop: 12,
        opacity: openingGoogle ? 0.6 : 1,
        cursor: openingGoogle ? 'default' : 'pointer',
      }}>
        Open Google
      </button>
    </div>
  );

  if (loading) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 48 }}>
        <style>{`@media (prefers-reduced-motion: reduce) { [data-rate-spinner] { animation: none !important; } }`}</style>
        <div data-rate-spinner="" style={{ width: 32, height: 32, border: `3px solid ${CARD_BORDER}`, borderTopColor: COLORS.glassNavy, borderRadius: '50%', animation: 'spin .7s linear infinite', margin: '0 auto 14px' }} />
        <span style={{ fontSize: 14, color: MUTED }}>Loading...</span>
      </div>
    </Page>
  );

  if (error === 'temporary') return (
    // CustomerColumn, not a hand-rolled wrapper: my first pass at un-nesting
    // this kept the page card's `calc(100% - 24px)` / 420 cap, which capped the
    // state card at 420 with 12px gutters and defeated its own 560 / 16. A
    // parent constraint bypasses the component's prop filtering entirely.
    <Scene>
      <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
        <PublicLoadError resource="feedback request" onRetry={() => setLoadAttempt(a => a + 1)} />
      </CustomerColumn>
    </Scene>
  );

  if (error === 'notfound') return (
    <Page>
      <div role="alert" style={{ textAlign: 'center', padding: 36, color: BODY, fontSize: 16, lineHeight: 1.5 }}>
        <p>This link may have expired or already been used.</p>
        <p style={{ marginTop: 12 }}><a href="https://wavespestcontrol.com" style={{ color: COLORS.glassNavy, fontWeight: 700, textDecoration: 'none' }}>Visit wavespestcontrol.com</a></p>
      </div>
    </Page>
  );

  return (
    <Page>
      {/* Rating Screen */}
      {screen === 'rating' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 22 }}>
            {techPhotoUrl ? (
              <img
                src={techPhotoUrl}
                alt={techName}
                referrerPolicy="no-referrer"
                style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', margin: '0 auto 12px', display: 'block', boxShadow: '0 4px 20px rgba(0,156,222,0.35)' }}
              />
            ) : (
              <div style={{ width: 80, height: 80, borderRadius: '50%', background: INPUT_BG, border: `1px solid ${INPUT_BORDER}`, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 700, color: COLORS.glassNavy, fontFamily: FONTS.body, boxShadow: 'none' }}>
                {(techName || 'W')[0].toUpperCase()}
              </div>
            )}
            <div style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>{techName}</div>
          </div>

          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, textAlign: 'center', color: TEXT, marginBottom: 22, lineHeight: 1.15 }}>
            Hey {firstName}, how'd we do?
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, padding: '0 2px' }}>
            <span style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: MUTED }}>Not Great</span>
            <span style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: MUTED }}>Amazing!</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: 4 }}>
            {[1,2,3,4,5,6,7,8,9,10].map(n => {
              const activeScore = scoreHover || score || 0;
              const isActive = n <= activeScore;
              const color = n <= 3 ? COLORS.red : n <= 7 ? COLORS.orange : COLORS.green;
              const shadow = isActive
                ? n <= 3 ? '0 8px 18px rgba(200,16,46,0.28)' : n <= 7 ? '0 8px 18px rgba(245,158,11,0.30)' : '0 8px 18px rgba(22,163,74,0.30)'
                : '0 3px 10px rgba(15,23,42,0.12)';
              return (
                <button
                  key={n}
                  onMouseEnter={() => setScoreHover(n)}
                  onMouseLeave={() => setScoreHover(0)}
                  onFocus={() => setScoreHover(n)}
                  onBlur={() => setScoreHover(0)}
                  onClick={() => handleScore(n)}
                  style={{
                    minHeight: 40, minWidth: 0, border: 'none', borderRadius: 8,
                    background: isActive ? color : INPUT_BG, fontFamily: FONTS.body, fontSize: 16, fontWeight: 700,
                    color: isActive ? COLORS.white : MUTED, cursor: 'pointer', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', padding: 0,
                    boxShadow: shadow,
                    transition: 'all 0.15s ease', transform: isActive ? 'scale(1.08)' : 'scale(1)',
                  }}>{n}</button>
              );
            })}
          </div>
          {score >= 8 ? (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 8, textAlign: 'center' }}>
                What stood out? <span style={{ fontWeight: 500, color: MUTED }}>(optional)</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                {QUICK_STANDOUT_OPTIONS.map(s => {
                  const selected = selectedStandouts.includes(s);
                  const disabled = !selected && selectedStandouts.length >= 3;
                  return (
                    <button key={s} onClick={() => toggleStandout(s)} disabled={disabled} style={{
                      minHeight: 40, border: `1px solid ${selected ? COLORS.green : CARD_BORDER}`,
                      borderRadius: 8, background: selected ? COLORS.green : COLORS.white,
                      color: selected ? COLORS.white : BODY, fontSize: 14, fontWeight: 700,
                      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
                      boxShadow: selected ? '0 6px 14px rgba(22,163,74,0.22)' : '0 2px 8px rgba(15,23,42,0.08)',
                    }}>{s}</button>
                  );
                })}
              </div>
              {data?.googleReviewUrl && googleReviewAction}
            </div>
          ) : (
            <div style={{ textAlign: 'center', marginTop: 10, fontSize: 14, color: MUTED, fontWeight: 600 }}>Tap a number to rate</div>
          )}
        </div>
      )}

      {/* Feedback Screen (1-7) */}
      {screen === 'feedback' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: score <= 3 ? '#FEE2E2' : '#FFF8E8', color: score <= 3 ? COLORS.red : COLORS.orange, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={score <= 3 ? 'frown' : 'message'} size={30} strokeWidth={2} />
          </div>
          {score <= 3 && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FEE2E2', color: COLORS.red, fontSize: 14, fontWeight: 700, padding: '6px 14px', borderRadius: 8, marginBottom: 12 }}>We want to make this right</div>}
          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>
            {score <= 3 ? "We're sorry to hear that." : "Thanks for the feedback."}
          </div>
          <div style={{ fontSize: 16, color: BODY, lineHeight: 1.55, marginBottom: 16 }}>
            {score <= 3 ? "What went wrong? We'll personally follow up." : "What could we have done better?"}
          </div>
          <textarea value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Tell us what happened..." rows={4} aria-label="Tell us what happened" className="waves-focus-ring" style={{
            ...inputBaseStyle,
            minHeight: 100,
            padding: 14,
            fontSize: 16,
            resize: 'vertical',
          }} />
          {submitError && (
            <div role="alert" style={{ marginTop: 12, fontSize: 14, fontWeight: 700, color: COLORS.red, background: '#FEE2E2', borderRadius: 8, padding: '10px 14px' }}>
              {submitError}
            </div>
          )}
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
            data-glass-accent=""
            style={{ ...primaryActionStyle, width: '100%', fontSize: 16, marginTop: 12 }}
          >
            {submitting ? 'Sending...' : 'Send Feedback'}
          </Button>
          {data?.googleReviewUrl && googleReviewAction}
        </div>
      )}

      {/* Success Screen */}
      {screen === 'success' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: COLORS.greenLight, color: COLORS.green, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="checkCircle" size={30} strokeWidth={2} />
          </div>
          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>Thank you!</div>
          <div style={{ fontSize: 16, color: BODY, lineHeight: 1.55 }}>Your feedback helps us serve you better.</div>
          {submittedGoogleUrl && googleReviewAction}
        </div>
      )}
    </Page>
  );
}

// The page scene, without the card. Split out because PublicLoadError now owns
// a card of its own: rendering it inside <Page> nested one glass card in
// another, with duplicate material and padding, on the one production path
// that shows it.
function Scene({ children }) {
  return (
    <div data-glass-clear="" style={{ flex: 1, paddingBottom: 40, background: PAGE_BG, display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: FONTS.body, position: 'relative', overflow: 'hidden' }}>
      {children}
      {/* Anton / Montserrat / Inter load globally via client/index.html */}
    </div>
  );
}

function Page({ children }) {
  return (
    <Scene>
      <div data-glass="card" style={{ position: 'relative', zIndex: 1, width: 'calc(100% - 24px)', maxWidth: 420, background: COLORS.white, borderRadius: 8, border: `1px solid ${CARD_BORDER}`, boxShadow: 'none', overflow: 'hidden', marginTop: 'clamp(20px, 8dvh, 64px)' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', justifyContent: 'center' }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 34, display: 'block' }} />
        </div>
        <div style={{ padding: '28px clamp(12px, 5vw, 22px) 24px' }}>
          {children}
        </div>
      </div>
    </Scene>
  );
}
