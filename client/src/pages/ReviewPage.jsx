import Icon from '../components/Icon';
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';
import { COLORS, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
export default function ReviewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRating, setSelectedRating] = useState(null);
  const [hoveredRating, setHoveredRating] = useState(null);
  const [phase, setPhase] = useState('rate'); // rate, submitting, thankyou, feedback, redirecting
  const [feedbackText, setFeedbackText] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/review/${token}`)
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); })
      .then(d => { setData(d); setLoading(false); if (d.alreadyRated) setPhase('thankyou'); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  const handleRate = async (rating) => {
    setSelectedRating(rating);
    setPhase('submitting');

    try {
      const res = await fetch(`${API_BASE}/review/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      const result = await res.json();

      if (result.action === 'review' && result.googleReviewUrl) {
        // High score — redirect to Google
        setPhase('redirecting');
        setTimeout(() => {
          window.location.href = result.googleReviewUrl;
        }, 2000);
      } else {
        // Low/mid score — show feedback form
        setPhase('feedback');
      }
    } catch {
      setPhase('rate'); // retry
    }
  };

  const handleFeedback = async () => {
    setSubmittingFeedback(true);
    try {
      await fetch(`${API_BASE}/review/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: selectedRating, feedbackText }),
      });
    } catch { /* already rated, that's fine */ }
    setPhase('thankyou');
    setSubmittingFeedback(false);
  };

  // ── Loading ──
  if (loading) return (
    <div style={{ minHeight: '100vh', background: COLORS.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 36, height: 36, border: `3px solid ${COLORS.grayLight}`, borderTopColor: COLORS.blueDark, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );

  if (error || !data) return (
    <div style={{ minHeight: '100vh', background: COLORS.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}></div>
        <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 18, color: COLORS.blueDeeper, letterSpacing: '-0.01em' }}>Link Expired</div>
        <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 8 }}>This review link is no longer available. Call us at <a href="tel:+19412975749" style={{ color: COLORS.blueDark }}>(941) 297-5749</a>.</div>
      </div>
    </div>
  );

  const { techName, techPhoto, serviceType, serviceDate, customerFirstName, techReviewCount } = data;
  const displayDate = serviceDate
    ? new Date(serviceDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : null;

  return (
    <div style={{ minHeight: '100vh', background: COLORS.offWhite, fontFamily: FONTS.body }}>
      {/* Header — brand fonts loaded globally via client/index.html */}
      <div style={{ background: `linear-gradient(135deg, ${COLORS.wavesBlue} 0%, ${COLORS.blueDeeper} 100%)`, padding: '28px 24px 36px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        {/* Hero video — waves-hero-service.mp4 */}
        <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true">
          <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
        </video>
        <div style={{ position: 'absolute', bottom: -2, left: 0, right: 0, height: 24, zIndex: 2 }}>
          <svg viewBox="0 0 1440 48" fill="none" style={{ width: '100%', height: '100%', display: 'block' }}>
            <path d="M0 24 C360 0 720 48 1080 24 C1260 12 1380 0 1440 8 L1440 48 L0 48 Z" fill={COLORS.offWhite} />
          </svg>
        </div>
        <h1 style={{
          position: 'relative', zIndex: 1,
          fontSize: 36, fontFamily: FONTS.display, fontWeight: 400,
          color: COLORS.white, letterSpacing: '0.04em', lineHeight: 1, margin: 0,
          textShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>WAVES</h1>
        <div style={{ position: 'relative', zIndex: 1, fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Pest Control</div>
      </div>

      <div style={{ maxWidth: 440, margin: '0 auto', padding: '0 20px 60px' }}>

        {/* ── Tech Profile ── */}
        <div style={{ textAlign: 'center', marginTop: -8, marginBottom: 24 }}>
          {/* Tech photo or initial */}
          <div style={{
            width: 80, height: 80, borderRadius: '50%', margin: '0 auto 12px',
            background: techPhoto ? `url(${techPhoto}) center/cover` : `linear-gradient(135deg, ${COLORS.blueDark}, ${COLORS.sky})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: `3px solid ${COLORS.white}`, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}>
            {!techPhoto && (
              <span style={{ color: COLORS.white, fontSize: 28, fontFamily: FONTS.heading, fontWeight: 800 }}>
                {(techName || 'W').charAt(0)}
              </span>
            )}
          </div>

          <div style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.blueDeeper }}>
            {techName || 'Your Technician'}
          </div>
          <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 4 }}>
            {serviceType}{displayDate ? ` · ${displayDate}` : ''}
          </div>

          {/* Social proof counter */}
          {techReviewCount > 0 && (
            <div style={{ fontSize: 13, color: COLORS.textCaption, marginTop: 8 }}>
              ⭐ {techReviewCount.toLocaleString()} homeowners have reviewed {techName ? techName.split(' ')[0] : 'our team'}
            </div>
          )}
        </div>

        {/* ── Rating Phase ── */}
        {phase === 'rate' && (
          <div style={{ background: COLORS.white, borderRadius: 20, border: `1px solid ${COLORS.grayLight}`, padding: '28px 24px', textAlign: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontFamily: FONTS.heading, fontSize: 17, fontWeight: 700, color: COLORS.blueDeeper, marginBottom: 4 }}>
              How was your experience?
            </div>
            <div style={{ fontSize: 13, color: COLORS.textCaption, marginBottom: 20 }}>
              {customerFirstName ? `${customerFirstName}, tap` : 'Tap'} to rate
            </div>

            {/* 1-10 buttons in two rows */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, maxWidth: 320, margin: '0 auto' }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => {
                const isHovered = hoveredRating === n;
                const isSelected = selectedRating === n;
                const color = n <= 4 ? '#EF5350' : n <= 6 ? COLORS.yellow : COLORS.green;
                return (
                  <button key={n}
                    onClick={() => handleRate(n)}
                    onMouseEnter={() => setHoveredRating(n)}
                    onMouseLeave={() => setHoveredRating(null)}
                    style={{
                      width: '100%', aspectRatio: '1', borderRadius: 12,
                      border: `2px solid ${isHovered || isSelected ? color : COLORS.grayLight}`,
                      background: isHovered || isSelected ? `${color}15` : COLORS.white,
                      color: isHovered || isSelected ? color : COLORS.textBody,
                      fontFamily: FONTS.heading, fontWeight: 700, fontSize: 18,
                      cursor: 'pointer', transition: 'all 0.15s',
                      transform: isHovered ? 'scale(1.08)' : 'scale(1)',
                    }}>
                    {n}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: COLORS.textCaption, marginTop: 10, maxWidth: 320, margin: '10px auto 0' }}>
              <span>Not great</span><span>Amazing!</span>
            </div>
          </div>
        )}

        {/* ── Submitting ── */}
        {phase === 'submitting' && (
          <div style={{ background: COLORS.white, borderRadius: 20, padding: 40, textAlign: 'center', border: `1px solid ${COLORS.grayLight}` }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${COLORS.grayLight}`, borderTopColor: COLORS.green, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: 15, color: COLORS.textBody }}>Submitting your rating...</div>
          </div>
        )}

        {/* ── Redirecting to Google ── */}
        {phase === 'redirecting' && (
          <div style={{ background: COLORS.white, borderRadius: 20, padding: 32, textAlign: 'center', border: `1px solid ${COLORS.green}` }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}></div>
            <div style={{ fontFamily: FONTS.heading, fontSize: 18, fontWeight: 700, color: COLORS.blueDeeper, marginBottom: 8 }}>
              Thank you, {customerFirstName}!
            </div>
            <div style={{ fontSize: 14, color: COLORS.textBody, lineHeight: 1.6, marginBottom: 16 }}>
              Taking you to Google to share your experience with other SWFL families...
            </div>
            <div style={{ width: 36, height: 36, border: `3px solid ${COLORS.grayLight}`, borderTopColor: COLORS.blueDark, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
            <div style={{ marginTop: 16 }}>
              <a href={data.googleReviewUrl} style={{ fontSize: 13, color: COLORS.blueDark, textDecoration: 'none' }}>
                Tap here if you're not redirected
              </a>
            </div>
          </div>
        )}

        {/* ── Feedback Form (low scores) ── */}
        {phase === 'feedback' && (
          <div style={{ background: COLORS.white, borderRadius: 20, padding: 28, textAlign: 'center', border: `1px solid ${COLORS.grayLight}` }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}></div>
            <div style={{ fontFamily: FONTS.heading, fontSize: 17, fontWeight: 700, color: COLORS.blueDeeper, marginBottom: 8 }}>
              We appreciate your honesty
            </div>
            <div style={{ fontSize: 14, color: COLORS.textBody, marginBottom: 16, lineHeight: 1.6 }}>
              {techName ? `${techName.split(' ')[0]} would` : "We'd"} love to know how we can do better.
            </div>
            <textarea
              value={feedbackText} onChange={e => setFeedbackText(e.target.value)}
              placeholder="What could we improve?"
              rows={4}
              style={{
                width: '100%', padding: 14, borderRadius: 12, border: `1px solid ${COLORS.grayLight}`,
                fontFamily: FONTS.body, fontSize: 14, color: COLORS.navy, resize: 'vertical',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Button
                variant="primary"
                onClick={handleFeedback}
                disabled={submittingFeedback}
                style={{ flex: 1, cursor: submittingFeedback ? 'wait' : 'pointer' }}
              >
                {submittingFeedback ? 'Sending...' : 'Send Feedback'}
              </Button>
              <button onClick={() => setPhase('thankyou')}
                style={{
                  padding: '14px 20px', borderRadius: 12, border: `1px solid ${COLORS.grayLight}`,
                  background: 'transparent', color: COLORS.textCaption, fontSize: 13, cursor: 'pointer',
                }}>
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── Thank You (final state) ── */}
        {phase === 'thankyou' && (
          <div style={{ background: COLORS.greenLight, borderRadius: 20, padding: 32, textAlign: 'center', border: `1px solid ${COLORS.green}` }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}></div>
            <div style={{ fontFamily: FONTS.heading, fontSize: 18, fontWeight: 700, color: '#2E7D32' }}>
              Thank you{customerFirstName ? `, ${customerFirstName}` : ''}!
            </div>
            <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 8, lineHeight: 1.6 }}>
              Your feedback helps us keep getting better. See you at your next service!
            </div>
          </div>
        )}

        {/* ── "Something wasn't right?" link (only during rating phase) ── */}
        {phase === 'rate' && (
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <button onClick={() => setPhase('feedback')}
              style={{ background: 'none', border: 'none', color: COLORS.textCaption, fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
              Something wasn't right? Let us know directly
            </button>
          </div>
        )}

        {/* Footer */}
        <BrandFooter />
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
