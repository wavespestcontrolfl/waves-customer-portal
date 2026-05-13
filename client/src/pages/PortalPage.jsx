import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import api from '../utils/api';
import { COLORS as B, TIER, FONTS, BUTTON_BASE, GOLD_CTA, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme-brand';
import NotificationBell from '../components/NotificationBell';
import AutopayCard from '../components/billing/AutopayCard';
import SaveCardConsent from '../components/billing/SaveCardConsent';
import NewsletterSignup from '../components/NewsletterSignup';
import Icon from '../components/Icon';
import { etDateString } from '../lib/timezone';
import useIsMobile from '../hooks/useIsMobile';

// Normalize date strings from API — handles both "2026-04-02" and "2026-04-02T00:00:00.000Z"
function parseDate(d) {
  if (!d) return new Date(NaN);
  const str = typeof d === 'string' ? d.split('T')[0] : etDateString(new Date(d));
  return new Date(str + 'T12:00:00');
}

function utcDayFromDateKey(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d);
}

function daysUntilEtDate(d) {
  const targetKey = typeof d === 'string' ? d.split('T')[0] : etDateString(new Date(d));
  const targetDay = utcDayFromDateKey(targetKey);
  const todayDay = utcDayFromDateKey(etDateString());
  if (!Number.isFinite(targetDay) || !Number.isFinite(todayDay)) return null;
  return Math.max(0, Math.round((targetDay - todayDay) / 86400000));
}

function fmtDate(d, opts) {
  const dt = parseDate(d);
  return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', opts);
}

// =========================================================================
// SECTION HEADING HELPER
// =========================================================================
function SectionHeading({ children }) {
  return <div style={{ fontSize: 22, fontWeight: 400, color: B.navy, fontFamily: FONTS.display, letterSpacing: '0.02em' }}>{children}</div>;
}

const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// Wave divider SVG — used between sections
function WaveDivider() {
  return (
    <div style={{ height: 20, overflow: 'hidden', margin: '4px 0' }}>
      <svg viewBox="0 0 1200 60" style={{ width: '100%', height: '100%' }}>
        <path d="M0,30 C200,60 400,0 600,30 C800,60 1000,0 1200,30" fill="none" stroke={B.blueLight} strokeWidth="2" strokeOpacity="0.3" />
      </svg>
    </div>
  );
}

// =========================================================================
// LAWN HEALTH HOOK
// =========================================================================
function useLawnHealth(customerId) {
  const [data, setData] = useState({
    scores: null, initialScores: null, hasLawnCare: false, loading: true,
    photos: [], beforeAfter: null, trend: [], recommendations: null,
    assessmentCount: 0, nextMilestone: null,
    seasonalContext: null, neighborBenchmark: null,
  });

  useEffect(() => {
    if (!customerId) return;
    api.getLawnHealth(customerId)
      .then(d => setData({
        scores: d.scores,
        initialScores: d.initialScores,
        hasLawnCare: d.hasLawnCare,
        loading: false,
        photos: d.photos || [],
        beforeAfter: d.beforeAfter || null,
        trend: d.trend || [],
        recommendations: d.recommendations || null,
        assessmentCount: d.assessmentCount || 0,
        nextMilestone: d.nextMilestone || null,
        seasonalContext: d.seasonalContext || null,
        neighborBenchmark: d.neighborBenchmark || null,
      }))
      .catch(() => setData(prev => ({ ...prev, loading: false })));
  }, [customerId]);

  return data;
}

// =========================================================================
// BEFORE / AFTER PHOTO COMPARISON SLIDER — real S3 photos or gradient fallback
// =========================================================================
function BeforeAfterSlider({ beforeAfter }) {
  const [position, setPosition] = useState(50);
  const containerRef = useRef(null);
  const dragging = useRef(false);

  const updatePosition = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setPosition((x / rect.width) * 100);
  }, []);

  const onPointerDown = useCallback((e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePosition(e.clientX);
  }, [updatePosition]);

  const onPointerMove = useCallback((e) => {
    if (dragging.current) updatePosition(e.clientX);
  }, [updatePosition]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const hasBeforePhoto = beforeAfter?.before?.photoUrl;
  const hasAfterPhoto = beforeAfter?.after?.photoUrl;
  const beforeDate = beforeAfter?.before?.date;
  const afterDate = beforeAfter?.after?.date;

  const beforeStyle = hasBeforePhoto
    ? { backgroundImage: `url(${beforeAfter.before.photoUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: `linear-gradient(135deg, ${B.grayDark} 0%, ${B.grayMid} 60%, ${B.grayLight} 100%)` };

  const afterStyle = hasAfterPhoto
    ? { backgroundImage: `url(${beforeAfter.after.photoUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: `linear-gradient(135deg, ${B.wavesBlue} 0%, ${B.sky} 100%)` };

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'relative', width: '100%', height: 220, borderRadius: 14,
        overflow: 'hidden', cursor: 'ew-resize', userSelect: 'none', touchAction: 'none',
      }}
    >
      {/* BEFORE layer */}
      <div style={{
        position: 'absolute', inset: 0, ...beforeStyle,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
        paddingBottom: 16,
      }}>
        <div style={{
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
          borderRadius: 10, padding: '8px 14px', textAlign: 'center',
        }}>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 14, fontFamily: FONTS.heading }}>
            BEFORE {beforeDate ? `— ${fmtDate(beforeDate, { month: 'short', day: 'numeric' })}` : ''}
          </div>
          {beforeAfter?.before?.overallScore != null && (
            <div style={{ color: B.yellow, fontSize: 12, fontWeight: 700, marginTop: 2 }}>
              Score: {beforeAfter.before.overallScore}%
            </div>
          )}
        </div>
      </div>

      {/* AFTER layer */}
      <div style={{
        position: 'absolute', inset: 0,
        clipPath: `inset(0 ${100 - position}% 0 0)`,
        ...afterStyle,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
        paddingBottom: 16,
        transition: dragging.current ? 'none' : 'clip-path 0.05s ease-out',
      }}>
        <div style={{
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
          borderRadius: 10, padding: '8px 14px', textAlign: 'center',
        }}>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 14, fontFamily: FONTS.heading }}>
            AFTER {afterDate ? `— ${fmtDate(afterDate, { month: 'short', day: 'numeric' })}` : ''}
          </div>
          {beforeAfter?.after?.overallScore != null && (
            <div style={{ color: B.green, fontSize: 12, fontWeight: 700, marginTop: 2 }}>
              Score: {beforeAfter.after.overallScore}%
            </div>
          )}
        </div>
      </div>

      {/* Slider handle */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: `${position}%`,
        transform: 'translateX(-50%)', width: 3, background: '#fff',
        boxShadow: '0 0 8px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 36, height: 36, borderRadius: '50%', background: '#fff',
          boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, color: B.navy,
        }}>⇔</div>
      </div>
    </div>
  );
}

// =========================================================================
// OVERALL SCORE RING — circular progress indicator
// =========================================================================
function ScoreRing({ score, size = 90, stroke = 7, label }) {
  const radius = (size - stroke) / 2;
  const circumference = radius * 2 * Math.PI;
  const [anim, setAnim] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setAnim(score || 0), 100);
    return () => clearTimeout(t);
  }, [score]);

  const offset = circumference - (anim / 100) * circumference;
  const color = score >= 75 ? B.green : score >= 50 ? B.orange : B.red;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={B.grayLight} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={stroke}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1.2s ease-out' }} />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: size * 0.28, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, lineHeight: 1 }}>
          {score || 0}
        </div>
        {label && <div style={{ fontSize: 9, color: B.grayMid, marginTop: 2, fontWeight: 600 }}>{label}</div>}
      </div>
    </div>
  );
}

// =========================================================================
// MINI TREND SPARKLINE — simple SVG line chart for trend data
// =========================================================================
function TrendSparkline({ trend, width = '100%', height = 60 }) {
  if (!trend || trend.length < 2) return null;

  const scores = trend.map(t => t.overallScore || 0);
  const min = Math.min(...scores) - 5;
  const max = Math.max(...scores) + 5;
  const range = max - min || 1;
  const w = 300;
  const h = height;
  const padding = 4;

  const points = scores.map((s, i) => {
    const x = padding + (i / (scores.length - 1)) * (w - padding * 2);
    const y = h - padding - ((s - min) / range) * (h - padding * 2);
    return `${x},${y}`;
  }).join(' ');

  const lastScore = scores[scores.length - 1];
  const lastX = padding + ((scores.length - 1) / (scores.length - 1)) * (w - padding * 2);
  const lastY = h - padding - ((lastScore - min) / range) * (h - padding * 2);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width, height, display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={B.teal} stopOpacity="0.15" />
          <stop offset="100%" stopColor={B.teal} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Fill area */}
      <polygon
        points={`${padding},${h - padding} ${points} ${lastX},${h - padding}`}
        fill="url(#trendFill)"
      />
      {/* Line */}
      <polyline points={points} fill="none" stroke={B.teal} strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" />
      {/* End dot */}
      <circle cx={lastX} cy={lastY} r="4" fill={B.teal} />
    </svg>
  );
}

// =========================================================================
// PHOTO GALLERY — latest visit photos with per-photo metrics
// =========================================================================
function PhotoGallery({ photos }) {
  const [selected, setSelected] = useState(null);

  if (!photos?.length) return null;

  const visiblePhotos = photos.filter(p => p.url);
  if (!visiblePhotos.length) return null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
        {visiblePhotos.map((p, i) => (
          <div key={p.id || i} onClick={() => setSelected(selected === i ? null : i)} style={{
            position: 'relative', flex: '0 0 auto', width: visiblePhotos.length === 1 ? '100%' : 140,
            height: visiblePhotos.length === 1 ? 180 : 105,
            borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
            border: p.isBest ? `2px solid ${B.teal}` : `1px solid ${B.grayLight}`,
            boxShadow: selected === i ? `0 0 0 3px ${B.teal}44` : 'none',
          }}>
            <img src={p.url} alt={`Lawn ${p.type || ''}`} loading="lazy" style={{
              width: '100%', height: '100%', objectFit: 'cover',
            }} />
            {p.isBest && (
              <div style={{
                position: 'absolute', top: 6, left: 6, background: B.teal, color: '#fff',
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              }}>BEST</div>
            )}
            {p.type && p.type !== 'general' && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: 'linear-gradient(transparent, rgba(0,0,0,0.6))',
                color: '#fff', fontSize: 10, fontWeight: 600, padding: '12px 8px 6px',
                textTransform: 'capitalize',
              }}>
                {p.type.replace(/_/g, ' ')}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Expanded photo detail */}
      {selected != null && visiblePhotos[selected]?.scores && (
        <div style={{
          marginTop: 8, padding: '10px 14px', background: `${B.teal}08`,
          borderRadius: 10, border: `1px solid ${B.teal}15`,
          display: 'flex', gap: 16, fontSize: 12,
        }}>
          {visiblePhotos[selected].scores.turfDensity != null && (
            <div><span style={{ color: B.grayMid }}>Density:</span> <span style={{ fontWeight: 700, color: B.navy }}>{visiblePhotos[selected].scores.turfDensity}%</span></div>
          )}
          {visiblePhotos[selected].scores.colorHealth != null && (
            <div><span style={{ color: B.grayMid }}>Color:</span> <span style={{ fontWeight: 700, color: B.navy }}>{visiblePhotos[selected].scores.colorHealth}/10</span></div>
          )}
          {visiblePhotos[selected].scores.weedCoverage != null && (
            <div><span style={{ color: B.grayMid }}>Weeds:</span> <span style={{ fontWeight: 700, color: B.navy }}>{visiblePhotos[selected].scores.weedCoverage}%</span></div>
          )}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// LAWN HEALTH CARD — overall score, progress bars, photos, trend, recs
// =========================================================================
function LawnHealthCard({ scores, initialScores, photos, beforeAfter, trend, recommendations, seasonalContext, neighborBenchmark }) {
  const [animated, setAnimated] = useState(false);
  const [showTrend, setShowTrend] = useState(false);

  useEffect(() => {
    const timer = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(timer);
  }, []);

  const metrics = [
    { label: 'Turf Density', key: 'turfDensity', initialKey: 'turfDensity' },
    { label: 'Weed Suppression', key: 'weedSuppression', initialKey: 'weedSuppression' },
    { label: 'Color Health', key: 'colorHealth', initialKey: 'colorHealth' },
    { label: 'Fungus Control', key: 'fungusControl', initialKey: 'fungusControl' },
    { label: 'Thatch Level', key: 'thatchScore', initialKey: 'thatchScore' },
  ];

  const overallScore = scores.overallScore || Math.round(
    ((scores.turfDensity || 0) + (scores.weedSuppression || 0) +
     (scores.fungusControl || 0) + (scores.colorHealth || 0) + (scores.thatchScore || 0)) / 5
  );

  const initialOverall = initialScores?.overallScore || Math.round(
    ((initialScores?.turfDensity || 0) + (initialScores?.weedSuppression || 0) +
     (initialScores?.fungusControl || 0) + (initialScores?.colorHealth || 0) + (initialScores?.thatchScore || 0)) / 5
  );

  const overallDelta = overallScore - initialOverall;

  return (
    <div style={{
      background: B.white, borderRadius: 16, padding: 20,
      border: `2px solid ${B.green}22`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
    }}>
      {/* Header with overall score ring */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <ScoreRing score={overallScore} size={80} label="OVERALL" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
            Lawn Health Progress
          </div>
          {scores.aiSummary ? (
            <div style={{ fontSize: 12, color: B.grayMid, lineHeight: 1.5, marginTop: 4 }}>
              {scores.aiSummary}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 4 }}>
              Your lawn's journey since starting the premium program.
            </div>
          )}
          {overallDelta !== 0 && (
            <div style={{
              display: 'inline-block', marginTop: 6, fontSize: 12, fontWeight: 700,
              color: overallDelta > 0 ? B.green : B.red,
              background: overallDelta > 0 ? `${B.green}12` : `${B.red}12`,
              padding: '3px 8px', borderRadius: 6,
            }}>
              {overallDelta > 0 ? '↑' : '↓'} {Math.abs(overallDelta)} pts since first visit
            </div>
          )}
        </div>
      </div>

      {/* Latest Visit Photos */}
      {photos?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: B.grayDark, fontFamily: FONTS.heading,
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8,
          }}>
            Latest Visit — {scores.assessmentDate ? fmtDate(scores.assessmentDate, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent'}
          </div>
          <PhotoGallery photos={photos} />
        </div>
      )}

      {/* Progress Bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {metrics.map((m, i) => {
          const current = scores[m.key] || 0;
          const initial = initialScores?.[m.initialKey] || 0;
          const delta = current - initial;
          return (
            <div key={m.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, fontFamily: FONTS.body }}>{m.label}</span>
                <span style={{ fontSize: 12, fontFamily: FONTS.ui }}>
                  <span style={{ fontWeight: 700, color: current >= 75 ? B.green : current >= 50 ? B.orange : B.red }}>{current}%</span>
                  {delta !== 0 && (
                    <span style={{
                      fontSize: 10, marginLeft: 6, fontWeight: 700,
                      color: delta > 0 ? B.green : B.red,
                    }}>
                      {delta > 0 ? '+' : ''}{delta}
                    </span>
                  )}
                  <span style={{ color: B.grayMid, fontSize: 10, marginLeft: 4 }}>from {initial}%</span>
                </span>
              </div>
              <div style={{
                position: 'relative', height: 8, borderRadius: 4, background: B.grayLight, overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', height: '100%', borderRadius: 4,
                  background: `linear-gradient(90deg, ${B.teal}30, ${B.green}30)`,
                  width: `${initial}%`,
                }} />
                <div style={{
                  position: 'absolute', height: '100%', borderRadius: 4,
                  background: `linear-gradient(90deg, ${B.teal}, ${B.green})`,
                  width: animated ? `${current}%` : '0%',
                  transition: `width 1s ease-out ${i * 0.12}s`,
                }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Trend Chart (expandable) */}
      {trend && trend.length >= 2 && (
        <div style={{ marginTop: 16 }}>
          <div
            onClick={() => setShowTrend(!showTrend)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              cursor: 'pointer', padding: '8px 0',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, fontFamily: FONTS.ui, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Progress Over Time ({trend.length} visits)
            </div>
            <span style={{ fontSize: 12, color: B.teal, fontWeight: 600 }}>{showTrend ? '▾ Hide' : '▸ Show'}</span>
          </div>
          {showTrend && (
            <div style={{
              background: `${B.teal}06`, borderRadius: 10, padding: '12px 8px 8px',
              border: `1px solid ${B.teal}12`,
            }}>
              <TrendSparkline trend={trend} height={70} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: B.grayMid }}>
                <span>{fmtDate(trend[0].date, { month: 'short', year: '2-digit' })}</span>
                <span>{fmtDate(trend[trend.length - 1].date, { month: 'short', year: '2-digit' })}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* AI Recommendations */}
      {recommendations && (
        <div style={{ marginTop: 16 }}>
          {recommendations.customerTip && (
            <div style={{
              padding: '12px 16px', borderRadius: 12,
              background: `${B.teal}08`, border: `1px solid ${B.teal}20`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.teal, marginBottom: 4 }}>
                Between-Visit Tip
              </div>
              <div style={{ fontSize: 16, color: B.grayDark, lineHeight: 1.6 }}>
                {recommendations.customerTip}
              </div>
            </div>
          )}
          {recommendations.nextVisitFocus && (
            <div style={{
              marginTop: 8, padding: '12px 16px', borderRadius: 12,
              background: `${B.green}08`, border: `1px solid ${B.green}20`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.green, marginBottom: 4 }}>
                Next Visit Focus
              </div>
              <div style={{ fontSize: 16, color: B.grayDark, lineHeight: 1.6 }}>
                {recommendations.nextVisitFocus}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fallback "What's Next" if no AI recommendations */}
      {!recommendations && (
        <div style={{
          marginTop: 16, padding: '12px 16px', borderRadius: 12,
          background: `${B.teal}08`, border: `1px solid ${B.teal}20`,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: B.teal, marginBottom: 4 }}>What's Next</div>
          <div style={{ fontSize: 16, color: B.grayDark, lineHeight: 1.6 }}>
            Next visit we'll focus on strengthening turf density and applying preventive fungicide.
          </div>
        </div>
      )}

      {/* Before / After Slider */}
      {beforeAfter && (
        <div style={{ marginTop: 18 }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: B.grayDark, fontFamily: FONTS.heading,
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Before &amp; After</span>
            {beforeAfter.improvement?.overall != null && beforeAfter.improvement.overall > 0 && (
              <span style={{
                fontSize: 12, fontWeight: 700, color: B.green,
                background: `${B.green}12`, padding: '2px 8px', borderRadius: 6,
              }}>
                +{beforeAfter.improvement.overall} pts improvement
              </span>
            )}
          </div>
          <BeforeAfterSlider beforeAfter={beforeAfter} />
          {beforeAfter.improvement?.daysSinceStart > 0 && (
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 6, textAlign: 'center' }}>
              {beforeAfter.improvement.daysSinceStart} days of progress
            </div>
          )}
        </div>
      )}

      {/* Before/After fallback for single assessment */}
      {!beforeAfter && (
        <div style={{ marginTop: 18 }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: B.grayDark, fontFamily: FONTS.heading,
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8,
          }}>
            Before &amp; After
          </div>
          <BeforeAfterSlider beforeAfter={null} />
        </div>
      )}

      {/* Neighbor comparison */}
      {neighborBenchmark && neighborBenchmark.percentile && (
        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 10,
          background: neighborBenchmark.percentile.includes('top 25') ? `${B.green}10`
            : neighborBenchmark.percentile.includes('top 50') ? `${B.teal}10`
            : `${B.wavesBlue}08`,
          border: `1px solid ${neighborBenchmark.percentile.includes('top 25') ? B.green : B.teal}20`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
            background: neighborBenchmark.percentile.includes('top 25') ? `${B.green}20` : `${B.teal}15`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16,
          }}>
            {neighborBenchmark.percentile.includes('top 25') ? '' : neighborBenchmark.percentile.includes('top 50') ? '⭐' : ''}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: B.navy }}>
              {neighborBenchmark.percentile === 'top 25%' ? 'Top 25% in your area!'
                : neighborBenchmark.percentile === 'top 50%' ? 'Above average for your area'
                : 'Growing toward the neighborhood average'}
            </div>
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2, lineHeight: 1.4 }}>
              Your score of {neighborBenchmark.customerScore}% vs {neighborBenchmark.neighborhoodAvg}% neighborhood avg
              {neighborBenchmark.customerCount > 5 && ` across ${neighborBenchmark.customerCount} properties`}
            </div>
          </div>
        </div>
      )}

      {/* Seasonal context — FAWN weather powered */}
      <div style={{
        marginTop: 10, padding: '10px 12px', borderRadius: 8,
        background: `${B.wavesBlue}08`, fontSize: 12, color: B.grayMid, lineHeight: 1.5,
      }}>
        {seasonalContext ? (
          <>
            <div style={{ fontWeight: 600, color: B.grayDark, marginBottom: 3 }}>{seasonalContext.seasonName}</div>
            <div>{seasonalContext.explanation}</div>
            {seasonalContext.expectation && (
              <div style={{ marginTop: 4, color: B.teal, fontWeight: 500 }}>{seasonalContext.expectation}</div>
            )}
          </>
        ) : (
          <>Scores adjusted for {(() => {
            const m = new Date().getMonth();
            return m >= 2 && m <= 4 ? 'spring growing' : m >= 5 && m <= 8 ? 'summer peak' : m >= 9 && m <= 10 ? 'fall transition' : 'winter dormancy';
          })()} season — typical for St. Augustine in SW Florida.</>
        )}
      </div>

      {/* Pressure signals when relevant */}
      {seasonalContext?.pressureSignals?.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {seasonalContext.pressureSignals.filter(s => s.level === 'high' || s.level === 'regulatory').slice(0, 3).map((s, i) => (
            <span key={i} style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 6,
              background: s.level === 'regulatory' ? `${B.red}15` : `${B.orange}15`,
              color: s.level === 'regulatory' ? B.red : B.orange,
              fontWeight: 600,
            }}>
              {s.type.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// BADGE SYSTEM — dashboard row, celebration toast, detail modal
// =========================================================================
// Gamification feature removed. Hook kept as a stub returning a frozen
// "no badges" payload so every call site — BadgeRow (removed),
// BadgeShowcase (removed), BadgeCelebrationToast (removed), admin
// BadgesPage (removed) — compiles without widening the refactor.
// Re-enable by restoring the original fetch call if badges return.
function useBadges() {
  return { loading: false, data: null };
}

function BadgeRow({ badges, earnedCount, totalCount, onViewAll }) {
  if (!badges) return null;
  const earned = badges.filter(b => b.earned).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
  if (!earned.length) return null;

  const displayBadges = earned.slice(0, 8);
  const remaining = earned.length - displayBadges.length;

  return (
    <div style={{
      background: B.white, borderRadius: 14, padding: '14px 18px',
      border: `1px solid ${B.grayLight}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Your Badges</div>
        <div style={{ fontSize: 12, color: B.grayMid }}>{earnedCount} of {totalCount}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
        {displayBadges.map(b => (
          <div key={b.badgeType} title={b.title} style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: `${B.wavesBlue}12`, border: `1.5px solid ${B.wavesBlue}33`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, position: 'relative',
          }}>
            {b.icon}
            {b.reward && (
              <span style={{
                position: 'absolute', top: -3, right: -3,
                fontSize: 10, color: B.yellow, lineHeight: 1,
              }}></span>
            )}
          </div>
        ))}
        {remaining > 0 && (
          <div onClick={onViewAll} style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: B.offWhite, border: `1px solid ${B.grayLight}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: B.grayMid, cursor: 'pointer',
          }}>+{remaining}</div>
        )}
      </div>
    </div>
  );
}

function BadgeShowcase({ badges, categories, categoryOrder }) {
  const [selected, setSelected] = useState(null);

  if (!badges) return null;

  // Group by category
  const grouped = {};
  for (const b of badges) {
    if (!grouped[b.category]) grouped[b.category] = [];
    grouped[b.category].push(b);
  }

  // Use defined category order, falling back to Object.keys
  const orderedCategories = (categoryOrder || Object.keys(grouped)).filter(cat => grouped[cat]);

  const earnedCount = badges.filter(b => b.earned).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 16, padding: 20, color: '#fff', textAlign: 'center',
      }}>
        <div style={{ fontSize: 32 }}></div>
        <div style={{ fontSize: 22, fontWeight: 400, fontFamily: FONTS.display, letterSpacing: '0.02em', marginTop: 4 }}>{earnedCount} Badges Earned</div>
        <div style={{ fontSize: 14, color: B.blueLight, marginTop: 4 }}>out of {badges.length} total</div>
        <div style={{
          marginTop: 12, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.15)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 3,
            background: `linear-gradient(90deg, ${B.yellow}, ${B.orange})`,
            width: `${(earnedCount / badges.length) * 100}%`,
            transition: 'width 1s ease-out',
          }} />
        </div>
      </div>

      {orderedCategories.map(cat => {
        const catBadges = grouped[cat];
        if (!catBadges) return null;
        return (
          <div key={cat}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
              {categories[cat] || cat}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {catBadges.sort((a, b) => a.order - b.order).map(b => (
                <div key={b.badgeType} onClick={() => setSelected(b)} style={{
                  background: B.white, borderRadius: 12, padding: '14px 8px',
                  border: `1px solid ${b.earned ? B.wavesBlue + '33' : B.grayLight}`,
                  textAlign: 'center', cursor: 'pointer',
                  opacity: b.earned ? 1 : 0.5,
                  transition: 'transform 0.15s',
                }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%', margin: '0 auto',
                    background: b.earned ? `${B.wavesBlue}12` : B.grayLight,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 22, position: 'relative',
                  }}>
                    {b.icon}
                    {!b.earned && (
                      <div style={{
                        position: 'absolute', bottom: -2, right: -2,
                        fontSize: 10, background: B.grayMid, color: '#fff',
                        width: 16, height: 16, borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}></div>
                    )}
                    {b.reward && (
                      <span style={{
                        position: 'absolute', top: -3, right: -3,
                        fontSize: 12, color: B.yellow, lineHeight: 1,
                      }}></span>
                    )}
                  </div>
                  <div style={{
                    fontSize: 12, fontWeight: 600, marginTop: 6,
                    color: b.earned ? B.navy : B.grayMid,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{b.title}</div>
                  {b.reward && (
                    <div style={{ fontSize: 8, color: B.yellow, fontWeight: 700, marginTop: 1 }}> Reward</div>
                  )}
                  {b.earned && b.earnedAt && (
                    <div style={{ fontSize: 9, color: B.grayMid, marginTop: 2 }}>
                      {new Date(b.earnedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    </div>
                  )}
                  {!b.earned && b.progress && (
                    <div style={{ fontSize: 9, color: B.orange, fontWeight: 600, marginTop: 2 }}>{b.progress}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Badge Detail Modal */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: B.white, borderRadius: 20, padding: 28, maxWidth: 340, width: '100%',
            textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%', margin: '0 auto',
              background: selected.earned ? `${B.wavesBlue}12` : B.grayLight,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 36,
            }}>{selected.icon}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: 12 }}>
              {selected.title}
            </div>
            <div style={{ fontSize: 10, color: B.wavesBlue, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 4 }}>
              {selected.categoryLabel}
            </div>
            <div style={{ fontSize: 16, color: B.grayDark, marginTop: 10, lineHeight: 1.6 }}>
              {selected.description}
            </div>

            {selected.earned ? (
              <>
                <div style={{ fontSize: 12, color: B.green, fontWeight: 600, marginTop: 12 }}>
                   Earned {selected.earnedAt ? new Date(selected.earnedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
                </div>
                {selected.reward && (
                  <div style={{
                    marginTop: 10, padding: '8px 12px', borderRadius: 8,
                    background: `${B.yellow}20`, border: '1px solid #DAA520',
                  }}>
                    <div style={{ fontSize: 12, color: B.yellow, fontWeight: 700 }}> Reward unlocked: {selected.reward.description}</div>
                  </div>
                )}
              </>
            ) : (
              <>
                {selected.progress && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 4 }}>Progress</div>
                    <div style={{
                      height: 6, borderRadius: 3, background: B.grayLight, overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', borderRadius: 3, background: B.orange,
                        width: (() => {
                          const match = selected.progress.match(/(\d+)\/(\d+)/);
                          return match ? `${(parseInt(match[1]) / parseInt(match[2])) * 100}%` : '0%';
                        })(),
                      }} />
                    </div>
                    <div style={{ fontSize: 12, color: B.orange, fontWeight: 600, marginTop: 4 }}>{selected.progress}</div>
                  </div>
                )}
                {selected.reward && (
                  <div style={{
                    marginTop: 10, padding: '8px 12px', borderRadius: 8,
                    background: `${B.yellow}20`, border: `1px solid ${B.yellow}33`,
                  }}>
                    <div style={{ fontSize: 12, color: B.blueDeeper, fontWeight: 600 }}> Unlock reward: {selected.reward.description}</div>
                  </div>
                )}
              </>
            )}

            {selected.nextBadgeInCategory && (
              <div style={{
                marginTop: 14, padding: '10px 14px', borderRadius: 10,
                background: B.offWhite, border: `1px solid ${B.grayLight}`,
              }}>
                <div style={{ fontSize: 10, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.5 }}>Next badge</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: B.navy, marginTop: 2 }}>{selected.nextBadgeInCategory.title}</div>
                <div style={{ fontSize: 12, color: B.orange, marginTop: 1 }}>{selected.nextBadgeInCategory.remaining}</div>
              </div>
            )}

            <button onClick={() => setSelected(null)} style={{
              ...BUTTON_BASE, marginTop: 16, padding: '9px 24px', fontSize: 14,
              background: B.offWhite, color: B.grayDark, border: `1px solid ${B.grayLight}`,
            }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BadgeCelebrationToast({ badges }) {
  const [toasts, setToasts] = useState([]);
  const notifiedRef = useRef(new Set());

  useEffect(() => {
    if (!badges) return;
    const unnotified = badges.filter(b => b.earned && !b.notified && !notifiedRef.current.has(b.badgeType));
    if (!unnotified.length) return;

    // Queue toasts 2 seconds apart
    unnotified.forEach((b, i) => {
      notifiedRef.current.add(b.badgeType);
      const isReward = !!b.reward;
      const duration = isReward ? 6000 : 4000;
      setTimeout(() => {
        setToasts(prev => [...prev, b]);
        api.notifyBadge(b.badgeType).catch(() => {});
        // Remove after duration
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.badgeType !== b.badgeType));
        }, duration);
      }, i * 2000);
    });
  }, [badges]);

  if (!toasts.length) return null;

  return (
    <>
      <style>{`
        @keyframes toast-slide-in { from { transform: translateY(-100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes toast-slide-out { from { opacity: 1; } to { opacity: 0; transform: translateY(-20px); } }
        @keyframes badge-confetti { 0% { transform: translateY(0) rotate(0); opacity: 1; } 100% { transform: translateY(60px) rotate(360deg); opacity: 0; } }
      `}</style>
      {toasts.map((b, i) => {
        const isReward = !!b.reward;
        return (
          <div key={b.badgeType} style={{
            position: 'fixed', top: 60 + i * 80, left: '50%', transform: 'translateX(-50%)',
            zIndex: 2000, animation: 'toast-slide-in 0.5s ease-out',
            background: B.white, borderRadius: 16, padding: '12px 20px',
            boxShadow: isReward ? '0 8px 30px rgba(255,215,0,0.3)' : '0 8px 30px rgba(0,0,0,0.15)',
            border: `2px solid ${isReward ? B.yellow : B.yellow}`,
            display: 'flex', alignItems: 'center', gap: 12, minWidth: 280,
            overflow: 'visible',
          }}>
            {/* Mini confetti */}
            {[B.yellow, B.green, B.wavesBlue, B.orange].map((c, j) => (
              <div key={j} style={{
                position: 'absolute', top: -4, left: `${20 + j * 20}%`,
                width: 5, height: 5, borderRadius: j % 2 ? 1 : '50%',
                background: c, animation: `badge-confetti 1.5s ease-out ${j * 0.1}s forwards`,
              }} />
            ))}
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: isReward ? `${B.yellow}20` : `${B.yellow}20`, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 20, flexShrink: 0,
            }}>{b.icon}</div>
            <div>
              <div style={{ fontSize: 12, color: isReward ? B.yellow : B.yellow, fontWeight: 700 }}>
                {isReward ? ' Reward Badge Earned!' : ' New Badge Earned!'}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{b.title}</div>
              {isReward && b.reward && (
                <div style={{ fontSize: 12, color: B.blueDeeper, marginTop: 1 }}>{b.reward.description}</div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// =========================================================================
// CONTEXTUAL PROMOTION CARDS
// =========================================================================
function PromotionCards() {
  const [promoData, setPromoData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(null); // promoId being acted on
  const [interested, setInterested] = useState(new Set());

  useEffect(() => {
    api.getRelevantPromotions()
      .then(d => { setPromoData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleInterest = async (promo) => {
    setInteracting(promo.id);
    try {
      await api.expressPromoInterest(promo.id, {
        serviceType: promo.serviceType,
        serviceName: promo.serviceName,
      });
      setInterested(prev => new Set([...prev, promo.id]));
    } catch (err) { console.error(err); }
    setInteracting(null);
  };

  const handleDismiss = async (promoId) => {
    try {
      await api.dismissPromotion(promoId);
      setPromoData(prev => ({
        ...prev,
        promotions: prev.promotions.filter(p => p.id !== promoId),
      }));
    } catch (err) { console.error(err); }
  };

  if (loading || !promoData) return null;

  // Fully protected — celebration card
  if (promoData.fullyProtected) {
    return (
      <div style={{
        background: `linear-gradient(135deg, ${B.green}15, ${B.teal}10)`,
        borderRadius: 16, padding: 20,
        border: `2px solid ${B.green}22`,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 28 }}></div>
        <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: 8 }}>
          You're Fully Protected
        </div>
        <div style={{ fontSize: 16, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>
          WaveGuard Platinum member saving {promoData.discount} on everything. Thank you for trusting Waves with your complete home protection.
        </div>
      </div>
    );
  }

  if (!promoData.promotions?.length) return null;

  const urgencyConfig = {
    peak: { badge: ' Peak Season', color: B.orange, bg: `${B.orange}20`, borderColor: B.orange },
    high: { badge: ' Rising', color: B.orange, bg: `${B.orange}20`, borderColor: B.orange },
    moderate: { badge: ' Recommended', color: B.teal, bg: `${B.bluePale}20`, borderColor: B.teal },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {promoData.promotions.map(promo => {
        const u = urgencyConfig[promo.seasonalUrgency] || urgencyConfig.moderate;
        const isInterested = interested.has(promo.id);

        return (
          <div key={promo.id} style={{
            background: B.white, borderRadius: 16, overflow: 'hidden',
            border: `1px solid ${B.grayLight}`,
            boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
            borderLeft: `4px solid ${u.borderColor}`,
          }}>
            <div style={{ padding: '16px 18px' }}>
              {/* Header: urgency badge + dismiss */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: u.bg, color: u.color,
                }}>{u.badge}</span>
                <button onClick={() => handleDismiss(promo.id)} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: B.grayMid, fontSize: 18, padding: 0, lineHeight: 1,
                }} title="Dismiss"></button>
              </div>

              {/* Title & description */}
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
                {promo.title}
              </div>
              <div style={{ fontSize: 16, color: B.grayDark, marginTop: 4, lineHeight: 1.5 }}>
                {promo.description}
              </div>

              {/* Price block */}
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 10,
                background: B.offWhite, display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 14, color: B.grayMid, textDecoration: 'line-through' }}>
                  ${promo.originalMonthlyPrice}/mo
                </span>
                <span style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui }}>
                  ${promo.discountedMonthlyPrice}/mo
                </span>
                {promo.savingsText && (
                  <span style={{ fontSize: 12, color: B.green, fontWeight: 600, marginLeft: 'auto' }}>
                    {promo.savingsText}
                  </span>
                )}
              </div>

              {/* Tier upgrade banner */}
              {promo.tierUpgradeAvailable && (
                <div style={{
                  marginTop: 10, padding: '10px 14px', borderRadius: 10,
                  background: `linear-gradient(135deg, ${B.yellow}15, ${B.orange}10)`,
                  border: `1px solid ${B.yellow}33`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="arrowUp" size={14} strokeWidth={2} /> Add this and unlock {promo.potentialNewTier} — {promo.potentialNewDiscount} off everything
                  </div>
                  {promo.totalMonthlySavingsAtNewTier > 0 && (
                    <div style={{ fontSize: 12, color: B.green, fontWeight: 600, marginTop: 2 }}>
                      You'd save ${promo.totalMonthlySavingsAtNewTier.toFixed(2)}/mo total across all services
                    </div>
                  )}
                </div>
              )}

              {/* Social proof */}
              <div style={{ fontSize: 12, color: B.grayMid, marginTop: 10 }}>
                {promo.socialProof}
              </div>

              {/* CTA */}
              {!isInterested ? (
                <button
                  onClick={() => handleInterest(promo)}
                  disabled={interacting === promo.id}
                  style={{
                    ...BUTTON_BASE, width: '100%', padding: 13, marginTop: 12, fontSize: 14,
                    background: B.yellow,
                    color: B.blueDeeper,
                    boxShadow: `0 4px 15px ${B.yellow}55`,
                    opacity: interacting === promo.id ? 0.7 : 1,
                  }}
                >
                  {interacting === promo.id ? 'Sending...' : promo.ctaText}
                </button>
              ) : (
                <div style={{
                  marginTop: 12, padding: 13, borderRadius: 50, textAlign: 'center',
                  background: `${B.green}20`, color: B.green, fontSize: 14, fontWeight: 700,
                }}>
                   We'll follow up within 24 hours!
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =========================================================================
// HERO SLIDER — van + branded promotional slides
// =========================================================================
function HeroSlider({ onSwitchTab }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef(0);
  const touchDeltaX = useRef(0);

  const slides = [
    {
      image: '/waves-ford-1.png',
      alt: 'Waves Pest Control & Lawn Care truck',
      title: 'Wave Goodbye to Pests!',
      subtitle: 'Full-service pest control, lawn care & mosquito protection for your home.',
      cta: { label: 'View My Plan', tab: 'plan' },
    },
    {
      image: '/waves-ford-2.png',
      alt: 'Waves Pest Control & Lawn Care truck',
      title: 'Refer a Friend, Earn Cash!',
      subtitle: 'Share your referral link and earn rewards for every neighbor who signs up.',
      cta: { label: 'Start Referring', tab: 'refer' },
    },
    {
      image: '/waves-ford-3.png',
      alt: 'Waves Pest Control & Lawn Care truck',
      title: 'Lawn Care Programs',
      subtitle: 'St. Augustine, Bermuda, Zoysia & Bahia — customized fertilization & weed control.',
      cta: { label: 'Learn More', tab: 'learn' },
    },
    {
      image: '/waves-ford-4.png',
      alt: 'Waves Pest Control & Lawn Care truck',
      title: 'Trusted SWFL Service',
      subtitle: 'Family-owned & operated across Manatee, Sarasota & Charlotte counties.',
      cta: { label: 'View My Plan', tab: 'plan' },
    },
    {
      image: '/waves-ford-1.png',
      alt: 'Waves Pest Control & Lawn Care truck',
      title: 'Stay in the Know',
      subtitle: 'SWFL pest & lawn tips, expert advice from UF/IFAS, and our monthly newsletter — all in the Learn tab.',
      cta: { label: 'Learn More', tab: 'learn' },
    },
  ];

  const count = slides.length;

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setActive(p => (p + 1) % count), 5000);
    return () => clearInterval(timer);
  }, [paused, count]);

  const goTo = (i) => setActive(i);
  const prev = () => setActive(p => (p - 1 + count) % count);
  const next = () => setActive(p => (p + 1) % count);

  const handleTouchStart = (e) => { touchStartX.current = e.touches[0].clientX; touchDeltaX.current = 0; };
  const handleTouchMove = (e) => { touchDeltaX.current = e.touches[0].clientX - touchStartX.current; };
  const handleTouchEnd = () => {
    if (touchDeltaX.current > 50) prev();
    else if (touchDeltaX.current < -50) next();
  };

  return (
    <div
      style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.10)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <style>{`
        @keyframes heroFadeIn { from { opacity: 0; transform: scale(1.02); } to { opacity: 1; transform: scale(1); } }
      `}</style>

      {/* Slides */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 7', minHeight: 160 }}>
        {slides.map((slide, i) => (
          <div
            key={i}
            style={{
              position: 'absolute', inset: 0,
              opacity: i === active ? 1 : 0,
              transition: 'opacity 0.6s ease',
              pointerEvents: i === active ? 'auto' : 'none',
            }}
          >
            <img
              src={slide.image}
              alt={slide.alt}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(90deg, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0.25) 100%)',
            }} />
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '24px 28px 24px 44px', boxSizing: 'border-box',
              ...(i === active ? { animation: 'heroFadeIn 0.6s ease' } : {}),
            }}>
              <div style={{
                fontSize: 20, fontWeight: 800, color: '#fff',
                fontFamily: FONTS.heading, lineHeight: 1.2, marginBottom: 6,
                textShadow: '0 2px 8px rgba(0,0,0,0.5)',
              }}>{slide.title}</div>
              <div style={{
                fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.98)', lineHeight: 1.4,
                maxWidth: 320, marginBottom: 14,
                textShadow: '0 1px 4px rgba(0,0,0,0.5)',
              }}>{slide.subtitle}</div>
              {slide.cta && (
                <button
                  onClick={() => onSwitchTab(slide.cta.tab)}
                  style={{
                    ...BUTTON_BASE, padding: '8px 18px', fontSize: 12,
                    background: B.yellow, color: '#000',
                    border: 'none',
                    alignSelf: 'flex-start',
                  }}
                >{slide.cta.label}</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Arrow buttons */}
      {[
        { dir: 'left', onClick: prev, char: '\u2039', label: 'Previous slide' },
        { dir: 'right', onClick: next, char: '\u203A', label: 'Next slide' },
      ].map(({ dir, onClick, char, label }) => (
        <button
          key={dir}
          onClick={onClick}
          aria-label={label}
          style={{
            position: 'absolute', top: '50%', [dir]: 8, transform: 'translateY(-50%)',
            width: 40, height: 40, borderRadius: '50%',
            background: 'rgba(0,0,0,0.35)', color: '#fff', border: 'none',
            fontSize: 20, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(4px)', transition: 'background 0.2s',
            lineHeight: 1,
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.55)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.35)'}
        >{char}</button>
      ))}

      {/* Dot indicators */}
      <div style={{
        position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 6,
      }}>
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Go to slide ${i + 1}`}
            aria-current={i === active ? 'true' : undefined}
            style={{
              width: 36, height: 32, borderRadius: 8,
              background: 'transparent',
              border: 'none', cursor: 'pointer', padding: 0,
              transition: 'all 0.3s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span aria-hidden="true" style={{
              width: i === active ? 20 : 8, height: 8, borderRadius: 4,
              background: i === active ? '#fff' : 'rgba(255,255,255,0.5)',
              display: 'block',
            }} />
          </button>
        ))}
      </div>
    </div>
  );
}

// =========================================================================
// DASHBOARD TAB — with referral, review prompt, irrigation recs
// =========================================================================
function LegacyDashboardTab({ customer, onSwitchTab }) {
  const [nextService, setNextService] = useState(null);
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);
  const [lastService, setLastService] = useState(null);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [pendingSatisfaction, setPendingSatisfaction] = useState(null);
  const [referralStats, setReferralStats] = useState(null);
  const badgeData = useBadges();
  const [satRating, setSatRating] = useState(0);
  const [satHover, setSatHover] = useState(0);
  const [satPhase, setSatPhase] = useState('rate'); // rate | review | feedback | thanks
  const [satFeedback, setSatFeedback] = useState('');
  const [satReviewLink, setSatReviewLink] = useState('');
  const [satOfficeName, setSatOfficeName] = useState('');
  const [satSubmitting, setSatSubmitting] = useState(false);
  const [satDismissed, setSatDismissed] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const lawnHealth = useLawnHealth(customer.id);

  useEffect(() => {
    api.getNextService().then(d => setNextService(d.next)).catch(console.error);
    api.getServiceStats().then(setStats).catch(console.error);
    api.getBalance().then(setBalance).catch(console.error);
    api.getServices({ limit: 1 }).then(d => {
      if (d.services?.length) setLastService(d.services[0]);
    }).catch(console.error);
    api.getPendingSatisfaction().then(d => {
      if (d.pending?.length) setPendingSatisfaction(d.pending[0]);
    }).catch(console.error);
    api.getReferrals().then(d => {
      if (d?.stats) setReferralStats(d.stats);
    }).catch(console.error);
  }, []);

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const tier = TIER[customer.tier];
  const referralCode = customer.referralCode || '';

  // Extract irrigation recommendations from last service notes
  const irrigationRecs = [];
  if (lastService?.notes) {
    const noteText = lastService.notes.toLowerCase();
    if (noteText.includes('irrigation') || noteText.includes('zone') || noteText.includes('watering') || noteText.includes('sprinkler')) {
      irrigationRecs.push({ text: lastService.notes, date: lastService.date, tech: lastService.technician });
    }
  }

  // Show review prompt if last service was within 3 days
  const showReview = lastService && !reviewDismissed && (() => {
    const svcDate = parseDate(lastService.date);
    const now = new Date();
    const diffDays = (now - svcDate) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 3;
  })();

  const handleSatRating = async (rating) => {
    setSatRating(rating);
    setSatSubmitting(true);
    try {
      const result = await api.submitSatisfaction({
        serviceRecordId: pendingSatisfaction.id,
        rating,
      });
      if (result.action === 'review') {
        setSatReviewLink(result.reviewLink);
        setSatOfficeName(result.officeName);
        setSatPhase('review');
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 3000);
      } else {
        setSatPhase('feedback');
      }
    } catch (err) {
      console.error(err);
    }
    setSatSubmitting(false);
  };

  const handleSatFeedback = async () => {
    setSatSubmitting(true);
    try {
      await api.submitSatisfaction({
        serviceRecordId: pendingSatisfaction.id,
        rating: satRating,
        feedbackText: satFeedback,
      });
    } catch (err) {
      // Already submitted the rating, feedback is supplemental
    }
    setSatPhase('thanks');
    setSatSubmitting(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Hero Slider */}
      <HeroSlider onSwitchTab={onSwitchTab} />

      {/* Satisfaction Pulse — above everything */}
      {pendingSatisfaction && !satDismissed && (() => {
        const svcDate = parseDate(pendingSatisfaction.service_date || pendingSatisfaction.serviceDate);

        // Confetti particles
        const confettiColors = [B.yellow, B.green, B.wavesBlue, B.orange, B.red, B.blueDeeper];
        const confettiParticles = showConfetti ? Array.from({ length: 40 }, (_, i) => ({
          id: i,
          color: confettiColors[i % confettiColors.length],
          left: Math.random() * 100,
          delay: Math.random() * 0.5,
          size: 4 + Math.random() * 6,
          rotation: Math.random() * 360,
        })) : [];

        return (
          <div style={{
            position: 'relative', overflow: 'hidden',
            background: B.white, borderRadius: 16,
            border: `2px solid ${satPhase === 'review' ? B.yellow : satPhase === 'feedback' || satPhase === 'thanks' ? B.wavesBlue : B.orange}33`,
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          }}>
            {/* Confetti animation */}
            {showConfetti && (
              <style>{`
                @keyframes confetti-fall {
                  0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
                  100% { transform: translateY(300px) rotate(720deg); opacity: 0; }
                }
              `}</style>
            )}
            {confettiParticles.map(p => (
              <div key={p.id} style={{
                position: 'absolute', top: 0, left: `${p.left}%`,
                width: p.size, height: p.size, borderRadius: p.size > 7 ? 2 : '50%',
                background: p.color, zIndex: 10, pointerEvents: 'none',
                animation: `confetti-fall 2.5s ease-out ${p.delay}s forwards`,
                transform: `rotate(${p.rotation}deg)`,
              }} />
            ))}

            <div style={{ padding: 20, position: 'relative', zIndex: 5 }}>
              {/* PHASE: Rate */}
              {satPhase === 'rate' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>How was your visit?</div>
                        <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>
                          {pendingSatisfaction.service_type || pendingSatisfaction.serviceType} · {!isNaN(svcDate) ? svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''} · {pendingSatisfaction.technician_name || pendingSatisfaction.technicianName}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => setSatDismissed(true)} style={{
                      background: 'none', border: 'none', color: B.grayMid, cursor: 'pointer', fontSize: 20, padding: 0, lineHeight: 1,
                      minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>×</button>
                  </div>

                  <div style={{ marginTop: 16, textAlign: 'center' }}>
                    <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 8 }}>Tap a number to rate your experience</div>
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'center', flexWrap: 'wrap' }}>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => {
                        const isActive = n <= (satHover || satRating);
                        const color = n <= 3 ? B.red : n <= 7 ? B.orange : B.green;
                        return (
                          <button
                            key={n}
                            onMouseEnter={() => setSatHover(n)}
                            onMouseLeave={() => setSatHover(0)}
                            onClick={() => handleSatRating(n)}
                            disabled={satSubmitting}
                            style={{
                              minWidth: 28, height: 44, borderRadius: 8, border: 'none',
                              cursor: satSubmitting ? 'wait' : 'pointer',
                              background: isActive ? color : B.offWhite,
                              color: isActive ? '#fff' : B.grayMid,
                              fontSize: 14, fontWeight: 700, fontFamily: FONTS.ui,
                              transition: 'all 0.15s ease',
                              transform: isActive ? 'scale(1.1)' : 'scale(1)',
                              flex: '1 1 0',
                            }}
                          >{n}</button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, padding: '0 2px' }}>
                      <span style={{ fontSize: 10, color: B.grayMid }}>Not great</span>
                      <span style={{ fontSize: 10, color: B.grayMid }}>Amazing</span>
                    </div>
                  </div>
                </>
              )}

              {/* PHASE: Review prompt (8-10) */}
              {satPhase === 'review' && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 36, marginBottom: 8 }}></div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
                    Awesome — {satRating}/10!
                  </div>
                  <div style={{ fontSize: 16, color: B.grayDark, marginTop: 6, lineHeight: 1.6 }}>
                    Would you share your experience on Google? It helps your neighbors find great pest & lawn care and means the world to our {satOfficeName} team.
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <a href={satReviewLink} target="_blank" rel="noopener noreferrer" style={{
                      ...BUTTON_BASE, padding: '11px 22px', fontSize: 14,
                      background: `linear-gradient(135deg, ${B.yellow}, ${B.orange})`,
                      color: B.navy, textDecoration: 'none',
                    }}>Leave a Review ⭐</a>
                    <button onClick={() => setSatDismissed(true)} style={{
                      ...BUTTON_BASE, padding: '11px 22px', fontSize: 14,
                      background: 'transparent', color: B.grayMid,
                      border: `1px solid ${B.grayLight}`,
                    }}>Maybe Later</button>
                  </div>
                  <div style={{ fontSize: 12, color: B.grayMid, marginTop: 12 }}>
                    We also texted you the review link in case you want to do it later
                  </div>
                </div>
              )}

              {/* PHASE: Feedback (1-7) */}
              {satPhase === 'feedback' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <Icon name="chat" size={24} strokeWidth={1.75} />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                        {satRating <= 3 ? "We're sorry to hear that." : "Thanks for the honest feedback."}
                      </div>
                      <div style={{ fontSize: 12, color: B.grayMid }}>
                        {satRating <= 3
                          ? "Tell us what went wrong and we'll make it right."
                          : "Anything we could do better? This stays between us."}
                      </div>
                    </div>
                  </div>
                  <textarea
                    value={satFeedback}
                    onChange={e => setSatFeedback(e.target.value)}
                    placeholder="What could we have done differently?"
                    aria-label="Service feedback"
                    rows={3}
                    style={{
                      width: '100%', padding: '12px 14px', borderRadius: 12,
                      border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
                      color: B.navy, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
                    }}
                    onFocus={e => e.target.style.borderColor = B.wavesBlue}
                    onBlur={e => e.target.style.borderColor = B.grayLight}
                  />
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <button onClick={handleSatFeedback} disabled={satSubmitting} style={{
                      ...BUTTON_BASE, padding: '10px 20px', flex: 1, fontSize: 14,
                      background: B.yellow, color: B.blueDeeper,
                      opacity: satSubmitting ? 0.7 : 1,
                    }}>{satSubmitting ? 'Sending...' : 'Send Feedback'}</button>
                    <button onClick={() => setSatPhase('thanks')} style={{
                      ...BUTTON_BASE, padding: '10px 20px', fontSize: 14,
                      background: 'transparent', color: B.grayMid,
                      border: `1px solid ${B.grayLight}`,
                    }}>Skip</button>
                  </div>
                </>
              )}

              {/* PHASE: Thank you */}
              {satPhase === 'thanks' && (
                <div style={{ textAlign: 'center', padding: '8px 0' }}>
                  <Icon name="hand" size={28} strokeWidth={1.75} />
                  <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 6 }}>
                    Thank you for your feedback.
                  </div>
                  <div style={{ fontSize: 16, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>
                    {satRating <= 3
                      ? `${(pendingSatisfaction.technician_name || pendingSatisfaction.technicianName) ? (pendingSatisfaction.technician_name || pendingSatisfaction.technicianName).split(' ')[0] + ' at Waves' : 'Your team at Waves'} will personally follow up with you within 24 hours.`
                      : satRating <= 7
                        ? "We appreciate you letting us know. We're always working to improve."
                        : "Thank you for being a valued Waves customer!"}
                  </div>
                  <button onClick={() => setSatDismissed(true)} style={{
                    ...BUTTON_BASE, padding: '8px 20px', fontSize: 12, marginTop: 12,
                    background: B.offWhite, color: B.grayDark, border: `1px solid ${B.grayLight}`,
                  }}>Dismiss</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Welcome */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark}, ${B.wavesBlue})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark}, ${B.wavesBlue})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 20, padding: '28px 24px 40px', color: '#fff',
      }}>
        {/* Hero video — waves-hero-service.mp4 */}
        <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true">
          <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
        </video>
        {/* Wave motif at bottom */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 30, zIndex: 1,
          background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 120'%3E%3Cpath d='M0,60 C200,120 400,0 600,60 C800,120 1000,0 1200,60 L1200,120 L0,120Z' fill='%234DC9F6' fill-opacity='0.25'/%3E%3C/svg%3E") no-repeat bottom`,
          backgroundSize: '100% 100%',
        }} />
        <div style={{ position: 'relative', zIndex: 1, fontSize: 14, color: B.blueLight, fontFamily: FONTS.body }}>Hey there,</div>
        <h1 style={{
          position: 'relative', zIndex: 1,
          fontFamily: FONTS.display, fontWeight: 400,
          fontSize: 'clamp(32px, 7vw, 44px)', color: '#fff',
          letterSpacing: '0.02em', lineHeight: 1.05,
          margin: 0,
          textShadow: '0 2px 12px rgba(0,0,0,0.25)',
        }}>
          {customer.firstName}! 
        </h1>
        {tier && (
          <div style={{
            position: 'relative', zIndex: 1,
            marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 24, fontSize: 14, fontWeight: 700,
            fontFamily: FONTS.heading,
            background: `linear-gradient(135deg, ${tier.gradientFrom}, ${tier.gradientTo})`,
            color: '#fff',
            border: 'none',
            textShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}> WaveGuard {customer.tier}</div>
        )}
        <div style={{ position: 'relative', zIndex: 1, marginTop: 12, fontSize: 16, color: '#fff', lineHeight: 1.6 }}>
          {customer.address?.line1}, {customer.address?.city}, {customer.address?.state} {customer.address?.zip}<br/>
          <span style={{ color: B.blueLight }}>{(customer.property?.lawnType || '').replace(/\s*(Full Sun|Shade|Sun\/Shade)\s*/gi, '') || 'Lawn'} · {customer.property?.propertySqFt?.toLocaleString()} sq ft · {customer.property?.lotSqFt?.toLocaleString()} sq ft lot</span>
        </div>
      </div>

      {/* Quick Actions Row */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
      }}>
        {[
          { icon: 'wrench', label: 'Request Service', action: () => onSwitchTab?.('request') },
          { icon: 'chat', label: 'Message Us', action: () => onSwitchTab?.('messages') },
          { icon: 'card', label: 'Pay Now', action: () => onSwitchTab?.('billing') },
          { icon: 'gift', label: 'Refer a Friend', action: () => onSwitchTab?.('refer') },
        ].map((item, i) => (
          <button key={i} onClick={item.action} style={{
            ...BUTTON_BASE, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            padding: '14px 8px', borderRadius: 14,
            background: B.white, border: `1.5px solid ${B.bluePale}`,
            color: B.navy, fontSize: 12, fontWeight: 600, fontFamily: FONTS.ui,
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}>
            <Icon name={item.icon} size={22} strokeWidth={1.75} />
            {item.label}
          </button>
        ))}
      </div>

      {/* Service Tracker — shows when a canonical tracker is active */}
      <ServiceTracker />

      {/* Next service — enhanced pre-service communication */}
      {nextService && (() => {
        const svcDate = parseDate(nextService.date);
        const now = new Date();
        const diffHrs = (svcDate - now) / (1000 * 60 * 60);
        const isToday = svcDate.toDateString() === now.toDateString();
        const isTomorrow = diffHrs > 0 && diffHrs <= 48 && !isToday;
        const daysUntil = Math.max(0, Math.ceil(diffHrs / 24));

        return (
          <div style={{
            background: B.white, borderRadius: 16, overflow: 'hidden',
            border: `2px solid ${isToday ? B.green : isTomorrow ? B.orange : B.wavesBlue}22`,
            boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
          }}>
            {/* Header */}
            <div style={{
              background: isToday
                ? `linear-gradient(135deg, ${B.green}, ${B.blueDark})`
                : isTomorrow
                  ? `linear-gradient(135deg, ${B.orange}, ${B.blueDark})`
                  : `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`,
              padding: '16px 20px', color: '#fff',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 26 }}>{isToday ? '' : isTomorrow ? '⏰' : ''}</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.85, fontFamily: FONTS.ui }}>
                    {isToday ? "Today's Service" : isTomorrow ? 'Tomorrow' : 'Your Next Visit'}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: FONTS.heading }}>
                    {svcDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </div>
              {!isToday && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.ui }}>{daysUntil}</div>
                  <div style={{ fontSize: 10, opacity: 0.75, textTransform: 'uppercase', letterSpacing: 0.5 }}>{daysUntil === 1 ? 'day away' : 'days away'}</div>
                </div>
              )}
            </div>

            {/* Service details */}
            <div style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: B.navy }}>{nextService.serviceType}</div>
              <div style={{ fontSize: 12, color: B.grayDark, marginTop: 3, lineHeight: 1.5, fontStyle: 'italic' }}>
                {(() => {
                  const sType = (nextService.serviceType || '').toLowerCase();
                  if (sType.includes('lawn') || sType.includes('fertiliz') || sType.includes('celsius'))
                    return 'Fertilizer application + weed spot treatment + perimeter pest barrier';
                  if (sType.includes('pest') || sType.includes('general'))
                    return 'Interior + exterior perimeter spray + entry point treatment';
                  if (sType.includes('mosquito'))
                    return 'Backyard fogging + standing water treatment + barrier spray';
                  if (sType.includes('rodent'))
                    return 'Bait station check + exclusion inspection + trapping';
                  if (sType.includes('termite'))
                    return 'Termite monitoring station inspection + barrier check';
                  return 'Full property inspection + targeted treatment application';
                })()}
              </div>
              <div style={{ fontSize: 14, color: B.grayMid, marginTop: 4 }}>
                Technician: <strong style={{ color: B.navy }}>{nextService.technician || 'TBD'}</strong>
                {nextService.windowStart && ` · ${formatTime(nextService.windowStart)} – ${formatTime(nextService.windowEnd)}`}
              </div>

              {/* SMS Communication Timeline */}
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 12,
                background: B.offWhite, border: `1px solid ${B.grayLight}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.grayMid, marginBottom: 10 }}>
                  Communication Timeline
                </div>
                {[
                  { icon: 'smartphone', label: '72-hour reminder', desc: 'SMS 3 days before your visit', done: diffHrs <= 72, active: diffHrs <= 72 && diffHrs > 24 },
                  { icon: 'smartphone', label: '24-hour reminder', desc: 'SMS the day before your visit', done: diffHrs <= 24, active: diffHrs <= 24 && diffHrs > 1 },
                  { icon: 'truck', label: 'Tech en route alert', desc: 'Live GPS tracking via Bouncie', done: false, active: isToday },
                  { icon: 'checkCircle', label: 'Service complete summary', desc: 'Products applied + tech notes', done: false, active: false },
                ].map((step, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: i < 3 ? 10 : 0 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      background: step.done ? `${B.green}18` : step.active ? `${B.orange}18` : B.grayLight,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: step.done ? B.green : step.active ? B.orange : B.grayMid,
                      border: step.active ? `1.5px solid ${B.orange}` : step.done ? `1.5px solid ${B.green}` : `1px solid ${B.grayLight}`,
                    }}><Icon name={step.icon} size={14} strokeWidth={2} /></div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: step.done ? B.green : step.active ? B.orange : B.grayDark }}>
                        {step.label} {step.done && ''}
                      </div>
                      <div style={{ fontSize: 12, color: B.grayMid }}>{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {!nextService.customerConfirmed ? (
                  <button onClick={() => {
                    api.confirmAppointment(nextService.id).then(() => {
                      setNextService({ ...nextService, customerConfirmed: true, status: 'confirmed' });
                    });
                  }} style={{
                    ...BUTTON_BASE, padding: '10px 20px', flex: 1,
                    background: B.green, color: '#fff', fontSize: 14,
                    boxShadow: `0 3px 10px ${B.green}30`,
                  }}> Confirm Appointment</button>
                ) : (
                  <span style={{
                    padding: '10px 20px', borderRadius: 50, background: `${B.green}20`, flex: 1,
                    color: B.green, fontSize: 14, fontWeight: 700, textAlign: 'center',
                  }}> Confirmed</span>
                )}
                <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${nextService.serviceType} on ${svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. What's available?`} style={{
                  ...BUTTON_BASE, padding: '10px 20px', flex: 1, textDecoration: 'none',
                  background: 'transparent', color: B.wavesBlue, fontSize: 14,
                  border: `1.5px solid ${B.wavesBlue}`,
                }}>Reschedule</a>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Last Service Summary */}
      {lastService && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 20,
          border: `1px solid ${B.bluePale}`, boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Icon name="checkCircle" size={22} strokeWidth={1.75} />
            <div style={{ fontSize: 14, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>Last Visit</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{lastService.type || lastService.serviceType}</div>
              <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>
                {parseDate(lastService.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {lastService.technician || 'Waves Team'}
              </div>
            </div>
            <span style={{
              fontSize: 12, padding: '3px 10px', borderRadius: 6,
              background: `${B.green}20`, color: B.green, fontWeight: 700,
            }}>Completed</span>
          </div>
          {lastService.notes || lastService.technician_notes ? (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 10,
              background: B.offWhite, fontSize: 16, color: B.grayDark, lineHeight: 1.6,
              borderLeft: `3px solid ${B.wavesBlue}`,
            }}>
              {((lastService.notes || lastService.technician_notes) || '').slice(0, 100)}
              {((lastService.notes || lastService.technician_notes) || '').length > 100 ? '...' : ''}
            </div>
          ) : (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 10,
              background: B.offWhite, fontSize: 12, color: B.grayMid, lineHeight: 1.5,
            }}>
              Service completed — full report in Documents
            </div>
          )}
        </div>
      )}

      {/* Irrigation Recommendations */}
      {irrigationRecs.length > 0 && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 20,
          border: `2px solid ${B.teal}33`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Icon name="droplet" size={24} strokeWidth={1.75} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Irrigation Recommendation</div>
              <div style={{ fontSize: 12, color: B.grayMid }}>From {irrigationRecs[0].tech} · {parseDate(irrigationRecs[0].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            </div>
          </div>
          <div style={{
            padding: 14, borderRadius: 12, background: `${B.teal}08`,
            fontSize: 16, color: B.grayDark, lineHeight: 1.6, borderLeft: `3px solid ${B.teal}`,
          }}>
            {irrigationRecs[0].text}
          </div>
        </div>
      )}

      {/* Lawn Health Progress — conditional display (moved up) */}
      {!lawnHealth.loading && lawnHealth.hasLawnCare && lawnHealth.scores && lawnHealth.initialScores && (
        <LawnHealthCard
          scores={lawnHealth.scores}
          initialScores={lawnHealth.initialScores}
          photos={lawnHealth.photos}
          beforeAfter={lawnHealth.beforeAfter}
          trend={lawnHealth.trend}
          recommendations={lawnHealth.recommendations}
          seasonalContext={lawnHealth.seasonalContext}
          neighborBenchmark={lawnHealth.neighborBenchmark}
        />
      )}
      {!lawnHealth.loading && lawnHealth.hasLawnCare && !lawnHealth.scores && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 24,
          border: `2px solid ${B.green}22`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
          textAlign: 'center',
        }}>
          <Icon name="sprout" size={28} strokeWidth={1.75} />
          <div style={{ fontSize: 14, fontWeight: 600, color: B.navy, fontFamily: FONTS.heading, marginTop: 8 }}>Lawn Health Tracking</div>
          <div style={{ fontSize: 16, color: B.grayMid, marginTop: 6, lineHeight: 1.6 }}>
            Your lawn health tracking will begin after your first assessment visit.
          </div>
        </div>
      )}

      {/* Contextual Promotions — based on services they don't have + season */}
      <PromotionCards />

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {[
          { label: 'Monthly Rate', value: `$${customer.monthlyRate}`, sub: `${tier?.discount || '0%'} discount`, icon: 'money' },
          { label: 'Next Service', value: nextService ? parseDate(nextService.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—', sub: nextService?.serviceType || '', icon: 'calendar' },
          { label: 'Services YTD', value: stats?.servicesYTD ?? '...', sub: stats?.celsiusApplicationsThisYear != null ? `Weed treatments: ${stats.celsiusApplicationsThisYear} of ${stats.celsiusMaxPerYear || 3} annual` : '', icon: 'clipboard' },
          { label: 'Member Since', value: customer.memberSince ? parseDate(customer.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—', sub: '', icon: 'star' },
        ].map((s, i) => (
          <div key={i} style={{
            background: B.white, borderRadius: 14, padding: 16,
            border: `1px solid ${B.bluePale}`,
          }}>
            <div style={{ marginBottom: 6, color: B.wavesBlue }}><Icon name={s.icon} size={22} strokeWidth={1.75} /></div>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: B.grayDark, fontFamily: FONTS.ui }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: B.navy, marginTop: 2, fontFamily: FONTS.ui }}>{s.value}</div>
            <div style={{ fontSize: 12, color: B.green, fontWeight: 600, marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* WaveGuard Rewards — compact dashboard card */}
      {tier && (() => {
        const renewalCredit = Math.min(75, Math.round(((new Date() - parseDate(customer.memberSince)) / (1000 * 60 * 60 * 24 * 30)) * 6.25));
        const referralCredits = (referralStats?.totalReferrals || 0) * 25;
        const totalCredits = renewalCredit + referralCredits;
        return totalCredits > 0 ? (
          <div style={{
            background: B.white, borderRadius: 14, padding: '14px 18px',
            border: `1.5px solid ${B.wavesBlue}22`,
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <Icon name="medal" size={28} strokeWidth={1.75} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>Your WaveGuard Rewards</div>
              <div style={{ fontSize: 12, color: B.grayDark, marginTop: 2, lineHeight: 1.5 }}>
                ${renewalCredit} renewal credit · ${referralCredits} referral credits · <strong style={{ color: B.wavesBlue }}>Total: ${totalCredits}</strong>
              </div>
            </div>
          </div>
        ) : null;
      })()}

      {/* My Requests — open service requests */}
      <MyRequestsCard />

      {/* Referral — compact dashboard card */}
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 16, padding: 20, color: '#fff',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{ fontSize: 36 }}></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: FONTS.heading }}>
            {referralStats && referralStats.totalReferrals > 0
              ? `You've referred ${referralStats.totalReferrals} neighbor${referralStats.totalReferrals !== 1 ? 's' : ''} — $${referralStats.totalEarned} earned!`
              : 'Give $25, Get $25'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2, lineHeight: 1.5 }}>
            {referralStats && referralStats.totalReferrals > 0
              ? 'Keep sharing — every referral earns you $25.'
              : 'Know someone who needs pest control? Refer a neighbor and you both get $25.'}
          </div>
        </div>
        <button onClick={() => onSwitchTab?.('refer')} style={{
          ...BUTTON_BASE, padding: '9px 16px', fontSize: 12, flexShrink: 0,
          background: B.yellow, color: B.blueDeeper,
        }}>Refer Now</button>
      </div>
    </div>
  );
}

function DashboardTab({ customer, onSwitchTab }) {
  const compact = useIsMobile(720);
  const [nextService, setNextService] = useState(null);
  const [nextServiceStatus, setNextServiceStatus] = useState('loading');
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);
  const [balanceStatus, setBalanceStatus] = useState('loading');
  const [lastService, setLastService] = useState(null);
  const [pendingSatisfaction, setPendingSatisfaction] = useState(null);
  const [referralStats, setReferralStats] = useState(null);
  const [satRating, setSatRating] = useState(0);
  const [satHover, setSatHover] = useState(0);
  const [satPhase, setSatPhase] = useState('rate');
  const [satFeedback, setSatFeedback] = useState('');
  const [satReviewLink, setSatReviewLink] = useState('');
  const [satOfficeName, setSatOfficeName] = useState('');
  const [satSubmitting, setSatSubmitting] = useState(false);
  const [satDismissed, setSatDismissed] = useState(false);
  const lawnHealth = useLawnHealth(customer.id);
  const tier = TIER[customer.tier];

  useEffect(() => {
    api.getNextService()
      .then(d => {
        setNextService(d.next || null);
        setNextServiceStatus('ready');
      })
      .catch(err => {
        console.error(err);
        setNextServiceStatus('error');
      });
    api.getServiceStats().then(setStats).catch(console.error);
    api.getBalance()
      .then(d => {
        setBalance(d);
        setBalanceStatus('ready');
      })
      .catch(err => {
        console.error(err);
        setBalanceStatus('error');
      });
    api.getServices({ limit: 1 }).then(d => {
      if (d.services?.length) setLastService(d.services[0]);
    }).catch(console.error);
    api.getPendingSatisfaction().then(d => {
      if (d.pending?.length) setPendingSatisfaction(d.pending[0]);
    }).catch(console.error);
    api.getReferrals().then(d => {
      if (d?.stats) setReferralStats(d.stats);
    }).catch(console.error);
  }, []);

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const handleSatRating = async (rating) => {
    setSatRating(rating);
    setSatSubmitting(true);
    try {
      const result = await api.submitSatisfaction({
        serviceRecordId: pendingSatisfaction.id,
        rating,
      });
      if (result.action === 'review') {
        setSatReviewLink(result.reviewLink);
        setSatOfficeName(result.officeName);
        setSatPhase('review');
      } else {
        setSatPhase('feedback');
      }
    } catch (err) {
      console.error(err);
    }
    setSatSubmitting(false);
  };

  const handleSatFeedback = async () => {
    setSatSubmitting(true);
    try {
      await api.submitSatisfaction({
        serviceRecordId: pendingSatisfaction.id,
        rating: satRating,
        feedbackText: satFeedback,
      });
    } catch {
      // Rating is already recorded; feedback is supplemental.
    }
    setSatPhase('thanks');
    setSatSubmitting(false);
  };

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const balanceReady = balanceStatus === 'ready' && !!balance;
  const balancePending = balanceStatus === 'loading';
  const balanceError = balanceStatus === 'error';
  const currentBalance = balanceReady ? Number(balance.currentBalance || 0) : 0;
  const hasBalance = balanceReady && currentBalance > 0;
  const nextDate = nextService ? parseDate(nextService.date) : null;
  const daysUntilNextService = nextService ? daysUntilEtDate(nextService.date) : null;
  const nextServiceReady = nextServiceStatus === 'ready';
  const nextDateLabel = nextServiceStatus === 'loading'
    ? 'Checking schedule'
    : nextServiceStatus === 'error'
      ? 'Schedule unavailable'
      : nextDate && !isNaN(nextDate)
        ? nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        : 'No visit scheduled';
  const balanceLabel = balancePending
    ? 'Checking balance'
    : balanceError
      ? 'Billing unavailable'
      : hasBalance ? 'Balance due' : 'Account current';
  const balanceValue = balancePending
    ? '...'
    : balanceError
      ? 'Call us'
      : `$${currentBalance.toFixed(2)}`;
  const billingSub = balancePending
    ? 'Checking...'
    : balanceError
      ? 'Tap to view'
      : hasBalance ? `$${currentBalance.toFixed(2)} due` : 'All current';
  const propertyLine = [
    (customer.property?.lawnType || '').replace(/\s*(Full Sun|Shade|Sun\/Shade)\s*/gi, '') || null,
    customer.property?.propertySqFt ? `${customer.property.propertySqFt.toLocaleString()} sq ft` : null,
    customer.property?.lotSqFt ? `${customer.property.lotSqFt.toLocaleString()} sq ft lot` : null,
  ].filter(Boolean).join(' · ');
  const renewalCredit = customer.memberSince
    ? Math.min(75, Math.round(((new Date() - parseDate(customer.memberSince)) / (1000 * 60 * 60 * 24 * 30)) * 6.25))
    : 0;
  const referralCredits = (referralStats?.totalReferrals || 0) * 25;
  const referralTotal = Number(referralStats?.totalEarned ?? referralCredits);
  const quickActions = [
    { icon: 'wrench', label: 'Request', sub: 'New service', action: () => onSwitchTab?.('request') },
    { icon: 'chat', label: 'Message', sub: 'Text the team', action: () => { window.location.href = 'sms:+19412975749'; } },
    { icon: 'card', label: hasBalance ? 'Pay now' : 'Billing', sub: billingSub, action: () => onSwitchTab?.('billing') },
    { icon: 'gift', label: 'Refer', sub: '$25 credit', action: () => onSwitchTab?.('refer') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '5px 10px', borderRadius: 999,
              background: tier ? `${tier.gradientFrom}22` : '#EEF6FF',
              color: B.blueDeeper, fontSize: 12, fontWeight: 800,
            }}>
              WaveGuard {customer.tier || 'Member'}
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Hi, {customer.firstName}.
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              {customer.address?.line1}
              {customer.address?.city ? `, ${customer.address.city}` : ''}
              {customer.address?.state ? `, ${customer.address.state}` : ''} {customer.address?.zip || ''}
            </div>
            {propertyLine && <div style={{ marginTop: 4, fontSize: 14, color: muted }}>{propertyLine}</div>}
          </div>
          <div style={{
            minWidth: compact ? '100%' : 180,
            padding: '14px 16px',
            borderRadius: 8,
            background: balanceReady ? (hasBalance ? '#FFF7ED' : '#F0FDF4') : '#F8FAFC',
            border: `1px solid ${balanceReady ? (hasBalance ? '#FED7AA' : '#BBF7D0') : '#E1E7EF'}`,
          }}>
            <div style={{ fontSize: 12, color: balanceReady ? (hasBalance ? '#9A3412' : '#047857') : muted, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {balanceLabel}
            </div>
            <div style={{ marginTop: 3, fontSize: 24, fontWeight: 800, color: B.blueDeeper }}>
              {balanceValue}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10, marginTop: 22 }}>
          {quickActions.map((item) => (
            <button key={item.label} type="button" onClick={item.action} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: '#F8FAFC',
              padding: 14,
              textAlign: 'left',
              cursor: 'pointer',
              minHeight: 78,
              fontFamily: FONTS.body,
            }}>
              <Icon name={item.icon} size={19} strokeWidth={1.8} />
              <div style={{ marginTop: 8, fontSize: 14, fontWeight: 800, color: B.blueDeeper }}>{item.label}</div>
              <div style={{ marginTop: 2, fontSize: 12, color: muted }}>{item.sub}</div>
            </button>
          ))}
        </div>
      </section>

      {pendingSatisfaction && !satDismissed && (
        <section style={{ ...card, padding: 18, borderColor: satPhase === 'rate' ? '#FED7AA' : '#BFDBFE' }}>
          {satPhase === 'rate' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: B.blueDeeper }}>How was your visit?</div>
                  <div style={{ marginTop: 2, fontSize: 14, color: muted }}>
                    {pendingSatisfaction.service_type || pendingSatisfaction.serviceType}
                    {pendingSatisfaction.technician_name || pendingSatisfaction.technicianName ? ` · ${pendingSatisfaction.technician_name || pendingSatisfaction.technicianName}` : ''}
                  </div>
                </div>
                <button type="button" onClick={() => setSatDismissed(true)} style={{
                  border: 'none', background: 'transparent', color: muted, cursor: 'pointer',
                  width: 34, height: 34, borderRadius: 8, fontSize: 20,
                }}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: 4, marginTop: 14 }}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => {
                  const active = n <= (satHover || satRating);
                  const color = n <= 3 ? B.red : n <= 7 ? B.orange : B.green;
                  return (
                    <button key={n} type="button" onMouseEnter={() => setSatHover(n)} onMouseLeave={() => setSatHover(0)} onClick={() => handleSatRating(n)} disabled={satSubmitting} style={{
                      height: 38, borderRadius: 8, border: 'none',
                      background: active ? color : '#F1F5F9',
                      color: active ? '#fff' : B.grayMid,
                      fontWeight: 800, cursor: satSubmitting ? 'wait' : 'pointer',
                    }}>{n}</button>
                  );
                })}
              </div>
            </>
          )}
          {satPhase === 'review' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: B.blueDeeper }}>Thanks for the {satRating}/10.</div>
              <div style={{ marginTop: 6, fontSize: 14, color: B.grayDark, lineHeight: 1.5 }}>
                A quick Google review helps neighbors find the {satOfficeName || 'Waves'} team.
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
                <a href={satReviewLink} target="_blank" rel="noopener noreferrer" style={{
                  ...BUTTON_BASE, textDecoration: 'none', background: B.blueDeeper, color: '#fff', padding: '10px 18px',
                  boxShadow: 'none', borderRadius: 8,
                }}>Open Google</a>
                <button type="button" onClick={() => setSatDismissed(true)} style={{
                  ...BUTTON_BASE, background: '#fff', color: B.blueDeeper, padding: '10px 18px',
                  boxShadow: 'none', border: '1px solid #E1E7EF', borderRadius: 8,
                }}>Done</button>
              </div>
            </div>
          )}
          {satPhase === 'feedback' && (
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: B.blueDeeper }}>Thanks for the feedback.</div>
              <textarea
                value={satFeedback}
                onChange={e => setSatFeedback(e.target.value)}
                placeholder="Anything we could do better?"
                rows={3}
                style={{
                  width: '100%', marginTop: 10, padding: 12, borderRadius: 8,
                  border: '1px solid #CBD5E1', fontSize: 14, fontFamily: FONTS.body,
                  resize: 'vertical',
                }}
              />
              <button type="button" onClick={handleSatFeedback} disabled={satSubmitting} style={{
                ...BUTTON_BASE, marginTop: 10, width: '100%', background: B.blueDeeper,
                color: '#fff', boxShadow: 'none', borderRadius: 8,
              }}>{satSubmitting ? 'Sending...' : 'Send feedback'}</button>
            </div>
          )}
          {satPhase === 'thanks' && (
            <div style={{ textAlign: 'center', color: B.blueDeeper, fontWeight: 800 }}>
              Thank you. We appreciate the note.
            </div>
          )}
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'minmax(0, 1.35fr) minmax(280px, .65fr)', gap: 16, alignItems: 'start' }}>
        <section style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: 20, borderBottom: '1px solid #E1E7EF', display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Next Visit</div>
              <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, color: B.blueDeeper }}>{nextDateLabel}</div>
              <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, color: B.navy }}>
                {nextService?.serviceType || 'Request service when you need us.'}
              </div>
              {nextService?.windowStart && (
                <div style={{ marginTop: 2, fontSize: 14, color: muted }}>
                  {formatTime(nextService.windowStart)} – {formatTime(nextService.windowEnd)}
                  {nextService.technician ? ` · ${nextService.technician}` : ''}
                </div>
              )}
            </div>
            {daysUntilNextService != null && (
              <div style={{ textAlign: 'center', minWidth: 76 }}>
                <div style={{ fontSize: 34, fontWeight: 850, color: B.blueDeeper, lineHeight: 1 }}>
                  {daysUntilNextService}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: muted, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em' }}>days</div>
              </div>
            )}
          </div>
          {nextService ? (
            <div style={{ padding: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {!nextService.customerConfirmed ? (
                <button type="button" onClick={() => {
                  api.confirmAppointment(nextService.id).then(() => {
                    setNextService({ ...nextService, customerConfirmed: true, status: 'confirmed' });
                  });
                }} style={{
                  ...BUTTON_BASE, background: B.blueDeeper, color: '#fff', boxShadow: 'none',
                  borderRadius: 8, padding: '11px 18px', fontSize: 14,
                }}>
                  Confirm Visit
                </button>
              ) : (
                <span style={{
                  padding: '11px 18px', borderRadius: 8, background: '#ECFDF5',
                  color: '#047857', fontSize: 14, fontWeight: 800,
                }}>Confirmed</span>
              )}
              <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${nextService.serviceType || 'service'} visit.`} style={{
                ...BUTTON_BASE, background: '#fff', color: B.blueDeeper, boxShadow: 'none',
                border: '1px solid #CBD5E1', borderRadius: 8, padding: '11px 18px',
                textDecoration: 'none', fontSize: 14,
              }}>Reschedule</a>
            </div>
          ) : nextServiceReady ? (
            <div style={{ padding: 20 }}>
              <button type="button" onClick={() => onSwitchTab?.('request')} style={{
                ...BUTTON_BASE, background: B.blueDeeper, color: '#fff', boxShadow: 'none',
                borderRadius: 8, padding: '11px 18px', fontSize: 14,
              }}>
                Request Service
              </button>
            </div>
          ) : (
            <div style={{ padding: 20, color: muted, fontSize: 14, lineHeight: 1.5 }}>
              {nextServiceStatus === 'loading'
                ? 'Checking your upcoming visits...'
                : 'We could not load your schedule right now.'}
            </div>
          )}
        </section>

        <section style={{ ...card, padding: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>At a glance</div>
          <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
            {[
              { label: 'Monthly rate', value: customer.monthlyRate ? `$${customer.monthlyRate}` : '—', sub: `${tier?.discount || '0%'} discount` },
              { label: 'Services YTD', value: stats?.servicesYTD ?? '—', sub: stats?.celsiusApplicationsThisYear != null ? `${stats.celsiusApplicationsThisYear} weed treatments` : 'completed visits' },
              { label: 'Member since', value: customer.memberSince ? fmtDate(customer.memberSince, { month: 'short', year: 'numeric' }) : '—', sub: 'active customer' },
            ].map(item => (
              <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'baseline', borderBottom: '1px solid #E1E7EF', paddingBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, color: muted }}>{item.label}</div>
                  <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 1 }}>{item.sub}</div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 850, color: B.blueDeeper }}>{item.value}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <ServiceTracker />

      {lastService && (
        <section style={{ ...card, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Last Visit</div>
              <div style={{ marginTop: 7, fontSize: 17, fontWeight: 800, color: B.blueDeeper }}>{lastService.type || lastService.serviceType}</div>
              <div style={{ marginTop: 2, fontSize: 14, color: muted }}>
                {fmtDate(lastService.date, { weekday: 'short', month: 'short', day: 'numeric' })} · {lastService.technician || 'Waves Team'}
              </div>
            </div>
            <span style={{ borderRadius: 999, background: '#ECFDF5', color: '#047857', fontSize: 12, fontWeight: 800, padding: '5px 9px' }}>Completed</span>
          </div>
          {(lastService.notes || lastService.technician_notes) && (
            <p style={{ margin: '12px 0 0', color: B.grayDark, fontSize: 14, lineHeight: 1.6 }}>
              {((lastService.notes || lastService.technician_notes) || '').slice(0, 220)}
              {((lastService.notes || lastService.technician_notes) || '').length > 220 ? '...' : ''}
            </p>
          )}
        </section>
      )}

      {!lawnHealth.loading && lawnHealth.hasLawnCare && lawnHealth.scores && lawnHealth.initialScores && (
        <LawnHealthCard
          scores={lawnHealth.scores}
          initialScores={lawnHealth.initialScores}
          photos={lawnHealth.photos}
          beforeAfter={lawnHealth.beforeAfter}
          trend={lawnHealth.trend}
          recommendations={lawnHealth.recommendations}
          seasonalContext={lawnHealth.seasonalContext}
          neighborBenchmark={lawnHealth.neighborBenchmark}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 16 }}>
        <section style={{ ...card, padding: 18 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: B.blueDeeper }}>WaveGuard Rewards</div>
          <div style={{ marginTop: 5, fontSize: 14, color: B.grayDark, lineHeight: 1.5 }}>
            ${renewalCredit} renewal credit · ${referralCredits} referral credits
          </div>
          <div style={{ marginTop: 10, fontSize: 22, fontWeight: 850, color: B.blueDeeper }}>${renewalCredit + referralCredits}</div>
        </section>
        <section style={{ ...card, padding: 18 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: B.blueDeeper }}>
            {referralStats?.totalReferrals ? `${referralStats.totalReferrals} referrals sent` : 'Give $25, get $25'}
          </div>
          <div style={{ marginTop: 5, fontSize: 14, color: B.grayDark, lineHeight: 1.5 }}>
            {referralStats?.totalReferrals
              ? `$${referralTotal} earned so far.`
              : 'Share Waves with a neighbor and you both get credit.'}
          </div>
          <button type="button" onClick={() => onSwitchTab?.('refer')} style={{
            ...BUTTON_BASE, marginTop: 12, background: '#fff', color: B.blueDeeper,
            boxShadow: 'none', border: '1px solid #CBD5E1', borderRadius: 8,
            padding: '10px 14px', fontSize: 14,
          }}>Open referrals</button>
        </section>
      </div>

      <MyRequestsCard />
    </div>
  );
}

// =========================================================================
// SERVICES TAB
// =========================================================================
function ServicesTab() {
  const compact = useIsMobile(760);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [typeFilter, setTypeFilter] = useState('All');
  const [yearFilter, setYearFilter] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [photoMap, setPhotoMap] = useState({});
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    api.getServices({ limit: 100 }).then(d => { setServices(d.services || []); setLoading(false); }).catch(console.error);
  }, []);

  const toggleExpand = (svc) => {
    const next = expanded === svc.id ? null : svc.id;
    setExpanded(next);
    if (next && svc.hasPhotos && !photoMap[svc.id]) {
      api.getService(svc.id)
        .then(d => setPhotoMap(prev => ({ ...prev, [svc.id]: d.photos || [] })))
        .catch(err => console.error('Failed to load service photos', err));
    }
  };

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 14,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  };
  const primaryButton = {
    ...BUTTON_BASE,
    background: B.blueDeeper,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };

  if (loading) {
    return (
      <div style={{ ...card, padding: 28, textAlign: 'center', color: muted }}>
        Loading service history...
      </div>
    );
  }

  // --- Helpers ---
  const classifyType = (type) => {
    if (!type) return 'Other';
    const t = type.toLowerCase();
    if (t.includes('lawn') || t.includes('fertiliz') || t.includes('weed') || t.includes('turf')) return 'Lawn Care';
    if (t.includes('mosquito')) return 'Mosquito';
    if (t.includes('pest') || t.includes('interior') || t.includes('exterior') || t.includes('roach') || t.includes('ant') || t.includes('spider') || t.includes('rodent')) return 'Pest Control';
    return 'Other';
  };

  const getStatus = (s) => {
    if (s.isCallback || s.is_callback) return 'Callback';
    if (s.status === 'rescheduled' || s.rescheduled) return 'Rescheduled';
    return 'Completed';
  };

  const statusBadge = (status) => {
    const styles = {
      Completed: { bg: '#F0FDF4', color: B.green, border: '#BBF7D0' },
      Callback: { bg: '#EEF6FF', color: B.wavesBlue, border: '#BFDBFE' },
      Rescheduled: { bg: subtle, color: muted, border: '#E1E7EF' },
    };
    const st = styles[status] || styles.Completed;
    return (
      <span style={{ fontSize: 12, padding: '5px 9px', borderRadius: 8, background: st.bg, color: st.color, border: `1px solid ${st.border}`, fontWeight: 850, whiteSpace: 'nowrap' }}>
        {status}
      </span>
    );
  };

  const aftercareTips = {
    'Lawn Care': 'Avoid mowing for 48 hours. Greening expected in 7-10 days.',
    'Pest Control': 'Keep windows closed for 2 hours. Normal insect activity may increase temporarily.',
    'Mosquito': 'Barrier effective for 21 days. Avoid watering treated foliage for 24 hours.',
  };

  // --- Filtering ---
  const filtered = services.filter(s => {
    const cat = classifyType(s.type);
    if (typeFilter !== 'All' && cat !== typeFilter) return false;
    if (yearFilter !== 'All') {
      const yr = parseDate(s.date).getFullYear();
      if (String(yr) !== yearFilter) return false;
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const haystack = [s.notes, s.type, s.technician].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // --- Aggregate stats ---
  const currentYear = new Date().getFullYear();
  const thisYearServices = services.filter(s => parseDate(s.date).getFullYear() === currentYear);
  const totalProducts = thisYearServices.reduce((sum, s) => sum + (s.products?.length || 0), 0);
  const uniqueTechs = new Set(thisYearServices.map(s => s.technician).filter(Boolean)).size;
  const avgMinutes = thisYearServices.length
    ? Math.round(thisYearServices.reduce((sum, s) => sum + (s.serviceTimeMinutes || 0), 0) / thisYearServices.filter(s => s.serviceTimeMinutes).length) || 0
    : 0;

  // --- Monthly grouping ---
  const grouped = {};
  filtered.forEach(s => {
    const dt = parseDate(s.date);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s);
  });
  const sortedMonths = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  // --- Visit numbering --- single pass: assign visit number, then fill totals via map lookup.
  const visitCounts = {};
  const sortedAll = [...services].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const visitKeys = new Array(sortedAll.length);
  sortedAll.forEach((s, idx) => {
    const cat = classifyType(s.type);
    const yr = parseDate(s.date).getFullYear();
    const k = `${cat}-${yr}`;
    visitKeys[idx] = k;
    visitCounts[k] = (visitCounts[k] || 0) + 1;
    s._visitNum = visitCounts[k];
  });
  sortedAll.forEach((s, idx) => { s._visitTotal = visitCounts[visitKeys[idx]]; });

  // --- Available years ---
  const years = [...new Set(services.map(s => parseDate(s.date).getFullYear()))].sort((a, b) => b - a);

  const thSt = { padding: '9px 10px', fontSize: 12, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em', color: muted, textAlign: 'left', borderBottom: '1px solid #E1E7EF', background: subtle };
  const tdSt = { padding: '10px', fontSize: 12, color: B.blueDeeper, borderBottom: '1px solid #EEF2F7', verticalAlign: 'top' };

  const pillStyle = (active) => ({
    padding: '7px 12px',
    borderRadius: 8,
    border: `1px solid ${active ? B.wavesBlue : '#CBD5E1'}`,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 850,
    fontFamily: FONTS.heading,
    background: active ? '#EEF6FF' : '#fff',
    color: active ? B.blueDeeper : muted,
    minHeight: 34,
  });

  const typeOptions = ['All', 'Pest Control', 'Lawn Care', 'Mosquito', 'Other'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ ...card, padding: compact ? 20 : 24 }}>
        <div style={sectionTitle}>Completed Visits</div>
        <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>
          Service reports and visit history
        </div>
        <div style={{ marginTop: 5, fontSize: 14, color: B.grayDark, lineHeight: 1.55 }}>
          What we applied, what we found, photos, and service reports for completed work.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10, marginTop: 18 }}>
          {[
            { val: thisYearServices.length, label: `${currentYear} visits` },
            { val: totalProducts, label: 'Products applied' },
            { val: uniqueTechs, label: 'Technicians' },
            { val: avgMinutes > 0 ? `${avgMinutes} min` : 'N/A', label: 'Avg visit' },
          ].map((stat) => (
            <div key={stat.label} style={{ padding: 12, borderRadius: 8, background: subtle, border: '1px solid #E1E7EF', minHeight: 70 }}>
              <div style={{ fontSize: 18, fontWeight: 850, color: B.blueDeeper, lineHeight: 1.1 }}>{stat.val}</div>
              <div style={{ marginTop: 5, fontSize: 12, color: muted, fontWeight: 800 }}>{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {typeOptions.map(t => (
              <button type="button" key={t} onClick={() => setTypeFilter(t)} style={pillStyle(typeFilter === t)}>{t}</button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {['All', ...years.map(String)].map(y => (
              <button type="button" key={y} onClick={() => setYearFilter(y)} style={pillStyle(yearFilter === y)}>{y}</button>
            ))}
            <input
              id="portal-service-history-search"
              name="serviceHistorySearch"
              type="search"
              placeholder="Search notes..."
              aria-label="Search service notes"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              style={{
                marginLeft: compact ? 0 : 'auto',
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
                fontFamily: FONTS.body,
                color: B.blueDeeper,
                background: '#fff',
                outline: 'none',
                minWidth: compact ? '100%' : 180,
                flex: compact ? '1 1 100%' : '0 1 220px',
              }}
            />
          </div>
        </div>
      </section>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div style={{ ...card, padding: 28, textAlign: 'center', color: muted, fontSize: 14 }}>
          {services.length === 0
            ? "We haven't logged any visits yet. Your service history will appear here after your first appointment."
            : 'No services match your filters. Try clearing the year or type filter above.'}
        </div>
      )}

      {/* 4. Monthly grouped list */}
      {sortedMonths.map(monthKey => {
        const monthServices = grouped[monthKey];
        const [yr, mo] = monthKey.split('-');
        const monthLabel = new Date(Number(yr), Number(mo) - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        return (
          <div key={monthKey}>
            {/* Month header */}
            <div style={{
              ...sectionTitle,
              padding: '2px 0 0',
              color: muted,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
            }}>
              <span>{monthLabel}</span>
              <span>{monthServices.length} visit{monthServices.length !== 1 ? 's' : ''}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {monthServices.map(s => {
                const status = getStatus(s);
                const cat = classifyType(s.type);
                const tip = aftercareTips[cat];
                return (
                  <div key={s.id} style={{
                    ...card,
                    overflow: 'hidden',
                    border: `1px solid ${expanded === s.id ? '#BFDBFE' : '#E1E7EF'}`,
                  }}>
                    {/* Header — always visible */}
                    <button type="button" onClick={() => toggleExpand(s)}
                      style={{ width: '100%', padding: '16px 18px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: compact ? 'wrap' : 'nowrap', border: 'none', background: '#fff', textAlign: 'left', fontFamily: FONTS.body }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 280px' }}>
                        <div style={{
                          width: 50, height: 50, borderRadius: 8,
                          background: subtle,
                          border: '1px solid #E1E7EF',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <div style={{ fontSize: 18, fontWeight: 850, color: B.blueDeeper, lineHeight: 1 }}>
                            {parseDate(s.date).getDate()}
                          </div>
                          <div style={{ fontSize: 10, fontWeight: 850, color: muted, textTransform: 'uppercase', marginTop: 2 }}>
                            {parseDate(s.date).toLocaleDateString('en-US', { month: 'short' })}
                          </div>
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 850, color: B.blueDeeper, lineHeight: 1.25 }}>
                            {s.type}
                            {s._visitNum && <span style={{ fontSize: 12, fontWeight: 600, color: B.grayMid, marginLeft: 6 }}>#{s._visitNum}{s._visitTotal ? ` of ${s._visitTotal}` : ''}</span>}
                          </div>
                          <div style={{ fontSize: 14, color: muted, marginTop: 3 }}>
                            {parseDate(s.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                            {s.technician ? ` - ${s.technician}` : ''}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: compact ? 62 : 0 }}>
                        {statusBadge(status)}
                        <Icon name="chevronDown" size={18} strokeWidth={2} style={{ color: muted, transform: expanded === s.id ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }} />
                      </div>
                    </button>

                    {/* Expanded detail — full service inspection report */}
                    {expanded === s.id && (
                      <div style={{ borderTop: '1px solid #E1E7EF' }}>

                        {/* Technician Notes — speech bubble at top */}
                        {s.notes && (
                          <div style={{ padding: '14px 18px', borderBottom: '1px solid #E1E7EF' }}>
                            <div style={{
                              padding: '12px 14px', borderRadius: 8,
                              background: subtle, border: '1px solid #E1E7EF',
                            }}>
                              <div style={{ fontSize: 12, fontWeight: 850, color: muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                {s.technician || 'Technician'} says:
                              </div>
                              <div style={{ fontSize: 15, color: B.blueDeeper, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{s.notes}</div>
                            </div>
                          </div>
                        )}

                        {/* Callback badge */}
                        {status === 'Callback' && (
                          <div style={{ padding: '0 18px 0', marginTop: -4 }}>
                            <div style={{
                              padding: '9px 12px', borderRadius: 8, background: '#EEF6FF',
                              border: '1px solid #BFDBFE', fontSize: 12, color: B.blueDeeper,
                              fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6,
                              marginBottom: 10,
                            }}>
                              <Icon name="refresh" size={16} strokeWidth={1.75} /> Callback — included with your WaveGuard Gold
                            </div>
                          </div>
                        )}

                        {/* Service Info Bar */}
                        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(4, 1fr)', gap: 8, padding: 18, borderBottom: '1px solid #E1E7EF', background: subtle }}>
                          {[
                            { label: 'Date', value: parseDate(s.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) },
                            { label: 'Technician', value: s.technician },
                            { label: 'Duration', value: s.serviceTimeMinutes ? `${s.serviceTimeMinutes} min` : '—' },
                            { label: 'Status', value: status },
                          ].map((item, i) => (
                            <div key={i} style={{ padding: 12, borderRadius: 8, border: '1px solid #E1E7EF', background: '#fff' }}>
                              <div style={{ fontSize: 12, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em', color: muted }}>{item.label}</div>
                              <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, marginTop: 4, wordBreak: 'break-word' }}>{item.value || 'N/A'}</div>
                            </div>
                          ))}
                        </div>

                        {/* Conditions */}
                        {(s.soilTemp || s.soilPh || s.thatchMeasurement || s.soilMoisture) && (
                          <div style={{ padding: '14px 18px', background: '#fff', borderBottom: '1px solid #E1E7EF' }}>
                            <div style={{ ...sectionTitle, marginBottom: 8 }}>Conditions & Measurements</div>
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                              {s.soilTemp && <div style={{ fontSize: 14, color: B.blueDeeper, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="thermometer" size={16} strokeWidth={1.75} /> Soil Temp: <strong>{s.soilTemp}F</strong></div>}
                              {s.soilPh && <div style={{ fontSize: 14, color: B.blueDeeper, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="flask" size={16} strokeWidth={1.75} /> pH: <strong>{s.soilPh}</strong></div>}
                              {s.thatchMeasurement && <div style={{ fontSize: 14, color: B.blueDeeper, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="ruler" size={16} strokeWidth={1.75} /> Thatch: <strong>{s.thatchMeasurement}"</strong></div>}
                              {s.soilMoisture && <div style={{ fontSize: 14, color: B.blueDeeper, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="droplet" size={16} strokeWidth={1.75} /> Moisture: <strong>{s.soilMoisture}</strong></div>}
                            </div>
                          </div>
                        )}

                        {/* Products Applied — full table */}
                        {s.products?.length > 0 && (
                          <div style={{ padding: '14px 18px', borderBottom: '1px solid #E1E7EF' }}>
                            <div style={{ ...sectionTitle, marginBottom: 10 }}>Products Applied</div>
                            <div style={{ overflowX: 'auto', border: '1px solid #E1E7EF', borderRadius: 8 }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                  <tr>
                                    <th style={thSt}>Product</th>
                                    <th style={thSt}>Active Ingredient</th>
                                    <th style={thSt}>Rate</th>
                                    <th style={thSt}>Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.products.map((p, i) => (
                                    <tr key={`${s.id}-${p.product_name || ''}-${p.active_ingredient || ''}-${i}`}>
                                      <td style={{ ...tdSt, fontWeight: 600 }}>
                                        {p.product_name}
                                        {p.product_category && <div style={{ fontSize: 10, color: B.grayMid, textTransform: 'capitalize', marginTop: 1 }}>{p.product_category}</div>}
                                      </td>
                                      <td style={{ ...tdSt, fontSize: 12, color: B.grayDark }}>
                                        {p.active_ingredient || '—'}
                                        {p.moa_group && <div style={{ fontSize: 10, color: B.grayMid }}>{p.moa_group}</div>}
                                      </td>
                                      <td style={{ ...tdSt, fontSize: 12 }}>{p.application_rate ? `${p.application_rate} ${p.rate_unit || ''}` : '—'}</td>
                                      <td style={{ ...tdSt, fontSize: 12 }}>{p.total_amount ? `${p.total_amount} ${p.amount_unit || ''}` : '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* What's Next — aftercare tips */}
                        {tip && (
                          <div style={{ padding: '14px 18px', background: '#F0FDF4', borderBottom: '1px solid #BBF7D0' }}>
                            <div style={{ ...sectionTitle, color: B.green, marginBottom: 6 }}>What's Next</div>
                            <div style={{ fontSize: 14, color: B.blueDeeper, lineHeight: 1.6 }}>{tip}</div>
                          </div>
                        )}

                        {/* Photos */}
                        {s.hasPhotos && (
                          <div style={{ padding: '14px 18px', borderBottom: '1px solid #E1E7EF' }}>
                            <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                              <Icon name="camera" size={16} strokeWidth={1.75} /> Service Photos ({s.photoCount})
                            </div>
                            {!photoMap[s.id] ? (
                              <div style={{ fontSize: 12, color: muted }}>Loading photos...</div>
                            ) : photoMap[s.id].length === 0 ? (
                              <div style={{ fontSize: 12, color: muted }}>No photos available.</div>
                            ) : (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                                {photoMap[s.id].map((p) => (
                                  <div key={p.id}
                                    onClick={() => setLightbox(p)}
                                    style={{
                                      position: 'relative', cursor: 'pointer', borderRadius: 8, overflow: 'hidden',
                                      border: '1px solid #E1E7EF', aspectRatio: '1 / 1', background: subtle,
                                    }}>
                                    <img src={p.url} alt={p.caption || p.type || 'service photo'}
                                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                    {p.type && (
                                      <div style={{
                                        position: 'absolute', top: 4, left: 4, padding: '2px 6px', borderRadius: 6,
                                        background: 'rgba(0,0,0,0.6)', color: B.white, fontSize: 9, fontWeight: 700,
                                        textTransform: 'uppercase', letterSpacing: 0.5,
                                      }}>{p.type}</div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Precautions */}
                        <div style={{ padding: '12px 18px', background: '#FFFBEB', borderBottom: '1px solid #FDE68A' }}>
                          <div style={{ fontSize: 12, color: '#92400E', lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <Icon name="warning" size={16} strokeWidth={1.75} /> Keep people and pets away from treated surfaces until dry. Do not contact treated surfaces until dry. For questions about products applied, contact us at (941) 297-5749.
                          </div>
                        </div>

                        {/* Footer with Download PDF */}
                        <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                          <div style={{ fontSize: 12, color: muted }}>Report generated automatically from service data</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <a
                              href={api.getServiceReportUrl(s.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                ...primaryButton, padding: '7px 12px', fontSize: 12,
                                textDecoration: 'none',
                                borderRadius: 8,
                              }}
                            >
                              <Icon name="document" size={16} strokeWidth={1.75} /> Download PDF
                            </a>
                            <div style={{ fontSize: 12, color: muted }}>Waves Pest Control · (941) 297-5749</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'pointer',
          }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ position: 'relative', maxWidth: '95vw', maxHeight: '95vh', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <img src={lightbox.url} alt={lightbox.caption || 'service photo'}
              style={{ maxWidth: '95vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 10, background: '#000' }} />
            {(lightbox.caption || lightbox.type) && (
              <div style={{ color: B.white, fontSize: 14, textAlign: 'center', maxWidth: 600 }}>
                {lightbox.type && <span style={{ textTransform: 'uppercase', fontWeight: 700, marginRight: 8, opacity: 0.8 }}>{lightbox.type}</span>}
                {lightbox.caption}
              </div>
            )}
            <button onClick={() => setLightbox(null)}
              style={{
                position: 'absolute', top: -10, right: -10, width: 36, height: 36, borderRadius: '50%',
                border: 'none', background: B.white, color: B.navy, fontSize: 18, fontWeight: 700, cursor: 'pointer',
              }}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// SCHEDULE TAB
// =========================================================================

// Treatment descriptions mapped by service type keyword
const SCHEDULE_TREATMENT_DESCRIPTIONS = {
  'Pest': [
    'Interior + exterior perimeter spray — general pest barrier',
    'Quarterly pest barrier renewal — interior baseboards + exterior foundation',
    'Seasonal pest inspection + preventive barrier treatment',
    'Full perimeter re-treatment + targeted interior applications',
  ],
  'Lawn': [
    'Spring green-up fertilizer + pre-emergent weed control',
    'Broadleaf weed treatment + slow-release nitrogen application',
    'Summer fertilizer + chinch bug preventive',
    'Fall fertilizer blend + winterizer prep',
    'Iron supplement + micro-nutrient foliar spray',
    'Weed management + turf health assessment',
  ],
  'Mosquito': [
    'Perimeter mist treatment — breeding site reduction + barrier spray',
    'Monthly barrier spray — foliage, fence lines, standing water areas',
    'Barrier re-application + larvicide in standing water zones',
  ],
  'Rodent': [
    'Bait station inspection + replenishment — exterior perimeter',
    'Rodent exclusion check + bait rotation',
  ],
  'Termite': [
    'Annual termite inspection + monitoring station check',
    'Sentricon station monitoring + bait replenishment',
  ],
};

function getScheduleVisitDescription(serviceType, visitNumber) {
  const num = visitNumber || 1;
  const key = Object.keys(SCHEDULE_TREATMENT_DESCRIPTIONS).find(k => (serviceType || '').toLowerCase().includes(k.toLowerCase()));
  if (!key) return 'Scheduled service visit — inspection + treatment';
  const descs = SCHEDULE_TREATMENT_DESCRIPTIONS[key];
  return descs[(num - 1) % descs.length];
}

function formatPhoneDisplay(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

function formatPropertyAddress(property) {
  const address = property?.address || {};
  const cityStateZip = [address.city, address.state, address.zip].filter(Boolean).join(' ');
  return [address.line1, cityStateZip].filter(Boolean).join(', ');
}

function ScheduleTab({ customer, properties = [], onRequestVisit }) {
  const compact = useIsMobile(760);
  const [upcoming, setUpcoming] = useState([]);
  const [prefs, setPrefs] = useState(null);
  const [propertyPrefs, setPropertyPrefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmTimestamps, setConfirmTimestamps] = useState({});
  const [confirmingIds, setConfirmingIds] = useState({});
  const [prefsLocked, setPrefsLocked] = useState({});

  useEffect(() => {
    Promise.all([
      api.getSchedule(90),
      api.getNotificationPrefs(),
      api.getPropertyNotificationPrefs().catch(() => ({ properties: [] })),
    ]).then(([schedData, prefsData, propertyPrefsData]) => {
      setUpcoming(schedData.upcoming || []);
      setPrefs(prefsData);
      setPropertyPrefs(propertyPrefsData.properties || []);
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleToggle = async (key) => {
    if (prefsLocked[key]) return;
    const newVal = !prefs[key];
    setPrefsLocked(prev => ({ ...prev, [key]: true }));
    setPrefs(prev => ({ ...prev, [key]: newVal }));
    try {
      await api.updateNotificationPrefs({ [key]: newVal });
    } catch (err) {
      setPrefs(prev => ({ ...prev, [key]: !newVal }));
      alert('Could not update notification preferences. Please try again.');
      console.error(err);
    } finally {
      setPrefsLocked(prev => ({ ...prev, [key]: false }));
    }
  };

  const handlePropertyPrefToggle = async (propertyId, key) => {
    const property = propertyPrefs.find(p => p.id === propertyId);
    if (!property || prefsLocked[`${propertyId}:${key}`]) return;
    const current = property.preferences?.[key] !== false;
    const newVal = !current;
    const lockKey = `${propertyId}:${key}`;
    setPrefsLocked(prev => ({ ...prev, [lockKey]: true }));
    setPropertyPrefs(prev => prev.map(p => (
      p.id === propertyId
        ? { ...p, preferences: { ...(p.preferences || {}), [key]: newVal } }
        : p
    )));
    try {
      const result = await api.updatePropertyNotificationPrefs(propertyId, { [key]: newVal });
      setPropertyPrefs(prev => prev.map(p => (
        p.id === propertyId
          ? { ...p, preferences: { ...(p.preferences || {}), ...(result.preferences || {}) } }
          : p
      )));
      if (propertyId === customer.id) {
        setPrefs(prev => ({ ...(prev || {}), ...(result.preferences || {}) }));
      }
    } catch (err) {
      setPropertyPrefs(prev => prev.map(p => (
        p.id === propertyId
          ? { ...p, preferences: { ...(p.preferences || {}), [key]: current } }
          : p
      )));
      alert('Could not update notification preferences. Please try again.');
      console.error(err);
    } finally {
      setPrefsLocked(prev => ({ ...prev, [lockKey]: false }));
    }
  };

  const handlePropertyContactChange = (propertyId, key, value) => {
    setPropertyPrefs(prev => prev.map(p => (
      p.id === propertyId
        ? { ...p, serviceContact: { ...(p.serviceContact || {}), [key]: value } }
        : p
    )));
  };

  const handlePropertyContactSave = async (propertyId) => {
    const property = propertyPrefs.find(p => p.id === propertyId);
    if (!property || prefsLocked[`${propertyId}:contact`]) return;
    const serviceContact = property.serviceContact || {};
    const savedContact = {
      firstName: serviceContact.firstName || '',
      lastName: serviceContact.lastName || '',
      phone: serviceContact.phone || '',
      email: serviceContact.email || '',
    };
    const lockKey = `${propertyId}:contact`;
    setPrefsLocked(prev => ({ ...prev, [lockKey]: true }));
    try {
      const result = await api.updatePropertyNotificationPrefs(propertyId, {
        serviceContact: savedContact,
      });
      setPropertyPrefs(prev => prev.map(p => (
        p.id === propertyId
          ? {
            ...p,
            preferences: { ...(p.preferences || {}), ...(result.preferences || {}) },
            serviceContact: result.serviceContact || savedContact,
          }
          : p
      )));
    } catch (err) {
      alert('Could not save the on-location contact. Please try again.');
      console.error(err);
    } finally {
      setPrefsLocked(prev => ({ ...prev, [lockKey]: false }));
    }
  };

  const handleConfirm = async (id) => {
    if (confirmingIds[id]) return;
    setConfirmingIds(prev => ({ ...prev, [id]: true }));
    try {
      await api.confirmAppointment(id);
      const ts = new Date();
      setConfirmTimestamps(prev => ({ ...prev, [id]: ts }));
      setUpcoming(prev => prev.map(s => s.id === id ? { ...s, status: 'confirmed', customerConfirmed: true } : s));
    } catch (err) {
      console.error(err);
      alert('Could not confirm this appointment. Refreshing latest status...');
      try {
        const fresh = await api.getSchedule(90);
        setUpcoming(fresh.upcoming || []);
      } catch (e) { console.error(e); }
    } finally {
      setConfirmingIds(prev => ({ ...prev, [id]: false }));
    }
  };

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  const formatConfirmTs = (ts) => {
    if (!ts) return '';
    return ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' +
      ts.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 14,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  };
  const primaryButton = {
    ...BUTTON_BASE,
    background: B.blueDeeper,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const secondaryButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };

  if (loading) {
    return (
      <div style={{ ...card, padding: 28, textAlign: 'center', color: muted }}>
        Loading schedule...
      </div>
    );
  }

  // Compute time-awareness for each service
  const now = new Date();
  const enriched = upcoming.map((s, idx) => {
    const svcDate = parseDate(s.date);
    const diffHrs = (svcDate - now) / (1000 * 60 * 60);
    const isToday = svcDate.toDateString() === now.toDateString();
    const isSoon = !isToday && diffHrs > 0 && diffHrs <= 48;
    const isTomorrow = isSoon;
    const isFuture = diffHrs > 48;
    const daysUntil = Math.max(0, Math.ceil(diffHrs / 24));
    const visitNum = s.visitNumber || (idx + 1);
    const description = getScheduleVisitDescription(s.serviceType, visitNum);
    return { ...s, svcDate, diffHrs, isToday, isTomorrow, isSoon, isFuture, daysUntil, visitNum, description };
  });

  // Split completed visits from upcoming
  const recentCompleted = (upcoming || [])
    .filter(s => s.status === 'completed')
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 2);
  const upcomingOnly = enriched.filter(s => s.diffHrs > -24 && s.status !== 'completed');

  // Empty state season info
  const currentMonth = now.getMonth();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const nextQuarterIdx = [3, 3, 3, 6, 6, 6, 9, 9, 9, 0, 0, 0][currentMonth];
  const nextQuarterName = monthNames[nextQuarterIdx > currentMonth ? nextQuarterIdx : (currentMonth + 3) % 12];
  const mosquitoResumes = (currentMonth >= 3 && currentMonth <= 9) ? null : 'April';

  // Pulsing dot animation
  const pulsingDotCss = `@keyframes schedPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.3); } }`;

  // Time TBD note helper
  const renderTimeTBD = (s) => {
    if (s.windowStart) return null;
    const prefTime = customer?.preferredTimeWindow;
    return (
      <div style={{ fontSize: 12, color: '#92400E', marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#FFFBEB', border: '1px solid #FDE68A' }}>
        {prefTime
          ? `We'll aim for your preferred ${prefTime.toLowerCase()} window`
          : "We'll confirm your time window 72 hours before this visit"}
      </div>
    );
  };

  // Confirm button with timestamp
  const renderConfirmBtn = (s, compact) => {
    const ts = confirmTimestamps[s.id];
    if (s.customerConfirmed || ts) {
      return (
        <span style={{
          flex: compact ? undefined : 1,
          padding: compact ? '7px 12px' : '10px 14px',
          borderRadius: 8, background: '#F0FDF4',
          color: B.green, border: '1px solid #BBF7D0', fontSize: 12, fontWeight: 850, textAlign: 'center',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <Icon name="check" size={16} strokeWidth={1.75} /> Confirmed{ts ? ` ${formatConfirmTs(ts)}` : ''}
        </span>
      );
    }
    const busy = !!confirmingIds[s.id];
    return (
      <button type="button" onClick={() => handleConfirm(s.id)} disabled={busy} style={{
        ...primaryButton, padding: compact ? '7px 12px' : '10px 14px', flex: compact ? undefined : 1,
        fontSize: 12,
        opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer',
      }}>{busy ? 'Confirming...' : <><Icon name="check" size={16} strokeWidth={1.75} /> Confirm</>}</button>
    );
  };

  // Featured card with full timeline (Today / Tomorrow-48hrs / first card)
  const renderFeaturedCard = (s) => {
    const isGreen = s.isToday;
    const isOrange = s.isSoon;
    const toneColor = isGreen ? B.green : isOrange ? B.orange : B.wavesBlue;
    const toneBg = isGreen ? '#F0FDF4' : isOrange ? '#FFF7ED' : '#EEF6FF';
    const toneBorder = isGreen ? '#BBF7D0' : isOrange ? '#FED7AA' : '#BFDBFE';

    return (
      <div key={s.id} style={{
        ...card,
        overflow: 'hidden',
        border: `1px solid ${toneBorder}`,
      }}>
        <div style={{
          background: toneBg, padding: '16px 18px', color: B.blueDeeper,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14,
          borderBottom: `1px solid ${toneBorder}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 34, height: 34, borderRadius: 8, background: '#fff',
              border: `1px solid ${toneBorder}`,
              color: toneColor, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              animation: isGreen ? 'schedPulse 2s ease-in-out infinite' : 'none',
              flexShrink: 0,
            }}>
              <Icon name={isGreen ? 'truck' : isOrange ? 'clock' : 'calendar'} size={18} strokeWidth={1.9} />
            </span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em', color: toneColor }}>
                {isGreen ? 'Service Today' : isOrange ? 'Service Tomorrow' : 'Next Up'}
              </div>
              <div style={{ marginTop: 3, fontSize: 18, fontWeight: 850, fontFamily: FONTS.heading, color: B.blueDeeper }}>
                {s.svcDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </div>
            </div>
          </div>
          {!isGreen && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 24, fontWeight: 850, fontFamily: FONTS.ui, color: B.blueDeeper }}>{s.daysUntil}</div>
              <div style={{ fontSize: 12, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 850 }}>{s.daysUntil === 1 ? 'day' : 'days'}</div>
            </div>
          )}
        </div>

        <div style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 16, fontWeight: 850, color: B.blueDeeper }}>{s.serviceType}</div>
          <div style={{ fontSize: 14, color: muted, marginTop: 3 }}>
            {s.windowStart ? `${formatTime(s.windowStart)} - ${formatTime(s.windowEnd)}` : 'Time TBD'}{s.technician ? ` - ${s.technician}` : ''}
          </div>

          {/* Service description */}
          <div style={{
            fontSize: 14, color: B.blueDeeper, marginTop: 10,
            padding: '10px 12px', borderRadius: 8,
            background: subtle, border: '1px solid #E1E7EF',
          }}>
            Visit #{s.visitNum} — {s.description}
          </div>
          {renderTimeTBD(s)}

          {/* Communication Timeline */}
          <div style={{
            marginTop: 14, padding: 12, borderRadius: 10,
            background: subtle, border: '1px solid #E1E7EF',
          }}>
            <div style={{ ...sectionTitle, marginBottom: 8 }}>
              You'll hear from us
            </div>
            {[
              { icon: 'smartphone', label: '72-hour SMS reminder', time: '3 days before your visit', done: s.diffHrs <= 72 },
              { icon: 'smartphone', label: '24-hour SMS reminder', time: 'Day before your visit', done: s.diffHrs <= 24 },
              { icon: 'truck', label: 'Tech en route', time: '~1 hour before arrival - live GPS', done: false, active: s.isToday },
              { icon: 'checkCircle', label: 'Service complete report', time: 'Products used + tech notes texted to you', done: false },
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: i < 3 ? 8 : 0 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                  background: step.done ? '#F0FDF4' : step.active ? '#FFF7ED' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: step.done ? B.green : step.active ? B.orange : muted,
                  border: `1px solid ${step.done ? '#BBF7D0' : step.active ? '#FED7AA' : '#E1E7EF'}`,
                }}><Icon name={step.icon} size={12} strokeWidth={2} /></div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 850, color: step.done ? B.green : step.active ? B.orange : B.blueDeeper }}>
                    {step.label} {step.done && ''}
                  </div>
                  <div style={{ fontSize: 12, color: muted }}>{step.time}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Confirm + Reschedule */}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            {renderConfirmBtn(s, false)}
            <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${s.serviceType} on ${s.svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. What's available?`} style={{
              ...secondaryButton, padding: '10px 14px', flex: 1, textDecoration: 'none',
              fontSize: 12,
            }}>Reschedule</a>
          </div>
        </div>
      </div>
    );
  };

  // Compact card for future (3+ days) services
  const renderCompactCard = (s) => (
    <div key={s.id} style={{
      ...card,
      padding: 16,
      display: 'flex', gap: 14, alignItems: 'center',
      flexWrap: compact ? 'wrap' : 'nowrap',
    }}>
      <div style={{
        minWidth: 52, height: 52, borderRadius: 8,
        background: subtle, border: '1px solid #E1E7EF',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: 18, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui, lineHeight: 1 }}>
          {s.svcDate.getDate()}
        </div>
        <div style={{ fontSize: 10, fontWeight: 850, color: muted, textTransform: 'uppercase', marginTop: 2 }}>
          {s.svcDate.toLocaleDateString('en-US', { month: 'short' })}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 850, color: B.blueDeeper }}>{s.serviceType}</div>
        <div style={{ fontSize: 14, color: muted, marginTop: 2 }}>
          {s.windowStart ? `${formatTime(s.windowStart)} - ${formatTime(s.windowEnd)}` : 'Time TBD'}{s.technician ? ` - ${s.technician}` : ''}
        </div>
        <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Visit #{s.visitNum} — {s.description}
        </div>
        {renderTimeTBD(s)}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: muted, fontWeight: 800 }}>In {s.daysUntil} {s.daysUntil === 1 ? 'day' : 'days'}</span>
          {renderConfirmBtn(s, true)}
          <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${s.serviceType} on ${s.svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. What's available?`} style={{
            ...secondaryButton, padding: '7px 12px', textDecoration: 'none',
            fontSize: 12,
          }}>Reschedule</a>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{pulsingDotCss}</style>

      <section style={{ ...card, padding: compact ? 20 : 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={sectionTitle}>Upcoming Visits</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>
              {upcomingOnly.length ? `${upcomingOnly.length} scheduled` : 'Nothing scheduled right now'}
            </div>
            <div style={{ marginTop: 5, fontSize: 14, color: B.grayDark, lineHeight: 1.55 }}>
              Appointment timing, confirmation status, reminders, and reschedule options.
            </div>
          </div>
          <button type="button" onClick={onRequestVisit} style={{ ...primaryButton, minHeight: 40, flexShrink: 0 }}>
            Request Visit
          </button>
        </div>
      </section>

      {/* Empty state */}
      {upcomingOnly.length === 0 && (
        <div style={{
          ...card,
          padding: 28,
          textAlign: 'center',
        }}>
          <div style={{ width: 42, height: 42, borderRadius: 8, margin: '0 auto 12px', background: subtle, border: '1px solid #E1E7EF', color: B.blueDeeper, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="leaf" size={20} strokeWidth={1.8} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.heading, marginBottom: 8 }}>No upcoming services scheduled</div>
          <div style={{ fontSize: 14, color: muted, lineHeight: 1.6 }}>
            Your next quarterly pest treatment will be in {nextQuarterName}.
            {mosquitoResumes && <><br />Your mosquito service resumes in {mosquitoResumes}.</>}
          </div>
          <button type="button" onClick={onRequestVisit} style={{
            ...primaryButton, marginTop: 16,
          }}>Request a Visit</button>
        </div>
      )}

      {/* Service cards — time-based rendering */}
      {upcomingOnly.map((s, idx) => {
        // Today or within 48hrs: full card with timeline
        if (s.isToday || s.isSoon) return renderFeaturedCard(s);
        // First card always gets featured treatment
        if (idx === 0) return renderFeaturedCard(s);
        // Future (3+ days): compact card
        return renderCompactCard(s);
      })}

      {/* Recent Completed Visits */}
      {recentCompleted.length > 0 && (
        <section style={{ ...card, padding: 16, marginTop: 4 }}>
          <div style={sectionTitle}>Recent Visits</div>
          {recentCompleted.map(s => {
            const sDate = parseDate(s.date);
            return (
              <div key={s.id} style={{
                background: subtle, borderRadius: 8, padding: '12px 14px', marginTop: 10,
                border: '1px solid #E1E7EF', display: 'flex', gap: 12, alignItems: 'center',
              }}>
                <div style={{
                  width: 9, height: 9, borderRadius: '50%', background: B.green, flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{s.serviceType}</div>
                    <div style={{ fontSize: 12, color: muted }}>
                      {sDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                    {s.technician}{s.productsApplied ? ` · ${s.productsApplied}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* Notification Preferences */}
      {prefs && (
        <section style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px', borderBottom: '1px solid #E1E7EF' }}>
            <div style={sectionTitle}>Reminder Settings</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Service notifications</div>
            <div style={{ marginTop: 4, fontSize: 14, color: muted }}>Messages sent to {formatPhoneDisplay(customer.phone)}</div>
          </div>
          <div style={{ padding: '4px 18px 12px' }}>
            {(() => {
              const items = [
                { key: 'appointmentConfirmation', label: 'New Appointment Confirmation', desc: 'Get a text when a visit is booked or rescheduled', icon: 'checkCircle', locked: false, defaultOn: true },
                { key: 'serviceReminder72h', label: '72-Hour Appointment Reminder', desc: 'Get a text 3 days before every visit', icon: 'smartphone', locked: false, defaultOn: true },
                { key: 'serviceReminder24h', label: '24-Hour Service Reminder', desc: 'Get a text the day before every visit', icon: 'smartphone', locked: false, defaultOn: true },
                { key: 'techEnRoute', label: 'Tech En Route Alert', desc: 'Know exactly when your tech is headed over — live GPS', icon: 'truck', locked: false, defaultOn: true },
                // Phase 2E: per-customer auto-flip opt-out. Distinct
                // from techEnRoute — that one fires when the tech taps
                // "En Route". This one fires automatically when the
                // tech's vehicle leaves the previous job. Default ON
                // (column DEFAULT TRUE); user can toggle off to skip
                // the auto-detected version while keeping the manual
                // tap-triggered text.
                { key: 'autoFlipEnRoute', label: 'Auto En Route from GPS', desc: "Send the en-route text the moment we detect your tech leaving the previous job", icon: 'truck', locked: false, defaultOn: true },
                { key: 'serviceCompleted', label: 'Service Complete Report', desc: 'Products applied, tech notes, and next steps', icon: 'checkCircle', locked: true },
                { key: 'billingReminder', label: 'Billing Reminder', desc: '3-day heads up before your monthly charge', icon: 'card', locked: false },
                { key: 'seasonalTips', label: 'Seasonal Lawn Tips', desc: 'Watering, mowing height, and care tips for SW Florida', icon: 'palm', locked: false },
              ];
              return items.map((p, i) => {
              const isOn = p.locked ? true : (prefs[p.key] !== undefined ? prefs[p.key] : (p.defaultOn || false));
              return (
                <div key={p.key} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 0',
                  borderBottom: i < items.length - 1 ? '1px solid #E1E7EF' : 'none',
                  gap: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                    <span style={{ width: 34, height: 34, borderRadius: 8, background: subtle, border: '1px solid #E1E7EF', color: B.blueDeeper, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon name={p.icon} size={18} strokeWidth={1.75} />
                    </span>
                    <div>
                      <div style={{ fontSize: 14, color: B.blueDeeper, fontWeight: 850 }}>{p.label}</div>
                      <div style={{ fontSize: 12, color: muted }}>{p.desc}</div>
                      {p.locked && (
                        <div style={{ fontSize: 10, color: B.orange, marginTop: 2, fontWeight: 800 }}>Required for service coordination</div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <div onClick={p.locked ? undefined : () => handleToggle(p.key)} style={{
                      width: 44, height: 24, borderRadius: 12,
                      cursor: p.locked ? 'default' : 'pointer',
                      background: isOn ? (p.locked ? B.green : B.blueDeeper) : '#CBD5E1',
                      position: 'relative', transition: 'background 0.3s',
                      opacity: p.locked ? 0.85 : 1,
                    }}>
                      <div style={{
                        position: 'absolute', top: 2, width: 20, height: 20,
                        borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                        left: isOn ? 22 : 2, transition: 'left 0.3s',
                      }} />
                    </div>
                    {p.locked && (
                      <span style={{ fontSize: 8, color: muted, textTransform: 'uppercase', letterSpacing: 0.3 }}>Locked</span>
                    )}
                  </div>
                </div>
              );
              });
            })()}
          </div>
        </section>
      )}

      {propertyPrefs.length > 1 && (
        <section style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px', borderBottom: '1px solid #E1E7EF' }}>
            <div style={sectionTitle}>Property Notifications</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Notifications by property</div>
            <div style={{ fontSize: 14, color: muted, marginTop: 4 }}>
              Choose which service texts each property receives.
            </div>
          </div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {propertyPrefs.map((property) => {
              const label = property.profileLabel || 'Service property';
              const address = formatPropertyAddress(property);
              const options = [
                { key: 'appointmentConfirmation', label: 'New appt' },
                { key: 'serviceReminder72h', label: '72 hr' },
                { key: 'serviceReminder24h', label: '24 hr' },
                { key: 'techEnRoute', label: 'En route' },
                { key: 'appointmentNotifyPrimary', label: 'Me too' },
              ];
              const contact = property.serviceContact || {};
              const contactLockKey = `${property.id}:contact`;
              return (
                <div key={property.id} style={{
                  border: '1px solid #E1E7EF',
                  borderRadius: 8,
                  padding: 14,
                  background: property.id === customer.id ? '#EEF6FF' : subtle,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{label}</div>
                      <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{address || 'No address on file'}</div>
                    </div>
                    {property.id === customer.id && (
                      <span style={{
                        fontSize: 10, fontWeight: 850, color: B.wavesBlue,
                        background: '#fff', border: `1px solid ${B.wavesBlue}22`,
                        borderRadius: 8, padding: '4px 8px', whiteSpace: 'nowrap',
                      }}>Current</span>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(86px, 1fr))', gap: 8 }}>
                    {options.map((option) => {
                      const on = property.preferences?.[option.key] !== false;
                      const lockKey = `${property.id}:${option.key}`;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          disabled={!!prefsLocked[lockKey]}
                          onClick={() => handlePropertyPrefToggle(property.id, option.key)}
                          style={{
                            border: `1px solid ${on ? B.wavesBlue : '#CBD5E1'}`,
                            borderRadius: 8,
                            padding: '9px 6px',
                            background: on ? '#fff' : B.white,
                            color: on ? B.blueDeeper : muted,
                            fontSize: 14,
                            fontWeight: 850,
                            cursor: prefsLocked[lockKey] ? 'wait' : 'pointer',
                            opacity: prefsLocked[lockKey] ? 0.6 : 1,
                          }}
                        >
                          {option.label}
                          <div style={{ fontSize: 12, marginTop: 2, color: on ? B.green : muted }}>{on ? 'On' : 'Off'}</div>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #E1E7EF' }}>
                    <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, marginBottom: 8 }}>On-location contact</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 8 }}>
                      <input
                        value={contact.firstName || ''}
                        onChange={(e) => handlePropertyContactChange(property.id, 'firstName', e.target.value)}
                        placeholder="First name"
                        style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #CBD5E1', fontSize: 14, color: B.blueDeeper, fontFamily: FONTS.body }}
                      />
                      <input
                        value={contact.lastName || ''}
                        onChange={(e) => handlePropertyContactChange(property.id, 'lastName', e.target.value)}
                        placeholder="Last name"
                        style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #CBD5E1', fontSize: 14, color: B.blueDeeper, fontFamily: FONTS.body }}
                      />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 10 }}>
                      <input
                        value={contact.phone || ''}
                        onChange={(e) => handlePropertyContactChange(property.id, 'phone', e.target.value)}
                        placeholder="Phone number"
                        inputMode="tel"
                        style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #CBD5E1', fontSize: 14, color: B.blueDeeper, fontFamily: FONTS.body }}
                      />
                      <input
                        value={contact.email || ''}
                        onChange={(e) => handlePropertyContactChange(property.id, 'email', e.target.value)}
                        placeholder="Email address"
                        inputMode="email"
                        style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #CBD5E1', fontSize: 14, color: B.blueDeeper, fontFamily: FONTS.body }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 14, color: muted, lineHeight: 1.4 }}>
                        This person receives appointment texts for this property. Turn on “Me too” to send those texts to you as well.
                      </div>
                      <button
                        type="button"
                        onClick={() => handlePropertyContactSave(property.id)}
                        disabled={!!prefsLocked[contactLockKey]}
                        style={{
                          ...BUTTON_BASE,
                          padding: '9px 14px',
                          background: B.blueDeeper,
                          color: '#fff',
                          fontSize: 14,
                          borderRadius: 8,
                          boxShadow: 'none',
                          flexShrink: 0,
                          opacity: prefsLocked[contactLockKey] ? 0.6 : 1,
                        }}
                      >
                        {prefsLocked[contactLockKey] ? 'Saving...' : 'Save contact'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// =========================================================================
// BILLING TAB
// =========================================================================
function loadStripeJs(publishableKey) {
  return new Promise((resolve) => {
    if (window.Stripe) return resolve(window.Stripe(publishableKey));
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => resolve(window.Stripe(publishableKey));
    document.head.appendChild(script);
  });
}

function BillingTab({ customer }) {
  const [payments, setPayments] = useState([]);
  const [balance, setBalance] = useState(null);
  const [cards, setCards] = useState([]);
  const [autopay, setAutopay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [yearFilter, setYearFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [billingEmail, setBillingEmail] = useState('');
  const [paymentSmsEnabled, setPaymentSmsEnabled] = useState(true);
  const [billingPrefsSaving, setBillingPrefsSaving] = useState(false);
  const compact = useIsMobile(760);

  // Stripe card management state
  const [showAddCard, setShowAddCard] = useState(false);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState('');
  const [stripeReady, setStripeReady] = useState(false);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const paymentElementRef = useRef(null);
  const cardMountRef = useRef(null);

  const refreshCards = () => api.getCards().then(d => setCards(d.cards)).catch(console.error);

  useEffect(() => {
    Promise.all([
      api.getPayments(),
      api.getBalance(),
      api.getCards(),
      api.getNotificationPrefs(),
      api.getAutopay().catch(() => ({ state: 'unknown', loadError: true })),
    ])
      .then(([payData, balData, cardData, prefsData, autopayData]) => {
        setPayments(payData.payments); setBalance(balData); setCards(cardData.cards);
        setAutopay(autopayData);
        if (prefsData) {
          setBillingEmail(prefsData.billingEmail || '');
          setPaymentSmsEnabled(prefsData.paymentConfirmationSms !== false);
        }
        setLoading(false);
      }).catch(console.error);
  }, []);

  const handleAddCard = async () => {
    setStripeLoading(true);
    setStripeError('');
    setStripeReady(false);
    try {
      const setupData = await api.createSetupIntent('card');
      const stripe = await loadStripeJs(setupData.publishableKey);
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: setupData.clientSecret, appearance: { theme: 'stripe' } });
      elementsRef.current = elements;
      setShowAddCard(true);
      // Mount after modal renders
      setTimeout(() => {
        if (cardMountRef.current) {
          const pe = elements.create('payment', {
            layout: { type: 'tabs' },
            paymentMethodOrder: ['us_bank_account', 'card', 'apple_pay', 'google_pay'],
          });
          pe.mount(cardMountRef.current);
          paymentElementRef.current = pe;
          pe.on('ready', () => setStripeReady(true));
        }
      }, 100);
    } catch (err) {
      setStripeError(err.message || 'Failed to initialize payment form');
    }
    setStripeLoading(false);
  };

  const handleConfirmCard = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setStripeLoading(true);
    setStripeError('');
    try {
      const { error, setupIntent } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        redirect: 'if_required',
      });
      if (error) {
        setStripeError(error.message);
        setStripeLoading(false);
        return;
      }
      if (setupIntent && setupIntent.payment_method) {
        await api.saveStripeCard(setupIntent.payment_method);
      }
      setShowAddCard(false);
      paymentElementRef.current = null;
      elementsRef.current = null;
      stripeRef.current = null;
      await refreshCards();
    } catch (err) {
      setStripeError(err.message || 'Failed to save card');
    }
    setStripeLoading(false);
  };

  const handleRemoveCard = async (cardId) => {
    if (!window.confirm('Remove this payment method?')) return;
    try {
      await api.removeCard(cardId);
      await refreshCards();
    } catch (err) {
      alert(err.message || 'Failed to remove card');
    }
  };

  const handleSetDefault = async (cardId) => {
    try {
      await api.setDefaultCard(cardId);
      await refreshCards();
    } catch (err) {
      alert(err.message || 'Failed to set default card');
    }
  };

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 14,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  };
  const primaryButton = {
    ...BUTTON_BASE,
    background: B.blueDeeper,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const secondaryButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const money = (n, digits = 2) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const methodLast4 = (method) => method?.lastFour || method?.last4 || '';
  const methodLabel = (method) => {
    if (!method) return 'No method on file';
    const last4 = methodLast4(method);
    if (method.methodType === 'ach') return `${method.bankName || 'Bank account'}${last4 ? ` ending in ${last4}` : ''}`;
    return `${method.brand || 'Card'}${last4 ? ` ending in ${last4}` : ''}`;
  };

  if (loading) {
    return (
      <div style={{ ...card, padding: 28, textAlign: 'center', color: muted }}>
        Loading billing...
      </div>
    );
  }

  // Compute upcoming auto-pay info
  const nextCharge = balance?.nextCharge;
  const autopayState = autopay?.state || (autopay?.autopay_enabled ? 'active' : 'unknown');
  const amountDue = Number(autopayState === 'active'
    ? (autopay?.next_charge_amount ?? autopay?.monthly_rate ?? 0)
    : (nextCharge?.amount ?? balance?.currentBalance ?? customer?.monthlyRate ?? 0));
  const dueDate = autopayState === 'active'
    ? (autopay?.next_charge_date ? parseDate(autopay.next_charge_date) : null)
    : nextCharge?.date ? parseDate(nextCharge.date) : balance?.dueDate ? parseDate(balance.dueDate) : null;
  const daysUntilDue = dueDate ? Math.max(0, Math.ceil((dueDate - parseDate(etDateString())) / 86400000)) : null;
  const dueDateLabel = dueDate && !isNaN(dueDate)
    ? dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'Not scheduled';
  const defaultCard = cards.find(c => c.isDefault) || cards[0];
  const lastPaymentFailed = balance?.lastPaymentFailed || false;
  const tierName = customer?.tier || 'Bronze';
  const tier = TIER[tierName];
  const monthlyRate = customer?.monthlyRate || 0;
  const numServices = TIER_SERVICES[tierName] || 1;
  const discount = TIER_DISCOUNTS[tierName] || 0;

  // Card expiry check — within 60 days
  const cardExpiringSoon = (() => {
    if (!defaultCard) return null;
    const now = new Date();
    const expDate = new Date(defaultCard.expYear, defaultCard.expMonth, 0); // last day of exp month
    const diffMs = expDate - now;
    const diffDays = Math.ceil(diffMs / 86400000);
    if (diffDays > 0 && diffDays <= 60) {
      const months = Math.ceil(diffDays / 30);
      return { last4: defaultCard.lastFour, months };
    }
    return null;
  })();

  // Banner state: red (failed) > amber (expiring) > green (all good)
  const bannerState = lastPaymentFailed
    ? 'failed'
    : cardExpiringSoon
      ? 'expiring'
      : autopayState === 'active'
        ? 'active'
        : autopayState === 'paused'
          ? 'paused'
          : autopayState === 'disabled'
            ? 'disabled'
            : 'unknown';
  const bannerConfig = {
    failed: {
      bg: `${B.red}10`, border: `${B.red}33`, icon: 'warning',
      badge: 'Action needed', titleColor: B.red, subtitleColor: B.grayDark,
      title: 'Payment failed - update your payment method',
      detail: 'Your last payment could not be processed. Update your card to avoid service interruption.',
    },
    expiring: {
      bg: `${B.orange}10`, border: `${B.orange}33`, icon: 'warning',
      badge: 'Card expiring', titleColor: B.orange, subtitleColor: B.grayDark,
      title: `Card ending in ${cardExpiringSoon?.last4 || ''} expires in ${cardExpiringSoon?.months || 0} month${cardExpiringSoon?.months === 1 ? '' : 's'}`,
      detail: 'Update your payment method to avoid any disruption to service.',
    },
    active: {
      bg: '#F0FDF4', border: '#BBF7D0', icon: 'check',
      badge: 'Auto Pay active', titleColor: B.green, subtitleColor: B.grayDark,
      title: daysUntilDue === 0
        ? 'Auto Pay is processing today'
        : `Next charge ${money(amountDue)} on ${dueDateLabel}`,
      detail: daysUntilDue === 0
        ? `Amount: ${money(amountDue)}`
        : `Amount due ${money(amountDue)}${dueDate ? ` - due ${dueDateLabel}` : ''}`,
    },
    paused: {
      bg: `${B.orange}10`, border: `${B.orange}33`, icon: 'clock',
      badge: 'Auto Pay paused', titleColor: B.orange, subtitleColor: B.grayDark,
      title: 'Auto Pay is paused',
      detail: autopay?.paused_until
        ? `Automatic charges resume after ${parseDate(autopay.paused_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`
        : 'Automatic charges are paused until you resume Auto Pay.',
    },
    disabled: {
      bg: subtle, border: '#E1E7EF', icon: 'card',
      badge: 'Auto Pay off', titleColor: B.blueDeeper, subtitleColor: B.grayDark,
      title: 'Auto Pay is off',
      detail: balance?.currentBalance > 0
        ? `Balance due: ${money(balance.currentBalance)}. Add or enable Auto Pay below to run future charges automatically.`
        : 'Charges will not run automatically unless you enable Auto Pay below.',
    },
    unknown: {
      bg: subtle, border: '#E1E7EF', icon: 'alert',
      badge: 'Status unavailable', titleColor: B.blueDeeper, subtitleColor: B.grayDark,
      title: 'Auto Pay status unavailable',
      detail: 'We could not load your Auto Pay status. Your saved settings have not been changed.',
    },
  }[bannerState];

  // Payment status badge helper
  const statusBadge = (status) => {
    const map = {
      paid: { bg: `${B.green}20`, color: B.green },
      upcoming: { bg: `${B.orange}20`, color: B.orange },
      processing: { bg: B.blueSurface, color: B.wavesBlue },
      failed: { bg: `${B.red}20`, color: B.red },
      refunded: { bg: B.offWhite, color: B.grayMid },
    };
    const s = map[status] || map.paid;
    return { background: s.bg, color: s.color };
  };

  // Year-to-date summary
  const currentYear = parseDate(etDateString()).getFullYear();
  const ytdPayments = payments.filter(p => {
    const yr = parseDate(p.date).getFullYear();
    return yr === currentYear && p.status === 'paid';
  });
  const ytdTotal = ytdPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const ytdRecurring = ytdPayments.filter(p => p.type === 'recurring').reduce((sum, p) => sum + (p.amount || 0), 0);
  const ytdOneTime = ytdPayments.filter(p => p.type === 'one_time').reduce((sum, p) => sum + (p.amount || 0), 0);
  const paymentYears = Array.from(new Set([
    currentYear,
    ...payments.map(p => parseDate(p.date).getFullYear()).filter(Number.isFinite),
  ])).sort((a, b) => b - a).map(String);

  // Filtered payments
  const filteredPayments = payments.filter(p => {
    const yr = parseDate(p.date).getFullYear();
    if (yearFilter !== 'All' && yr !== parseInt(yearFilter)) return false;
    if (typeFilter === 'Recurring' && p.type !== 'recurring') return false;
    if (typeFilter === 'One-Time' && p.type !== 'one_time') return false;
    return true;
  });

  // Credits
  const credits = customer?.credits || [];
  const referralCredits = credits.filter(c => c.type === 'referral');
  const serviceCredits = credits.filter(c => c.type === 'service');
  const promoCredits = credits.filter(c => c.type === 'promo');
  const totalCredits = credits.reduce((sum, c) => sum + (c.amount || 0), 0);

  // WaveGuard membership — services & upsell
  const includedServices = SERVICE_CATALOG.slice(0, numServices);
  const totalFullPrice = includedServices.reduce((sum, s) => sum + s.basePrice * 12, 0);
  const annualSavings = totalFullPrice * discount;
  const platinumDiscount = TIER_DISCOUNTS.Platinum || 0.20;
  const platinumSavings = totalFullPrice * platinumDiscount;
  const additionalSavings = platinumSavings - annualSavings;

  const currentBalance = Number(balance?.currentBalance || 0);
  const balanceState = currentBalance > 0 ? 'Balance due' : 'Current';
  const balanceTone = currentBalance > 0 ? B.orange : B.green;
  const autopayLabel = bannerConfig.badge;
  const defaultMethodLabel = methodLabel(defaultCard);
  const historyDescription = filteredPayments.length === payments.length
    ? `${payments.length} total payment${payments.length === 1 ? '' : 's'}`
    : `${filteredPayments.length} of ${payments.length} payment${payments.length === 1 ? '' : 's'}`;

  // Segmented filter helper
  const PillFilter = ({ options, value, onChange }) => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          style={{
            padding: '7px 12px',
            borderRadius: 8,
            border: `1px solid ${value === opt ? B.wavesBlue : '#CBD5E1'}`,
            background: value === opt ? '#EEF6FF' : '#fff',
            color: value === opt ? B.blueDeeper : muted,
            fontSize: 12,
            fontWeight: 800,
            cursor: 'pointer',
            fontFamily: FONTS.heading,
            minHeight: 34,
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );

  const saveBillingPrefs = () => {
    setBillingPrefsSaving(true);
    api.updateNotificationPrefs({ billingEmail: billingEmail || '', paymentConfirmationSms: paymentSmsEnabled })
      .then(() => setBillingPrefsSaving(false))
      .catch(() => setBillingPrefsSaving(false));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              borderRadius: 999,
              background: tier ? `${tier.color}18` : '#EEF6FF',
              color: B.blueDeeper,
              fontSize: 12,
              fontWeight: 850,
            }}>
              WaveGuard {tierName}
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Billing
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              Payment methods, Auto Pay, receipts, and billing preferences.
            </div>
          </div>
          <div style={{
            minWidth: compact ? '100%' : 190,
            padding: '14px 16px',
            borderRadius: 8,
            background: currentBalance > 0 ? `${B.orange}10` : '#F0FDF4',
            border: `1px solid ${currentBalance > 0 ? `${B.orange}33` : '#BBF7D0'}`,
            boxSizing: 'border-box',
          }}>
            <div style={{ fontSize: 12, color: balanceTone, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {balanceState}
            </div>
            <div style={{ marginTop: 3, fontSize: 24, fontWeight: 850, color: B.blueDeeper }}>
              {money(currentBalance)}
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: muted }}>
              {dueDate && currentBalance > 0 ? `Due ${dueDateLabel}` : 'Account balance'}
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: 10,
          marginTop: 22,
        }}>
          {[
            { label: 'Auto Pay', value: autopayLabel, sub: autopayState === 'active' ? `Next ${dueDateLabel}` : 'Manage below' },
            { label: 'Default method', value: defaultMethodLabel, sub: cards.length ? `${cards.length} saved` : 'None saved' },
            { label: 'Monthly plan', value: money(monthlyRate), sub: `WaveGuard ${tierName}` },
            { label: `${currentYear} paid`, value: money(ytdTotal), sub: `${ytdPayments.length} payment${ytdPayments.length === 1 ? '' : 's'}` },
          ].map((item) => (
            <div key={item.label} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: subtle,
              padding: 14,
              minHeight: 74,
            }}>
              <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>{item.label}</div>
              <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 16, fontWeight: 850, lineHeight: 1.15 }}>{item.value}</div>
              <div style={{ marginTop: 3, color: muted, fontSize: 12 }}>{item.sub}</div>
            </div>
          ))}
        </div>
      </section>

      <div style={{
        background: bannerConfig.bg,
        borderRadius: 8,
        padding: 16,
        border: `1px solid ${bannerConfig.border}`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}>
        <div style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: '#fff',
          color: bannerConfig.titleColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          border: `1px solid ${bannerConfig.border}`,
        }}>
          <Icon name={bannerConfig.icon} size={18} strokeWidth={2} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: bannerConfig.titleColor, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {bannerConfig.badge}
          </div>
          <div style={{ marginTop: 3, fontSize: 15, fontWeight: 850, color: B.blueDeeper, lineHeight: 1.3 }}>
            {bannerConfig.title}
          </div>
          <div style={{ fontSize: 14, color: bannerConfig.subtitleColor, marginTop: 3, lineHeight: 1.45 }}>
            {bannerConfig.detail}
          </div>
        </div>
      </div>

      <AutopayCard onStateChange={setAutopay} />

      <div style={{
        ...card,
        padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={sectionTitle}>Plan Charges</div>
            <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 20, fontWeight: 850 }}>
              WaveGuard {tierName}
            </div>
          </div>
          <span style={{
            fontSize: 18,
            fontWeight: 850,
            color: B.blueDeeper,
            fontFamily: FONTS.ui,
          }}>{money(monthlyRate)}/mo</span>
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
          {includedServices.map(svc => (
            <div key={svc.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              background: subtle,
              border: '1px solid #E1E7EF',
              fontSize: 14,
              color: B.grayDark,
            }}>
              <Icon name={svc.icon} size={16} strokeWidth={1.8} style={{ color: B.blueDeeper }} />
              <span style={{ minWidth: 0, flex: 1 }}>{svc.name}</span>
              {discount > 0 && (
                <span style={{ fontSize: 14, color: B.green, fontWeight: 850, whiteSpace: 'nowrap' }}>
                  {money(svc.basePrice * (1 - discount), 0)}/mo
                </span>
              )}
            </div>
          ))}
        </div>
        {annualSavings > 0 && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, fontSize: 14, color: B.green, fontWeight: 850 }}>
            Saving {money(annualSavings, 0)}/year with your {tierName} bundle
          </div>
        )}
        {tierName !== 'Platinum' && additionalSavings > 0 && (
          <div style={{ marginTop: 10, fontSize: 14, color: muted, fontWeight: 700 }}>
            Platinum would add {money(additionalSavings, 0)}/year in bundle savings.
          </div>
        )}
      </div>

      <div style={{ ...card, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={sectionTitle}>Payment Methods</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Saved methods</div>
          </div>
          <button
            type="button"
            onClick={handleAddCard}
            disabled={stripeLoading}
            style={{ ...secondaryButton, opacity: stripeLoading ? 0.6 : 1, cursor: stripeLoading ? 'wait' : 'pointer' }}
          >
            <Icon name="plus" size={15} strokeWidth={2} style={{ marginRight: 6 }} />
            {stripeLoading && !showAddCard ? 'Loading...' : 'Add method'}
          </button>
        </div>

        {cards.map(c => (
          <div key={c.id} style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
            background: subtle, borderRadius: 8, marginBottom: 8, border: '1px solid #E1E7EF',
            flexWrap: 'wrap',
          }}>
            <div style={{
              width: 48, height: 32, borderRadius: 6,
              background: B.blueDeeper,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: 1, fontFamily: FONTS.ui,
            }}>{c.brand || 'CARD'}</div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{methodLabel(c)}</div>
              {c.expMonth && <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>Expires {c.expMonth}/{c.expYear}</div>}
              {c.methodType === 'ach' && c.bankName && <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{c.bankName}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {c.isDefault ? (
                <span style={{ fontSize: 12, fontWeight: 850, color: B.green, background: '#F0FDF4', padding: '5px 9px', borderRadius: 8, border: '1px solid #BBF7D0' }}>Default</span>
              ) : (
                <button type="button" onClick={() => handleSetDefault(c.id)} style={{ ...secondaryButton, padding: '8px 10px', fontSize: 12 }}>Set default</button>
              )}
              <button type="button" onClick={() => handleRemoveCard(c.id)} style={{ ...secondaryButton, padding: '8px 10px', fontSize: 12, color: B.red }}>Remove</button>
            </div>
          </div>
        ))}

        {cards.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: muted, fontSize: 14, background: subtle, borderRadius: 8, border: '1px solid #E1E7EF' }}>
            No payment methods on file. Add a card to enable Auto Pay.
          </div>
        )}

        {stripeError && !showAddCard && (
          <div style={{ padding: 10, background: `${B.red}10`, border: `1px solid ${B.red}33`, borderRadius: 8, fontSize: 14, color: B.red, marginTop: 8 }}>
            {stripeError}
          </div>
        )}
      </div>

      {/* ── Stripe Add Card Modal ── */}
      {showAddCard && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999, padding: 20,
        }} onClick={(e) => { if (e.target === e.currentTarget) { setShowAddCard(false); paymentElementRef.current = null; elementsRef.current = null; } }}>
          <div style={{
            background: '#fff', borderRadius: 8, padding: 24, width: '100%', maxWidth: 460,
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            border: '1px solid #E1E7EF',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.heading }}>Add Payment Method</div>
              <button type="button" aria-label="Close" onClick={() => { setShowAddCard(false); paymentElementRef.current = null; elementsRef.current = null; }} style={{
                background: 'transparent', border: 'none', cursor: 'pointer', color: muted, lineHeight: 1,
                width: 36, height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}><Icon name="close" size={20} strokeWidth={2} /></button>
            </div>
            <div ref={cardMountRef} style={{ minHeight: 120, marginBottom: 16 }} />
            {stripeError && (
              <div style={{ padding: 10, background: `${B.red}10`, border: `1px solid ${B.red}33`, borderRadius: 8, fontSize: 14, color: B.red, marginBottom: 12 }}>
                {stripeError}
              </div>
            )}
            {/* Save-card authorization — locked because saving is the
                purpose of this modal. Shown so the consent record
                reflects the copy the customer saw. */}
            <div style={{ marginBottom: 12 }}>
              <SaveCardConsent locked onChange={() => {}} />
            </div>
            <button onClick={handleConfirmCard} disabled={stripeLoading || !stripeReady} style={{
              ...primaryButton,
              width: '100%',
              padding: 14,
              background: stripeReady ? B.blueDeeper : B.grayLight,
              color: stripeReady ? '#fff' : B.grayMid,
              opacity: stripeLoading ? 0.6 : 1,
              cursor: stripeLoading || !stripeReady ? 'not-allowed' : 'pointer',
            }}>{stripeLoading ? 'Saving...' : 'Save Card'}</button>
            <div style={{ fontSize: 12, color: muted, marginTop: 10, textAlign: 'center' }}>
              Secured by Stripe. We never store your card details directly.
            </div>
          </div>
        </div>
      )}

      {(totalCredits > 0 || credits.length > 0) && (
        <div style={{ ...card, padding: 20 }}>
          <div style={sectionTitle}>Credits</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper, marginBottom: 14 }}>Adjustments</div>
          {totalCredits > 0 && (
            <div style={{
              padding: '10px 14px',
              background: '#F0FDF4',
              border: '1px solid #BBF7D0',
              borderRadius: 8,
              marginBottom: 12,
              fontSize: 14,
              fontWeight: 850,
              color: B.green,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
            }}>
              <span>Total Account Credit</span>
              <span>{money(totalCredits)}</span>
            </div>
          )}
          {[
            { label: 'Referral Credits', items: referralCredits, icon: 'hand' },
            { label: 'Service Credits', items: serviceCredits, icon: 'wrench' },
            { label: 'Promo Credits', items: promoCredits, icon: 'party' },
          ].filter(g => g.items.length > 0).map(group => (
            <div key={group.label} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 850, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name={group.icon} size={12} strokeWidth={2} /> {group.label}
              </div>
              {group.items.map((cr, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', background: subtle, borderRadius: 8, marginBottom: 4, border: '1px solid #E1E7EF',
                }}>
                  <span style={{ fontSize: 14, color: B.grayDark }}>{cr.description || group.label}</span>
                  <span style={{ fontSize: 14, fontWeight: 850, color: B.green, fontFamily: FONTS.ui }}>{money(cr.amount || 0)}</span>
                </div>
              ))}
            </div>
          ))}
          {credits.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: muted, fontSize: 14 }}>No credits on your account</div>
          )}
        </div>
      )}

      <div style={{ ...card, padding: 20 }}>
        <div style={sectionTitle}>{currentYear} Summary</div>
        <div style={{ marginTop: 8, fontSize: 28, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>
          {money(ytdTotal)}
        </div>
        <div style={{ fontSize: 14, color: muted, marginTop: 4 }}>
          Across {ytdPayments.length} payment{ytdPayments.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 10, marginTop: 14 }}>
          <div style={{ padding: 12, background: subtle, border: '1px solid #E1E7EF', borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>WaveGuard {tierName}</div>
            <div style={{ marginTop: 5, color: B.blueDeeper, fontSize: 18, fontWeight: 850 }}>{money(ytdRecurring)}</div>
          </div>
          <div style={{ padding: 12, background: subtle, border: '1px solid #E1E7EF', borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>One-time services</div>
            <div style={{ marginTop: 5, color: B.blueDeeper, fontSize: 18, fontWeight: 850 }}>{money(ytdOneTime)}</div>
          </div>
        </div>
      </div>

      <div style={{ ...card, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <div style={sectionTitle}>Payment History</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>{historyDescription}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 850, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Year</span>
            <PillFilter options={[...paymentYears, 'All']} value={yearFilter} onChange={setYearFilter} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 850, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Type</span>
            <PillFilter options={['All', 'Recurring', 'One-Time']} value={typeFilter} onChange={setTypeFilter} />
          </div>
        </div>

        {filteredPayments.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: muted, fontSize: 14 }}>No payments match your filters</div>
        )}
        {filteredPayments.map(p => (
          <div key={p.id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            gap: 12,
            padding: '14px 0',
            borderBottom: `1px solid #E1E7EF`,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{p.description}</div>
              <div style={{ fontSize: 12, color: muted, marginTop: 3 }}>
                {parseDate(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {p.lastFour && ` - ${p.cardBrand || 'Card'} ending in ${p.lastFour}`}
              </div>
              {p.status === 'failed' && (
                <button type="button" style={{
                  marginTop: 8, padding: '7px 10px', borderRadius: 8, border: `1px solid ${B.red}`,
                  background: '#fff', color: B.red, fontSize: 12, fontWeight: 800, cursor: 'pointer',
                }}>Update Payment Method</button>
              )}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>{money(p.amount)}</div>
              <span style={{
                display: 'inline-flex',
                marginTop: 5,
                fontSize: 14,
                fontWeight: 850,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '4px 8px',
                borderRadius: 999,
                ...statusBadge(p.status),
              }}>{p.status}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ ...card, padding: 20 }}>
        <div style={sectionTitle}>Billing Preferences</div>
        <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper, marginBottom: 14 }}>Notifications</div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="portal-billing-email" style={{ fontSize: 12, fontWeight: 850, color: muted, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Billing Email
          </label>
          <input
            id="portal-billing-email"
            name="billingEmail"
            type="email"
            value={billingEmail}
            onChange={e => setBillingEmail(e.target.value)}
            placeholder={customer?.email || 'billing@example.com'}
            aria-label="Billing email"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #CBD5E1',
              fontSize: 14, fontFamily: FONTS.body, color: B.blueDeeper, background: '#fff',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ marginTop: 5, color: muted, fontSize: 12 }}>Optional - separate from account email.</div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', background: subtle, borderRadius: 8, marginBottom: 14, border: '1px solid #E1E7EF', gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Payment confirmation texts</div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>Get a text when your payment processes.</div>
          </div>
          <button
            type="button"
            onClick={() => setPaymentSmsEnabled(!paymentSmsEnabled)}
            aria-label={`Payment confirmation texts ${paymentSmsEnabled ? 'enabled' : 'disabled'}`}
            style={{
              width: 48, height: 32, borderRadius: 16, border: 'none', cursor: 'pointer',
              background: paymentSmsEnabled ? B.green : B.grayLight,
              position: 'relative', transition: 'background 0.2s ease',
            }}
          >
            <div style={{
              width: 22, height: 22, borderRadius: 11, background: '#fff',
              position: 'absolute', top: 5,
              left: paymentSmsEnabled ? 24 : 2,
              transition: 'left 0.2s ease',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        <button type="button" onClick={saveBillingPrefs} disabled={billingPrefsSaving} style={{
          ...primaryButton,
          opacity: billingPrefsSaving ? 0.6 : 1,
          width: '100%',
          cursor: billingPrefsSaving ? 'wait' : 'pointer',
        }}>
          {billingPrefsSaving ? 'Saving...' : 'Save Billing Preferences'}
        </button>
      </div>
    </div>
  );
}

// =========================================================================
// MY PROPERTY TAB — access codes, pets, scheduling, irrigation, HOA
// =========================================================================
function PropertySection({ title, icon = 'document', summary, defaultOpen, children, aside }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  return (
    <section style={{
      background: B.white,
      borderRadius: 8,
      overflow: 'hidden',
      border: '1px solid #E1E7EF',
      boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          width: '100%',
          border: 'none',
          background: '#fff',
          padding: '16px 18px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          textAlign: 'left',
          fontFamily: FONTS.body,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: '#EEF6FF',
            color: B.blueDeeper,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon name={icon} size={17} strokeWidth={2} />
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 850, color: B.blueDeeper }}>{title}</span>
            {summary && <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#64748B', lineHeight: 1.35 }}>{summary}</span>}
          </span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {aside}
          <Icon name="chevronDown" size={18} strokeWidth={2} style={{ color: '#64748B', transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }} />
        </span>
      </button>
      {open && <div style={{ padding: '0 18px 18px' }}>{children}</div>}
    </section>
  );
}

function PasswordField({ value, onChange, placeholder, label }) {
  const [show, setShow] = useState(false);
  const inputLabel = label || placeholder || 'Secure field';
  return (
    <div>
      {label && <label style={{ fontSize: 12, fontWeight: 850, color: '#64748B', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: 0 }}>{label}</label>}
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={inputLabel}
          style={{
            width: '100%',
            padding: '10px 42px 10px 12px',
            borderRadius: 8,
            border: '1px solid #CBD5E1',
            fontSize: 14,
            fontFamily: FONTS.body,
            color: B.blueDeeper,
            outline: 'none',
            boxSizing: 'border-box',
            background: '#fff',
          }}
          onFocus={e => e.target.style.borderColor = B.wavesBlue}
          onBlur={e => e.target.style.borderColor = '#CBD5E1'}
        />
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? `Hide ${inputLabel}` : `Show ${inputLabel}`} style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: '#64748B', padding: 4, width: 32, height: 32,
        }}><Icon name={show ? 'eyeOff' : 'eye'} size={18} strokeWidth={2} /></button>
      </div>
    </div>
  );
}

function PillSelector({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value} style={{
          ...BUTTON_BASE,
          minHeight: 36,
          padding: '8px 12px',
          fontSize: 14,
          borderRadius: 8,
          letterSpacing: 0,
          boxShadow: 'none',
          background: value === o.value ? '#EEF6FF' : '#fff',
          color: value === o.value ? B.blueDeeper : '#64748B',
          border: `1px solid ${value === o.value ? B.wavesBlue : '#CBD5E1'}`,
        }}>{o.label}</button>
      ))}
    </div>
  );
}

function NumberStepper({ value, onChange, min = 0, max = 99, label = 'Value' }) {
  const v = value || 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button type="button" onClick={() => onChange(Math.max(min, v - 1))} aria-label={`Decrease ${label}`} style={{
        width: 38, height: 38, borderRadius: 8, border: '1px solid #CBD5E1',
        background: '#fff', cursor: 'pointer', color: B.blueDeeper,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icon name="minus" size={16} strokeWidth={2} /></button>
      <span style={{ fontSize: 20, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui, minWidth: 28, textAlign: 'center' }}>{v}</span>
      <button type="button" onClick={() => onChange(Math.min(max, v + 1))} aria-label={`Increase ${label}`} style={{
        width: 38, height: 38, borderRadius: 8, border: '1px solid #CBD5E1',
        background: '#fff', cursor: 'pointer', color: B.blueDeeper,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icon name="plus" size={16} strokeWidth={2} /></button>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      style={{
        width: 50,
        height: 30,
        borderRadius: 999,
        border: 'none',
        cursor: disabled ? 'wait' : 'pointer',
        background: checked ? B.wavesBlue : '#CBD5E1',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.18s ease',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 4,
        left: checked ? 24 : 4,
        width: 22,
        height: 22,
        borderRadius: 999,
        background: '#fff',
        boxShadow: '0 1px 3px rgba(15,23,42,0.22)',
        transition: 'left 0.18s ease',
      }} />
    </button>
  );
}

// Service preferences — customer can opt out of interior spraying or
// exterior eave sweep for their pest control visits. Reads/writes
// /api/service-preferences; the PUT pings the admin notification bus
// so the office knows to update the tech's next work order.
function ServicePrefsSection() {
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(null); // which key is currently saving
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getServicePreferences()
      .then((d) => setPrefs(d.preferences || { interior_spray: true, exterior_sweep: true }))
      .catch(() => setPrefs({ interior_spray: true, exterior_sweep: true }));
  }, []);

  async function toggle(key) {
    if (!prefs) return;
    const nextVal = !prefs[key];
    const prev = prefs;
    setPrefs({ ...prefs, [key]: nextVal });
    setBusy(key);
    setError(null);
    try {
      const d = await api.updateServicePreferences({ [key]: nextVal });
      if (d && d.preferences) setPrefs(d.preferences);
    } catch (e) {
      setPrefs(prev);
      setError('Could not save. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  if (!prefs) return null;

  const rows = [
    { key: 'interior_spray', icon: 'home', title: 'Interior spraying', desc: 'Treat inside the home on each visit. Turn off for exterior-only service.' },
    { key: 'exterior_sweep', icon: 'sparkles', title: 'Exterior eave sweep', desc: 'Sweep cobwebs from eaves and exterior corners during recurring service.' },
  ];

  return (
    <PropertySection
      title="Service preferences"
      icon="wrench"
      summary="Choose what is included on each recurring pest control visit."
    >
      <div style={{ fontSize: 14, color: '#64748B', marginBottom: 12, lineHeight: 1.5 }}>
        These update your next work order automatically, so the office and technician see the same preference.
      </div>
      {rows.map((r) => {
        const on = prefs[r.key] !== false;
        return (
          <div key={r.key} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            padding: '14px 0',
            borderTop: '1px solid #E1E7EF',
          }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
              <span style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: on ? '#EEF6FF' : '#F8FAFC',
                color: on ? B.blueDeeper : '#64748B',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                border: '1px solid #E1E7EF',
              }}>
                <Icon name={r.icon} size={17} strokeWidth={2} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{r.title}</div>
                <div style={{ fontSize: 14, color: '#64748B', marginTop: 2, lineHeight: 1.45 }}>{r.desc}</div>
              </div>
            </div>
            <ToggleSwitch
              checked={on}
              onChange={() => toggle(r.key)}
              disabled={busy === r.key}
              label={`${r.title} ${on ? 'enabled' : 'disabled'}`}
            />
          </div>
        );
      })}
      {error && <div style={{ fontSize: 12, color: B.red || '#c8102e', marginTop: 8 }}>{error}</div>}
    </PropertySection>
  );
}

function PropertyTab({ customer }) {
  const compact = useIsMobile(760);
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const debounceRef = useRef(null);
  const pendingRef = useRef({});
  const lastSavedRef = useRef(null);

  useEffect(() => {
    api.getPropertyPreferences()
      .then(d => { setPrefs(d.preferences); lastSavedRef.current = d.preferences; setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const updateField = useCallback((field, value) => {
    setPrefs(prev => ({ ...prev, [field]: value }));
    // Merge into pending so earlier-edited fields aren't lost when the
    // debounce timer resets for a later field.
    pendingRef.current = { ...pendingRef.current, [field]: value };

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const toSave = { ...pendingRef.current };
      pendingRef.current = {};
      setSaveStatus('saving');
      try {
        const result = await api.updatePropertyPreferences(toSave);
        if (result && result.preferences) {
          lastSavedRef.current = result.preferences;
        }
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus(prev => (prev === 'saved' ? null : prev)), 2000);
      } catch (err) {
        console.error('[PropertyTab] save failed', err);
        // Revert optimistic UI to last confirmed server state so the user
        // isn't misled into thinking gate codes / pet info persisted.
        if (lastSavedRef.current) {
          setPrefs(lastSavedRef.current);
        }
        setSaveStatus('error');
      }
    }, 1000);
  }, []);

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 12,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
  const labelStyle = {
    fontSize: 12,
    fontWeight: 850,
    color: muted,
    marginBottom: 6,
    display: 'block',
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #CBD5E1',
    fontSize: 14,
    fontFamily: FONTS.body,
    color: B.blueDeeper,
    outline: 'none',
    boxSizing: 'border-box',
    background: '#fff',
  };
  const fieldGrid = {
    display: 'grid',
    gridTemplateColumns: compact ? '1fr' : 'repeat(2, minmax(0, 1fr))',
    gap: 12,
  };

  if (loading) return <div style={{ ...card, padding: 28, textAlign: 'center', color: muted }}>Loading property info...</div>;
  if (!prefs) {
    return (
      <div style={{ ...card, padding: 24 }}>
        <div style={sectionTitle}>My Property</div>
        <div style={{ marginTop: 8, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Unable to load preferences</div>
        <div style={{ marginTop: 6, fontSize: 14, color: muted }}>Refresh the portal and try again.</div>
      </div>
    );
  }

  const updatedAt = prefs.updatedAt ? (() => {
    const d = new Date(prefs.updatedAt);
    if (isNaN(d)) return null;
    const diff = Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'Updated today';
    if (diff === 1) return 'Updated yesterday';
    return `Updated ${diff} days ago`;
  })() : null;

  const focusBorder = e => { e.target.style.borderColor = B.wavesBlue; };
  const blurBorder = e => { e.target.style.borderColor = '#CBD5E1'; };
  const textArea = (field, placeholder, rows = 2, label, valueOverride) => (
    <textarea
      value={valueOverride ?? prefs[field] ?? ''}
      onChange={e => updateField(field, e.target.value)}
      placeholder={placeholder}
      aria-label={label || placeholder}
      rows={rows}
      style={{ ...inputStyle, minHeight: rows * 28 + 34, resize: 'vertical', lineHeight: 1.45 }}
      onFocus={focusBorder}
      onBlur={blurBorder}
    />
  );

  const textInput = (field, placeholder, label, type = 'text') => (
    <div>
      {label && <label style={labelStyle}>{label}</label>}
      <input
        type={type}
        value={prefs[field] || ''}
        onChange={e => updateField(field, e.target.value)}
        placeholder={placeholder}
        aria-label={label || placeholder}
        style={inputStyle}
        onFocus={focusBorder}
        onBlur={blurBorder}
      />
    </div>
  );

  const dateValue = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    const d = new Date(value);
    return isNaN(d) ? '' : etDateString(d);
  };

  const dateInput = (field, label) => (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type="date"
        value={dateValue(prefs[field])}
        onChange={e => updateField(field, e.target.value || null)}
        aria-label={label}
        style={inputStyle}
        onFocus={focusBorder}
        onBlur={blurBorder}
      />
    </div>
  );

  const sqft = (n) => {
    const num = Number(n || 0);
    return num > 0 ? `${num.toLocaleString()} sq ft` : 'Not set';
  };
  const displayChoice = (value, fallback = 'No preference') => {
    if (!value || value === 'no_preference') return fallback;
    return String(value).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };
  const fullAddress = formatPropertyAddress(customer);
  const cleanTurf = (customer.property?.lawnType || '').replace(/\s*(Full Sun|Shade|Sun\/Shade)\s*/gi, '').trim() || 'Not set';
  const homeSqFt = Number(customer.property?.propertySqFt || 0);
  const bedSqFt = Number(customer.property?.bedSqFt || 0);
  const treatedSqFt = homeSqFt ? Math.max(0, homeSqFt - bedSqFt) : 0;
  const accessReady = [
    prefs.neighborhoodGateCode,
    prefs.propertyGateCode,
    prefs.garageCode,
    prefs.lockboxCode,
    prefs.sideGateAccess,
  ].some(Boolean);
  const petCount = Math.max(0, Number(prefs.petCount || 0));
  const petPlan = prefs.petsSecuredPlan ?? prefs.petSecuredPlan ?? '';
  const petSummary = petCount > 0 ? `${petCount} pet${petCount === 1 ? '' : 's'} on file` : 'No pets listed';
  const scheduleSummary = `${displayChoice(prefs.preferredDay)}, ${displayChoice(prefs.preferredTime).toLowerCase()}`;
  const irrigationSummary = prefs.irrigationSystem ? `${prefs.irrigationZones || 'Unknown'} zone${Number(prefs.irrigationZones) === 1 ? '' : 's'}${prefs.rainSensor ? ' with rain sensor' : ''}` : 'No irrigation system listed';
  const hoaSummary = prefs.hoaName || prefs.hoaCompany || 'No HOA details listed';
  const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const staticMapUrl = mapsKey && customer.address?.line1
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(`${customer.address.line1}, ${customer.address.city}, ${customer.address.state} ${customer.address.zip}`)}&zoom=19&size=640x280&scale=2&maptype=satellite&key=${mapsKey}`
    : '';
  const saveText = saveStatus === 'saving'
    ? 'Saving changes'
    : saveStatus === 'saved'
      ? 'Saved'
      : saveStatus === 'error'
        ? 'Save failed'
        : 'Auto-save on';
  const saveColor = saveStatus === 'error' ? B.red : saveStatus === 'saved' ? B.green : B.blueDeeper;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'relative' }}>
      {saveStatus && (
        <div style={{
          padding: '12px 14px',
          borderRadius: 8,
          border: `1px solid ${saveStatus === 'error' ? `${B.red}33` : '#BBF7D0'}`,
          background: saveStatus === 'error' ? `${B.red}10` : '#F0FDF4',
          color: saveStatus === 'error' ? B.red : B.green,
          fontSize: 14,
          fontWeight: 800,
        }}>
          {saveStatus === 'saving' ? 'Saving property details...' : saveStatus === 'error' ? 'Could not save. Please check your connection and try again.' : 'Property details saved.'}
        </div>
      )}

      <section style={{ ...card, overflow: 'hidden' }}>
        {staticMapUrl && (
          <div style={{ width: '100%', height: compact ? 140 : 170, overflow: 'hidden', background: subtle }}>
            <img
              src={staticMapUrl}
              alt="Property satellite view"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={e => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
        )}
        <div style={{ padding: compact ? 20 : 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 300px' }}>
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 10px',
                borderRadius: 999,
                background: '#EEF6FF',
                color: B.blueDeeper,
                fontSize: 12,
                fontWeight: 850,
              }}>
                <Icon name="house" size={14} strokeWidth={2} />
                Property Profile
              </div>
              <h1 style={{
                margin: '12px 0 8px',
                color: B.blueDeeper,
                fontFamily: FONTS.heading,
                fontSize: compact ? 28 : 34,
                lineHeight: 1.1,
                letterSpacing: 0,
              }}>
                My Property
              </h1>
              <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
                Access notes, pets, scheduling preferences, irrigation, and HOA details for your service team.
              </div>
              {fullAddress && <div style={{ marginTop: 4, fontSize: 14, color: muted }}>{fullAddress}</div>}
            </div>
            <div style={{
              minWidth: compact ? '100%' : 210,
              padding: '14px 16px',
              borderRadius: 8,
              background: subtle,
              border: '1px solid #E1E7EF',
              boxSizing: 'border-box',
            }}>
              <div style={{ ...sectionTitle, color: saveColor }}>Status</div>
              <div style={{ marginTop: 3, fontSize: 20, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>
                {saveText}
              </div>
              <div style={{ marginTop: 2, fontSize: 12, color: muted }}>
                {updatedAt || 'Ready for updates'}
              </div>
            </div>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)',
            gap: 10,
            marginTop: 22,
          }}>
            {[
              { label: 'Turf', value: cleanTurf, sub: 'Lawn profile' },
              { label: 'Home', value: sqft(homeSqFt), sub: 'Property size' },
              { label: 'Treated Area', value: treatedSqFt ? sqft(treatedSqFt) : sqft(homeSqFt), sub: 'Estimated service area' },
              { label: 'Lot', value: sqft(customer.property?.lotSqFt), sub: 'Parcel size' },
            ].map((item) => (
              <div key={item.label} style={{
                border: '1px solid #E1E7EF',
                borderRadius: 8,
                background: subtle,
                padding: 14,
                minHeight: 78,
                boxSizing: 'border-box',
              }}>
                <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>{item.label}</div>
                <div style={{
                  marginTop: 6,
                  color: B.blueDeeper,
                  fontSize: 16,
                  fontWeight: 850,
                  lineHeight: 1.2,
                  fontFamily: FONTS.ui,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{item.value}</div>
                <div style={{ marginTop: 3, color: muted, fontSize: 12 }}>{item.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ServicePrefsSection />

      <PropertySection
        title="Access"
        icon="key"
        summary={accessReady ? 'Technician access details are on file.' : 'Add gate or parking details before the next visit.'}
        aside={<span style={{ fontSize: 12, fontWeight: 850, color: accessReady ? B.green : muted }}>{accessReady ? 'Ready' : 'Needs details'}</span>}
      >
        <div style={fieldGrid}>
          <PasswordField
            label="Community Gate"
            value={prefs.neighborhoodGateCode}
            onChange={v => updateField('neighborhoodGateCode', v)}
            placeholder="e.g., #1234 or press 5"
          />
          <PasswordField
            label="Property Gate"
            value={prefs.propertyGateCode}
            onChange={v => updateField('propertyGateCode', v)}
            placeholder="e.g., Combination lock: 4821"
          />
          <PasswordField
            label="Garage Code"
            value={prefs.garageCode}
            onChange={v => updateField('garageCode', v)}
            placeholder="e.g., Keypad code: 9876"
          />
          <PasswordField
            label="Lockbox Code"
            value={prefs.lockboxCode}
            onChange={v => updateField('lockboxCode', v)}
            placeholder="e.g., Back door lockbox: 0000"
          />
          {textInput('sideGateAccess', 'e.g., Side gate - lift latch, no code needed', 'Side Gate / Backyard Access')}
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>Parking Notes</label>
          {textArea('parkingNotes', 'e.g., Park in driveway, HOA enforces no street parking')}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-start', color: muted, fontSize: 12, lineHeight: 1.45 }}>
          <Icon name="lock" size={15} strokeWidth={2} style={{ marginTop: 1 }} />
          <span>Access codes are only shown to the assigned technician on service day.</span>
        </div>
      </PropertySection>

      <PropertySection title="Pets" icon="paw" summary={petSummary}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, padding: 14, borderRadius: 8, background: subtle, border: '1px solid #E1E7EF', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Pets at this property</div>
            <div style={{ marginTop: 2, fontSize: 14, color: muted }}>Helps technicians plan safe entry and treatment timing.</div>
          </div>
          <NumberStepper value={prefs.petCount} onChange={v => {
            updateField('petCount', v);
            const current = Array.isArray(prefs.petsStructured) ? prefs.petsStructured : [];
            if (v > current.length) {
              const extended = [...current];
              for (let i = current.length; i < v; i++) {
                extended.push({ name: '', type: '', breed: '', indoor: '', temperament: '' });
              }
              updateField('petsStructured', extended);
            } else if (v < current.length) {
              updateField('petsStructured', current.slice(0, v));
            }
          }} max={10} />
        </div>
        {petCount > 0 && (
          <>
            {Array.from({ length: petCount }).map((_, idx) => {
              const pet = (Array.isArray(prefs.petsStructured) ? prefs.petsStructured : [])[idx] || {};
              const updatePet = (key, val) => {
                const arr = Array.isArray(prefs.petsStructured) ? [...prefs.petsStructured] : [];
                while (arr.length <= idx) arr.push({ name: '', type: '', breed: '', indoor: '', temperament: '' });
                arr[idx] = { ...arr[idx], [key]: val };
                updateField('petsStructured', arr);
              };
              return (
                <div key={idx} style={{
                  marginBottom: 14,
                  padding: 14,
                  borderRadius: 8,
                  background: '#fff',
                  border: '1px solid #E1E7EF',
                }}>
                  <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, marginBottom: 12 }}>
                    Pet {idx + 1}
                  </div>
                  <div style={fieldGrid}>
                    <div>
                      <label style={labelStyle}>Name</label>
                      <input
                        type="text"
                        value={pet.name || ''}
                        onChange={e => updatePet('name', e.target.value)}
                        placeholder="e.g., Max"
                        aria-label={`Pet ${idx + 1} name`}
                        style={inputStyle}
                        onFocus={focusBorder}
                        onBlur={blurBorder}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Breed</label>
                      <input
                        type="text"
                        value={pet.breed || ''}
                        onChange={e => updatePet('breed', e.target.value)}
                        placeholder="e.g., Golden Retriever"
                        aria-label={`Pet ${idx + 1} breed`}
                        style={inputStyle}
                        onFocus={focusBorder}
                        onBlur={blurBorder}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>
                    <div>
                      <label style={labelStyle}>Type</label>
                      <PillSelector value={pet.type} onChange={v => updatePet('type', v)} options={['Dog', 'Cat', 'Other'].map(t => ({ value: t, label: t }))} />
                    </div>
                    <div>
                      <label style={labelStyle}>Location</label>
                      <PillSelector value={pet.indoor} onChange={v => updatePet('indoor', v)} options={['Indoor', 'Outdoor', 'Both'].map(t => ({ value: t, label: t }))} />
                    </div>
                    <div>
                      <label style={labelStyle}>Temperament</label>
                      <PillSelector value={pet.temperament} onChange={v => updatePet('temperament', v)} options={['Friendly', 'Cautious', 'Aggressive'].map(t => ({ value: t, label: t }))} />
                    </div>
                  </div>
                </div>
              );
            })}
            <div>
              <label style={labelStyle}>Service Day Plan</label>
              {textArea('petsSecuredPlan', 'e.g., Dogs will be inside. Please text 15 min before so I can secure them.', 2, 'Service day pet plan', petPlan)}
            </div>
          </>
        )}
      </PropertySection>

      <PropertySection title="Scheduling" icon="calendar" summary={scheduleSummary}>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
          <div>
            <label style={labelStyle}>Preferred Day</label>
            <PillSelector
              value={prefs.preferredDay}
              onChange={v => updateField('preferredDay', v)}
              options={[
                { value: 'monday', label: 'Mon' }, { value: 'tuesday', label: 'Tue' },
                { value: 'wednesday', label: 'Wed' }, { value: 'thursday', label: 'Thu' },
                { value: 'friday', label: 'Fri' }, { value: 'no_preference', label: 'Any' },
              ]}
            />
          </div>
          <div>
            <label style={labelStyle}>Preferred Time</label>
            <PillSelector
              value={prefs.preferredTime}
              onChange={v => updateField('preferredTime', v)}
              options={[
                { value: 'early_morning', label: '7-9' }, { value: 'morning', label: '9-11' },
                { value: 'midday', label: '11-1' }, { value: 'afternoon', label: '1-4' },
                { value: 'no_preference', label: 'Any' },
              ]}
            />
          </div>
          <div>
            <label style={labelStyle}>Contact</label>
            <PillSelector
              value={prefs.contactPreference}
              onChange={v => updateField('contactPreference', v)}
              options={[
                { value: 'call', label: 'Call' }, { value: 'text', label: 'Text' },
                { value: 'email', label: 'Email' },
              ]}
            />
          </div>
        </div>
        <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: subtle, border: '1px solid #E1E7EF' }}>
          <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, marginBottom: 4 }}>Blackout dates</div>
          <div style={{ fontSize: 14, color: muted, marginBottom: 12 }}>
            Do not service between these dates (vacation, events, etc.)
          </div>
          <div style={fieldGrid}>
            {dateInput('blackoutStart', 'Start Date')}
            {dateInput('blackoutEnd', 'End Date')}
          </div>
        </div>
      </PropertySection>

      <PropertySection title="Irrigation" icon="droplet" summary={irrigationSummary}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Irrigation system</div>
            <div style={{ fontSize: 14, color: muted, marginTop: 2 }}>Watering timing can affect lawn and pest applications.</div>
          </div>
          <ToggleSwitch checked={!!prefs.irrigationSystem} onChange={() => updateField('irrigationSystem', !prefs.irrigationSystem)} label="Irrigation system" />
        </div>
        {prefs.irrigationSystem && (
          <>
            <div style={fieldGrid}>
              {textInput('irrigationControllerLocation', 'e.g., Left side of garage, gray box', 'Controller Location')}
              <div>
                <label style={labelStyle}>Number of Zones</label>
                <NumberStepper value={prefs.irrigationZones} onChange={v => updateField('irrigationZones', v)} max={20} label="Irrigation zones" />
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <label style={labelStyle}>Watering Days</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => {
                  const days = Array.isArray(prefs.wateringDays) ? prefs.wateringDays : [];
                  const active = days.includes(day);
                  return (
                    <button key={day} type="button" aria-pressed={active} onClick={() => {
                      const next = active ? days.filter(d => d !== day) : [...days, day];
                      updateField('wateringDays', next);
                    }} style={{
                      ...BUTTON_BASE,
                      minWidth: 44,
                      padding: '8px 10px',
                      fontSize: 14,
                      borderRadius: 8,
                      letterSpacing: 0,
                      boxShadow: 'none',
                      background: active ? '#EEF6FF' : '#fff',
                      color: active ? B.blueDeeper : muted,
                      border: `1px solid ${active ? B.wavesBlue : '#CBD5E1'}`,
                    }}>{day}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 220px', gap: 14, marginTop: 14, alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>System Type</label>
                <PillSelector
                  value={prefs.irrigationSystemType}
                  onChange={v => updateField('irrigationSystemType', v)}
                  options={[
                    { value: 'spray', label: 'In-ground Spray' },
                    { value: 'drip', label: 'Drip' },
                    { value: 'rotor', label: 'Rotor' },
                  ]}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid #E1E7EF', borderRadius: 8, background: subtle }}>
                <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Rain sensor</div>
                <ToggleSwitch checked={!!prefs.rainSensor} onChange={() => updateField('rainSensor', !prefs.rainSensor)} label="Rain sensor installed" />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 12, marginTop: 14 }}>
              <div>
                <label style={labelStyle}>Schedule Notes</label>
                {textArea('irrigationScheduleNotes', 'e.g., Runs Mon/Wed/Fri at 4am. Zone 3 seems to run too long.', 3)}
              </div>
              <div>
                <label style={labelStyle}>Known Issues</label>
                {textArea('irrigationIssues', "e.g., Zone 4 doesn't reach the back corner", 3)}
              </div>
            </div>
          </>
        )}
      </PropertySection>

      <PropertySection title="HOA" icon="building" summary={hoaSummary}>
        <div style={fieldGrid}>
          {textInput('hoaName', 'e.g., Sandpiper Bay HOA', 'HOA Name')}
          {textInput('hoaCompany', 'e.g., FirstService Residential', 'Management Company')}
          {textInput('hoaPhone', 'e.g., (239) 555-0100', 'Contact Phone', 'tel')}
          {textInput('hoaEmail', 'e.g., manager@sandpiperhoa.com', 'Contact Email', 'email')}
          {textInput('hoaLawnHeight', 'e.g., Must be mowed below 4 inches', 'Lawn Height Requirement')}
          {textInput('hoaInspectionPeriod', 'e.g., March and October', 'Inspection Period')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 12, marginTop: 12 }}>
          <div>
            <label style={labelStyle}>HOA Restrictions</label>
            {textArea('hoaRestrictions', 'e.g., No signs in yard, must notify management 24hr before exterior treatment, no parking on street', 3)}
          </div>
          <div>
            <label style={labelStyle}>Treatment Signage</label>
            {textArea('hoaSignageRules', 'e.g., No lawn signs allowed', 3)}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>Application Timing Restrictions</label>
          {textArea('hoaTimingRestrictions', 'e.g., No spray before 9 AM near pool', 2)}
        </div>
      </PropertySection>

      <PropertySection title="Technician notes" icon="clipboard" summary="Doorbell, access, and special instructions for the service day.">
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>Access Notes</label>
            {textArea('accessNotes', "e.g., Please don't ring doorbell - baby sleeping during morning appointments", 3)}
          </div>
          <div>
            <label style={labelStyle}>Anything Else</label>
            {textArea('specialInstructions', 'Anything else your technician should know about your property...', 3)}
          </div>
        </div>
      </PropertySection>
    </div>
  );
}

// =========================================================================
// KNOWLEDGE BASE TAB — SWFL-specific pest & lawn content
// =========================================================================
const ARTICLES = [
  {
    id: 1, icon: 'bug', category: 'Pests',
    title: 'Why Ghost Ants Love Your Kitchen',
    summary: 'Ghost ants are one of the most common indoor pests in Southwest Florida. They\'re attracted to moisture and sweet foods, and their tiny size (1.3mm) lets them slip through the smallest cracks.',
    tips: ['Keep counters wiped down — even small crumbs attract them', 'Fix any dripping faucets or pipes', 'Don\'t leave pet food out overnight', 'Our quarterly treatment creates a barrier they can\'t cross'],
  },
  {
    id: 2, icon: 'leaf', category: 'Lawn Care',
    title: 'Large Patch Fungus in St. Augustine',
    summary: 'Large patch (Rhizoctonia solani) is the #1 disease in St. Augustine lawns in Florida. It shows up as circular brown patches, usually in fall/spring when soil temps are 60-75°F.',
    tips: ['Don\'t water in the evening — morning irrigation only', 'Reduce nitrogen fertilizer during active infection', 'Improve air circulation by trimming overhanging branches', 'We treat with Headway G or Azoxystrobin for proven control'],
  },
  {
    id: 3, icon: 'bug', category: 'Pests',
    title: 'Mosquito Season in SWFL',
    summary: 'In Southwest Florida, mosquito season runs nearly year-round but peaks June through October. Standing water after rain is their #1 breeding ground.',
    tips: ['Empty saucers, bird baths, and any standing water weekly', 'Keep gutters clear and draining properly', 'Our barrier treatments last 21-30 days per application', 'WaveGuard Gold and Platinum include monthly mosquito service'],
  },
  {
    id: 4, icon: 'palm', category: 'Lawn Care',
    title: 'Dollar Weed: What It Tells You',
    summary: 'Dollar weed (Hydrocotyle) is actually an indicator plant — it thrives in overwatered areas. If you see it spreading, your irrigation is probably too aggressive.',
    tips: ['Reduce irrigation runtime by 5-10 minutes per zone', 'Water deeply but less frequently (2-3x per week max)', 'We spot-treat with Celsius WG (max 3 applications/year)', 'Proper irrigation is the real long-term fix'],
  },
  {
    id: 5, icon: 'bug', category: 'Pests',
    title: 'Spiders Around Your Lanai',
    summary: 'Most spiders in SWFL (banana spiders, orb weavers, wolf spiders) are harmless and actually helpful — they eat other pests. But nobody wants webs all over their lanai.',
    tips: ['Our cobweb sweep is included in every quarterly visit', 'Reducing outdoor lighting at night reduces spider food (bugs)', 'Seal gaps around doors and windows', 'Dangerous species (brown recluse, black widow) are rare but we monitor'],
  },
  {
    id: 6, icon: 'sprout', category: 'Lawn Care',
    title: 'Chinch Bugs: The Silent Lawn Killer',
    summary: 'Southern chinch bugs cause more damage to St. Augustine lawns in Florida than any other insect. They suck plant juices and inject a toxin that kills the grass.',
    tips: ['Damage looks like drought stress — yellowing then browning at edges', 'Peak season is July-September in the hottest, sunniest spots', 'Thatch buildup over 0.5" increases risk — ask us about dethatching', 'We rotate insecticide modes of action to prevent resistance'],
  },
];

function WeatherPestWidget({ customer, nextService }) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getWeather()
      .then(d => { setWeather(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';

  if (loading) return (
    <div style={{ ...card, padding: 24, color: muted, textAlign: 'center', fontSize: 14 }}>
      Loading local conditions...
    </div>
  );

  if (!weather) return null;

  // Localized location label
  const cityName = customer?.address?.city || '';
  const localizedLocation = cityName ? `${cityName} Weather` : weather.location;

  // Build action items per pest pressure indicator
  const getActionItem = (type, level) => {
    if (level === 'LOW') return null;
    const nextDate = nextService?.date ? parseDate(nextService.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
    const actions = {
      mosquito: {
        HIGH: `Empty standing water, clear gutters.${nextDate ? ` Your next barrier: ${nextDate}.` : ''}`,
        MODERATE: `Reduce standing water sources. Treat birdbaths weekly.`,
      },
      fungus: {
        HIGH: `Avoid evening irrigation. Water before 10 AM only.`,
        MODERATE: `Avoid evening irrigation. Ensure good air circulation around turf.`,
      },
      chinch: {
        HIGH: `Watch for yellowing edges in sunny spots. Water stressed areas.`,
        MODERATE: `Monitor sunny turf edges for early yellowing.`,
      },
    };
    return actions[type]?.[level] || null;
  };

  const pressure = weather.pestPressure || {};
  const pressureItems = [
    { label: 'Mosquito Pressure', icon: 'bug', type: 'mosquito', level: pressure.mosquito?.level || 'LOW', color: pressure.mosquito?.color || B.green },
    { label: 'Fungus Risk', icon: 'leaf', type: 'fungus', level: pressure.fungus?.level || 'LOW', color: pressure.fungus?.color || B.green },
    { label: 'Chinch Bug Risk', icon: 'bug', type: 'chinch', level: pressure.chinch?.level || 'LOW', color: pressure.chinch?.color || B.green },
  ];
  const irrigation = weather.irrigationRecommendation || {};
  const irrigationInches = Number(irrigation.inches ?? 0);
  const irrigationAmount = Number.isFinite(irrigationInches)
    ? String(Number(irrigationInches.toFixed(2)))
    : '0';
  const updatedAt = weather.updatedAt ? new Date(weather.updatedAt) : null;
  const updatedText = updatedAt && !isNaN(updatedAt)
    ? updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <section style={{ ...card, padding: 18 }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 18,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 10px',
            borderRadius: 999,
            background: '#EEF6FF',
            color: B.blueDeeper,
            fontSize: 12,
            fontWeight: 850,
          }}>
            <Icon name="sun" size={14} strokeWidth={2} />
            Local Conditions
          </div>
          <div style={{ marginTop: 10, fontSize: 18, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.heading }}>
            {localizedLocation}
          </div>
          <div style={{ marginTop: 3, fontSize: 14, color: muted, lineHeight: 1.45 }}>
            {weather.forecast || 'Current local weather'}{updatedText ? ` - updated ${updatedText}` : ''}
          </div>
        </div>
        <div style={{
          minWidth: 152,
          padding: '12px 14px',
          borderRadius: 8,
          background: subtle,
          border: '1px solid #E1E7EF',
          textAlign: 'right',
        }}>
          <div style={{ fontSize: 40, lineHeight: 1, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>
            {weather.temp}°
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: muted }}>
            Tonight {weather.nightTemp}° · {weather.humidity}% humidity
          </div>
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 10,
        marginTop: 16,
      }}>
        {pressureItems.map(p => {
          const action = getActionItem(p.type, p.level);
          return (
            <div key={p.label} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: subtle,
              padding: 12,
              minHeight: 112,
              boxSizing: 'border-box',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name={p.icon} size={15} strokeWidth={2} /> {p.label}
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 800, letterSpacing: 0.5,
                  padding: '3px 7px', borderRadius: 8,
                  background: `${p.color}33`, color: p.color,
                }}>{p.level}</span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: '#E2E8F0' }}>
                <div style={{
                  height: '100%', borderRadius: 999, background: p.color,
                  width: p.level === 'HIGH' ? '100%' : p.level === 'MODERATE' ? '60%' : '25%',
                  transition: 'width 1s ease-out',
                }} />
              </div>
              {action && (
                <div style={{ fontSize: 12, color: muted, marginTop: 8, lineHeight: 1.45 }}>
                  {action}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 10,
        padding: 14,
        borderRadius: 8,
        background: '#EEF6FF',
        border: '1px solid #CDEAFE',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: '#fff',
          color: B.blueDeeper,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name="droplet" size={18} strokeWidth={2} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>
            Irrigation: {irrigationAmount}" recommended
          </div>
          <div style={{ marginTop: 2, fontSize: 14, color: muted, lineHeight: 1.4 }}>{irrigation.note || 'Adjust watering around rainfall and local restrictions.'}</div>
        </div>
      </div>
    </section>
  );
}

function FeedSection({ title, icon, fetchFn, emptyMsg }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFn()
      .then(d => { setPosts(d.posts || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ padding: 20, textAlign: 'center', color: B.grayMid, fontSize: 12 }}>Loading {title.toLowerCase()}...</div>
  );
  if (!posts.length) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{title}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {posts.map((p, i) => {
          const pubDate = p.pubDate ? new Date(p.pubDate) : null;
          return (
            <a key={i} href={p.link} target="_blank" rel="noopener noreferrer" style={{
              background: B.white, borderRadius: 12, padding: '14px 16px',
              border: `1px solid ${B.grayLight}`, textDecoration: 'none',
              transition: 'border-color 0.2s',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: B.navy, lineHeight: 1.4 }}>{p.title}</div>
              {p.description && (
                <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4, lineHeight: 1.5 }}>
                  {p.description}{p.description.length >= 200 ? '...' : ''}
                </div>
              )}
              <div style={{ fontSize: 12, color: B.grayMid, marginTop: 6 }}>
                {pubDate && !isNaN(pubDate) ? pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                {p.category ? ` · ${p.category}` : ''}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function ContentCard({ post, large, compact }) {
  const pubDate = post.pubDate ? new Date(post.pubDate) : null;
  const sourceMeta = {
    blog: { color: B.wavesBlue, label: 'Waves', icon: 'waves' },
    newsletter: { color: B.orange, label: 'Newsletter', icon: 'newspaper' },
    ifas: { color: B.green, label: 'UF/IFAS', icon: 'leaf' },
    local: { color: B.grayMid, label: 'Local', icon: 'map' },
  };
  const meta = sourceMeta[post.source] || { color: B.grayMid, label: post.sourceName || 'Article', icon: 'document' };
  const srcColor = meta.color;
  const sourceLabel = post.sourceName || meta.label;

  // Defense in depth — server already filters, but never trust a URL
  // coming off an external RSS feed. Only http(s) links are rendered, and
  // images used in CSS backgrounds must not contain url(...) breakouts.
  const safeHref = (() => {
    try {
      const u = new URL(post.link, window.location.origin);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
    } catch { return null; }
  })();
  const safeImg = (() => {
    if (!post.image) return null;
    try {
      const u = new URL(post.image, window.location.origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const s = u.toString();
      return /[\s"'<>\\)]/.test(s) ? null : s;
    } catch { return null; }
  })();

  if (!safeHref) return null;

  return (
    <a href={safeHref} target="_blank" rel="noopener noreferrer" style={{
      background: B.white,
      borderRadius: 8,
      overflow: 'hidden',
      border: '1px solid #E1E7EF',
      textDecoration: 'none',
      display: 'flex',
      flexDirection: large ? 'column' : 'row',
      minHeight: large ? 0 : 104,
      boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    }}>
      {safeImg && large && (
        <div style={{
          height: compact ? 130 : 170,
          background: `url("${safeImg}") center/cover no-repeat`,
          borderBottom: '1px solid #E1E7EF',
        }} />
      )}
      {!safeImg && large && (
        <div style={{
          height: compact ? 92 : 124,
          background: '#EEF6FF',
          borderBottom: '1px solid #E1E7EF',
          color: B.blueDeeper,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Icon name={meta.icon} size={30} strokeWidth={1.8} />
        </div>
      )}
      <div style={{
        padding: large ? 16 : 14,
        display: 'flex',
        gap: 12,
        flex: 1,
        minWidth: 0,
      }}>
        {safeImg && !large && (
          <div style={{
            width: 64,
            height: 64,
            borderRadius: 8,
            flexShrink: 0,
            background: `url("${safeImg}") center/cover no-repeat, ${B.blueSurface}`,
          }} />
        )}
        {!safeImg && !large && (
          <span style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: '#EEF6FF',
            color: B.blueDeeper,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon name={meta.icon} size={18} strokeWidth={2} />
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 12,
              fontWeight: 850,
              padding: '4px 7px',
              borderRadius: 8,
              background: `${srcColor}18`,
              color: srcColor,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}>
              <Icon name={meta.icon} size={12} strokeWidth={2} />
              {sourceLabel}
            </span>
            {pubDate && !isNaN(pubDate) && (
              <span style={{ fontSize: 12, color: '#64748B' }}>
                {pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
          <div style={{
            fontSize: large ? 17 : 14,
            fontWeight: 850,
            color: B.blueDeeper,
            lineHeight: 1.35,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: large ? 2 : 3,
            WebkitBoxOrient: 'vertical',
          }}>{post.title}</div>
          {post.description && (large || !safeImg) && (
            <div style={{
              fontSize: 14,
              color: '#64748B',
              marginTop: 7,
              lineHeight: 1.45,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: large ? 3 : 2,
              WebkitBoxOrient: 'vertical',
            }}>{post.description}</div>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: B.blueDeeper, fontWeight: 850, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Read article <Icon name="arrowRight" size={13} strokeWidth={2} />
          </div>
        </div>
      </div>
    </a>
  );
}

function LearnTab({ customer }) {
  const compact = useIsMobile(760);
  const [alerts, setAlerts] = useState([]);
  const [blogPosts, setBlogPosts] = useState([]);
  const [newsletterPosts, setNewsletterPosts] = useState([]);
  const [expertPosts, setExpertPosts] = useState([]);
  const [localNews, setLocalNews] = useState([]);
  const [faq, setFaq] = useState([]);
  const [monthlyTip, setMonthlyTip] = useState(null);
  const [expandedFaq, setExpandedFaq] = useState(null);
  const [faqSearch, setFaqSearch] = useState('');
  const [showAllPosts, setShowAllPosts] = useState(false);
  const [nextService, setNextService] = useState(null);

  useEffect(() => {
    api.getAlerts().then(d => setAlerts(d.alerts || [])).catch(() => {});
    api.getBlogPosts().then(d => setBlogPosts(d.posts || [])).catch(() => {});
    api.getNewsletterPosts().then(d => setNewsletterPosts(d.posts || [])).catch(() => {});
    api.getExpertPosts().then(d => setExpertPosts(d.posts || [])).catch(() => {});
    api.getLocalNews().then(d => setLocalNews(d.posts || [])).catch(() => {});
    api.getFaq().then(d => setFaq(d.categories || [])).catch(() => {});
    api.getMonthlyTip().then(setMonthlyTip).catch(() => {});
    api.getNextService().then(d => setNextService(d.next || null)).catch(() => {});
  }, []);

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 12,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
  const secondaryButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '9px 12px',
    fontSize: 14,
    letterSpacing: 0,
  };
  const iconTile = {
    width: 38,
    height: 38,
    borderRadius: 8,
    background: '#EEF6FF',
    color: B.blueDeeper,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
  const alertColors = { urgent: B.red, seasonal: B.orange, info: B.wavesBlue };
  const postLimit = compact ? 3 : 4;
  const allWavesPosts = [...blogPosts, ...newsletterPosts]
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  const wavesPosts = showAllPosts ? allWavesPosts : allWavesPosts.slice(0, postLimit);
  const hasMorePosts = allWavesPosts.length > postLimit;
  const allContent = [...allWavesPosts, ...expertPosts, ...localNews]
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  const latestContent = allContent[0];
  const totalFaqQuestions = faq.reduce((sum, cat) => sum + (cat.questions?.length || 0), 0);

  const tierName = customer?.tier || 'Bronze';
  const numServices = TIER_SERVICES[tierName] || 1;
  const customerServiceNames = SERVICE_CATALOG
    .slice(0, numServices)
    .map(s => s.name.replace(/ Program| Barrier Treatment/g, '').replace('Quarterly ', ''));

  const filteredFaq = faqSearch.trim()
    ? faq.map(cat => ({
        ...cat,
        questions: cat.questions.filter(q =>
          `${q.q} ${q.a}`.toLowerCase().includes(faqSearch.toLowerCase())
        ),
      })).filter(cat => cat.questions.length > 0)
    : faq;

  const personalizeFaqAnswer = (answer) => {
    if (!answer || !tierName) return answer;
    return answer
      .replace(/your (plan|membership|tier)/gi, `your WaveGuard ${tierName}`)
      .replace(/unlimited callbacks/gi, `unlimited callbacks (included with WaveGuard ${tierName})`)
      .replace(/callback guarantee/gi, `callback guarantee (${tierName} benefit)`);
  };

  const faqIconFor = (category = '') => {
    const text = category.toLowerCase();
    if (text.includes('lawn') || text.includes('grass')) return 'sprout';
    if (text.includes('billing') || text.includes('payment')) return 'card';
    if (text.includes('termite')) return 'shield';
    if (text.includes('schedule') || text.includes('service')) return 'calendar';
    if (text.includes('mosquito') || text.includes('pest')) return 'bug';
    return 'bulb';
  };

  const renderFeedSection = (title, icon, posts, emptyText) => (
    <section style={{ ...card, padding: 18, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={iconTile}><Icon name={icon} size={18} strokeWidth={2} /></span>
          <div>
            <div style={sectionTitle}>{title}</div>
            <div style={{ marginTop: 2, fontSize: 14, color: muted }}>{posts.length} item{posts.length === 1 ? '' : 's'}</div>
          </div>
        </div>
      </div>
      {posts.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {posts.slice(0, 4).map((p, i) => (
            <ContentCard key={`${title}-${i}`} post={p} compact={compact} />
          ))}
        </div>
      ) : (
        <div style={{ padding: 16, borderRadius: 8, background: subtle, border: '1px solid #E1E7EF', fontSize: 14, color: muted }}>
          {emptyText}
        </div>
      )}
    </section>
  );

  const latestDate = latestContent?.pubDate ? new Date(latestContent.pubDate) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              borderRadius: 999,
              background: '#EEF6FF',
              color: B.blueDeeper,
              fontSize: 12,
              fontWeight: 850,
            }}>
              <Icon name="bulb" size={14} strokeWidth={2} />
              Learning Center
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Learn
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              Seasonal pest and lawn guidance for Southwest Florida, plus answers tied to your WaveGuard plan.
            </div>
          </div>
          <div style={{
            minWidth: compact ? '100%' : 220,
            padding: '14px 16px',
            borderRadius: 8,
            background: subtle,
            border: '1px solid #E1E7EF',
            boxSizing: 'border-box',
          }}>
            <div style={sectionTitle}>Your Plan</div>
            <div style={{ marginTop: 3, fontSize: 22, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>
              WaveGuard {tierName}
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: muted }}>
              {numServices} included service{numServices === 1 ? '' : 's'} in your guidance.
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
          gap: 10,
          marginTop: 22,
        }}>
          {[
            { label: 'Waves Articles', value: allWavesPosts.length, sub: 'Blog and newsletter' },
            { label: 'Expert Sources', value: expertPosts.length, sub: 'UF/IFAS and references' },
            { label: 'FAQ Answers', value: totalFaqQuestions, sub: 'Service and lawn topics' },
            {
              label: 'Latest',
              value: latestDate && !isNaN(latestDate) ? latestDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'None',
              sub: latestContent?.title || 'No articles loaded yet',
            },
          ].map(item => (
            <div key={item.label} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: subtle,
              padding: 14,
              minHeight: 78,
              minWidth: 0,
              boxSizing: 'border-box',
            }}>
              <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>{item.label}</div>
              <div style={{
                marginTop: 6,
                color: B.blueDeeper,
                fontSize: typeof item.value === 'number' ? 20 : 16,
                fontWeight: 850,
                lineHeight: 1.2,
                fontFamily: FONTS.ui,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{item.value}</div>
              <div style={{ marginTop: 3, color: muted, fontSize: 12, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      <WeatherPestWidget customer={customer} nextService={nextService} />

      {alerts.length > 0 && (
        <section style={{ ...card, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={iconTile}><Icon name="warning" size={18} strokeWidth={2} /></span>
            <div>
              <div style={sectionTitle}>SWFL Alerts</div>
              <div style={{ marginTop: 2, fontSize: 14, color: muted }}>Local pest and lawn notices.</div>
            </div>
          </div>
          <div style={{
            display: 'grid',
            gridAutoFlow: compact ? 'column' : 'row',
            gridAutoColumns: compact ? 'minmax(260px, 82%)' : undefined,
            gridTemplateColumns: compact ? undefined : 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
            overflowX: compact ? 'auto' : 'visible',
            WebkitOverflowScrolling: 'touch',
            paddingBottom: compact ? 2 : 0,
          }}>
            {alerts.map((a, i) => (
              <div key={i} style={{
                background: subtle,
                borderRadius: 8,
                padding: 14,
                border: '1px solid #E1E7EF',
                borderLeft: `4px solid ${alertColors[a.type] || B.wavesBlue}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                  <Icon name={a.type === 'urgent' ? 'warning' : a.type === 'seasonal' ? 'sun' : 'bell'} size={16} strokeWidth={2} style={{ color: alertColors[a.type] || B.wavesBlue }} />
                  <span style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{a.title}</span>
                </div>
                <div style={{ fontSize: 14, color: muted, lineHeight: 1.45 }}>{a.desc}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {monthlyTip && (
        <section style={{ ...card, padding: 18 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span style={iconTile}><Icon name="sparkles" size={18} strokeWidth={2} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={sectionTitle}>{monthlyTip.month} Homeowner Tip</div>
              <div style={{ marginTop: 5, fontSize: 18, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.heading, lineHeight: 1.25 }}>
                {monthlyTip.title}
              </div>
              <div style={{ marginTop: 7, fontSize: 14, color: B.grayDark, lineHeight: 1.6 }}>
                {monthlyTip.tip}
              </div>
              {customerServiceNames.length > 0 && (
                <div style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 8,
                  background: subtle,
                  border: '1px solid #E1E7EF',
                  fontSize: 14,
                  color: muted,
                  lineHeight: 1.45,
                }}>
                  Your {tierName} plan includes {customerServiceNames.join(', ')}.
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <section style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={iconTile}><Icon name="waves" size={18} strokeWidth={2} /></span>
            <div>
              <div style={sectionTitle}>From Waves</div>
              <div style={{ marginTop: 2, fontSize: 14, color: muted }}>{allWavesPosts.length} article{allWavesPosts.length === 1 ? '' : 's'} and newsletter issue{allWavesPosts.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          {hasMorePosts && (
            <button type="button" onClick={() => setShowAllPosts(v => !v)} style={secondaryButton}>
              {showAllPosts ? 'Show less' : `View all (${allWavesPosts.length})`}
            </button>
          )}
        </div>

        {wavesPosts.length > 0 ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact || wavesPosts.length < 2 ? '1fr' : 'minmax(0, 1.15fr) minmax(280px, 0.85fr)',
            gap: 10,
          }}>
            <ContentCard post={wavesPosts[0]} large compact={compact} />
            {wavesPosts.length > 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {wavesPosts.slice(1).map((p, i) => (
                  <ContentCard key={`waves-${i}`} post={p} compact={compact} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{
            padding: 18,
            borderRadius: 8,
            background: subtle,
            border: '1px solid #E1E7EF',
            fontSize: 14,
            color: muted,
          }}>
            New Waves articles and newsletter issues will appear here.
          </div>
        )}

        <div style={{
          marginTop: 14,
          padding: 16,
          background: B.sand,
          border: '1px solid #E1E7EF',
          borderRadius: 8,
        }}>
          <NewsletterSignup
            variant="light"
            source="portal_learn"
            heading="Get the next issue in your inbox"
            blurb="Local SWFL events, seasonal pest tips, and the occasional deal - straight from the truck."
          />
        </div>
      </section>

      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr' : 'repeat(2, minmax(0, 1fr))',
        gap: 16,
      }}>
        {renderFeedSection('From the Experts', 'leaf', expertPosts, 'Expert pest and lawn references will appear here.')}
        {renderFeedSection('Local Suncoast News', 'map', localNews, 'Local Suncoast updates will appear here.')}
      </div>

      {(filteredFaq.length > 0 || faqSearch.trim()) && (
        <section style={{ ...card, padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={iconTile}><Icon name="message" size={18} strokeWidth={2} /></span>
              <div>
                <div style={sectionTitle}>Pest & Lawn FAQ</div>
                <div style={{ marginTop: 2, fontSize: 14, color: muted }}>{totalFaqQuestions} answer{totalFaqQuestions === 1 ? '' : 's'} available</div>
              </div>
            </div>
            <a href="sms:+19412975749" style={{
              ...secondaryButton,
              textDecoration: 'none',
              display: 'inline-flex',
              gap: 7,
              alignItems: 'center',
            }}>
              <Icon name="message" size={14} strokeWidth={2} /> Text Us
            </a>
          </div>

          <div style={{ position: 'relative', marginBottom: 12 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: muted, pointerEvents: 'none' }}>
              <Icon name="search" size={16} strokeWidth={2} />
            </span>
            <input
              type="text"
              value={faqSearch}
              onChange={e => setFaqSearch(e.target.value)}
              placeholder="Search questions..."
              aria-label="Search pest and lawn questions"
              style={{
                width: '100%',
                padding: '10px 14px 10px 38px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
                fontFamily: FONTS.body,
                color: B.blueDeeper,
                outline: 'none',
                boxSizing: 'border-box',
              }}
              onFocus={e => e.target.style.borderColor = B.wavesBlue}
              onBlur={e => e.target.style.borderColor = '#CBD5E1'}
            />
          </div>

          {filteredFaq.length === 0 && faqSearch.trim() && (
            <div style={{ textAlign: 'center', padding: 20, color: muted, fontSize: 14 }}>
              No results for "{faqSearch}". Try different keywords or text us below.
            </div>
          )}

          {filteredFaq.map(cat => (
            <div key={cat.category} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...iconTile, width: 30, height: 30 }}>
                  <Icon name={faqIconFor(cat.category)} size={15} strokeWidth={2} />
                </span>
                {cat.category}
              </div>
              {cat.questions.map((q, qi) => {
                const faqId = `${cat.category}-${qi}`;
                const isOpen = expandedFaq === faqId;
                return (
                  <div key={qi} style={{
                    background: isOpen ? subtle : B.white,
                    borderRadius: 8,
                    marginBottom: 8,
                    border: `1px solid ${isOpen ? '#A7DDF8' : '#E1E7EF'}`,
                    overflow: 'hidden',
                  }}>
                    <button
                      type="button"
                      onClick={() => setExpandedFaq(isOpen ? null : faqId)}
                      aria-expanded={isOpen}
                      style={{
                        width: '100%',
                        padding: '13px 14px',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                        border: 'none',
                        background: 'transparent',
                        textAlign: 'left',
                        fontFamily: FONTS.body,
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, flex: 1 }}>{q.q}</span>
                      <Icon name="chevronDown" size={18} strokeWidth={2} style={{ color: muted, transform: isOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }} />
                    </button>
                    {isOpen && (
                      <div style={{ padding: '0 14px 14px', borderTop: '1px solid #E1E7EF' }}>
                        <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.65, marginTop: 10 }}>
                          {personalizeFaqAnswer(q.a)}
                        </div>
                        {(q.a?.toLowerCase().includes('callback') || q.a?.toLowerCase().includes('guarantee')) && (
                          <div style={{
                            marginTop: 10,
                            padding: '9px 11px',
                            borderRadius: 8,
                            background: `${B.green}10`,
                            fontSize: 12,
                            color: B.green,
                            fontWeight: 850,
                          }}>
                            As a {tierName} member, you have unlimited callbacks between services.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// =========================================================================
// SERVICE CATALOG — pricing & details for My Plan
// =========================================================================
const SERVICE_CATALOG = [
  {
    id: 'pest_control', name: 'Quarterly Pest Control', icon: 'bug',
    frequencies: ['Quarterly (4x)', 'Bi-Monthly (6x)', 'Monthly (12x)'],
    basePrice: 55, description: 'Interior + exterior treatment, granular perimeter band, bait station check, cobweb sweep on all eaves',
    products: ['Demand CS', 'Advion WDG Granular', 'Alpine WSG'],
  },
  {
    id: 'lawn_care', name: 'Lawn Care Program', icon: 'sprout',
    frequencies: ['4x per year', '6x per year', '9x per year', '12x per year'],
    basePrice: 65, description: 'Fertilization, weed control, fungicide treatments, soil testing, thatch monitoring',
    products: ['Prodiamine 65 WDG', 'Celsius WG', '16-4-8 + Micros', 'Headway G'],
  },
  {
    id: 'mosquito', name: 'Mosquito Barrier Treatment', icon: 'bug',
    frequencies: ['Monthly (Apr–Oct)', 'Year-Round (12x)'],
    basePrice: 45, description: 'Perimeter barrier spray, standing water treatment, foliage and shrub line application',
    products: ['Cyzmic CS', 'Tekko Pro IGR'],
  },
  {
    id: 'tree_shrub', name: 'Tree & Shrub Program', icon: 'palm',
    frequencies: ['4x per year', '6x per year'],
    basePrice: 50, description: 'Deep root feeding, insect & disease treatment, palm injections (Arborjet)',
    products: ['Merit 75 WP', 'Keel Fungicide', 'Arborjet TREE-age'],
  },
  {
    id: 'termite', name: 'Termite Bait Monitoring', icon: '🪵',
    frequencies: ['Basic (annual inspection)', 'Premier (quarterly monitoring + warranty)'],
    basePrice: 35, description: 'Bait station installation, quarterly monitoring, damage warranty (Premier)',
    products: ['Sentricon Always Active', 'Trelona ATBS'],
  },
];

const ADD_ONS = [
  { id: 'palm_injection', name: 'Arborjet Palm Injection', icon: 'palm', price: 35, unit: '/palm', min: '$75/visit minimum', desc: 'Trunk-injected nutrients and pest protection for coconut, queen, and royal palms' },
  { id: 'top_dressing', name: 'Top Dressing / Dethatching', icon: 'palm', price: 150, unit: '/service', min: 'Seasonal (fall recommended)', desc: 'Sand top-dressing to improve soil structure + mechanical dethatching when thatch exceeds 0.5"' },
  { id: 'fire_ant', name: 'Fire Ant Treatment', icon: 'flame', price: 40, unit: '/treatment', min: 'As needed', desc: 'Broadcast granular bait + individual mound drench for aggressive colonies' },
  { id: 'rodent', name: 'Rodent Bait Stations', icon: 'mouse', price: 30, unit: '/month', min: 'Monthly monitoring', desc: 'Tamper-resistant exterior bait stations, monthly monitoring and reporting' },
  { id: 'wdo_inspection', name: 'WDO Inspection', icon: 'clipboard', price: 250, unit: '', min: 'Real estate transaction?', desc: 'Wood-destroying organism inspection report for real estate closings. FL Form 13645 compliant. Includes full attic, crawl space, and exterior assessment.' },
];

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const TIER_SERVICES = { Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
const TIER_DISCOUNTS = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };

const TIER_SERVICE_NAMES = {
  Bronze: ['Quarterly Pest Control'],
  Silver: ['Quarterly Pest Control', 'Lawn Care Program'],
  Gold: ['Quarterly Pest Control', 'Lawn Care Program', 'Mosquito Barrier Treatment'],
  Platinum: ['Quarterly Pest Control', 'Lawn Care Program', 'Mosquito Barrier Treatment', 'Tree & Shrub Program'],
};

// Coverage details for each included service
const SERVICE_COVERAGE = {
  pest_control: { summary: 'Unlimited callbacks within 30 days. Interior re-treatment included.', details: ['Interior + exterior perimeter treatment', 'Granular bait band around foundation', 'Bait station monitoring', 'Cobweb sweep on all eaves', 'Free callback if pests return within 30 days'] },
  lawn_care: { summary: 'Fertilization, weed control, fungicide. Callbacks for breakthrough weeds.', details: ['Custom fertilization for your turf type', 'Pre-emergent and post-emergent weed control', 'Fungicide treatments as needed', 'Soil testing and thatch monitoring', 'Callback for breakthrough weeds between visits'] },
  mosquito: { summary: 'Barrier treatments Apr-Oct. Re-spray within 14 days of heavy rain.', details: ['Monthly perimeter barrier spray (Apr-Oct)', 'Standing water treatment with larvicide', 'Foliage and shrub line application', 'Free re-spray within 14 days of heavy rain', 'Event spray available on request'] },
  tree_shrub: { summary: 'Deep root feeding, insect & disease treatment, palm injections.', details: ['Deep root fertilization', 'Insect and disease treatment', 'Palm trunk injections (Arborjet)', 'Seasonal monitoring and reporting'] },
  termite: { summary: 'Bait station installation and monitoring with damage warranty.', details: ['Bait station installation around perimeter', 'Quarterly monitoring inspections', 'Damage warranty (Premier tier)', 'Annual re-certification report'] },
};

// Service schedule months for calendar view
const SERVICE_SCHEDULE_MONTHS = {
  pest_control: [0, 3, 6, 9],        // Jan, Apr, Jul, Oct (quarterly)
  lawn_care: [0, 2, 5, 8],            // Jan, Mar, Jun, Sep (4x/year)
  mosquito: [3, 4, 5, 6, 7, 8, 9],   // Apr-Oct
  tree_shrub: [1, 4, 7, 10],          // Feb, May, Aug, Nov
  termite: [0, 3, 6, 9],              // Quarterly
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Hidden badge types (engagement-tracking ones we don't show)
const HIDDEN_BADGE_TYPES = ['portal_regular', 'document_downloader', 'doc_downloader', 'responsive', 'early_adopter', 'feedback_hero', 'portal_explorer', 'feedback_champion'];

// =========================================================================
// MY PLAN TAB
// =========================================================================
function MyPlanTab({ customer }) {
  const [expandedService, setExpandedService] = useState(null);
  const [expandedAddon, setExpandedAddon] = useState(null);
  const [nextService, setNextService] = useState(null);
  const [serviceHistory, setServiceHistory] = useState([]);
  const [addonRequested, setAddonRequested] = useState({});
  const [addonSubmitting, setAddonSubmitting] = useState({});
  const [showPauseForm, setShowPauseForm] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [pauseDuration, setPauseDuration] = useState('1');
  const [pauseReason, setPauseReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelDetails, setCancelDetails] = useState('');
  const [pauseSubmitted, setPauseSubmitted] = useState(false);
  const [cancelSubmitted, setCancelSubmitted] = useState(false);
  const [pauseSubmitting, setPauseSubmitting] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [upgradeRequested, setUpgradeRequested] = useState({});
  const [upgradeSubmitting, setUpgradeSubmitting] = useState({});
  const lawnHealth = useLawnHealth(customer.id);
  const compact = useIsMobile(760);

  useEffect(() => {
    api.getNextService().then(d => setNextService(d.next || null)).catch(console.error);
    api.getServices({ limit: 50 }).then(d => {
      if (d.services) setServiceHistory(d.services);
    }).catch(console.error);
  }, []);

  const tier = TIER[customer.tier];
  const tierName = customer.tier || 'Bronze';
  const tierIdx = TIER_ORDER.indexOf(tierName);
  const discount = TIER_DISCOUNTS[tierName] || 0;
  const memberMonths = customer.memberSince
    ? Math.max(1, Math.round((new Date() - parseDate(customer.memberSince)) / (1000 * 60 * 60 * 24 * 30)))
    : 0;
  const numServices = TIER_SERVICES[tierName] || 1;

  // Calculate annual savings
  const totalFullPrice = SERVICE_CATALOG.slice(0, numServices).reduce((sum, s) => sum + s.basePrice * 12, 0);
  const annualSavings = totalFullPrice * discount;
  const monthlyRate = customer.monthlyRate || 0;

  // Build bundled services one-liner
  const includedServices = SERVICE_CATALOG.slice(0, numServices);
  const bundleSummary = includedServices.map(s => s.name.replace(/ Program| Barrier Treatment| Control/g, '').replace('Quarterly ', '')).join(' + ');

  // Build plan history timeline from member data
  const planTimeline = [];
  if (customer.memberSince) {
    const startDate = parseDate(customer.memberSince);
    planTimeline.push({ date: startDate, label: `Started WaveGuard ${tierName}`, icon: 'rocket' });
  }
  if (customer.activity_log) {
    customer.activity_log.forEach(a => {
      if (a.type === 'tier_change' || a.type === 'upgrade') {
        planTimeline.push({ date: parseDate(a.date), label: a.description || `Upgraded to ${a.tier || 'new tier'}`, icon: 'upgrade' });
      }
      if (a.type === 'service_added') {
        planTimeline.push({ date: parseDate(a.date), label: a.description || `Added ${a.service || 'service'}`, icon: 'plus' });
      }
    });
  }
  // If no activity log, construct from tier
  if (planTimeline.length === 1 && tierIdx > 0) {
    const startDate = parseDate(customer.memberSince);
    const upgradeDate = new Date(startDate);
    upgradeDate.setMonth(upgradeDate.getMonth() + Math.floor(memberMonths * 0.4));
    planTimeline.push({ date: upgradeDate, label: `Upgraded to ${tierName}`, icon: 'upgrade' });
  }
  if (numServices >= 3 && planTimeline.length <= 2) {
    const startDate = parseDate(customer.memberSince);
    const addDate = new Date(startDate);
    addDate.setMonth(addDate.getMonth() + Math.floor(memberMonths * 0.6));
    planTimeline.push({ date: addDate, label: 'Added mosquito service', icon: 'bug' });
  }
  planTimeline.sort((a, b) => a.date - b.date);

  // Current month for calendar
  const now = parseDate(etDateString());
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // Determine completed months from service history
  const getCompletedMonths = (svcId) => {
    const completed = new Set();
    serviceHistory.forEach(s => {
      const svcType = (s.serviceType || s.type || '').toLowerCase();
      const matchesService = (
        (svcId === 'pest_control' && (svcType.includes('pest') || svcType.includes('general'))) ||
        (svcId === 'lawn_care' && (svcType.includes('lawn') || svcType.includes('fertiliz'))) ||
        (svcId === 'mosquito' && svcType.includes('mosquito')) ||
        (svcId === 'tree_shrub' && (svcType.includes('tree') || svcType.includes('shrub'))) ||
        (svcId === 'termite' && svcType.includes('termite'))
      );
      if (matchesService && s.date) {
        const d = parseDate(s.date);
        if (d.getFullYear() === currentYear) {
          completed.add(d.getMonth());
        }
      }
    });
    return completed;
  };

  // Included service IDs for filtering add-ons
  const includedServiceIds = includedServices.map(s => s.id);

  // Filter add-ons that are NOT already included in the plan
  const availableAddOns = ADD_ONS.filter(addon => {
    // Don't filter based on overlap; just exclude exact matches.
    return !includedServiceIds.includes(addon.id);
  });

  const money = (n, digits = 2) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const nextDate = nextService ? parseDate(nextService.date) : null;
  const nextVisitLabel = nextDate && !isNaN(nextDate)
    ? nextDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'No visit scheduled';
  const memberSinceLabel = customer.memberSince
    ? parseDate(customer.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : 'Not set';
  const currentAnnual = totalFullPrice - annualSavings;
  const renewalCredit = Math.min(75, Math.round(memberMonths * 6.25));

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 14,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  };
  const primaryButton = {
    ...BUTTON_BASE,
    background: B.blueDeeper,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const secondaryButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const smallLinkButton = {
    border: 'none',
    background: 'transparent',
    color: muted,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: FONTS.body,
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    padding: '8px 10px',
    minHeight: 36,
  };
  const iconName = (name) => (typeof name === 'string' && /^[a-z]/i.test(name) ? name : 'shield');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '5px 10px', borderRadius: 999,
              background: tier ? `${tier.color}18` : '#EEF6FF',
              color: B.blueDeeper, fontSize: 12, fontWeight: 850,
            }}>
              WaveGuard {tierName}
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Your plan
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              {bundleSummary || 'Recurring service'} - {numServices} service{numServices > 1 ? 's' : ''} bundled
            </div>
          </div>
          <div style={{
            minWidth: compact ? '100%' : 190,
            padding: '14px 16px',
            borderRadius: 8,
            background: '#F0FDF4',
            border: '1px solid #BBF7D0',
            boxSizing: 'border-box',
          }}>
            <div style={{ fontSize: 12, color: '#047857', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Active plan
            </div>
            <div style={{ marginTop: 3, fontSize: 24, fontWeight: 850, color: B.blueDeeper }}>
              {money(monthlyRate)}
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: muted }}>per month</div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: 10,
          marginTop: 22,
        }}>
          {[
            { label: 'Next visit', value: nextVisitLabel, sub: nextService?.serviceType || 'Schedule' },
            { label: 'Bundle discount', value: `${Math.round(discount * 100)}%`, sub: `${money(annualSavings)}/yr saved` },
            { label: 'Member since', value: memberSinceLabel, sub: `${memberMonths} month${memberMonths === 1 ? '' : 's'}` },
            { label: 'Renewal credit', value: money(renewalCredit, 0), sub: 'Month 13' },
          ].map((item) => (
            <div key={item.label} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: subtle,
              padding: 14,
              minHeight: 74,
            }}>
              <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>{item.label}</div>
              <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 18, fontWeight: 850, lineHeight: 1.1 }}>{item.value}</div>
              <div style={{ marginTop: 3, color: muted, fontSize: 12 }}>{item.sub}</div>
            </div>
          ))}
        </div>
      </section>

      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr' : 'minmax(0, 1.35fr) minmax(300px, .65fr)',
        gap: 16,
        alignItems: 'start',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section style={{ ...card, overflow: 'hidden' }}>
            <div style={{ padding: 20, borderBottom: '1px solid #E1E7EF' }}>
              <div style={sectionTitle}>Included Services</div>
              <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 20, fontWeight: 850 }}>
                {tierName} covers {numServices} recurring service{numServices > 1 ? 's' : ''}
              </div>
            </div>

            <div>
              {includedServices.map((svc, index) => {
                const completedMonths = getCompletedMonths(svc.id);
                const scheduleMonths = SERVICE_SCHEDULE_MONTHS[svc.id] || [];
                const totalVisits = scheduleMonths.length;
                const completedVisits = scheduleMonths.filter(m => completedMonths.has(m)).length;
                const annualSavingsForService = svc.basePrice * 12 * discount;
                const progress = totalVisits > 0 ? Math.round((completedVisits / totalVisits) * 100) : 0;
                const coverage = SERVICE_COVERAGE[svc.id];
                const expanded = expandedService === svc.id;
                return (
                  <div key={svc.id} style={{
                    borderTop: index === 0 ? 'none' : '1px solid #E1E7EF',
                    padding: 18,
                  }}>
                    <button
                      type="button"
                      onClick={() => setExpandedService(expanded ? null : svc.id)}
                      aria-expanded={expanded}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        width: '100%',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: FONTS.body,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
                          <span style={{
                            width: 38,
                            height: 38,
                            borderRadius: 8,
                            background: '#EEF6FF',
                            color: B.blueDeeper,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}>
                            <Icon name={iconName(svc.icon)} size={20} strokeWidth={1.8} />
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 16, fontWeight: 850, color: B.blueDeeper }}>{svc.name}</span>
                            <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: muted }}>{svc.frequencies[0]}</span>
                            {svc.id === 'lawn_care' && !lawnHealth.loading && lawnHealth.hasLawnCare && lawnHealth.scores && lawnHealth.initialScores && (() => {
                              const avg = Math.round((lawnHealth.scores.turfDensity + lawnHealth.scores.weedSuppression + lawnHealth.scores.fungusControl + lawnHealth.scores.thatchScore) / 4);
                              const initialAvg = Math.round((lawnHealth.initialScores.turfDensity + lawnHealth.initialScores.weedSuppression + lawnHealth.initialScores.fungusControl + lawnHealth.initialScores.thatchScore) / 4);
                              const improving = avg >= initialAvg;
                              return (
                                <span style={{ display: 'block', marginTop: 3, fontSize: 12, color: improving ? B.green : B.orange, fontWeight: 800 }}>
                                  Lawn health {avg}% {improving ? `(up from ${initialAvg}%)` : `(from ${initialAvg}%)`}
                                </span>
                              );
                            })()}
                          </span>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 12, color: muted }}>{completedVisits}/{totalVisits || 0} visits</div>
                          <div style={{ marginTop: 4, fontSize: 14, color: annualSavingsForService > 0 ? B.green : muted, fontWeight: 850 }}>
                            {annualSavingsForService > 0 ? `${money(annualSavingsForService)}/yr saved` : `${money(svc.basePrice * 12)}/yr`}
                          </div>
                        </div>
                      </div>
                    </button>

                    <div style={{ marginTop: 12, height: 5, borderRadius: 999, background: '#E8EEF5', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.max(0, Math.min(100, progress))}%`,
                        borderRadius: 999,
                        background: B.wavesBlue,
                      }} />
                    </div>

                    {expanded && (
                      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #E1E7EF' }}>
                        <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55 }}>{svc.description}</div>
                        {coverage && (
                          <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: subtle, border: '1px solid #E1E7EF' }}>
                            <div style={{ fontSize: 14, color: B.blueDeeper, fontWeight: 850 }}>{coverage.summary}</div>
                            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                              {coverage.details.map((detail) => (
                                <div key={detail} style={{ display: 'flex', gap: 8, color: B.grayDark, fontSize: 14, lineHeight: 1.45 }}>
                                  <Icon name="check" size={14} strokeWidth={2} style={{ color: B.green, marginTop: 2 }} />
                                  <span>{detail}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {svc.products?.length ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                            {svc.products.map((product) => (
                              <span key={product} style={{
                                padding: '4px 9px',
                                borderRadius: 999,
                                background: '#EEF6FF',
                                color: B.blueDeeper,
                                fontSize: 12,
                                fontWeight: 700,
                              }}>{product}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ ...card, padding: 20 }}>
            <div style={sectionTitle}>Add To Plan</div>
            <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 20, fontWeight: 850 }}>Common upgrades</div>
            <div style={{ marginTop: 4, color: muted, fontSize: 14 }}>
              {Math.round(discount * 100)}% {tierName} discount applies where eligible.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 16 }}>
              {availableAddOns.map((addon) => {
                const eligibleDiscount = discount > 0 && addon.id !== 'wdo_inspection';
                const planPrice = eligibleDiscount ? addon.price * (1 - discount) : addon.price;
                const expanded = expandedAddon === addon.id;
                return (
                  <div key={addon.id} style={{ border: '1px solid #E1E7EF', borderRadius: 8, padding: 14, background: subtle }}>
                    <div style={{ display: 'flex', gap: 10, minWidth: 0, alignItems: 'flex-start' }}>
                      <span style={{ color: B.blueDeeper, display: 'inline-flex', marginTop: 1, flexShrink: 0 }}>
                        <Icon name={iconName(addon.icon)} size={18} strokeWidth={1.8} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper, lineHeight: 1.25 }}>{addon.name}</div>
                        <div style={{ marginTop: 2, fontSize: 12, color: muted, lineHeight: 1.35 }}>{addon.min}</div>
                        <div style={{ marginTop: 8, color: B.blueDeeper, fontSize: 14, fontWeight: 850, lineHeight: 1.25 }}>
                          {money(planPrice)}{addon.unit}
                        </div>
                      </div>
                    </div>
                    {expanded && (
                      <div style={{ marginTop: 10, color: B.grayDark, fontSize: 14, lineHeight: 1.5 }}>
                        {addon.desc}
                        {eligibleDiscount && (
                          <div style={{ color: B.green, fontWeight: 800, marginTop: 6 }}>
                            Was {money(addon.price)}{addon.unit}
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={() => setExpandedAddon(expanded ? null : addon.id)}
                        style={{ ...secondaryButton, padding: '8px 11px', fontSize: 12 }}
                      >
                        {expanded ? 'Hide' : 'Details'}
                      </button>
                      {addonRequested[addon.id] ? (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          minHeight: 34,
                          padding: '0 10px',
                          color: B.green,
                          fontSize: 12,
                          fontWeight: 850,
                        }}>
                          <Icon name="check" size={14} strokeWidth={2} /> Request sent
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={addonSubmitting[addon.id]}
                          onClick={async () => {
                            if (addonSubmitting[addon.id]) return;
                            setAddonSubmitting(prev => ({ ...prev, [addon.id]: true }));
                            try {
                              await api.createRequest?.({ category: 'add_service', subject: `Add ${addon.name} to my plan`, description: `Customer requested to add ${addon.name} via portal.` });
                              setAddonRequested(prev => ({ ...prev, [addon.id]: true }));
                            } catch (err) {
                              alert(`Couldn't send request: ${err.message || 'please try again or call us at (941) 297-5749.'}`);
                            } finally {
                              setAddonSubmitting(prev => ({ ...prev, [addon.id]: false }));
                            }
                          }}
                          style={{
                            ...primaryButton,
                            padding: '8px 11px',
                            fontSize: 12,
                            opacity: addonSubmitting[addon.id] ? 0.65 : 1,
                            cursor: addonSubmitting[addon.id] ? 'wait' : 'pointer',
                          }}
                        >
                          {addonSubmitting[addon.id] ? 'Sending...' : 'Request'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ ...card, padding: 20 }}>
            <div style={sectionTitle}>Compare Plans</div>
            <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 20, fontWeight: 850 }}>WaveGuard tiers</div>
            <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginTop: 16 }}>
              {TIER_ORDER.map((tn, i) => {
                const t = TIER[tn];
                const isCurrent = tn === tierName;
                const isUpgrade = i > tierIdx;
                const disc = TIER_DISCOUNTS[tn];
                const services = TIER_SERVICE_NAMES[tn] || [];
                const tierMonthly = SERVICE_CATALOG.slice(0, TIER_SERVICES[tn]).reduce((sum, s) => sum + s.basePrice * (1 - disc), 0);
                return (
                  <div key={tn} style={{
                    border: `1px solid ${isCurrent ? B.wavesBlue : '#E1E7EF'}`,
                    borderRadius: 8,
                    background: isCurrent ? '#EEF6FF' : '#fff',
                    padding: 14,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 15, color: B.blueDeeper, fontWeight: 850 }}>{tn}</div>
                      {isCurrent && (
                        <span style={{ fontSize: 10, color: B.green, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          Current
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 22, color: B.blueDeeper, fontWeight: 850 }}>
                      {money(tierMonthly, 0)}<span style={{ fontSize: 12, color: muted, fontWeight: 600 }}>/mo</span>
                    </div>
                    <div style={{ marginTop: 3, color: disc > 0 ? B.green : muted, fontSize: 12, fontWeight: 800 }}>
                      {disc > 0 ? `${Math.round(disc * 100)}% bundle discount` : 'Base plan'}
                    </div>
                    <div style={{ display: 'grid', gap: 5, marginTop: 12 }}>
                      {services.slice(0, 4).map((svcName) => (
                        <div key={svcName} style={{ display: 'flex', gap: 6, fontSize: 12, color: B.grayDark, lineHeight: 1.35 }}>
                          <Icon name="check" size={13} strokeWidth={2} style={{ color: B.green, marginTop: 1 }} />
                          <span>{svcName.replace(/ Program| Barrier Treatment/g, '')}</span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 6, fontSize: 12, color: B.grayDark, lineHeight: 1.35 }}>
                        <Icon name="check" size={13} strokeWidth={2} style={{ color: B.green, marginTop: 1 }} />
                        <span>Unlimited callbacks</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 14 }}>
                      {isCurrent ? (
                        <span style={{ display: 'inline-flex', minHeight: 34, alignItems: 'center', color: B.green, fontSize: 12, fontWeight: 850 }}>
                          Active
                        </span>
                      ) : isUpgrade ? (
                        upgradeRequested[tn] ? (
                          <span style={{ display: 'inline-flex', minHeight: 34, alignItems: 'center', color: B.green, fontSize: 12, fontWeight: 850 }}>
                            Request sent
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={upgradeSubmitting[tn]}
                            onClick={async () => {
                              if (upgradeSubmitting[tn]) return;
                              setUpgradeSubmitting(prev => ({ ...prev, [tn]: true }));
                              try {
                                await api.createRequest?.({ category: 'upgrade', subject: `Upgrade to WaveGuard ${tn}`, description: `Customer requested tier upgrade from ${tierName} to ${tn}.` });
                                setUpgradeRequested(prev => ({ ...prev, [tn]: true }));
                              } catch (err) {
                                alert(`Couldn't send upgrade request: ${err.message || 'please try again or call us at (941) 297-5749.'}`);
                              } finally {
                                setUpgradeSubmitting(prev => ({ ...prev, [tn]: false }));
                              }
                            }}
                            style={{
                              ...primaryButton,
                              width: '100%',
                              padding: '8px 10px',
                              fontSize: 12,
                              opacity: upgradeSubmitting[tn] ? 0.65 : 1,
                              cursor: upgradeSubmitting[tn] ? 'wait' : 'pointer',
                            }}
                          >
                            {upgradeSubmitting[tn] ? 'Sending...' : 'Upgrade'}
                          </button>
                        )
                      ) : (
                        <a href="sms:+19412975749?body=Hi Waves, I'd like to discuss adjusting my WaveGuard plan." style={{
                          ...secondaryButton,
                          minHeight: 34,
                          padding: '8px 10px',
                          fontSize: 12,
                          textDecoration: 'none',
                          width: '100%',
                        }}>Contact</a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section style={{ ...card, padding: 20 }}>
            <div style={sectionTitle}>Year At A Glance</div>
            <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 20, fontWeight: 850 }}>{currentYear} service calendar</div>
            <div style={{ display: 'grid', gap: 15, marginTop: 16 }}>
              {includedServices.map((svc) => {
                const scheduleMonths = SERVICE_SCHEDULE_MONTHS[svc.id] || [];
                const completedMonths = getCompletedMonths(svc.id);
                return (
                  <div key={svc.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: B.blueDeeper, fontSize: 14, fontWeight: 850, marginBottom: 8 }}>
                      <Icon name={iconName(svc.icon)} size={14} strokeWidth={1.8} />
                      <span>{svc.name.replace(/ Program| Barrier Treatment/g, '')}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3 }}>
                      {MONTH_LABELS.map((month, mi) => {
                        const isScheduled = scheduleMonths.includes(mi);
                        const isCompleted = completedMonths.has(mi);
                        const isCurrentMonth = mi === currentMonth;
                        const isOverdue = isScheduled && !isCompleted && mi < currentMonth;
                        const fill = isCompleted ? B.green : isOverdue ? B.orange : isCurrentMonth && isScheduled ? B.wavesBlue : isScheduled ? '#CBD5E1' : 'transparent';
                        const border = isScheduled ? fill : '#E1E7EF';
                        const title = isScheduled
                          ? `${month}: ${isCompleted ? 'Completed' : isOverdue ? 'Pending or missed' : isCurrentMonth ? 'This month' : 'Scheduled'}`
                          : `${month}: No service`;
                        return (
                          <div key={month} title={title} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                            <div style={{
                              width: 12,
                              height: 12,
                              borderRadius: 999,
                              background: fill,
                              border: `1px solid ${border}`,
                              opacity: isScheduled ? 1 : 0.45,
                              boxShadow: isCurrentMonth && isScheduled ? `0 0 0 3px ${B.wavesBlue}18` : 'none',
                            }} />
                            <div style={{ fontSize: 9, color: muted }}>{month[0]}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ ...card, padding: 20 }}>
            <div style={sectionTitle}>Savings</div>
            <div style={{ marginTop: 8, color: B.green, fontSize: 34, fontWeight: 850, lineHeight: 1 }}>
              {money(annualSavings)}
            </div>
            <div style={{ marginTop: 6, color: muted, fontSize: 14, lineHeight: 1.5 }}>
              Full price {money(totalFullPrice)}/yr. Your current bundle is {money(currentAnnual)}/yr.
            </div>
          </section>

          {tier && (
            <section style={{ ...card, padding: 20 }}>
              <div style={sectionTitle}>Loyalty</div>
              <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                {[
                  { text: `${money(renewalCredit, 0)} annual renewal credit`, icon: 'money' },
                  tierIdx < TIER_ORDER.length - 1 && {
                    text: `${money(tierIdx >= 2 ? 100 : tierIdx >= 1 ? 50 : 25, 0)} upgrade credit toward ${TIER_ORDER[tierIdx + 1]}`,
                    icon: 'upgrade',
                  },
                  tierIdx >= 2 && { text: 'Priority hurricane scheduling', icon: 'tornado' },
                ].filter(Boolean).map((item) => (
                  <div key={item.text} style={{ display: 'flex', gap: 9, color: B.grayDark, fontSize: 14, lineHeight: 1.45 }}>
                    <Icon name={item.icon} size={16} strokeWidth={1.8} style={{ color: B.blueDeeper, marginTop: 1 }} />
                    <span>{item.text}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section style={{ ...card, padding: 20 }}>
            <div style={sectionTitle}>Plan History</div>
            <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
              {planTimeline.map((event) => (
                <div key={`${event.label}-${event.date}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: B.wavesBlue, marginTop: 6, flexShrink: 0 }} />
                  <span>
                    <span style={{ display: 'block', color: muted, fontSize: 12, fontWeight: 700 }}>
                      {!isNaN(event.date) ? event.date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Date unavailable'}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, color: B.blueDeeper, fontSize: 14, fontWeight: 800 }}>
                      <Icon name={iconName(event.icon)} size={14} strokeWidth={1.8} /> {event.label}
                    </span>
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: B.green, marginTop: 5, flexShrink: 0 }} />
                <span>
                  <span style={{ display: 'block', color: muted, fontSize: 12, fontWeight: 700 }}>Now</span>
                  <span style={{ display: 'block', marginTop: 2, color: B.green, fontSize: 14, fontWeight: 850 }}>
                    Active - WaveGuard {tierName}
                  </span>
                </span>
              </div>
            </div>
          </section>

          <section style={{ ...card, padding: 20 }}>
            <div style={sectionTitle}>Account Options</div>
            {!showPauseForm && !showCancelForm && !pauseSubmitted && !cancelSubmitted && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                <button type="button" onClick={() => setShowPauseForm(true)} style={smallLinkButton}>Pause My Plan</button>
                <button type="button" onClick={() => setShowCancelForm(true)} style={smallLinkButton}>Cancel</button>
              </div>
            )}

            {showPauseForm && !pauseSubmitted && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 15, color: B.blueDeeper, fontWeight: 850 }}>Pause My Plan</div>
                <div style={{ fontSize: 14, color: muted, marginTop: 4, lineHeight: 1.45 }}>
                  We will hold services and billing while your spot stays reserved.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {['1', '2'].map(d => (
                    <button key={d} type="button" onClick={() => setPauseDuration(d)} style={{
                      border: `1px solid ${pauseDuration === d ? B.wavesBlue : '#CBD5E1'}`,
                      background: pauseDuration === d ? '#EEF6FF' : '#fff',
                      color: pauseDuration === d ? B.blueDeeper : B.grayDark,
                      borderRadius: 8,
                      padding: '8px 12px',
                      cursor: 'pointer',
                      fontSize: 14,
                      fontWeight: 800,
                      fontFamily: FONTS.body,
                    }}>
                      {d} month{d === '2' ? 's' : ''}
                    </button>
                  ))}
                </div>
                <input
                  value={pauseReason}
                  onChange={e => setPauseReason(e.target.value)}
                  placeholder="Reason (optional)"
                  aria-label="Pause reason"
                  style={{
                    width: '100%',
                    marginTop: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    fontSize: 14,
                    border: '1px solid #CBD5E1',
                    fontFamily: FONTS.body,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={pauseSubmitting}
                    onClick={async () => {
                      if (pauseSubmitting) return;
                      setPauseSubmitting(true);
                      try {
                        await api.createRequest?.({
                          category: 'pause',
                          subject: `Pause plan for ${pauseDuration} month(s)`,
                          description: `Customer requested to pause their WaveGuard ${tierName} plan for ${pauseDuration} month(s). Reason: ${pauseReason || 'Not specified'}`,
                        });
                        setPauseSubmitted(true);
                        setShowPauseForm(false);
                      } catch (err) {
                        alert(`Couldn't submit pause request: ${err.message || 'please try again or call us at (941) 297-5749.'}`);
                      } finally {
                        setPauseSubmitting(false);
                      }
                    }}
                    style={{ ...primaryButton, opacity: pauseSubmitting ? 0.65 : 1, cursor: pauseSubmitting ? 'wait' : 'pointer' }}
                  >
                    {pauseSubmitting ? 'Sending...' : 'Submit Pause'}
                  </button>
                  <button type="button" onClick={() => setShowPauseForm(false)} style={secondaryButton}>Never mind</button>
                </div>
              </div>
            )}

            {pauseSubmitted && (
              <div style={{ marginTop: 12, color: B.green, fontSize: 14, fontWeight: 850, lineHeight: 1.5 }}>
                Pause request submitted. We will confirm within 1 business day.
              </div>
            )}

            {showCancelForm && !cancelSubmitted && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 15, color: B.blueDeeper, fontWeight: 850 }}>Cancellation Request</div>
                <div style={{ fontSize: 14, color: muted, marginTop: 4, lineHeight: 1.45 }}>
                  Pausing keeps your discount and service spot reserved.
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                  {['Moving', 'Cost', 'Not satisfied', 'Switching providers', 'Other'].map(r => (
                    <button key={r} type="button" onClick={() => setCancelReason(r)} style={{
                      padding: '7px 11px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 800,
                      border: `1px solid ${cancelReason === r ? B.red : '#CBD5E1'}`,
                      background: cancelReason === r ? `${B.red}10` : '#fff',
                      color: cancelReason === r ? B.red : B.grayDark,
                      cursor: 'pointer',
                      fontFamily: FONTS.body,
                    }}>{r}</button>
                  ))}
                </div>
                <textarea
                  value={cancelDetails}
                  onChange={e => setCancelDetails(e.target.value)}
                  placeholder="Anything else you'd like us to know?"
                  aria-label="Cancellation details"
                  rows={3}
                  style={{
                    width: '100%',
                    marginTop: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    fontSize: 14,
                    border: '1px solid #CBD5E1',
                    fontFamily: FONTS.body,
                    outline: 'none',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={cancelSubmitting}
                    onClick={async () => {
                      if (cancelSubmitting) return;
                      setCancelSubmitting(true);
                      try {
                        await api.createRequest?.({
                          category: 'cancellation',
                          subject: `Cancel WaveGuard ${tierName} plan`,
                          description: `Customer requested cancellation. Reason: ${cancelReason || 'Not specified'}. Details: ${cancelDetails || 'None'}`,
                        });
                        setCancelSubmitted(true);
                        setShowCancelForm(false);
                      } catch (err) {
                        alert(`Couldn't submit cancellation request: ${err.message || 'please try again or call us at (941) 297-5749.'}`);
                      } finally {
                        setCancelSubmitting(false);
                      }
                    }}
                    style={{ ...primaryButton, background: B.grayMid, opacity: cancelSubmitting ? 0.65 : 1, cursor: cancelSubmitting ? 'wait' : 'pointer' }}
                  >
                    {cancelSubmitting ? 'Sending...' : 'Submit Request'}
                  </button>
                  <button type="button" onClick={() => setShowCancelForm(false)} style={secondaryButton}>Keep My Plan</button>
                </div>
              </div>
            )}

            {cancelSubmitted && (
              <div style={{ marginTop: 12, color: B.grayDark, fontSize: 14, fontWeight: 850, lineHeight: 1.5 }}>
                Cancellation request received. We will reach out to finalize.
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

// =========================================================================
// EN-ROUTE LIVE MAP — Google Map with moving truck + customer pin.
//
// Rendered inside ServiceTracker when step === 3 AND both the tech's
// Bouncie position and the customer's geocode lat/lng are available
// on the tracker response. Parent ServiceTracker polls every 15s and
// passes fresh `techPosition` down; this component just animates the
// truck marker on each new prop. Falls back to null if anything's
// missing (no Maps key, no bouncie imei on tech, no geocoded customer,
// Maps script blocked) — the existing ETA card below handles the
// "no map" case.
// =========================================================================
function EnRouteLiveMap({ techPosition, customerLocation, techName }) {
  const mapRef = useRef(null);
  const mapInstRef = useRef(null);
  const truckMarkerRef = useRef(null);
  const customerMarkerRef = useRef(null);
  const [mapsKey, setMapsKey] = useState(null);
  const [mapReady, setMapReady] = useState(false);

  // Fetch the Maps key once on mount.
  useEffect(() => {
    api.request('/tracking/maps-key')
      .then((d) => setMapsKey(d?.key || ''))
      .catch(() => setMapsKey(''));
  }, []);

  // Load Google Maps JS once the key is in hand.
  useEffect(() => {
    if (!mapsKey) return;
    if (window.google?.maps) { setMapReady(true); return; }
    const existing = document.querySelector('script[data-waves-maps-loader]');
    if (existing) {
      existing.addEventListener('load', () => setMapReady(true));
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}`;
    script.async = true;
    script.defer = true;
    script.setAttribute('data-waves-maps-loader', '1');
    script.onload = () => setMapReady(true);
    script.onerror = () => setMapReady(false);
    document.head.appendChild(script);
  }, [mapsKey]);

  // Create map + customer marker once the script + both positions exist.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !techPosition || !customerLocation) return;
    if (!mapInstRef.current) {
      const map = new window.google.maps.Map(mapRef.current, {
        center: { lat: techPosition.lat, lng: techPosition.lng },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: 'cooperative',
        clickableIcons: false,
        // Hide all POI types (not just businesses) and transit so the
        // map reads as "where is my tech" rather than a cluttered city
        // map. Matches the styling used on the public /track page.
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      });
      mapInstRef.current = map;

      // Property marker: small navy house-roof shape (was a green
      // circle). Gives a directional anchor that visually distinguishes
      // it from the moving tech pin without relying on color alone.
      customerMarkerRef.current = new window.google.maps.Marker({
        map,
        position: customerLocation,
        title: 'Your property',
        icon: {
          path: 'M -10,4 L -10,-4 L 0,-12 L 10,-4 L 10,4 Z',
          scale: 1,
          fillColor: B.blueDeeper,
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        },
        zIndex: 1,
      });

      // Fit map to both points with breathing room. 80px matches the
      // /track page so the same tech vehicle pin sits ~the same
      // distance from the chrome on both surfaces.
      const bounds = new window.google.maps.LatLngBounds();
      bounds.extend({ lat: techPosition.lat, lng: techPosition.lng });
      bounds.extend(customerLocation);
      map.fitBounds(bounds, 80);
    }

    // Truck marker — Waves-blue circle on white halo. Replaces the
    // earlier rotated rectangle; the rotation telegraphed direction
    // but at the typical zoom level read as a small smudge. Circle
    // matches the /track page treatment.
    const truckPos = { lat: techPosition.lat, lng: techPosition.lng };
    if (!truckMarkerRef.current) {
      truckMarkerRef.current = new window.google.maps.Marker({
        map: mapInstRef.current,
        position: truckPos,
        title: `${techName || 'Tech'} is on the way`,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor: B.wavesBlue,
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 4,
        },
        zIndex: 2,
      });
    } else {
      truckMarkerRef.current.setPosition(truckPos);
    }
  }, [mapReady, techPosition, customerLocation, techName]);

  if (!techPosition || !customerLocation) return null;
  if (mapsKey === '') return null; // no Maps key configured — silently skip the map
  return (
    <div
      ref={mapRef}
      aria-label="Live tech location map"
      style={{
        width: '100%',
        height: 320,
        borderRadius: 16,
        overflow: 'hidden',
        background: B.blueLight,
        boxShadow: '0 2px 12px rgba(15, 23, 42, 0.08)',
      }}
    />
  );
}

// =========================================================================
// WAVES SERVICE TRACKER — Domino's-style real-time tracker
// =========================================================================
function useLastUpdated(iso) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!iso) {
      setText('');
      return undefined;
    }
    const tick = () => {
      const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (sec < 10) setText('Updated just now');
      else if (sec < 60) setText(`Updated ${sec}s ago`);
      else if (sec < 3600) setText(`Updated ${Math.floor(sec / 60)} min ago`);
      else setText(`Updated ${Math.floor(sec / 3600)}h ago`);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [iso]);
  return text;
}

function ServiceTracker() {
  const [tracker, setTracker] = useState(null);
  const [loading, setLoading] = useState(true);
  const [propertyPrefs, setPropertyPrefs] = useState(null);
  const [weather, setWeather] = useState(null);

  const fetchTracker = useCallback(() => {
    api.getActiveTracker()
      .then(d => { setTracker(d.tracker); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.getTodayTracker()
      .then(d => { setTracker(d.tracker); setLoading(false); })
      .catch(() => fetchTracker());
    api.getPropertyPreferences().then(d => setPropertyPrefs(d.preferences)).catch(() => {});
    api.getWeather().then(setWeather).catch(() => {});
  }, [fetchTracker]);

  useEffect(() => {
    if (!tracker || tracker.currentStep <= 1 || tracker.currentStep >= 7) return;
    const interval = setInterval(fetchTracker, 15000);
    return () => clearInterval(interval);
  }, [tracker?.currentStep, fetchTracker]);

  const lastReportedAt = tracker?.techPosition?.lastReportedAt || tracker?.techPosition?.updatedAt;
  const lastUpdated = useLastUpdated(lastReportedAt);

  if (loading || !tracker) return null;

  const step = tracker.currentStep;
  const techName = tracker.technician?.name || 'Your tech';
  const techFirst = techName.split(' ')[0];
  const techInitials = tracker.technician?.initials || '?';
  const svcType = tracker.service?.type || 'Service';
  const eta = tracker.etaMinutes;
  const notes = tracker.liveNotes || [];
  const summary = tracker.serviceSummary;
  const serviceDescription = tracker.service?.summary;
  const office = tracker.office || { name: 'Waves Pest Control', phone: '(941) 297-5749', area: 'Southwest Florida' };
  const isLawn = svcType.toLowerCase().includes('lawn');
  const isPest = svcType.toLowerCase().includes('pest');
  const isMosquito = svcType.toLowerCase().includes('mosquito');
  const isTermite = svcType.toLowerCase().includes('termite');

  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const window = tracker.service?.windowStart ? `${fmtTime(tracker.service.windowStart)} – ${fmtTime(tracker.service.windowEnd)}` : 'today';
  const stepTs = tracker.steps[step - 1]?.completedAt;
  const etaSource = tracker.etaSource || tracker.techPosition?.eta?.source;
  const etaDisplay = eta == null ? '—' : eta < 1 ? 'Now' : Math.round(eta);
  const hasLiveMap = !!(tracker.techPosition && tracker.customerLocation);

  // Estimated completion
  const avgDurations = { lawn: 45, pest: 35, mosquito: 25, termite: 60 };
  const svcDuration = isLawn ? avgDurations.lawn : isPest ? avgDurations.pest : isMosquito ? avgDurations.mosquito : isTermite ? avgDurations.termite : 40;
  const estComplete = step >= 4 && step < 6 && tracker.steps[3]?.completedAt
    ? new Date(new Date(tracker.steps[3].completedAt).getTime() + svcDuration * 60000)
    : null;

  // Status pill: maps the 7-step internal model to the 5-state UI
  // taxonomy used on the public /track/<token> page so authenticated
  // and public customers see the same status vocabulary.
  // Distance-driven sub-states for en route (Nearby / Arriving now)
  // pull from tracker.techPosition.eta.distanceMiles when available.
  const distMi = tracker.techPosition?.eta?.distanceMiles;
  const status = (() => {
    if (step === 7) return { label: 'Service complete', color: B.green };
    if (step >= 4) {
      if (step === 6) return { label: 'Finishing up', color: B.green };
      if (step === 5) return { label: 'Servicing now', color: B.green };
      return { label: 'On property', color: B.green };
    }
    if (step === 3) {
      if (distMi != null && distMi < 0.3) return { label: 'Arriving now', color: B.green };
      if (distMi != null && distMi < 3)   return { label: 'Nearby',       color: B.wavesBlue };
      return { label: 'On the way', color: B.wavesBlue };
    }
    if (step === 2) return { label: 'Confirmed', color: B.wavesBlue };
    return { label: 'Scheduled', color: B.wavesBlue };
  })();

  const cardBase = {
    background: B.white,
    borderRadius: 16,
    padding: 20,
    boxShadow: '0 2px 12px rgba(15, 23, 42, 0.06)',
  };
  const subCardBase = {
    background: B.white,
    borderRadius: 12,
    padding: '14px 16px',
    border: `1px solid ${B.slate200 || '#E2E8F0'}`,
  };

  return (
    <div style={{
      background: B.sand,
      borderRadius: 20,
      padding: 16,
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Status pill + weather strip. The pill is the authoritative
          state read; the weather chip is informational context.
          Replaces the gradient header + 6-step chevron bar. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{
          display: 'inline-block',
          fontSize: 12, fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          color: status.color, background: `${status.color}1A`,
          padding: '6px 12px', borderRadius: 9999,
        }}>
          <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: status.color, marginRight: 8, verticalAlign: 'middle',
          }} />
          {status.label}
        </div>
        {weather && (
          <div style={{ fontSize: 14, color: B.textBody, fontFamily: FONTS.ui, textAlign: 'right' }}>
            {weather.temp}°F
            {weather.forecast?.toLowerCase().includes('rain') && (
              <div style={{ fontSize: 12, color: B.textCaption, marginTop: 2 }}>Rain possible — tech may adjust timing</div>
            )}
          </div>
        )}
      </div>

      {/* Main state card. Content depends on step; chrome is constant
          (sand-bg parent, white card, rounded 16, soft shadow). */}
      <div style={cardBase}>
        {/* Step 1-2: Scheduled / Confirmed message */}
        {step <= 2 && (
          <>
            <div style={{
              fontFamily: FONTS.heading, fontSize: 22, fontWeight: 700,
              lineHeight: 1.25, color: B.blueDeeper,
            }}>
              Your {svcType.toLowerCase()} is {step === 2 ? 'confirmed' : 'booked'}{tracker.service?.windowStart ? ` for ${window}` : ''}.
            </div>
            <div style={{ fontSize: 16, color: B.textBody, marginTop: 12, lineHeight: 1.5 }}>
              You'll get a text as soon as {techFirst} is on the way.
            </div>
          </>
        )}

        {/* Step 3: EN ROUTE — Anton ETA hero + map + tech block + gold CTA */}
        {step === 3 && (
          <>
            <div>
              <div style={{ fontSize: 16, color: B.textBody, marginBottom: 4 }}>
                {techName} arrives in
              </div>
              <div style={{
                fontFamily: FONTS.display,
                fontSize: 'clamp(56px, 14vw, 88px)',
                fontWeight: 700,
                color: B.blueDeeper,
                lineHeight: 1,
                letterSpacing: '0.02em',
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
              }}>
                <span>{etaDisplay}</span>
                {eta != null && eta >= 1 && (
                  <span style={{
                    fontSize: 22, color: B.textCaption,
                    fontFamily: FONTS.body, fontWeight: 600, letterSpacing: '0.02em',
                  }}>min</span>
                )}
              </div>
              {etaSource === 'haversine' && (
                <div style={{ fontSize: 14, color: B.textCaption, marginTop: 8 }}>
                  Estimated based on distance
                </div>
              )}
            </div>
            {hasLiveMap ? (
              <>
                <EnRouteLiveMap
                  techPosition={tracker.techPosition}
                  customerLocation={tracker.customerLocation}
                  techName={techName}
                />
                {lastUpdated && (
                  <div style={{
                    fontSize: 14, color: B.textCaption,
                    marginTop: 10, textAlign: 'right',
                  }}>
                    {lastUpdated}{tracker.techPosition?.stale ? ' · GPS reconnecting' : ''}
                  </div>
                )}
              </>
            ) : (
              <div style={{
                marginTop: 20, padding: 14, background: B.blueSurface || B.blueLight,
                borderRadius: 10, fontSize: 14, color: B.textBody,
              }}>
                {techFirst} is on the way. We'll update once GPS reconnects.
              </div>
            )}
          </>
        )}

        {/* Step 4-6: ON PROPERTY / IN PROGRESS / WRAPPING UP */}
        {step >= 4 && step < 7 && (
          <>
            <div style={{
              fontFamily: FONTS.heading, fontSize: 22, fontWeight: 700,
              lineHeight: 1.25, color: B.blueDeeper,
            }}>
              {techName} is {step === 6 ? 'wrapping up' : step === 5 ? 'servicing your property' : 'on your property'}.
            </div>
            {estComplete && (
              <div style={{ fontSize: 16, color: B.textBody, marginTop: 10, lineHeight: 1.5 }}>
                Estimated done at {estComplete.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
              </div>
            )}
          </>
        )}

        {/* Step 7: COMPLETE */}
        {step === 7 && (
          <>
            <div style={{
              fontFamily: FONTS.heading, fontSize: 22, fontWeight: 700,
              lineHeight: 1.25, color: B.blueDeeper,
            }}>
              Thanks for choosing Waves.
            </div>
            <div style={{ fontSize: 16, color: B.textBody, marginTop: 8 }}>
              {svcType} completed{stepTs ? ` at ${new Date(stepTs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}.
            </div>
          </>
        )}

        {/* Tech block (steps 2+) — name + service-type pill */}
        {step >= 2 && step < 7 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            marginTop: 20, paddingTop: 16,
            borderTop: `1px solid ${B.offWhite}`,
          }}>
            {tracker.technician?.photoUrl ? (
              <img
                src={tracker.technician.photoUrl}
                alt={tracker.technician?.firstName || techName}
                style={{
                  width: 56, height: 56, borderRadius: '50%',
                  objectFit: 'cover', border: `2px solid ${B.offWhite}`, flexShrink: 0,
                }}
              />
            ) : (
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: B.blueDeeper, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, fontWeight: 700, fontFamily: FONTS.heading, flexShrink: 0,
              }}>{techInitials}</div>
            )}
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: B.navy, lineHeight: 1.2 }}>{techName}</div>
              <div style={{ fontSize: 14, color: B.textCaption, marginTop: 4 }}>{svcType}</div>
            </div>
          </div>
        )}

        {/* Service meta — type + window + tech timestamp */}
        <div style={{
          marginTop: 16, paddingTop: 16,
          borderTop: `1px solid ${B.offWhite}`,
        }}>
          <div style={{ fontSize: 14, color: B.textCaption, marginBottom: 4 }}>Today's visit</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: B.navy }}>{svcType}</div>
          {serviceDescription && (
            <div style={{ fontSize: 15, color: B.textBody, marginTop: 6, lineHeight: 1.5 }}>
              {serviceDescription}
            </div>
          )}
          {tracker.service?.windowStart && (
            <div style={{ fontSize: 14, color: B.textBody, marginTop: 6 }}>{window}</div>
          )}
          {stepTs && step < 7 && (
            <div style={{ fontSize: 14, color: B.textCaption, marginTop: 4 }}>
              {techFirst} · {new Date(stepTs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </div>
          )}
          {tracker.trackUrl && (
            <a
              href={tracker.trackUrl}
              style={{
                display: 'inline-flex', alignItems: 'center',
                fontSize: 14, color: B.wavesBlue, fontWeight: 700,
                marginTop: 10, textDecoration: 'none',
              }}
            >
              Open live tracking page
            </a>
          )}
        </div>

        {/* Gold "TEXT WAVES" CTA — only EN ROUTE. Same pattern as
            /track/<token>: SMS to office.phone (per-office). */}
        {step === 3 && office?.phone && (
          <a
            href={`sms:${office.phone.replace(/\D/g, '')}`}
            style={{ ...GOLD_CTA, width: '100%', marginTop: 20, boxSizing: 'border-box' }}
          >
            TEXT WAVES
          </a>
        )}
      </div>

      {/* Pre-arrival checklist — richer than /track's because it
          consults the customer's actual property prefs and service
          type. Shown until the tech is fully servicing (step 5+). */}
      {step < 5 && (
        <div style={subCardBase}>
          <div style={{ fontSize: 16, fontWeight: 600, color: B.blueDeeper, marginBottom: 8 }}>Before your tech arrives</div>
          {[
            propertyPrefs?.neighborhoodGateCode || propertyPrefs?.propertyGateCode
              ? { icon: 'checkCircle', text: 'Gate code on file', ok: true }
              : { icon: 'warning', text: 'No gate code on file', ok: false },
            propertyPrefs?.petCount > 0 && (propertyPrefs?.petsSecuredPlan || propertyPrefs?.petSecuredPlan)
              ? { icon: 'checkCircle', text: `Pet plan: ${(propertyPrefs.petsSecuredPlan || propertyPrefs.petSecuredPlan).slice(0, 40)}`, ok: true }
              : { icon: 'warning', text: 'Secure pets before tech arrives', ok: false },
            { icon: 'unlock', text: 'Ensure gates are unlocked', ok: true },
            ...(isLawn ? [
              { icon: 'droplet', text: 'Turn off irrigation 24hrs before', ok: true },
              { icon: 'leaf', text: "Don't mow 3 days before/after", ok: true },
            ] : []),
            ...(isPest ? [
              { icon: 'home', text: 'Clear counters and baseboards', ok: true },
              { icon: 'fish', text: 'Cover fish tanks and pet bowls', ok: true },
            ] : []),
            ...(isMosquito ? [
              { icon: 'droplet', text: 'Remove standing water', ok: true },
              { icon: 'checkCircle', text: 'Exterior only — no indoor prep', ok: true },
            ] : []),
            ...(isTermite ? [
              { icon: 'home', text: 'Clear access to garage/attic', ok: true },
            ] : []),
          ].map((item, i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6,
              borderLeft: item.ok ? 'none' : `2px solid ${B.orange}`,
              paddingLeft: item.ok ? 0 : 8,
            }}>
              <Icon name={item.icon} size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: item.ok ? 400 : 600, color: item.ok ? B.textBody : B.navy, lineHeight: 1.4 }}>{item.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Live notes from tech, if any */}
      {notes.length > 0 && (
        <div style={subCardBase}>
          <div style={{
            fontSize: 12, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: B.wavesBlue, marginBottom: 8,
          }}>Live updates</div>
          {notes.map((n, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < notes.length - 1 ? 8 : 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: B.wavesBlue, marginTop: 4 }} />
                {i < notes.length - 1 && <div style={{ width: 1.5, flex: 1, background: B.bluePale, marginTop: 2 }} />}
              </div>
              <div>
                <div style={{ fontSize: 15, color: B.navy, fontWeight: 500, lineHeight: 1.4 }}>{n.note}</div>
                <div style={{ fontSize: 14, color: B.textCaption, marginTop: 2 }}>
                  {new Date(n.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Office card — Call / Text. Always shown; the gold CTA above
          covers en-route specifically, this is the always-available
          contact path. */}
      <div style={subCardBase}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: B.navy }}>{office.name}</div>
          <div style={{ fontSize: 14, color: B.textCaption }}>Open 24 hrs</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a
            href={`tel:${office.phone.replace(/\D/g, '')}`}
            style={{ ...BUTTON_BASE, flex: 1, padding: '12px 16px', fontSize: 14, background: B.yellow, color: B.blueDeeper, textDecoration: 'none' }}
          >Call</a>
          <a
            href={`sms:${office.phone.replace(/\D/g, '')}`}
            style={{ ...BUTTON_BASE, flex: 1, padding: '12px 16px', fontSize: 14, background: B.wavesBlue, color: '#fff', textDecoration: 'none' }}
          >Text</a>
        </div>
      </div>

      {/* Completion summary at step 7 */}
      {step === 7 && summary && (
        <div style={{ ...subCardBase, background: `${B.green}14`, borderColor: `${B.green}33` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.green, letterSpacing: '0.05em', marginBottom: 8, textTransform: 'uppercase' }}>Service summary</div>
          {summary.productsApplied?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 14, color: B.textBody, fontWeight: 600, marginBottom: 6 }}>Products</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {summary.productsApplied.map((p, i) => (
                  <span key={i} style={{ fontSize: 14, padding: '4px 10px', borderRadius: 6, background: B.white, color: B.navy, fontWeight: 600 }}>{p}</span>
                ))}
              </div>
            </div>
          )}
          {summary.areasTreated?.length > 0 && (
            <div style={{ fontSize: 15, color: B.textBody, marginBottom: 8 }}>
              <strong>Areas:</strong> {summary.areasTreated.join(' · ')}
            </div>
          )}
          {summary.recommendations && (
            <div style={{ fontSize: 15, color: B.textBody, fontStyle: 'italic' }}>{summary.recommendations}</div>
          )}
          {summary.nextVisitDate && (
            <div style={{ fontSize: 14, color: B.wavesBlue, fontWeight: 600, marginTop: 8 }}>
              Next visit: {new Date(summary.nextVisitDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// REFER & EARN TAB
// =========================================================================
function ReferTab({ customer, onSwitchTab }) {
  const compact = useIsMobile(760);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ name: '', phone: '' });
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(false);

  const fetchData = () => {
    setLoadError('');
    api.getReferrals()
      .then(d => { setData(d); setLoading(false); })
      .catch(err => {
        setLoadError(err?.message || 'Could not load referral details.');
        setLoading(false);
      });
  };

  useEffect(() => { fetchData(); }, []);

  const flash = (text, type = 'success') => {
    setNotice({ text, type });
    window.setTimeout(() => setNotice(null), 3600);
  };

  const handleCopy = async (value) => {
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      flash('Could not copy the referral link.', 'error');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const friendName = form.name.trim();
    const friendPhone = form.phone.trim();
    if (!friendName || !friendPhone) return;
    setSubmitting(true);
    try {
      await api.submitReferral({ name: friendName, phone: friendPhone });
      setForm({ name: '', phone: '' });
      flash('Invite sent. We texted them your referral.');
      fetchData();
    } catch (err) {
      flash(err?.message || 'Could not submit your referral. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 12,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
  const primaryButton = {
    ...BUTTON_BASE,
    background: B.blueDeeper,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const secondaryButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
  };
  const money = (n, digits = 0) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const cents = (n, digits = 0) => money(Number(n || 0) / 100, digits);

  if (loading) {
    return (
      <div style={{ ...card, padding: 28, textAlign: 'center', color: muted }}>
        Loading referrals...
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ ...card, padding: 24 }}>
        <div style={sectionTitle}>Referrals</div>
        <div style={{ marginTop: 8, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Could not load referrals</div>
        <div style={{ marginTop: 6, fontSize: 14, color: muted }}>{loadError}</div>
        <button type="button" onClick={fetchData} style={{ ...secondaryButton, marginTop: 16 }}>Try again</button>
      </div>
    );
  }

  const referralCode = data?.referralCode || customer?.referralCode || '';
  const shareLink = data?.referralLink || data?.shareLink || (referralCode ? `https://wavespestcontrol.com/r/${referralCode}` : 'https://wavespestcontrol.com');
  const stats = data?.stats || { totalReferrals: 0, converted: 0, totalEarned: 0 };
  const referrals = data?.referrals || [];
  const totalReferrals = Number(stats.totalReferrals || referrals.length || 0);
  const converted = Number(stats.converted ?? stats.totalConverted ?? 0);
  const pending = Number(stats.pending ?? referrals.filter(r => ['pending', 'contacted', 'estimated'].includes(r.status)).length);
  const clicks = Number(stats.totalClicks || 0);
  const rewardPerReferral = Number(data?.rewardPerReferral || 50);
  const lifetimeEarned = data?.totalEarned != null
    ? Number(data.totalEarned || 0) / 100
    : Number(stats.totalEarned || 0);
  const availableBalance = Number(data?.availableBalance || 0) / 100;
  const pendingEarnings = Number(data?.pendingEarnings || 0) / 100;
  const shareText = `I use Waves Pest Control and thought you might want their info. Here is my referral link: ${shareLink}`;
  const customerFirstName = customer?.firstName || customer?.first_name || 'your friend';

  const statusConfig = {
    pending: { label: 'Invited', color: muted, bg: '#F1F5F9' },
    contacted: { label: 'Contacted', color: B.wavesBlue, bg: '#EEF6FF' },
    estimated: { label: 'Estimated', color: B.orange, bg: `${B.orange}14` },
    signed_up: { label: 'Signed up', color: B.green, bg: '#F0FDF4' },
    credited: { label: 'Credit applied', color: B.green, bg: '#F0FDF4' },
    rejected: { label: 'Closed', color: B.red, bg: `${B.red}10` },
    lost: { label: 'Closed', color: B.red, bg: `${B.red}10` },
  };
  const milestoneMeta = {
    none: { label: 'Getting started', next: 'advocate' },
    advocate: { label: 'Advocate', next: 'ambassador' },
    ambassador: { label: 'Ambassador', next: 'champion' },
    champion: { label: 'Champion', next: null },
  };
  const currentMilestone = data?.milestoneLevel || (converted >= 10 ? 'champion' : converted >= 5 ? 'ambassador' : converted >= 3 ? 'advocate' : 'none');
  const fallbackMilestone = [
    { level: 'advocate', threshold: 3, bonus: 2500 },
    { level: 'ambassador', threshold: 5, bonus: 5000 },
    { level: 'champion', threshold: 10, bonus: 10000 },
  ].find(m => converted < m.threshold);
  const nextMilestone = data?.nextMilestone || fallbackMilestone;
  const milestoneThreshold = Number(nextMilestone?.threshold || 0);
  const milestoneProgress = milestoneThreshold ? Math.min(100, Math.round((converted / milestoneThreshold) * 100)) : 100;
  const milestoneRemaining = Number(nextMilestone?.remaining ?? Math.max(0, milestoneThreshold - converted));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {notice && (
        <div style={{
          padding: '12px 14px',
          borderRadius: 8,
          border: `1px solid ${notice.type === 'error' ? `${B.red}33` : '#BBF7D0'}`,
          background: notice.type === 'error' ? `${B.red}10` : '#F0FDF4',
          color: notice.type === 'error' ? B.red : B.green,
          fontSize: 14,
          fontWeight: 800,
        }}>
          {notice.text}
        </div>
      )}

      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 300px' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              borderRadius: 999,
              background: '#EEF6FF',
              color: B.blueDeeper,
              fontSize: 12,
              fontWeight: 850,
            }}>
              <Icon name="gift" size={14} strokeWidth={2} />
              Referral Program
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Refer and Earn
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              Share your Waves link with neighbors. You earn {money(rewardPerReferral)} account credit when a referral starts service.
            </div>
          </div>
          <div style={{
            minWidth: compact ? '100%' : 210,
            padding: '14px 16px',
            borderRadius: 8,
            background: availableBalance > 0 ? '#F0FDF4' : subtle,
            border: `1px solid ${availableBalance > 0 ? '#BBF7D0' : '#E1E7EF'}`,
            boxSizing: 'border-box',
          }}>
            <div style={{ fontSize: 12, color: availableBalance > 0 ? B.green : muted, fontWeight: 850, textTransform: 'uppercase', letterSpacing: 0 }}>
              Available credit
            </div>
            <div style={{ marginTop: 3, fontSize: 24, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>
              {money(availableBalance)}
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: muted }}>
              {money(lifetimeEarned)} earned all time
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: 10,
          marginTop: 22,
        }}>
          {[
            { label: 'Sent', value: totalReferrals, sub: pending ? `${pending} in progress` : 'Ready to share' },
            { label: 'Started', value: converted, sub: `${Math.round(totalReferrals ? (converted / totalReferrals) * 100 : 0)}% conversion` },
            { label: 'Pending', value: money(pendingEarnings), sub: 'Awaiting first service' },
            { label: 'Clicks', value: clicks, sub: clicks ? 'Link traffic' : 'No clicks yet' },
          ].map((item) => (
            <div key={item.label} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: subtle,
              padding: 14,
              minHeight: 74,
              boxSizing: 'border-box',
            }}>
              <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>{item.label}</div>
              <div style={{ marginTop: 6, color: B.blueDeeper, fontSize: 17, fontWeight: 850, lineHeight: 1.15, fontFamily: FONTS.ui }}>{item.value}</div>
              <div style={{ marginTop: 3, color: muted, fontSize: 12 }}>{item.sub}</div>
            </div>
          ))}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 16, alignItems: 'stretch' }}>
        <section style={{ ...card, padding: 20 }}>
          <div style={sectionTitle}>Share Link</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Your referral code</div>
          <div style={{ marginTop: 6, fontSize: 14, color: muted, lineHeight: 1.45 }}>
            Send the link directly or copy it into your own message.
          </div>
          <div style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 8,
            background: subtle,
            border: '1px solid #E1E7EF',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>Code</div>
              <div style={{ marginTop: 3, fontSize: 18, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {referralCode || 'Auto-assigned'}
              </div>
            </div>
            <button type="button" onClick={() => handleCopy(shareLink)} style={{
              ...primaryButton,
              background: copied ? B.green : B.blueDeeper,
              whiteSpace: 'nowrap',
            }}>
              <Icon name={copied ? 'check' : 'share'} size={15} strokeWidth={2} style={{ marginRight: 6 }} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid #E1E7EF',
            color: muted,
            fontSize: 12,
            lineHeight: 1.45,
            overflowWrap: 'anywhere',
          }}>
            {shareLink}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <a href={`sms:?body=${encodeURIComponent(shareText)}`} style={{ ...secondaryButton, flex: '1 1 120px', justifyContent: 'center', textDecoration: 'none' }}>
              <Icon name="message" size={15} strokeWidth={2} style={{ marginRight: 6 }} /> Text
            </a>
            <a href={`mailto:?subject=${encodeURIComponent('Waves Pest Control referral')}&body=${encodeURIComponent(shareText)}`} style={{ ...secondaryButton, flex: '1 1 120px', justifyContent: 'center', textDecoration: 'none' }}>
              <Icon name="mail" size={15} strokeWidth={2} style={{ marginRight: 6 }} /> Email
            </a>
          </div>
        </section>

        <section style={{ ...card, padding: 20 }}>
          <div style={sectionTitle}>Send Invite</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Text a friend</div>
          <div style={{ marginTop: 6, fontSize: 14, color: muted, lineHeight: 1.45 }}>
            We will send a short referral text from {customerFirstName}.
          </div>
          <form onSubmit={handleSubmit} style={{ marginTop: 16 }}>
            <label htmlFor="portal-referral-name" style={{ fontSize: 12, fontWeight: 850, color: muted, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0 }}>
              Friend's Name
            </label>
            <input
              id="portal-referral-name"
              name="referralName"
              type="text"
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Jane Smith"
              autoComplete="name"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
                fontFamily: FONTS.body,
                color: B.blueDeeper,
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 12,
              }}
            />
            <label htmlFor="portal-referral-phone" style={{ fontSize: 12, fontWeight: 850, color: muted, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0 }}>
              Phone Number
            </label>
            <input
              id="portal-referral-phone"
              name="referralPhone"
              type="tel"
              inputMode="tel"
              value={form.phone}
              onChange={e => setForm(prev => ({ ...prev, phone: e.target.value }))}
              placeholder="(941) 555-0123"
              autoComplete="tel"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
                fontFamily: FONTS.body,
                color: B.blueDeeper,
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 14,
              }}
            />
            <button type="submit" disabled={!form.name.trim() || !form.phone.trim() || submitting} style={{
              ...primaryButton,
              width: '100%',
              opacity: submitting || !form.name.trim() || !form.phone.trim() ? 0.65 : 1,
              cursor: submitting || !form.name.trim() || !form.phone.trim() ? 'not-allowed' : 'pointer',
            }}>
              <Icon name="phone" size={15} strokeWidth={2} style={{ marginRight: 6 }} />
              {submitting ? 'Sending...' : 'Send Invite'}
            </button>
          </form>
        </section>
      </div>

      <section style={{ ...card, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <div style={sectionTitle}>Milestone</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>
              {milestoneMeta[currentMilestone]?.label || 'Getting started'}
            </div>
          </div>
          {nextMilestone ? (
            <div style={{ color: muted, fontSize: 14, lineHeight: 1.4, textAlign: compact ? 'left' : 'right' }}>
              {milestoneRemaining} more converted referral{milestoneRemaining === 1 ? '' : 's'} to {milestoneMeta[nextMilestone.level]?.label || 'the next level'}
              {nextMilestone.bonus ? <div style={{ color: B.green, fontWeight: 850 }}>Bonus {cents(nextMilestone.bonus)}</div> : null}
            </div>
          ) : (
            <div style={{ color: B.green, fontSize: 14, fontWeight: 850 }}>Top referral level reached</div>
          )}
        </div>
        <div style={{ height: 8, borderRadius: 999, background: subtle, overflow: 'hidden', border: '1px solid #E1E7EF' }}>
          <div style={{
            width: `${milestoneProgress}%`,
            height: '100%',
            background: B.wavesBlue,
            borderRadius: 999,
            transition: 'width 0.4s ease',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, color: muted, fontSize: 12 }}>
          <span>{converted} converted</span>
          <span>{milestoneThreshold ? `${milestoneThreshold} target` : 'Complete'}</span>
        </div>
      </section>

      <section style={{ ...card, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <div style={sectionTitle}>Referral Activity</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>
              {referrals.length ? `${referrals.length} referral${referrals.length === 1 ? '' : 's'}` : 'No referrals yet'}
            </div>
          </div>
          <div style={{ fontSize: 14, color: muted, fontWeight: 700 }}>{money(rewardPerReferral)} per signup</div>
        </div>

        {referrals.length === 0 ? (
          <div style={{
            padding: 18,
            background: subtle,
            border: '1px solid #E1E7EF',
            borderRadius: 8,
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          }}>
            <span style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: '#EEF6FF',
              color: B.blueDeeper,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <Icon name="gift" size={18} strokeWidth={2} />
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Start with one neighbor</div>
              <div style={{ marginTop: 3, fontSize: 14, color: muted, lineHeight: 1.45 }}>
                Copy your link or send an invite above. New referrals will appear here as they move through the signup process.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {referrals.map((r, idx) => {
              const s = statusConfig[r.status] || statusConfig.pending;
              const nameLabel = r.name || r.refereeName || 'Referral';
              const phoneLabel = r.phone || r.refereePhone || '';
              const created = r.createdAt ? new Date(r.createdAt) : null;
              const reward = Number(r.rewardAmount ?? r.creditAmount ?? 0);
              const rewardEarned = r.rewardStatus === 'earned' || r.rewardStatus === 'paid' || r.referrerCredited;
              return (
                <div key={r.id || `${nameLabel}-${idx}`} style={{
                  padding: '14px 0',
                  borderTop: idx === 0 ? 'none' : '1px solid #E1E7EF',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  alignItems: 'flex-start',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{nameLabel}</div>
                    <div style={{ marginTop: 3, fontSize: 12, color: muted }}>
                      {[phoneLabel, created && !isNaN(created) ? created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null].filter(Boolean).join(' - ')}
                    </div>
                    {rewardEarned && reward > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12, color: B.green, fontWeight: 850 }}>
                        {money(reward)} credit earned
                      </div>
                    )}
                  </div>
                  <span style={{
                    flexShrink: 0,
                    fontSize: 12,
                    fontWeight: 850,
                    padding: '5px 9px',
                    borderRadius: 8,
                    background: s.bg,
                    color: s.color,
                    border: `1px solid ${s.color}22`,
                  }}>{s.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section style={{ ...card, padding: 20 }}>
        <div style={sectionTitle}>How It Works</div>
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(3, 1fr)', gap: 10 }}>
          {[
            { icon: 'share', title: 'Share', text: 'Send your code or referral link to a neighbor.' },
            { icon: 'checkCircle', title: 'They start', text: 'We track the referral when they become a Waves customer.' },
            { icon: 'coins', title: 'You earn', text: `${money(rewardPerReferral)} credit is applied after their qualifying first service.` },
          ].map(item => (
            <div key={item.title} style={{
              padding: 14,
              background: subtle,
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              minHeight: 108,
              boxSizing: 'border-box',
            }}>
              <span style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: '#EEF6FF',
                color: B.blueDeeper,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Icon name={item.icon} size={17} strokeWidth={2} />
              </span>
              <div style={{ marginTop: 10, fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>{item.title}</div>
              <div style={{ marginTop: 3, fontSize: 14, color: muted, lineHeight: 1.45 }}>{item.text}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// =========================================================================
// DOCUMENTS TAB
// =========================================================================
function DocumentsTab({ customer, onSwitchTab }) {
  const compact = useIsMobile(760);
  const [docs, setDocs] = useState({});
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [notice, setNotice] = useState(null);
  const [shareStatus, setShareStatus] = useState({}); // { docId: 'copying' | 'copied' | shareLink }

  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 12,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
  const primaryButton = {
    ...BUTTON_BASE,
    background: B.blueDeeper,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
    letterSpacing: 0,
  };
  const secondaryButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '10px 14px',
    fontSize: 14,
    letterSpacing: 0,
  };

  const loadDocuments = useCallback(() => {
    setLoading(true);
    setLoadError('');
    api.getDocuments()
      .then(d => {
        setDocs(d.documents || {});
        setTotalDocs(Number(d.total || 0));
      })
      .catch(err => setLoadError(err?.message || 'Could not load documents.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const flash = (text, type = 'success') => {
    setNotice({ text, type });
    window.setTimeout(() => setNotice(null), 3600);
  };

  const absoluteUrl = (path) => {
    if (!path) return '';
    try {
      return new URL(path, window.location.origin).toString();
    } catch {
      return path;
    }
  };

  const downloadBlob = (blob, fileName = 'Waves_Document.pdf') => {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  };

  const handleDownload = (doc) => {
    if (doc.viewUrl || doc.isProjectReport) {
      window.open(absoluteUrl(doc.viewUrl || doc.downloadUrl), '_blank', 'noopener,noreferrer');
      return;
    }

    const url = doc.isAutoGenerated && doc.linkedServiceRecordId
      ? api.getServiceReportUrl(doc.linkedServiceRecordId)
      : doc.downloadUrl;

    if (!url) {
      flash('This document is not ready to download yet.', 'error');
      return;
    }

    const token = localStorage.getItem('waves_token');
    fetch(absoluteUrl(url), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async r => {
        if (!r.ok) throw new Error(`Download failed (${r.status})`);
        const contentType = r.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const body = await r.json().catch(() => null);
          throw new Error(body?.message || body?.error || 'This document is not ready to download yet.');
        }
        return r.blob();
      })
      .then(blob => downloadBlob(blob, doc.fileName || `${doc.title || 'Waves_Document'}.pdf`))
      .catch(err => {
        console.error(err);
        flash(err?.message || 'Could not download this document. Please try again.', 'error');
      });
  };

  const handleShare = async (doc) => {
    setShareStatus(prev => ({ ...prev, [doc.id]: 'copying' }));
    try {
      const shareLink = doc.viewUrl || doc.isProjectReport
        ? absoluteUrl(doc.viewUrl || doc.downloadUrl)
        : (await api.shareDocument(doc.id)).shareLink;
      await navigator.clipboard?.writeText(shareLink);
      setShareStatus(prev => ({ ...prev, [doc.id]: 'copied' }));
      setTimeout(() => setShareStatus(prev => ({ ...prev, [doc.id]: null })), 3000);
    } catch (err) {
      console.error(err);
      setShareStatus(prev => ({ ...prev, [doc.id]: null }));
      flash('Could not create a share link right now. Please try again.', 'error');
    }
  };

  const handleShareWithRealtor = (doc) => {
    const safeAddress = formatPropertyAddress(customer) || 'the property on file';
    const safeReportTitle = doc.title || 'WDO Inspection Report';
    const subject = encodeURIComponent(`WDO Inspection Report - ${safeAddress}`);
    const docLink = doc.viewUrl || doc.isProjectReport ? `\nReport link: ${absoluteUrl(doc.viewUrl || doc.downloadUrl)}\n` : '';
    const validThrough = doc.expirationDate
      ? `Valid through: ${new Date(doc.expirationDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
      : '';
    const body = encodeURIComponent(
      `Hi,\n\nPlease find the WDO inspection report for ${safeAddress}.\n\nReport: ${safeReportTitle}\n${validThrough}${docLink}\nFor questions, contact Waves Pest Control at (941) 297-5749.\n\nBest regards,\n${customer.firstName || ''} ${customer.lastName || ''}`
    );
    window.open(`mailto:?subject=${subject}&body=${body}`, '_self');
  };

  if (loading) {
    return (
      <div style={{ ...card, padding: 28, textAlign: 'center', color: muted }}>
        Loading documents...
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ ...card, padding: 24 }}>
        <div style={sectionTitle}>Documents</div>
        <div style={{ marginTop: 8, fontSize: 20, fontWeight: 850, color: B.blueDeeper }}>Could not load documents</div>
        <div style={{ marginTop: 6, fontSize: 14, color: muted }}>{loadError}</div>
        <button type="button" onClick={loadDocuments} style={{ ...secondaryButton, marginTop: 16 }}>Try again</button>
      </div>
    );
  }

  // Documents tab is scoped to legal / agreement / insurance paperwork.
  // Per-visit service reports live under Visits → Completed (already linked
  // next to the visit they document); they were removed from here to avoid
  // the same report appearing in two places.
  const categories = [
    { id: 'wdo', keys: ['wdo_inspection'], label: 'Real Estate', icon: 'clipboard', empty: 'No WDO or real estate reports on file.' },
    { id: 'agreements', keys: ['service_agreement'], label: 'Agreements', icon: 'shield', empty: 'Your service agreement will appear here after enrollment.' },
    { id: 'insurance', keys: ['insurance_cert'], label: 'Insurance', icon: 'document', empty: 'Insurance certificates will be uploaded by Waves.' },
    { id: 'compliance', keys: ['pesticide_record'], label: 'Compliance', icon: 'flask', empty: 'Compliance records will appear here when available.' },
    { id: 'other', keys: ['proposal', 'annual_summary', 'other'], label: 'Other Paperwork', icon: 'paperclip', empty: 'No other paperwork is currently on file.' },
  ];

  const typeFilters = [
    { value: 'all', label: 'All' },
    ...categories.map(c => ({ value: c.id, label: c.label })),
  ];

  const docsForCategory = (category) => category.keys
    .flatMap(key => (docs[key] || []).map(doc => ({ ...doc, categoryId: category.id, categoryLabel: category.label })))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const filteredCategories = categories
    .filter(c => typeFilter === 'all' || c.id === typeFilter)
    .map(c => {
      let items = docsForCategory(c);
      if (search.trim()) {
        const q = search.toLowerCase();
        items = items.filter(d =>
          d.title?.toLowerCase().includes(q) ||
          d.description?.toLowerCase().includes(q) ||
          d.fileName?.toLowerCase().includes(q) ||
          d.documentType?.toLowerCase().includes(q) ||
          d.createdAt?.includes(q)
        );
      }
      return { ...c, items };
    });

  const getExpirationBadge = (expDate) => {
    if (!expDate) return null;
    const exp = new Date(expDate + 'T12:00:00');
    const now = new Date();
    const daysUntil = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));

    if (daysUntil < 0) return { label: 'Expired', color: B.red, bg: `${B.red}20` };
    if (daysUntil <= 30) return { label: `Valid through ${exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, color: B.red, bg: `${B.red}20` };
    if (daysUntil <= 60) return { label: `Valid through ${exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, color: B.orange, bg: `${B.orange}20` };
    return { label: `Valid through ${exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, color: B.green, bg: `${B.green}20` };
  };

  const formatDate = (date) => {
    const d = new Date(date);
    if (isNaN(d)) return 'Date unavailable';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const relativeTime = (date) => {
    const d = new Date(date);
    const diff = Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 30) return `${diff} days ago`;
    if (diff < 365) return `${Math.floor(diff / 30)} months ago`;
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Year-to-date mini summary — only counts docs from the categories this
  // tab actually renders, so the number matches what the customer sees.
  const thisYear = new Date().getFullYear();
  const visibleDocs = categories.flatMap(c => docsForCategory(c));
  const visibleDocsByDate = [...visibleDocs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const ytdDocs = visibleDocs.filter(d => new Date(d.createdAt).getFullYear() === thisYear);
  const expiringDocs = visibleDocs.filter(d => {
    if (!d.expirationDate) return false;
    const days = Math.ceil((new Date(d.expirationDate + 'T12:00:00') - new Date()) / 86400000);
    return days >= 0 && days <= 60;
  });
  const latestDoc = visibleDocsByDate[0];
  const currentTotal = visibleDocs.length;
  const resultCount = filteredCategories.reduce((sum, c) => sum + c.items.length, 0);
  const hasActiveFilter = search.trim() || typeFilter !== 'all';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {notice && (
        <div style={{
          padding: '12px 14px',
          borderRadius: 8,
          border: `1px solid ${notice.type === 'error' ? `${B.red}33` : '#BBF7D0'}`,
          background: notice.type === 'error' ? `${B.red}10` : '#F0FDF4',
          color: notice.type === 'error' ? B.red : B.green,
          fontSize: 14,
          fontWeight: 800,
        }}>
          {notice.text}
        </div>
      )}

      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 300px' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              borderRadius: 999,
              background: '#EEF6FF',
              color: B.blueDeeper,
              fontSize: 12,
              fontWeight: 850,
            }}>
              <Icon name="document" size={14} strokeWidth={2} />
              Document Center
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Documents
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              Agreements, real estate reports, insurance certificates, and compliance paperwork.
            </div>
          </div>
          <div style={{
            minWidth: compact ? '100%' : 210,
            padding: '14px 16px',
            borderRadius: 8,
            background: subtle,
            border: '1px solid #E1E7EF',
            boxSizing: 'border-box',
          }}>
            <div style={{ fontSize: 12, color: muted, fontWeight: 850, textTransform: 'uppercase', letterSpacing: 0 }}>
              On file
            </div>
            <div style={{ marginTop: 3, fontSize: 24, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.ui }}>
              {currentTotal}
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: muted }}>
              {totalDocs > currentTotal ? `${totalDocs} total including visit reports` : 'Customer paperwork'}
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: 10,
          marginTop: 22,
        }}>
          {[
            { label: `${thisYear} added`, value: ytdDocs.length, sub: `${ytdDocs.length === 1 ? 'document' : 'documents'} this year` },
            { label: 'Real estate', value: docsForCategory(categories[0]).length, sub: 'WDO and inspection reports' },
            { label: 'Expiring soon', value: expiringDocs.length, sub: expiringDocs.length ? 'Within 60 days' : 'Nothing due soon' },
            { label: 'Latest', value: latestDoc ? formatDate(latestDoc.createdAt) : 'None', sub: latestDoc?.title || 'No paperwork yet' },
          ].map((item) => (
            <div key={item.label} style={{
              border: '1px solid #E1E7EF',
              borderRadius: 8,
              background: subtle,
              padding: 14,
              minHeight: 78,
              boxSizing: 'border-box',
            }}>
              <div style={{ fontSize: 12, color: muted, fontWeight: 800 }}>{item.label}</div>
              <div style={{
                marginTop: 6,
                color: B.blueDeeper,
                fontSize: typeof item.value === 'number' ? 18 : 14,
                fontWeight: 850,
                lineHeight: 1.2,
                fontFamily: FONTS.ui,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{item.value}</div>
              <div style={{ marginTop: 3, color: muted, fontSize: 12, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.sub}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: muted, pointerEvents: 'none' }}>
              <Icon name="search" size={16} strokeWidth={2} />
            </span>
            <input
              id="portal-document-search"
              name="documentSearch"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search documents..."
              aria-label="Search documents"
              style={{
                width: '100%',
                minHeight: 40,
                padding: '10px 12px 10px 38px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
                fontFamily: FONTS.body,
                color: B.blueDeeper,
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 1 }}>
            {typeFilters.map(f => {
              const active = typeFilter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setTypeFilter(f.value)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: `1px solid ${active ? B.wavesBlue : '#CBD5E1'}`,
                    background: active ? '#EEF6FF' : '#fff',
                    color: active ? B.blueDeeper : muted,
                    fontSize: 12,
                    fontWeight: 850,
                    cursor: 'pointer',
                    fontFamily: FONTS.heading,
                    whiteSpace: 'nowrap',
                    minHeight: 40,
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        {hasActiveFilter && (
          <div style={{ marginTop: 10, fontSize: 12, color: muted }}>
            Showing {resultCount} matching document{resultCount === 1 ? '' : 's'}.
          </div>
        )}
      </section>

      {/* Document Categories */}
      {filteredCategories.map(cat => (
        <DocumentSection
          key={cat.id}
          section={cat}
          items={cat.items}
          emptyMessage={cat.empty}
          onDownload={handleDownload}
          onShare={handleShare}
          onShareWithRealtor={handleShareWithRealtor}
          shareStatus={shareStatus}
          getExpirationBadge={getExpirationBadge}
          formatDate={formatDate}
          relativeTime={relativeTime}
          formatSize={formatSize}
          customer={customer}
          compact={compact}
        />
      ))}

      {/* Invoices link — redirect to Billing tab */}
      <section style={{
        ...card,
        padding: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 38,
            height: 38,
            borderRadius: 8,
            background: '#EEF6FF',
            color: B.blueDeeper,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon name="money" size={18} strokeWidth={2} />
          </span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Invoices and receipts</div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>Payment records now live in Billing.</div>
          </div>
        </div>
        <button type="button" onClick={() => onSwitchTab?.('billing')} style={secondaryButton}>
          <Icon name="card" size={15} strokeWidth={2} style={{ marginRight: 6 }} />
          Open Billing
        </button>
      </section>

      {/* Bottom note */}
      <section style={{
        ...card,
        padding: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={sectionTitle}>Need a document?</div>
          <div style={{ marginTop: 6, fontSize: 18, color: B.blueDeeper, fontWeight: 850 }}>Request paperwork from Waves</div>
          <div style={{ marginTop: 4, fontSize: 14, color: muted, lineHeight: 1.45 }}>
            Tell us what you need and we will upload it to your portal.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href="tel:+19412975749" style={{ ...secondaryButton, textDecoration: 'none' }}>
            <Icon name="phone" size={15} strokeWidth={2} style={{ marginRight: 6 }} />
            Call
          </a>
          <a href="sms:+19412975749" style={{ ...primaryButton, textDecoration: 'none' }}>
            <Icon name="message" size={15} strokeWidth={2} style={{ marginRight: 6 }} />
            Text
          </a>
        </div>
      </section>
    </div>
  );
}

function DocumentSection({ section, items, emptyMessage, onDownload, onShare, onShareWithRealtor, shareStatus, getExpirationBadge, formatDate, relativeTime, formatSize, customer, compact }) {
  const [open, setOpen] = useState(true);
  const muted = '#64748B';
  const subtle = '#F8FAFC';
  const sectionTitle = {
    fontSize: 12,
    fontWeight: 850,
    color: muted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
  const actionButton = {
    ...BUTTON_BASE,
    background: '#fff',
    color: B.blueDeeper,
    border: '1px solid #CBD5E1',
    borderRadius: 8,
    boxShadow: 'none',
    padding: '8px 10px',
    fontSize: 12,
    minHeight: 34,
    letterSpacing: 0,
  };

  return (
    <section style={{
      background: B.white,
      borderRadius: 8,
      overflow: 'hidden',
      border: '1px solid #E1E7EF',
      boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          width: '100%',
          border: 'none',
          background: '#fff',
          padding: '16px 18px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          textAlign: 'left',
          fontFamily: FONTS.body,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: '#EEF6FF',
            color: B.blueDeeper,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon name={section.icon} size={17} strokeWidth={2} />
          </span>
          <span>
            <span style={sectionTitle}>{section.label}</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 18, fontWeight: 850, color: B.blueDeeper }}>
              {items.length} document{items.length === 1 ? '' : 's'}
            </span>
          </span>
        </div>
        <Icon name="chevronDown" size={18} strokeWidth={2} style={{ color: muted, transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }} />
      </button>

      {open && (
        <div style={{ padding: '0 18px 16px' }}>
          {items.length === 0 ? (
            <div style={{
              padding: 16,
              borderRadius: 8,
              background: subtle,
              border: '1px solid #E1E7EF',
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}>
              <span style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: '#EEF6FF',
                color: B.blueDeeper,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Icon name="document" size={17} strokeWidth={2} />
              </span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 850, color: B.blueDeeper }}>Nothing here yet</div>
                <div style={{ marginTop: 3, fontSize: 14, color: muted, lineHeight: 1.45 }}>{emptyMessage}</div>
              </div>
            </div>
          ) : (
            <div style={{ borderTop: '1px solid #E1E7EF' }}>
              {items.map((doc, idx) => {
              const expBadge = doc.expirationDate ? getExpirationBadge(doc.expirationDate) : null;
              const share = shareStatus[doc.id];
              const isWdo = doc.documentType === 'wdo_inspection';
              const isInsurance = doc.documentType === 'insurance_cert';
              const canOpen = !!(doc.viewUrl || doc.isProjectReport);
              const meta = [
                formatDate(doc.createdAt),
                relativeTime(doc.createdAt),
                doc.fileSizeBytes ? formatSize(doc.fileSizeBytes) : null,
                doc.isAutoGenerated ? 'Generated by Waves' : null,
              ].filter(Boolean);

              return (
                <div key={doc.id} style={{
                  padding: '16px 0',
                  borderTop: idx === 0 ? 'none' : '1px solid #E1E7EF',
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <span style={{
                      width: 38,
                      height: 38,
                      borderRadius: 8,
                      flexShrink: 0,
                      background: doc.isAutoGenerated ? '#EEF6FF' : subtle,
                      border: '1px solid #E1E7EF',
                      color: B.blueDeeper,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <Icon name={isWdo ? 'clipboard' : isInsurance ? 'shield' : 'document'} size={18} strokeWidth={2} />
                    </span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 15,
                        fontWeight: 850,
                        color: B.blueDeeper,
                        lineHeight: 1.25,
                      }}>{doc.title}</div>
                      {doc.description && (
                        <div style={{ marginTop: 3, fontSize: 14, color: muted, lineHeight: 1.45 }}>
                          {doc.description}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: muted, marginTop: 5, fontWeight: 700 }}>
                        {meta.join(' - ')}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {expBadge && (
                          <span style={{
                            fontSize: 12,
                            fontWeight: 850,
                            padding: '4px 8px',
                            borderRadius: 8,
                            background: expBadge.bg,
                            color: expBadge.color,
                          }}>{expBadge.label}</span>
                        )}
                        {doc.isSharedWithThirdParty && (
                          <span style={{
                            fontSize: 12,
                            fontWeight: 850,
                            padding: '4px 8px',
                            borderRadius: 8,
                            background: '#EEF6FF',
                            color: B.blueDeeper,
                          }}>Shared</span>
                        )}
                        {isInsurance && (doc.licenseNumber || customer?.licenseNumber) && (
                          <span style={{
                            fontSize: 12,
                            fontWeight: 850,
                            padding: '4px 8px',
                            borderRadius: 8,
                            background: subtle,
                            color: muted,
                            border: '1px solid #E1E7EF',
                          }}>License {doc.licenseNumber || customer.licenseNumber}</span>
                        )}
                      </div>
                      {isWdo && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                          <button type="button" onClick={() => onShareWithRealtor(doc)} style={actionButton}>
                            <Icon name="mail" size={14} strokeWidth={2} style={{ marginRight: 5 }} />
                            Realtor email
                          </button>
                        </div>
                      )}
                    </div>

                    <div style={{
                      display: 'flex',
                      gap: 6,
                      flexShrink: 0,
                      flexDirection: compact ? 'column' : 'row',
                      alignItems: 'stretch',
                    }}>
                      <button
                        type="button"
                        onClick={() => onShare(doc)}
                        disabled={share === 'copying'}
                        style={{
                          ...actionButton,
                          background: share === 'copied' ? '#F0FDF4' : '#fff',
                          color: share === 'copied' ? B.green : B.blueDeeper,
                          opacity: share === 'copying' ? 0.65 : 1,
                          cursor: share === 'copying' ? 'wait' : 'pointer',
                        }}
                        aria-label={`Share ${doc.title || 'document'}`}
                      >
                        <Icon name={share === 'copied' ? 'check' : 'share'} size={14} strokeWidth={2} style={{ marginRight: compact ? 0 : 5 }} />
                        {!compact && (share === 'copied' ? 'Copied' : share === 'copying' ? 'Copying' : 'Share')}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDownload(doc)}
                        style={actionButton}
                        aria-label={`${canOpen ? 'Open' : 'Download'} ${doc.title || 'document'}`}
                      >
                        <Icon name={canOpen ? 'arrowRight' : 'document'} size={14} strokeWidth={2} style={{ marginRight: compact ? 0 : 5 }} />
                        {!compact && (canOpen ? 'Open' : 'Download')}
                      </button>
                    </div>
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// =========================================================================
// REPORT ISSUE OVERLAY — full-screen form triggered by FAB
// =========================================================================
function ReportIssueOverlay({ open, onClose, onSubmitted, customer }) {
  const [category, setCategory] = useState('');
  const [urgency, setUrgency] = useState('routine');
  const [description, setDescription] = useState('');
  const [locations, setLocations] = useState([]); // multi-select array
  const [photos, setPhotos] = useState([]); // array of { preview, data }
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [lastService, setLastService] = useState(null);
  const [nextService, setNextService] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (open) {
      api.getServices({ limit: 1 }).then(d => {
        if (d.services?.length) setLastService(d.services[0]);
      }).catch(() => {});
      api.getNextService().then(d => setNextService(d.next || null)).catch(() => {});
    }
  }, [open]);

  const problemCategories = [
    { value: 'pest_issue', label: ' Pest' },
    { value: 'lawn_concern', label: ' Lawn' },
    { value: 'billing', label: ' Billing' },
    { value: 'schedule_change', label: ' Schedule' },
  ];

  const locationOptions = [
    { value: 'front_yard', label: 'Front Yard' },
    { value: 'back_yard', label: 'Back Yard' },
    { value: 'side_yard', label: 'Side Yard' },
    { value: 'inside_home', label: 'Inside Home' },
    { value: 'garage_lanai', label: 'Garage / Lanai' },
    { value: 'garden_beds', label: 'Garden Beds' },
    { value: 'perimeter_foundation', label: 'Perimeter / Foundation' },
    { value: 'pool_lanai', label: 'Pool Area / Lanai' },
    { value: 'other', label: 'Other' },
  ];

  const isProblemCategory = ['pest_issue', 'lawn_concern', 'schedule_change'].includes(category);

  // Callback recognition: pest/lawn issue within 30 days of last service
  const tierName = customer?.tier || 'Bronze';
  const isCallbackEligible = isProblemCategory && lastService && (() => {
    const svcDate = parseDate(lastService.date);
    const daysSince = (new Date() - svcDate) / (1000 * 60 * 60 * 24);
    return daysSince <= 30 && daysSince >= 0;
  })();

  // Schedule awareness: next service within 3 days
  const nextServiceSoon = nextService && (() => {
    const nextDate = parseDate(nextService.date);
    const daysUntil = (nextDate - new Date()) / (1000 * 60 * 60 * 24);
    return daysUntil >= 0 && daysUntil <= 3;
  })();
  const nextServiceDateStr = nextService ? parseDate(nextService.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

  const toggleLocation = (val) => {
    setLocations(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]);
  };

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file || photos.length >= 5) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPhotos(prev => [...prev, { preview: ev.target.result, data: ev.target.result }]);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const removePhoto = (idx) => {
    setPhotos(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!category || !description.trim()) return;
    setSubmitting(true);
    try {
      await api.createRequest({
        category,
        subject: description.trim().slice(0, 80),
        description: description.trim(),
        urgency: isProblemCategory ? urgency : 'routine',
        locationOnProperty: locations.length ? locations.join(', ') : null,
        photos: photos.map(p => p.data),
      });
      setSubmitted(true);
      onSubmitted?.();
      setTimeout(() => {
        setSubmitted(false);
        setCategory(''); setDescription('');
        setUrgency('routine'); setLocations([]); setPhotos([]);
        onClose();
      }, 2500);
    } catch (err) {
      console.error(err);
    }
    setSubmitting(false);
  };

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: B.offWhite, overflowY: 'auto',
      animation: 'slideUp 0.3s ease-out',
    }}>
      <style>{`
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes checkPop { 0% { transform: scale(0); opacity: 0; } 50% { transform: scale(1.2); } 100% { transform: scale(1); opacity: 1; } }
      `}</style>

      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${B.grayLight}`,
        padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>New Request</div>
        <button onClick={onClose} aria-label="Close" style={{
          background: B.offWhite, border: 'none', cursor: 'pointer',
          color: B.grayMid, width: 40, height: 40, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="close" size={16} strokeWidth={2} /></button>
      </div>

      {submitted ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 64, animation: 'checkPop 0.5s ease-out' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 80, height: 80, borderRadius: '50%', background: `${B.green}15` }}>
              <Icon name="check" size={28} strokeWidth={1.75} />
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: 12 }}>Sent to Waves!</div>
          <div style={{ fontSize: 16, color: B.grayDark, marginTop: 8, lineHeight: 1.6 }}>
            We'll review your request and text you when it's been assigned.
            {urgency === 'urgent' && isProblemCategory ? ' Urgent requests are prioritized — expect a response within 2 hours.' : ''}
          </div>
        </div>
      ) : (
        <div style={{ padding: '16px 20px 120px', maxWidth: 600, margin: '0 auto' }}>

          {/* Pre-fill context */}
          {customer && (
            <div style={{
              padding: '10px 14px', borderRadius: 10, background: B.blueSurface,
              border: `1px solid ${B.bluePale}`, marginBottom: 16,
              fontSize: 12, color: B.grayDark, lineHeight: 1.6,
            }}>
              <span style={{ fontWeight: 700, color: B.navy }}>{customer.firstName} {customer.lastName}</span>
              {customer.address?.street && <span> · {customer.address.street}</span>}
              <span> · WaveGuard {tierName}</span>
              {lastService && (
                <span> · Last service: {parseDate(lastService.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              )}
            </div>
          )}

          {/* Photo Upload — moved to top */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, marginBottom: 8 }}>
               Photos <span style={{ fontWeight: 400, color: B.grayMid }}>(optional, up to 5)</span>
            </div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: 'none' }} />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {photos.length < 5 && (
                <div onClick={() => fileRef.current?.click()} style={{
                  width: 80, height: 80, borderRadius: 10, cursor: 'pointer',
                  border: `2px dashed ${B.wavesBlue}`, background: `${B.wavesBlue}08`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon name="camera" size={24} strokeWidth={1.75} />
                  <span style={{ fontSize: 9, color: B.wavesBlue, marginTop: 2, fontWeight: 600 }}>Add photo</span>
                </div>
              )}
              {photos.map((p, i) => (
                <div key={i} style={{ position: 'relative', width: 80, height: 80 }}>
                  <img src={p.preview} alt="" style={{
                    width: 80, height: 80, objectFit: 'cover', borderRadius: 10,
                    border: `1px solid ${B.grayLight}`,
                  }} />
                  <button onClick={() => removePhoto(i)} style={{
                    position: 'absolute', top: -6, right: -6,
                    width: 22, height: 22, borderRadius: '50%',
                    background: B.red, color: '#fff', border: '2px solid #fff',
                    cursor: 'pointer', fontSize: 12, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', padding: 0,
                  }}></button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, marginBottom: 12, fontFamily: FONTS.heading }}>
              We're on it. Tell us what's happening.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {problemCategories.map(c => (
                <button key={c.value} onClick={() => { setCategory(c.value); if (!isProblemCategory) setUrgency('routine'); }} style={{
                  ...BUTTON_BASE, padding: '9px 16px', fontSize: 14, borderRadius: 12,
                  background: category === c.value ? B.wavesBlue : B.white,
                  color: category === c.value ? '#fff' : B.grayDark,
                  border: category === c.value ? 'none' : `1px solid ${B.grayLight}`,
                }}>{c.label}</button>
              ))}
            </div>
          </div>

          {/* Callback recognition */}
          {isCallbackEligible && (category === 'pest_issue' || category === 'lawn_concern') && (
            <div style={{
              padding: '10px 14px', borderRadius: 10, marginBottom: 16,
              background: `${B.green}10`, border: `1px solid ${B.green}30`,
              fontSize: 12, color: B.green, fontWeight: 600, lineHeight: 1.5,
            }}>
              Callbacks are free with your WaveGuard {tierName} plan. We'll get this taken care of.
            </div>
          )}

          {/* Schedule awareness */}
          {nextServiceSoon && isProblemCategory && (
            <div style={{
              padding: '10px 14px', borderRadius: 10, marginBottom: 16,
              background: `${B.wavesBlue}10`, border: `1px solid ${B.wavesBlue}30`,
              fontSize: 12, color: B.wavesBlue, fontWeight: 600, lineHeight: 1.5,
            }}>
               Your next visit is {nextServiceDateStr}. Want us to address it then, or do you need us sooner?
            </div>
          )}

          {/* Urgency — only for problem categories */}
          {isProblemCategory && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, marginBottom: 8 }}>How urgent?</div>
              <div style={{ display: 'flex', gap: 10 }}>
                {[
                  { value: 'routine', label: 'Routine', desc: 'Next 24 hours', color: B.wavesBlue },
                  { value: 'urgent', label: 'Urgent', desc: 'Within 2 hours', color: B.red },
                ].map(u => (
                  <button key={u.value} onClick={() => setUrgency(u.value)} style={{
                    flex: 1, padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
                    border: urgency === u.value ? `2px solid ${u.color}` : `1px solid ${B.grayLight}`,
                    background: urgency === u.value ? `${u.color}10` : B.white,
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: urgency === u.value ? u.color : B.grayDark }}>{u.label}</div>
                    <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>{u.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Merged description field (subject + details combined) */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, marginBottom: 8 }}>
              Describe what's happening
            </div>
            <textarea
              value={description} onChange={e => { if (e.target.value.length <= 500) setDescription(e.target.value); }}
              rows={5}
              aria-label="Describe what's happening"
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12,
                border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
                color: B.navy, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
              }}
              onFocus={e => e.target.style.borderColor = B.wavesBlue}
              onBlur={e => e.target.style.borderColor = B.grayLight}
            />
            {description.length > 450 && (
              <div style={{ fontSize: 12, color: B.red, marginTop: 4, textAlign: 'right' }}>
                {description.length}/500
              </div>
            )}
          </div>

          {/* Location on Property — multi-select */}
          {isProblemCategory && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, marginBottom: 8 }}>Where on your property? <span style={{ fontWeight: 400, color: B.grayMid }}>(select all that apply)</span></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {locationOptions.map(l => (
                  <button key={l.value} onClick={() => toggleLocation(l.value)} style={{
                    ...BUTTON_BASE, padding: '7px 12px', fontSize: 12, borderRadius: 20,
                    background: locations.includes(l.value) ? B.teal : B.white,
                    color: locations.includes(l.value) ? '#fff' : B.grayDark,
                    border: locations.includes(l.value) ? 'none' : `1px solid ${B.grayLight}`,
                  }}>{l.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* Submit */}
          <button onClick={handleSubmit} disabled={!category || !description.trim() || submitting} style={{
            ...GOLD_CTA, width: '100%',
            opacity: (!category || !description.trim() || submitting) ? 0.55 : 1,
            cursor: (!category || !description.trim() || submitting) ? 'not-allowed' : 'pointer',
          }}>
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// MY REQUESTS CARD — shows on dashboard when customer has open requests
// =========================================================================
function MyRequestsCard() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRequests()
      .then(d => { setRequests(d.requests || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return null;

  const open = requests.filter(r => r.status !== 'resolved');
  if (!open.length) return null;

  const statusConfig = {
    new: { label: 'New', color: B.wavesBlue, bg: B.bluePale },
    acknowledged: { label: 'Reviewed', color: B.orange, bg: `${B.orange}20` },
    scheduled: { label: 'Scheduled', color: B.teal, bg: `${B.bluePale}20` },
    resolved: { label: 'Resolved', color: B.green, bg: `${B.green}20` },
  };

  const STATUS_ORDER = ['new', 'acknowledged', 'scheduled', 'resolved'];

  return (
    <div style={{
      background: B.white, borderRadius: 16, padding: 20,
      border: `1px solid ${B.grayLight}`, boxShadow: '0 2px 12px rgba(0,0,0,0.03)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Icon name="clipboard" size={18} strokeWidth={1.75} />
        <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>My Requests</div>
        <span style={{
          marginLeft: 'auto', fontSize: 12, fontWeight: 700, padding: '2px 8px',
          borderRadius: 10, background: B.bluePale, color: B.wavesBlue,
        }}>{open.length} open</span>
      </div>

      {open.slice(0, 3).map(r => {
        const s = statusConfig[r.status] || statusConfig.new;
        const created = new Date(r.createdAt);
        return (
          <div key={r.id} style={{
            padding: '12px 0',
            borderBottom: `1px solid ${B.grayLight}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>{r.subject}</div>
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                padding: '3px 8px', borderRadius: 20,
                background: s.bg, color: s.color,
              }}>{s.label}</span>
            </div>
            {/* Status progress */}
            <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
              {STATUS_ORDER.map((st, i) => (
                <div key={st} style={{
                  flex: 1, height: 3, borderRadius: 2,
                  background: STATUS_ORDER.indexOf(r.status) >= i ? s.color : B.grayLight,
                }} />
              ))}
            </div>
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 6 }}>
              {r.category?.replace(/_/g, ' ')} · {created.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              {r.urgency === 'urgent' && <span style={{ color: B.red, fontWeight: 700, marginLeft: 6 }}>URGENT</span>}
              {r.assignedTechnician && <span> · Assigned: {r.assignedTechnician}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =========================================================================
// MAIN PORTAL
// =========================================================================
// Bottom nav pins the five most-used destinations; the rest live behind a
// "More" sheet. Short labels picked specifically for the 5-across layout.
const PRIMARY_TABS = [
  { id: 'dashboard', label: 'Home', icon: 'home' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'visits', label: 'Visits', icon: 'calendar' },
  { id: 'billing', label: 'Billing', icon: 'card' },
  { id: 'refer', label: 'Refer', icon: 'gift' },
];
const MORE_TABS = [
  { id: 'documents', label: 'Documents', icon: 'document' },
  { id: 'property', label: 'My Property', icon: 'house' },
  { id: 'learn', label: 'Learn', icon: 'bulb' },
];
const TAB_TITLES = {
  dashboard: 'Customer Dashboard',
  plan: 'My Plan',
  visits: 'Visits',
  billing: 'Billing',
  refer: 'Refer and Earn',
  documents: 'Documents',
  property: 'My Property',
  learn: 'Learn and Stay Informed',
};

// The sub-tabs on Visits surface their own IDs, so "Visits" stays lit
// whether the customer is on Upcoming or Completed.
function BottomNav({ activeTab, onSelect, onOpenMore, moreActive }) {
  const button = (t, onClick, isActive) => (
    <button
      key={t.id}
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 2, padding: '6px 2px', border: 'none',
        background: 'transparent', cursor: 'pointer', minHeight: 56,
        color: isActive ? B.wavesBlue : B.grayMid,
        fontFamily: FONTS.heading, transition: 'color 0.15s ease',
      }}
    >
      <Icon name={t.icon} size={22} strokeWidth={isActive ? 2.25 : 1.75} />
      <span style={{ fontSize: 10, fontWeight: isActive ? 700 : 600, letterSpacing: 0.2 }}>{t.label}</span>
    </button>
  );
  return (
    <nav aria-label="Main" style={{
      position: 'fixed', bottom: 60, left: 0, right: 0, zIndex: 98,
      background: 'rgba(255,255,255,0.98)', backdropFilter: 'blur(12px)',
      borderTop: `1px solid ${B.grayLight}`,
      boxShadow: '0 -2px 10px rgba(0,0,0,0.04)',
      display: 'flex', maxWidth: 700, margin: '0 auto',
    }}>
      {PRIMARY_TABS.map(t => button(t, () => onSelect(t.id), activeTab === t.id))}
      {button(
        { id: 'more', label: 'More', icon: 'more' },
        onOpenMore,
        moreActive || MORE_TABS.some(m => m.id === activeTab),
      )}
    </nav>
  );
}

function MoreSheet({ activeTab, onSelect, onClose }) {
  // Close on Esc for keyboard users.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 150,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="More navigation" style={{
        background: B.white, borderRadius: '20px 20px 0 0', padding: '18px 20px 28px',
        boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
        animation: 'moreSheetUp 0.25s ease',
      }}>
        <style>{`@keyframes moreSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
        <div style={{
          width: 36, height: 4, borderRadius: 2, background: B.grayLight,
          margin: '0 auto 14px',
        }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 12 }}>More</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {MORE_TABS.map(t => {
            const isActive = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => onSelect(t.id)} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px',
                border: 'none', background: isActive ? `${B.wavesBlue}10` : 'transparent',
                borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                color: isActive ? B.wavesBlue : B.navy,
                fontFamily: FONTS.body, fontSize: 14, fontWeight: isActive ? 700 : 500,
              }}>
                <Icon name={t.icon} size={20} strokeWidth={1.75} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Wraps ScheduleTab (upcoming) + ServicesTab (completed) behind a single
// "Visits" surface — a visit is one object moving from upcoming → completed,
// so customers shouldn't have to know which tab holds which state.
function VisitsTab({ customer, properties = [], subTab, onSubTabChange, onRequestVisit }) {
  const compact = useIsMobile(760);
  const active = subTab === 'completed' ? 'completed' : 'upcoming';
  const card = {
    background: B.white,
    border: '1px solid #E1E7EF',
    borderRadius: 8,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  };
  const muted = '#64748B';
  const propertyLine = [
    customer.address?.line1,
    customer.address?.city,
    customer.address?.state,
    customer.address?.zip,
  ].filter(Boolean).join(', ');
  const pill = (id, label) => {
    const isActive = active === id;
    return (
      <button
        type="button"
        key={id}
        onClick={() => onSubTabChange(id)}
        style={{
          flex: 1, padding: '9px 14px', borderRadius: 8, border: `1px solid ${isActive ? B.wavesBlue : 'transparent'}`,
          cursor: 'pointer', fontSize: 14, fontWeight: 850,
          fontFamily: FONTS.heading,
          background: isActive ? '#EEF6FF' : 'transparent',
          color: isActive ? B.blueDeeper : muted,
          minHeight: 38,
        }}
      >{label}</button>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              borderRadius: 999,
              background: '#EEF6FF',
              color: B.blueDeeper,
              fontSize: 12,
              fontWeight: 850,
            }}>
              Service Schedule
            </div>
            <h1 style={{
              margin: '12px 0 8px',
              color: B.blueDeeper,
              fontFamily: FONTS.heading,
              fontSize: compact ? 28 : 34,
              lineHeight: 1.1,
              letterSpacing: 0,
            }}>
              Visits
            </h1>
            <div style={{ fontSize: 15, color: B.grayDark, lineHeight: 1.55 }}>
              Upcoming appointments, completed reports, reminders, and service notes.
            </div>
            {propertyLine && <div style={{ marginTop: 4, fontSize: 14, color: muted }}>{propertyLine}</div>}
          </div>
          <div style={{
            display: 'flex',
            gap: 4,
            background: '#F8FAFC',
            borderRadius: 8,
            padding: 4,
            border: '1px solid #E1E7EF',
            minWidth: compact ? '100%' : 260,
          }}>
            {pill('upcoming', 'Upcoming')}
            {pill('completed', 'Completed')}
          </div>
        </div>
      </section>
      {active === 'upcoming' ? <ScheduleTab customer={customer} properties={properties} onRequestVisit={onRequestVisit} /> : <ServicesTab />}
    </div>
  );
}

// =========================================================================
// AI CHAT WIDGET
// =========================================================================
function ChatWidget({ customer, onClose }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: `Hi${customer?.first_name ? ` ${customer.first_name}` : ''}! I'm the Waves AI assistant. How can I help you today?` },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);
  const sessionId = useRef(`chat-${Date.now()}`);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_token')}`,
        },
        body: JSON.stringify({ message: text, sessionId: sessionId.current }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply || "I'm having trouble right now. Please try calling us at (941) 297-5749." }]);
      if (data.escalated) {
        setMessages(prev => [...prev, { role: 'system', content: 'A team member has been notified and will follow up shortly.' }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: "Connection issue — please try again or call us at (941) 297-5749." }]);
    }
    setSending(false);
  };

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, top: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: B.white, borderRadius: '20px 20px 0 0', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
        animation: 'chatSlideUp 0.3s ease',
      }}>
        <style>{`@keyframes chatSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>

        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${B.grayLight}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`, borderRadius: '20px 20px 0 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }}><Icon name="waves" size={16} strokeWidth={1.75} /></div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Waves Assistant</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Usually replies instantly</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close chat" style={{
            background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff',
            width: 32, height: 32, borderRadius: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon name="close" size={16} strokeWidth={1.75} /></button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 300, maxHeight: '60vh' }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 10,
            }}>
              <div style={{
                maxWidth: '80%', padding: '10px 14px', borderRadius: 16,
                fontSize: 16, lineHeight: 1.5, fontFamily: FONTS.body,
                ...(msg.role === 'user' ? {
                  background: B.wavesBlue, color: '#fff',
                  borderBottomRightRadius: 4,
                } : msg.role === 'system' ? {
                  background: B.offWhite, color: B.grayMid, fontSize: 12, fontStyle: 'italic',
                  borderRadius: 8,
                } : {
                  background: B.offWhite, color: B.navy,
                  borderBottomLeftRadius: 4,
                }),
              }}>
                {msg.content}
              </div>
            </div>
          ))}
          {sending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
              <div style={{ background: B.offWhite, padding: '10px 18px', borderRadius: 16, fontSize: 14, color: B.grayMid }}>
                <span style={{ animation: 'pulse 1.5s ease infinite' }}>{'•••'}</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div style={{
          padding: '12px 16px', borderTop: `1px solid ${B.grayLight}`,
          display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Type a message..."
            aria-label="Chat message"
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 24, border: `1px solid ${B.grayLight}`,
              fontSize: 14, fontFamily: FONTS.body, outline: 'none', background: B.offWhite,
            }}
            autoFocus
          />
          <button onClick={send} disabled={sending || !input.trim()} style={{
            width: 40, height: 40, borderRadius: 20, border: 'none',
            background: input.trim() ? B.wavesBlue : B.grayLight,
            color: '#fff', cursor: input.trim() ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            transition: 'background 0.15s',
          }}>{'↑'}</button>
        </div>
      </div>
    </div>
  );
}

export default function PortalPage() {
  const { customer, logout, properties, switchProperty } = useAuth();
  const isMobileShell = useIsMobile(900);
  // Honor ?tab=billing etc. so deep-links from SMS (e.g. the "update your
  // card" link in autopay-failure texts) land the customer on the right tab.
  // Returns [tabId, visitsSubTab, openRequest]. Legacy ?tab=schedule /
  // ?tab=services land on Visits with the matching sub-tab preselected;
  // ?tab=request opens the request overlay instead of routing to a tab.
  const [initialTab, initialVisitsSubTab, initialOpenRequest] = (() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t === 'schedule') return ['visits', 'upcoming', false];
      if (t === 'services') return ['visits', 'completed', false];
      if (t === 'request') return ['dashboard', 'upcoming', true];
      const allowed = ['dashboard', 'plan', 'visits', 'billing', 'refer', 'documents', 'property', 'learn'];
      return [t && allowed.includes(t) ? t : 'dashboard', 'upcoming', false];
    } catch { return ['dashboard', 'upcoming', false]; }
  })();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [visitsSubTab, setVisitsSubTab] = useState(initialVisitsSubTab);
  const [showMenu, setShowMenu] = useState(false);
  // "Request" is no longer a tab — it's the same bottom-sheet overlay used
  // for the FAB. Kept the old state name (showReportIssue) since a lot of
  // UI hangs off it; only the surfaced copy changed to "New Request".
  const [showReportIssue, setShowReportIssue] = useState(initialOpenRequest);
  // Translates legacy 'schedule' / 'services' / 'request' targets into
  // their consolidated surfaces (Visits sub-tabs, request overlay) so
  // existing call-sites route correctly without rewriting each one.
  const switchTab = (id) => {
    if (id === 'schedule') { setVisitsSubTab('upcoming'); setActiveTab('visits'); return; }
    if (id === 'services') { setVisitsSubTab('completed'); setActiveTab('visits'); return; }
    if (id === 'request') { setShowReportIssue(true); return; }
    setActiveTab(id);
  };
  const headerNavItems = [
    ...PRIMARY_TABS,
    ...MORE_TABS,
  ];
  const headerNavButton = (tab) => {
    const isActive = activeTab === tab.id;
    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => switchTab(tab.id)}
        aria-current={isActive ? 'page' : undefined}
        style={{
          border: 'none',
          borderRadius: 999,
          minHeight: 36,
          padding: '8px 12px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flex: '0 0 auto',
          background: isActive ? '#EEF6FF' : 'transparent',
          color: isActive ? B.blueDeeper : B.grayMid,
          fontFamily: FONTS.heading,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        <Icon name={tab.icon} size={15} strokeWidth={1.75} />
        {tab.label}
      </button>
    );
  };
  const [showChat, setShowChat] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [requestRefreshKey, setRequestRefreshKey] = useState(0);
  const [switchingPropertyId, setSwitchingPropertyId] = useState(null);
  const menuRef = useRef(null);
  const portalBadgeData = useBadges();

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  if (!customer) return null;

  const initials = `${customer.firstName?.[0] || ''}${customer.lastName?.[0] || ''}`;
  const portalProperties = Array.isArray(properties) ? properties : [];
  const canSwitchProperties = portalProperties.length > 1;
  const propertyRenderKey = `${customer.id}:${requestRefreshKey}`;
  const selectProperty = async (propertyId) => {
    if (!propertyId || propertyId === customer.id || switchingPropertyId) return;
    setSwitchingPropertyId(propertyId);
    const switched = await switchProperty(propertyId);
    setSwitchingPropertyId(null);
    if (switched) {
      setActiveTab('dashboard');
      setVisitsSubTab('upcoming');
      setShowMenu(false);
      setShowMoreSheet(false);
      setRequestRefreshKey(key => key + 1);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: B.offWhite,
      fontFamily: FONTS.body,
    }}>
      {/* Header */}
      <div style={{
        background: 'rgba(255,255,255,0.96)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid #E1E7EF',
        boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
        padding: '12px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 34, width: 'auto' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: B.blueDeeper, fontFamily: FONTS.heading }}>WAVES</div>
            <div style={{ fontSize: 12, color: B.grayMid, fontWeight: 600, letterSpacing: 0, textTransform: 'uppercase' }}>Customer Portal</div>
          </div>
        </div>
        {!isMobileShell && (
          <nav aria-label="Customer portal" style={{
            flex: 1, minWidth: 0, margin: '0 18px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 4, overflowX: 'auto', scrollbarWidth: 'none',
          }}>
            {headerNavItems.map(headerNavButton)}
          </nav>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <NotificationBell type="customer" />
          <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={showMenu}
            style={{
              width: 36, height: 36, borderRadius: '50%',
              background: B.blueDeeper, border: 'none', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: B.white, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: FONTS.heading,
            }}
          >{initials}</button>
          {showMenu && (
            <div style={{
              position: 'absolute', right: 0, top: 44, minWidth: 200,
              background: B.white, borderRadius: 14, overflow: 'hidden',
              boxShadow: '0 8px 30px rgba(0,0,0,0.12)', border: `1px solid ${B.grayLight}`,
              zIndex: 200,
            }}>
              <div style={{ padding: '14px 16px', borderBottom: `1px solid ${B.grayLight}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{customer.firstName} {customer.lastName}</div>
                <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>{formatPhoneDisplay(customer.phone)}</div>
              </div>
              {canSwitchProperties && (
                <div style={{ padding: '10px 10px 8px', borderBottom: `1px solid ${B.grayLight}` }}>
                  <div style={{
                    fontSize: 10, color: B.grayMid, fontWeight: 800, letterSpacing: 0.5,
                    textTransform: 'uppercase', padding: '0 6px 6px',
                  }}>
                    Service Property
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {portalProperties.map(property => {
                      const active = property.id === customer.id;
                      const address = formatPropertyAddress(property);
                      return (
                        <button
                          key={property.id}
                          type="button"
                          onClick={() => selectProperty(property.id)}
                          disabled={active || !!switchingPropertyId}
                          style={{
                            width: '100%', border: 'none', borderRadius: 8, textAlign: 'left',
                            padding: '9px 8px', cursor: active || switchingPropertyId ? 'default' : 'pointer',
                            background: active ? B.offWhite : B.white,
                            color: B.navy, fontFamily: FONTS.body,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 800, minWidth: 0 }}>
                              {property.profileLabel || (property.isPrimaryProfile ? 'Primary' : 'Property')}
                            </span>
                            {active && <span style={{ fontSize: 10, color: B.wavesBlue, fontWeight: 800 }}>Current</span>}
                            {switchingPropertyId === property.id && <span style={{ fontSize: 10, color: B.grayMid, fontWeight: 800 }}>Switching</span>}
                          </div>
                          {address && (
                            <div style={{
                              fontSize: 12, color: B.grayMid, marginTop: 2,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {address}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {[
                { icon: 'home', label: 'Home', action: () => { switchTab('dashboard'); setShowMenu(false); } },
                { icon: 'plan', label: 'My Plan', action: () => { switchTab('plan'); setShowMenu(false); } },
                { icon: 'calendar', label: 'Visits', action: () => { switchTab('schedule'); setShowMenu(false); } },
                { icon: 'card', label: 'Billing', action: () => { switchTab('billing'); setShowMenu(false); } },
                { icon: 'sos', label: 'Request Service', action: () => { switchTab('request'); setShowMenu(false); } },
                { icon: 'gift', label: 'Refer & Earn', action: () => { switchTab('refer'); setShowMenu(false); } },
                { icon: 'document', label: 'Documents', action: () => { switchTab('documents'); setShowMenu(false); } },
                { icon: 'house', label: 'My Property', action: () => { switchTab('property'); setShowMenu(false); } },
                { icon: 'bulb', label: 'Learn', action: () => { switchTab('learn'); setShowMenu(false); } },
              ].map(item => (
                <div key={item.label} onClick={item.action} style={{
                  padding: '11px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                  transition: 'background 0.15s',
                }} onMouseEnter={e => e.currentTarget.style.background = B.offWhite}
                   onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <Icon name={item.icon} size={18} strokeWidth={1.75} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: B.navy }}>{item.label}</span>
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${B.grayLight}` }}>
                <div onClick={() => { logout(); setShowMenu(false); }} style={{
                  padding: '11px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                }} onMouseEnter={e => e.currentTarget.style.background = B.offWhite}
                   onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <Icon name="hand" size={16} strokeWidth={1.75} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: B.red }}>Sign Out</span>
                </div>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Content — bottom padding clears the CTA bar (60px) + bottom nav
          (60px) stack so fixed UI doesn't hide the last section. */}
      <div style={{ padding: `16px 16px ${isMobileShell ? 150 : 32}px`, maxWidth: activeTab === 'dashboard' ? 960 : 700, margin: '0 auto' }}>
        {activeTab !== 'dashboard' && <h1 style={VISUALLY_HIDDEN}>{TAB_TITLES[activeTab] || 'Customer Portal'}</h1>}
        {activeTab === 'dashboard' && <DashboardTab key={`dashboard-${propertyRenderKey}`} customer={customer} onSwitchTab={switchTab} />}
        {activeTab === 'plan' && <MyPlanTab key={`plan-${propertyRenderKey}`} customer={customer} />}
        {activeTab === 'visits' && <VisitsTab key={`visits-${propertyRenderKey}`} customer={customer} properties={portalProperties} subTab={visitsSubTab} onSubTabChange={setVisitsSubTab} onRequestVisit={() => setShowReportIssue(true)} />}
        {activeTab === 'billing' && <BillingTab key={`billing-${propertyRenderKey}`} customer={customer} />}
        {activeTab === 'refer' && <ReferTab key={`refer-${propertyRenderKey}`} customer={customer} onSwitchTab={switchTab} />}
        {activeTab === 'documents' && <DocumentsTab key={`documents-${propertyRenderKey}`} customer={customer} onSwitchTab={switchTab} />}
        {activeTab === 'property' && <PropertyTab key={`property-${propertyRenderKey}`} customer={customer} />}
        {activeTab === 'learn' && <LearnTab key={`learn-${propertyRenderKey}`} customer={customer} />}
      </div>

      <footer style={{
        maxWidth: activeTab === 'dashboard' ? 960 : 700,
        margin: '0 auto',
        padding: `10px 20px ${isMobileShell ? 96 : 44}px`,
        borderTop: '1px solid #D9E2EC',
        color: B.grayMid,
        fontSize: 12,
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <span>Waves Pest Control</span>
        <span>Lakewood Ranch · Sarasota · Venice</span>
      </footer>

      {/* Bottom nav — primary destinations pinned as icons, rest behind
          "More". Sits above the CTA bar (which stays anchored at bottom:0). */}
      {isMobileShell && (
        <BottomNav
          activeTab={activeTab}
          onSelect={switchTab}
          onOpenMore={() => setShowMoreSheet(true)}
          moreActive={showMoreSheet}
        />
      )}
      {isMobileShell && showMoreSheet && (
        <MoreSheet
          activeTab={activeTab}
          onSelect={(id) => { switchTab(id); setShowMoreSheet(false); }}
          onClose={() => setShowMoreSheet(false)}
        />
      )}

      {/* Bottom CTA */}
      {isMobileShell && <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(12px)',
        borderTop: `1px solid ${B.grayLight}`, padding: '10px 12px',
        display: 'flex', gap: 6, justifyContent: 'center', zIndex: 100,
      }}>
        <a href="tel:+19412975749" style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: '#fff', color: B.blueDeeper, fontSize: 12, textAlign: 'center',
          boxShadow: 'none', border: '1px solid #E1E7EF', minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="phone" size={16} strokeWidth={1.75} /> Call</a>
        <a href="sms:+19412975749" style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: '#fff', color: B.blueDeeper, fontSize: 12,
          textAlign: 'center', boxShadow: 'none', border: '1px solid #E1E7EF', minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="chat" size={16} strokeWidth={1.75} /> Text</a>
        <button onClick={() => setShowChat(true)} style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: '#fff', color: B.blueDeeper, fontSize: 12,
          textAlign: 'center', boxShadow: 'none', border: '1px solid #E1E7EF', minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="bot" size={16} strokeWidth={1.75} /> Chat</button>
        <button type="button" onClick={() => setShowReportIssue(true)} style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: B.blueDeeper, color: '#fff', fontSize: 12,
          textAlign: 'center', boxShadow: 'none', minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="wrench" size={16} strokeWidth={1.75} /> Request</button>
      </div>}

      {/* AI Chat Widget */}
      {showChat && <ChatWidget customer={customer} onClose={() => setShowChat(false)} />}

      {/* Report Issue Overlay */}
      <ReportIssueOverlay
        open={showReportIssue}
        onClose={() => setShowReportIssue(false)}
        onSubmitted={() => setRequestRefreshKey(k => k + 1)}
        customer={customer}
      />
    </div>
  );
}
