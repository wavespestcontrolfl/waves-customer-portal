/**
 * Customer reviews carousel — React port of the server-rendered estimate's
 * "Customer reviews" card. Pulls the same rotating Google-review pool
 * (/api/reviews/featured, shared with wavespestcontrol.com), shows pages of
 * three with dot navigation and a 6s auto-advance, and falls back to GBP
 * profile cards when no reviews are available so the section never renders
 * broken or empty.
 */
import { useEffect, useRef, useState } from 'react';
import { estimateCard, estimateInnerBox } from './cardStyles';
import { glassCopyActive, GLASS_COPY } from '../../lib/estimate-glass-copy';
import { fiveStarReviews, GlassReviewMarquee, GlassSectionCta } from './glass/GlassEstimateExtras';

const W = {
  blueDeeper: '#1B2C5B', yellow: '#FFD700',
  textBody: '#3F4A65', textCaption: '#64748B',
  white: '#FFFFFF', warmBorder: '#E7E2D7',
};

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// 3 reviews per page on desktop, 2 on phones (owner directive) — the
// dots pager scrolls the rest.
const MOBILE_MAX_WIDTH = 640;
function pageSizeForViewport() {
  if (typeof window === 'undefined') return 3;
  return window.innerWidth <= MOBILE_MAX_WIDTH ? 2 : 3;
}
const ROTATE_MS = 6000;

// Same three GBP profiles the server-rendered page falls back to.
const REVIEW_FALLBACKS = [
  { name: 'Lakewood Ranch', placeId: 'ChIJVbBOKGYyTCgRVFz8_lu61Mw' },
  { name: 'Parrish', placeId: 'ChIJM32aQRIlw4gRr7goqhbAVpw' },
  { name: 'Sarasota', placeId: 'ChIJeT_63_Y5w4gRGTNLozgSmdw' },
].map((l) => ({
  reviewerName: `Waves ${l.name}`,
  text: `Read current Google reviews for our ${l.name} location.`,
  location: l.name,
  url: `https://www.google.com/maps/place/?q=place_id:${l.placeId}`,
  fallback: true,
}));

function Stars({ rating }) {
  const filled = Math.max(1, Math.min(5, Math.round(Number(rating || 5))));
  return (
    <div aria-hidden="true" style={{ color: W.yellow, fontSize: 14, letterSpacing: 1, marginBottom: 8 }}>
      {'★'.repeat(filled)}{'☆'.repeat(5 - filled)}
    </div>
  );
}

function ReviewCard({ review }) {
  return (
    <div style={estimateInnerBox({ padding: 16, display: 'flex', flexDirection: 'column', minHeight: 150 })}>
      <Stars rating={review.starRating} />
      <p style={{
        fontSize: 13, margin: '0 0 12px', lineHeight: 1.55, color: W.textBody,
        fontStyle: review.fallback ? 'normal' : 'italic', flex: 1,
      }}>
        {review.fallback ? review.text : `“${review.text}”`}
      </p>
      <div style={{ fontSize: 13, color: W.textCaption }}>
        <strong style={{ color: W.blueDeeper }}>{review.reviewerName || 'Waves customer'}</strong>
        {review.location ? ` · ${review.location}` : ''}
      </div>
      {review.url ? (
        <a href={review.url} target="_blank" rel="noopener noreferrer" style={{
          fontSize: 13, fontWeight: 600, color: W.blueDeeper, marginTop: 8,
        }}>
          {review.fallback ? 'Open Google reviews' : 'View local reviews'}
        </a>
      ) : null}
    </div>
  );
}

export default function CustomerReviews({ onJoinNeighbors = null }) {
  const [reviews, setReviews] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(pageSizeForViewport);
  const timerRef = useRef(null);

  useEffect(() => {
    const onResize = () => {
      const next = pageSizeForViewport();
      setPageSize((prev) => {
        if (prev !== next) setPage(0);
        return next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/reviews/featured?limit=8`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('reviews fetch failed'))))
      .then((body) => {
        if (cancelled) return;
        const list = (body?.reviews || []).filter((x) => x?.text && x.text.length > 40);
        setReviews(list.length ? list : REVIEW_FALLBACKS);
      })
      .catch(() => { if (!cancelled) setReviews(REVIEW_FALLBACKS); });
    return () => { cancelled = true; };
  }, []);

  const pageCount = reviews ? Math.max(1, Math.ceil(reviews.length / pageSize)) : 1;

  useEffect(() => {
    if (!reviews || pageCount <= 1) return undefined;
    timerRef.current = setInterval(() => setPage((p) => (p + 1) % pageCount), ROTATE_MS);
    return () => clearInterval(timerRef.current);
  }, [reviews, pageCount]);

  const showPage = (next) => {
    setPage(((next % pageCount) + pageCount) % pageCount);
    // Manual navigation restarts the auto-advance clock so the page the
    // customer just picked doesn't rotate away moments later.
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = setInterval(() => setPage((p) => (p + 1) % pageCount), ROTATE_MS);
    }
  };

  if (!reviews) return null;

  // Glass (PR C): real 5-star reviews render as the continuous GBP-native
  // marquee; the paged carousel stays for the non-glass control, for the
  // GBP profile fallbacks (a marquee of fallback links reads as fake
  // reviews), and when fewer than three TRUE 5-star reviews exist — the
  // gate uses the same filter the marquee applies, so it can never render
  // an empty section.
  const marqueeReviews = fiveStarReviews(reviews);
  const glassMarquee = glassCopyActive() && marqueeReviews.length >= 3
    ? <GlassReviewMarquee reviews={marqueeReviews} />
    : null;

  const start = page * pageSize;
  const visibleCount = Math.min(pageSize, reviews.length);
  const visible = Array.from({ length: visibleCount }, (_, offset) => reviews[(start + offset) % reviews.length]);

  return (
    <section style={estimateCard()}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6,
      }}>
        Reviews
      </div>
      <h2 style={{
        fontFamily: "'Source Serif 4', Georgia, serif",
        fontSize: 24, fontWeight: 500, lineHeight: 1.2,
        color: W.blueDeeper, margin: '0 0 6px',
      }}>
        {glassCopyActive() ? GLASS_COPY.reviewsTitle : 'Customer reviews'}
      </h2>
      <p style={{ fontSize: 14, color: W.textCaption, margin: '0 0 16px', lineHeight: 1.5 }}>
        {glassCopyActive()
          ? GLASS_COPY.reviewsExcerpt
          : 'Real Google reviews from homeowners across our service area.'}
      </p>
      {glassCopyActive() && onJoinNeighbors ? (
        <GlassSectionCta label="Join your neighbors →" onClick={onJoinNeighbors} style={{ margin: '0 0 10px' }} />
      ) : null}
      {glassMarquee || (
        <div style={{
          display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        }}>
          {visible.map((review, i) => (
            <ReviewCard key={`${review.reviewerName || 'review'}-${start + i}`} review={review} />
          ))}
        </div>
      )}
      {pageCount > 1 && !glassMarquee ? (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 14 }}>
          {Array.from({ length: pageCount }, (_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Review group ${i + 1}`}
              onClick={() => showPage(i)}
              style={{
                width: 9, height: 9, borderRadius: '50%', border: 0, padding: 0,
                cursor: 'pointer',
                background: i === page ? W.blueDeeper : W.warmBorder,
              }}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
