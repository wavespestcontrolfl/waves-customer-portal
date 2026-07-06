import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import BrandFooter from '../components/BrandFooter';
import Icon from '../components/Icon';
import { useGlassSurface } from '../glass/glass-engine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PAGE_BG = '#FAF8F3';
const CARD_BORDER = '#E7E2D7';
const INPUT_BORDER = '#CFE7F5';
const INPUT_BG = '#F8FCFE';
const TEXT = COLORS.blueDeeper;
const BODY = '#3F4A65';
const MUTED = CUSTOMER_SURFACE.muted;

const primaryActionStyle = {
  minHeight: 46,
  border: 'none',
  borderRadius: 10,
  background: COLORS.blueDeeper,
  color: COLORS.white,
  fontSize: 15,
  fontWeight: 800,
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

const disabledActionStyle = {
  ...primaryActionStyle,
  background: '#9CA3AF',
  cursor: 'default',
};

const inputBaseStyle = {
  width: '100%',
  padding: '12px 14px',
  border: `1px solid ${INPUT_BORDER}`,
  borderRadius: 10,
  background: INPUT_BG,
  fontSize: 14,
  color: TEXT,
  outline: 'none',
  boxSizing: 'border-box',
};

const HIGHLIGHTS = [
  'On Time', 'Thorough', 'Professional', 'Friendly', 'Knowledgeable',
  'Great Communication', 'Clean Work', 'Fast Service', 'Fair Price', 'Above & Beyond',
];

const SERVICE_OPTIONS = [
  'Pest Control',
  'Lawn Care',
  'Mosquito',
  'Tree & Shrub',
];

const STANDOUT_OPTIONS = [
  'On time', 'Professional', 'Thorough', 'Friendly', 'Great results', 'Fair price',
];

const QUICK_STANDOUT_OPTIONS = ['On time', 'Professional', 'Thorough', 'Friendly'];

function getServiceSelection(serviceType) {
  const clean = String(serviceType || '').trim();
  if (!clean) return [];
  const match = SERVICE_OPTIONS.find((service) => clean.toLowerCase().includes(service.toLowerCase()));
  return [match || clean];
}

export default function RatePage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [score, setScore] = useState(null);
  const [scoreHover, setScoreHover] = useState(0);
  const [screen, setScreen] = useState('rating'); // rating, highlights, ai-review, feedback, success, redirect
  const [highlights, setHighlights] = useState([]);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // AI Review Writer state
  const [selectedServices, setSelectedServices] = useState([]);
  const [selectedStandouts, setSelectedStandouts] = useState([]);
  const [personalNote, setPersonalNote] = useState('');
  const [generatedReview, setGeneratedReview] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [postHint, setPostHint] = useState('');

  // Score taps are saved separately from final feedback submission so quick
  // bounces are still captured without locking the token before corrections.
  const scoreSavePromiseRef = useRef(Promise.resolve());
  const submitPromiseRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/rate/${token}`)
      .then(r => { if (!r.ok) throw new Error('Invalid link'); return r.json(); })
      .then(d => {
        setData(d);
        if (d?.alreadySubmitted) setScreen('success');
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  const getKnownServices = () => (
    data?.hasServiceType ? getServiceSelection(data.serviceType) : []
  );

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
    setPostHint('');
    setReviewError('');
    setGeneratedReview('');
    saveScoreDraft(s, s >= 8 ? selectedStandouts : []);
    // 8–10 stays on the rating screen, reveals the quick standout chips, and
    // waits to submit until the customer commits to the Google-review path.
    if (s >= 8) {
      setScreen('rating');
      const knownServices = getKnownServices();
      if (knownServices.length) setSelectedServices(knownServices);
      submitPromiseRef.current = null;
    } else {
      submitPromiseRef.current = null;
      setScreen('feedback');
    }
  };

  const toggleHighlight = (h) => {
    setHighlights(prev => prev.includes(h) ? prev.filter(x => x !== h) : [...prev, h]);
  };

  const toggleService = (s) => {
    setSelectedServices(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
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
    setSubmitting(true);
    try {
      await scoreSavePromiseRef.current;
      const r = await fetch(`${API_BASE}/rate/${token}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, feedback, highlights }),
      });
      const result = await r.json();
      if (result.redirect) {
        setScreen('redirect');
        setTimeout(() => { window.location.href = result.redirect; }, 2000);
      } else {
        setScreen('success');
      }
    } catch { setScreen('success'); }
    setSubmitting(false);
  };

  // Submit score, then go to AI review step
  const handleHighlightsNext = async () => {
    setSubmitting(true);
    try {
      await scoreSavePromiseRef.current;
      await fetch(`${API_BASE}/rate/${token}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, feedback: '', highlights }),
      });
    } catch { /* proceed anyway */ }
    setSubmitting(false);
    // Pre-select service type from data if available
    const knownServices = getKnownServices();
    if (knownServices.length && !knownServices.every((service) => selectedServices.includes(service))) {
      setSelectedServices(knownServices);
    }
    setScreen('ai-review');
  };

  const ensureHighScoreSubmitted = async (standouts = selectedStandouts) => {
    await scoreSavePromiseRef.current;

    if (submitPromiseRef.current) {
      await submitPromiseRef.current;
      return;
    }

    const submitPromise = fetch(`${API_BASE}/rate/${token}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, feedback: '', highlights: standouts }),
    }).then((r) => {
      // If the score was already persisted in this session, the draft endpoint
      // can still proceed because it only needs request.score >= 8.
      if (!r.ok && r.status !== 409) throw new Error('Unable to save rating');
      return r.json().catch(() => ({}));
    });

    submitPromiseRef.current = submitPromise;
    await submitPromise;
  };

  const handleGenerateReview = async ({ services = selectedServices, standouts = selectedStandouts, note = personalNote } = {}) => {
    setGenerating(true);
    setGeneratedReview('');
    setReviewError('');
    setPostHint('');
    try {
      await ensureHighScoreSubmitted(standouts);
      const r = await fetch(`${API_BASE}/rate/${token}/generate-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services,
          highlights: standouts,
          personalNote: note,
        }),
      });
      const result = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(result.error || 'Unable to write review');
      if (!result.review) throw new Error('Review writer returned no draft');
      setGeneratedReview(result.review);
    } catch (err) {
      setReviewError("We couldn't write this automatically. You can still write your own on Google.");
    }
    setGenerating(false);
  };

  const handleHappyReviewStart = async () => {
    const services = selectedServices.length ? selectedServices : getKnownServices();
    if (services.length) setSelectedServices(services);
    setScreen('ai-review');
    if (!services.length) return;
    await handleGenerateReview({ services, standouts: selectedStandouts });
  };

  const handleCopyReview = () => {
    navigator.clipboard.writeText(generatedReview).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {});
  };

  // Single-action "Post on Google" — copy the draft and immediately redirect
  // to the closest GBP review URL in the same tab. New tabs get orphaned on
  // mobile Safari, which is the main browser these review links open on.
  const handlePostOnGoogle = async () => {
    if (!data?.googleReviewUrl) return;
    try {
      if (generatedReview) await navigator.clipboard.writeText(generatedReview);
    } catch { /* clipboard API can fail on iOS in-app browsers; still redirect */ }
    setPostHint('Review copied. Paste it into Google.');
    setTimeout(() => { window.location.href = data.googleReviewUrl; }, 900);
  };

  const handleSkipToGoogle = async () => {
    if (score >= 8) {
      try { await ensureHighScoreSubmitted(selectedStandouts); } catch { await saveScoreDraft(score, selectedStandouts); }
    }
    if (data?.googleReviewUrl) {
      window.location.href = data.googleReviewUrl;
    } else {
      setScreen('success');
    }
  };

  const firstName = data?.firstName || 'there';
  const techName = data?.techName || 'your technician';
  const techPhotoUrl = data?.techPhotoUrl || null;
  const knownServiceSelection = getKnownServices();
  const hasKnownService = knownServiceSelection.length > 0;

  if (loading) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div style={{ width: 32, height: 32, border: `3px solid ${CARD_BORDER}`, borderTopColor: COLORS.blueDeeper, borderRadius: '50%', animation: 'spin .7s linear infinite', margin: '0 auto 14px' }} />
        <span style={{ fontSize: 14, color: MUTED }}>Loading...</span>
      </div>
    </Page>
  );

  if (error) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 36, color: BODY, fontSize: 15, lineHeight: 1.5 }}>
        <p>This link may have expired or already been used.</p>
        <p style={{ marginTop: 12 }}><a href="https://wavespestcontrol.com" style={{ color: COLORS.blueDeeper, fontWeight: 800, textDecoration: 'none' }}>Visit wavespestcontrol.com</a></p>
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
                style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', margin: '0 auto 12px', display: 'block', boxShadow: '0 4px 20px rgba(0,156,222,0.35)' }}
              />
            ) : (
              <div style={{ width: 80, height: 80, borderRadius: '50%', background: INPUT_BG, border: `1px solid ${INPUT_BORDER}`, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 800, color: COLORS.blueDeeper, fontFamily: FONTS.body, boxShadow: 'none' }}>
                {(techName || 'W')[0].toUpperCase()}
              </div>
            )}
            <div style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>{techName}</div>
          </div>

          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, textAlign: 'center', color: TEXT, marginBottom: 22, lineHeight: 1.15 }}>
            Hey {firstName}, how'd we do?
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, padding: '0 2px' }}>
            <span style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, color: MUTED }}>Not Great</span>
            <span style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, color: MUTED }}>Amazing!</span>
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
                    background: isActive ? color : INPUT_BG, fontFamily: FONTS.body, fontSize: 16, fontWeight: 800,
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
              <div style={{ fontSize: 14, fontWeight: 800, color: TEXT, marginBottom: 8, textAlign: 'center' }}>
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
                      color: selected ? COLORS.white : BODY, fontSize: 14, fontWeight: 800,
                      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
                      boxShadow: selected ? '0 6px 14px rgba(22,163,74,0.22)' : '0 2px 8px rgba(15,23,42,0.08)',
                    }}>{s}</button>
                  );
                })}
              </div>
              <div style={{ marginTop: 12, fontSize: 14, lineHeight: 1.45, color: MUTED, textAlign: 'center' }}>
                Public Google reviews help local neighbors choose a provider.
              </div>
              <button onClick={handleHappyReviewStart} disabled={generating} data-glass-accent="" style={{
                ...(generating ? disabledActionStyle : primaryActionStyle),
                width: '100%', marginTop: 12,
              }}>
                {generating ? 'Writing your review...' : 'Help Me Write It'}
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', marginTop: 10, fontSize: 14, color: MUTED, fontWeight: 600 }}>Tap a number to rate</div>
          )}
        </div>
      )}

      {/* Highlights Screen (8-10) */}
      {screen === 'highlights' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: COLORS.greenLight, color: COLORS.green, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="party" size={30} strokeWidth={2} />
          </div>
          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>Awesome, thank you!</div>
          <div style={{ fontSize: 15, color: BODY, lineHeight: 1.55, marginBottom: 16 }}>What stood out about your experience?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
            {HIGHLIGHTS.map(h => (
              <button key={h} onClick={() => toggleHighlight(h)} style={{
                padding: '10px 16px', minHeight: 44, border: `1px solid ${highlights.includes(h) ? COLORS.blueDeeper : CARD_BORDER}`,
                borderRadius: 8, background: highlights.includes(h) ? COLORS.blueDeeper : COLORS.white,
                color: highlights.includes(h) ? COLORS.white : BODY, fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>{h}</button>
            ))}
          </div>
          <Button
            variant="primary"
            onClick={handleHighlightsNext}
            disabled={submitting}
            data-glass-accent=""
            style={{ ...primaryActionStyle, fontSize: 16 }}
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="#FFFFFF"/></svg>}
            iconPosition="left"
          >
            {submitting ? 'Sending...' : 'Leave a Google Review'}
          </Button>
          <button onClick={() => { setScreen('success'); handleSubmit(); }} style={{ display: 'block', margin: '14px auto 0', fontSize: 14, color: MUTED, background: 'none', border: 'none', cursor: 'pointer' }}>Skip for now</button>
        </div>
      )}

      {/* AI Review Writer Screen */}
      {screen === 'ai-review' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 6 }}>
              We'll write it for you!
            </div>
            <div style={{ fontSize: 16, color: BODY, lineHeight: 1.5 }}>
              Public Google reviews help local neighbors choose a provider.
            </div>
          </div>

          {!generatedReview && !generating && (
            <>
              {/* Service selection */}
              {!hasKnownService && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 8 }}>What service did you receive?</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {SERVICE_OPTIONS.map(s => (
                      <button key={s} onClick={() => toggleService(s)} style={{
                        padding: '9px 16px', border: `1px solid ${selectedServices.includes(s) ? COLORS.blueDeeper : CARD_BORDER}`,
                        borderRadius: 8, background: selectedServices.includes(s) ? COLORS.blueDeeper : COLORS.white,
                        color: selectedServices.includes(s) ? COLORS.white : BODY, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                      }}>{s}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Standout selection */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 4 }}>What stood out?</div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Pick up to 3</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {STANDOUT_OPTIONS.map(s => (
                    <button key={s} onClick={() => toggleStandout(s)} style={{
                      padding: '9px 16px', border: `1px solid ${selectedStandouts.includes(s) ? COLORS.green : CARD_BORDER}`,
                      borderRadius: 8, background: selectedStandouts.includes(s) ? COLORS.green : COLORS.white,
                      color: selectedStandouts.includes(s) ? COLORS.white : BODY, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                      opacity: (!selectedStandouts.includes(s) && selectedStandouts.length >= 3) ? 0.4 : 1,
                    }}>{s}</button>
                  ))}
                </div>
              </div>

              {/* Personal note */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 8 }}>Anything specific you loved? <span style={{ fontWeight: 400, color: MUTED }}>(optional)</span></div>
                <input
                  value={personalNote}
                  onChange={e => setPersonalNote(e.target.value)}
                  placeholder="e.g. No more ants in the kitchen!"
                  maxLength={150}
                  style={inputBaseStyle}
                />
              </div>

              {/* Generate button */}
              <button onClick={() => handleGenerateReview()} disabled={selectedServices.length === 0} data-glass-accent="" style={{
                ...(selectedServices.length === 0 ? disabledActionStyle : primaryActionStyle),
                width: '100%', padding: 14, fontSize: 16,
                opacity: selectedServices.length === 0 ? 0.5 : 1,
                transition: 'all 0.2s',
              }}>
                Help Me Write It
              </button>
            </>
          )}

          {generating && (
            <div style={{ textAlign: 'center', padding: '20px 0 8px', color: BODY, fontSize: 15, fontWeight: 700 }}>
              Writing your review...
            </div>
          )}

          {reviewError && !generating && !generatedReview && (
            <div style={{
              background: '#FFF8E8', border: '1px solid #F0DCA9', borderRadius: 8,
              padding: 14, color: TEXT, fontSize: 14, lineHeight: 1.5, fontWeight: 700,
            }}>
              {reviewError}
              <button onClick={handleSkipToGoogle} data-glass-accent="" style={{
                ...primaryActionStyle,
                display: 'block', width: '100%', marginTop: 12, padding: 12,
              }}>
                Open Google
              </button>
            </div>
          )}

          {/* Generated review — editable textarea so the customer can tweak
              before one-tap post. Single action: copies + redirects. */}
          {generatedReview && (
            <div style={{ marginTop: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: TEXT, textTransform: 'uppercase', letterSpacing: 0 }}>
                  Your Review <span style={{ fontWeight: 400, color: MUTED, textTransform: 'none', letterSpacing: 0 }}>— edit if you want</span>
                </div>
              </div>
              <textarea
                value={generatedReview}
                onChange={(e) => setGeneratedReview(e.target.value)}
                rows={5}
                style={{
                  ...inputBaseStyle,
                  minHeight: 150, fontSize: 15, lineHeight: 1.6, marginBottom: 12,
                  fontFamily: FONTS.body, resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                }}
              />

              <Button
                variant="primary"
                onClick={handlePostOnGoogle}
                data-glass-accent=""
                style={{ ...primaryActionStyle, width: '100%', fontSize: 16 }}
              >
                Copy & Open Google
              </Button>
              {postHint && (
                <div style={{ marginTop: 8, textAlign: 'center', fontSize: 14, color: COLORS.green, fontWeight: 800 }}>
                  {postHint}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 12 }}>
                <button onClick={handleGenerateReview} disabled={generating} style={{
                  fontSize: 14, color: COLORS.blueDeeper, background: 'none', border: 'none',
                  cursor: 'pointer', fontWeight: 600,
                }}>
                  {generating ? 'Rewriting…' : 'Regenerate'}
                </button>
                <span style={{ fontSize: 14, color: CARD_BORDER }}>·</span>
                <button onClick={handleCopyReview} style={{
                  fontSize: 14, color: copied ? COLORS.green : MUTED, background: 'none',
                  border: 'none', cursor: 'pointer', fontWeight: 600,
                }}>
                  {copied ? 'Copied' : 'Copy only'}
                </button>
              </div>
            </div>
          )}

          {/* Skip link */}
          <button onClick={handleSkipToGoogle} style={{
            display: 'block', margin: '16px auto 0', fontSize: 14, color: MUTED, background: 'none',
            border: 'none', cursor: 'pointer', textDecoration: 'underline',
          }}>
            Skip -- Write my own on Google
          </button>
        </div>
      )}

      {/* Feedback Screen (1-7) */}
      {screen === 'feedback' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: score <= 3 ? '#FEE2E2' : '#FFF8E8', color: score <= 3 ? COLORS.red : COLORS.orange, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={score <= 3 ? 'frown' : 'message'} size={30} strokeWidth={2} />
          </div>
          {score <= 3 && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FEE2E2', color: COLORS.red, fontSize: 14, fontWeight: 800, padding: '6px 14px', borderRadius: 8, marginBottom: 12 }}>We want to make this right</div>}
          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>
            {score <= 3 ? "We're sorry to hear that." : "Thanks for the feedback."}
          </div>
          <div style={{ fontSize: 15, color: BODY, lineHeight: 1.55, marginBottom: 16 }}>
            {score <= 3 ? "What went wrong? We'll personally follow up." : "What could we have done better?"}
          </div>
          <textarea value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Tell us what happened..." rows={4} style={{
            ...inputBaseStyle,
            minHeight: 100,
            padding: 14,
            fontSize: 15,
            resize: 'vertical',
          }} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
            data-glass-accent=""
            style={{ ...primaryActionStyle, width: '100%', fontSize: 16, marginTop: 12 }}
          >
            {submitting ? 'Sending...' : 'Send Feedback'}
          </Button>
        </div>
      )}

      {/* Redirect Screen (going to Google) */}
      {screen === 'redirect' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: COLORS.greenLight, color: COLORS.green, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="party" size={30} strokeWidth={2} />
          </div>
          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>Taking you to Google...</div>
          <div style={{ fontSize: 15, color: BODY }}>Your review means the world to our small team!</div>
        </div>
      )}

      {/* Success Screen */}
      {screen === 'success' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: COLORS.greenLight, color: COLORS.green, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="checkCircle" size={30} strokeWidth={2} />
          </div>
          <div style={{ fontFamily: FONTS.serif, fontSize: 30, fontWeight: 500, color: TEXT, marginBottom: 8 }}>Thank you!</div>
          <div style={{ fontSize: 15, color: BODY, lineHeight: 1.55 }}>Your feedback helps us serve you better.</div>
        </div>
      )}
    </Page>
  );
}

function Page({ children }) {
  return (
    <div data-glass-clear="" style={{ minHeight: '100dvh', background: PAGE_BG, display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: FONTS.body, position: 'relative', overflow: 'hidden' }}>
      <div data-glass="card" style={{ position: 'relative', zIndex: 1, width: 'calc(100% - 24px)', maxWidth: 420, background: COLORS.white, borderRadius: 8, border: `1px solid ${CARD_BORDER}`, boxShadow: 'none', overflow: 'hidden', marginTop: 'clamp(20px, 8dvh, 64px)' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', justifyContent: 'center' }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 34, display: 'block' }} />
        </div>
        <div style={{ padding: '28px clamp(12px, 5vw, 22px) 24px' }}>
          {children}
        </div>
      </div>
      {/* Footer lives OUTSIDE the overflow:hidden card so tall states (AI
          review writer, feedback form) scroll instead of clipping it. */}
      <div style={{ position: 'relative', zIndex: 1, width: 'calc(100% - 24px)', maxWidth: 420, paddingBottom: 24 }}>
        <BrandFooter />
      </div>
      {/* Anton / Montserrat / Inter load globally via client/index.html */}
    </div>
  );
}
