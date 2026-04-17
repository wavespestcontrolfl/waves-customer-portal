import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// Mirrored from wavespestcontrol.com (Astro @theme brand tokens)
const W = {
  blue: '#065A8C', blueBright: '#097ABD', bluePale: '#E3F5FD',
  red: '#C0392B', yellow: '#FFD700', gold: '#FFD700',
  teal: '#4DC9F6', green: '#16A34A', greenLight: '#DCFCE7',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', offWhite: '#F1F5F9', border: '#CBD5E1',
};

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
    <div style={{ minHeight: '100vh', background: W.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 36, height: 36, border: `3px solid ${W.border}`, borderTopColor: W.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );

  if (error || !data) return (
    <div style={{ minHeight: '100vh', background: W.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🌊</div>
        <div style={{ fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontWeight: 700, fontSize: 18, color: W.navy }}>Link Expired</div>
        <div style={{ fontSize: 14, color: W.textBody, marginTop: 8 }}>This review link is no longer available. Call us at <a href="tel:+19413187612" style={{ color: W.blue }}>(941) 318-7612</a>.</div>
      </div>
    </div>
  );

  const { techName, techPhoto, serviceType, serviceDate, customerFirstName, techReviewCount } = data;
  const displayDate = serviceDate
    ? new Date(serviceDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : null;

  return (
    <div style={{ minHeight: '100vh', background: W.offWhite, fontFamily: "'Nunito', sans-serif" }}>
      {/* Header — brand fonts loaded globally via client/index.html */}
      <div style={{ background: `linear-gradient(135deg, ${W.blue} 0%, ${W.navy} 100%)`, padding: '28px 24px 36px', textAlign: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', bottom: -2, left: 0, right: 0, height: 24 }}>
          <svg viewBox="0 0 1440 48" fill="none" style={{ width: '100%', height: '100%', display: 'block' }}>
            <path d="M0 24 C360 0 720 48 1080 24 C1260 12 1380 0 1440 8 L1440 48 L0 48 Z" fill={W.offWhite} />
          </svg>
        </div>
        <h1 style={{
          fontSize: 36, fontFamily: "'Luckiest Guy', 'Baloo 2', cursive", fontWeight: 400,
          color: W.white, letterSpacing: '0.04em', lineHeight: 1, margin: 0,
          textShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>WAVES</h1>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Pest Control</div>
      </div>

      <div style={{ maxWidth: 440, margin: '0 auto', padding: '0 20px 60px' }}>

        {/* ── Tech Profile ── */}
        <div style={{ textAlign: 'center', marginTop: -8, marginBottom: 24 }}>
          {/* Tech photo or initial */}
          <div style={{
            width: 80, height: 80, borderRadius: '50%', margin: '0 auto 12px',
            background: techPhoto ? `url(${techPhoto}) center/cover` : `linear-gradient(135deg, ${W.blue}, ${W.teal})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: `3px solid ${W.white}`, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}>
            {!techPhoto && (
              <span style={{ color: W.white, fontSize: 28, fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontWeight: 800 }}>
                {(techName || 'W').charAt(0)}
              </span>
            )}
          </div>

          <div style={{ fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontSize: 20, fontWeight: 700, color: W.navy }}>
            {techName || 'Your Technician'}
          </div>
          <div style={{ fontSize: 14, color: W.textBody, marginTop: 4 }}>
            {serviceType}{displayDate ? ` · ${displayDate}` : ''}
          </div>

          {/* Social proof counter */}
          {techReviewCount > 0 && (
            <div style={{ fontSize: 13, color: W.textCaption, marginTop: 8 }}>
              ⭐ {techReviewCount.toLocaleString()} homeowners have reviewed {techName ? techName.split(' ')[0] : 'our team'}
            </div>
          )}
        </div>

        {/* ── Rating Phase ── */}
        {phase === 'rate' && (
          <div style={{ background: W.white, borderRadius: 20, border: `1px solid ${W.border}`, padding: '28px 24px', textAlign: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontSize: 17, fontWeight: 700, color: W.navy, marginBottom: 4 }}>
              How was your experience?
            </div>
            <div style={{ fontSize: 13, color: W.textCaption, marginBottom: 20 }}>
              {customerFirstName ? `${customerFirstName}, tap` : 'Tap'} to rate
            </div>

            {/* 1-10 buttons in two rows */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, maxWidth: 320, margin: '0 auto' }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => {
                const isHovered = hoveredRating === n;
                const isSelected = selectedRating === n;
                const color = n <= 4 ? '#EF5350' : n <= 6 ? W.gold : W.green;
                return (
                  <button key={n}
                    onClick={() => handleRate(n)}
                    onMouseEnter={() => setHoveredRating(n)}
                    onMouseLeave={() => setHoveredRating(null)}
                    style={{
                      width: '100%', aspectRatio: '1', borderRadius: 12,
                      border: `2px solid ${isHovered || isSelected ? color : W.border}`,
                      background: isHovered || isSelected ? `${color}15` : W.white,
                      color: isHovered || isSelected ? color : W.textBody,
                      fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontWeight: 700, fontSize: 18,
                      cursor: 'pointer', transition: 'all 0.15s',
                      transform: isHovered ? 'scale(1.08)' : 'scale(1)',
                    }}>
                    {n}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: W.textCaption, marginTop: 10, maxWidth: 320, margin: '10px auto 0' }}>
              <span>Not great</span><span>Amazing!</span>
            </div>
          </div>
        )}

        {/* ── Submitting ── */}
        {phase === 'submitting' && (
          <div style={{ background: W.white, borderRadius: 20, padding: 40, textAlign: 'center', border: `1px solid ${W.border}` }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${W.border}`, borderTopColor: W.green, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: 15, color: W.textBody }}>Submitting your rating...</div>
          </div>
        )}

        {/* ── Redirecting to Google ── */}
        {phase === 'redirecting' && (
          <div style={{ background: W.white, borderRadius: 20, padding: 32, textAlign: 'center', border: `1px solid ${W.green}` }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🙏</div>
            <div style={{ fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontSize: 18, fontWeight: 700, color: W.navy, marginBottom: 8 }}>
              Thank you, {customerFirstName}!
            </div>
            <div style={{ fontSize: 14, color: W.textBody, lineHeight: 1.6, marginBottom: 16 }}>
              Taking you to Google to share your experience with other SWFL families...
            </div>
            <div style={{ width: 36, height: 36, border: `3px solid ${W.border}`, borderTopColor: W.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
            <div style={{ marginTop: 16 }}>
              <a href={data.googleReviewUrl} style={{ fontSize: 13, color: W.blue, textDecoration: 'none' }}>
                Tap here if you're not redirected
              </a>
            </div>
          </div>
        )}

        {/* ── Feedback Form (low scores) ── */}
        {phase === 'feedback' && (
          <div style={{ background: W.white, borderRadius: 20, padding: 28, textAlign: 'center', border: `1px solid ${W.border}` }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
            <div style={{ fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontSize: 17, fontWeight: 700, color: W.navy, marginBottom: 8 }}>
              We appreciate your honesty
            </div>
            <div style={{ fontSize: 14, color: W.textBody, marginBottom: 16, lineHeight: 1.6 }}>
              {techName ? `${techName.split(' ')[0]} would` : "We'd"} love to know how we can do better.
            </div>
            <textarea
              value={feedbackText} onChange={e => setFeedbackText(e.target.value)}
              placeholder="What could we improve?"
              rows={4}
              style={{
                width: '100%', padding: 14, borderRadius: 12, border: `1px solid ${W.border}`,
                fontFamily: "'Nunito', sans-serif", fontSize: 14, color: W.navy, resize: 'vertical',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={handleFeedback} disabled={submittingFeedback}
                style={{
                  flex: 1, padding: 14, borderRadius: 12, border: 'none',
                  background: W.blue, color: W.white, fontFamily: "'Baloo 2', 'Nunito', sans-serif",
                  fontWeight: 700, fontSize: 15, cursor: 'pointer',
                  opacity: submittingFeedback ? 0.6 : 1,
                }}>
                {submittingFeedback ? 'Sending...' : 'Send Feedback'}
              </button>
              <button onClick={() => setPhase('thankyou')}
                style={{
                  padding: '14px 20px', borderRadius: 12, border: `1px solid ${W.border}`,
                  background: 'transparent', color: W.textCaption, fontSize: 13, cursor: 'pointer',
                }}>
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── Thank You (final state) ── */}
        {phase === 'thankyou' && (
          <div style={{ background: W.greenLight, borderRadius: 20, padding: 32, textAlign: 'center', border: `1px solid ${W.green}` }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🌊</div>
            <div style={{ fontFamily: "'Baloo 2', 'Nunito', sans-serif", fontSize: 18, fontWeight: 700, color: '#2E7D32' }}>
              Thank you{customerFirstName ? `, ${customerFirstName}` : ''}!
            </div>
            <div style={{ fontSize: 14, color: W.textBody, marginTop: 8, lineHeight: 1.6 }}>
              Your feedback helps us keep getting better. See you at your next service!
            </div>
          </div>
        )}

        {/* ── "Something wasn't right?" link (only during rating phase) ── */}
        {phase === 'rate' && (
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <button onClick={() => setPhase('feedback')}
              style={{ background: 'none', border: 'none', color: W.textCaption, fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
              Something wasn't right? Let us know directly
            </button>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '32px 0 0', color: W.textCaption, fontSize: 12 }}>
          <div>Waves Pest Control · Southwest Florida</div>
          <div style={{ marginTop: 4 }}><a href="tel:+19413187612" style={{ color: W.blue, textDecoration: 'none' }}>(941) 318-7612</a></div>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
