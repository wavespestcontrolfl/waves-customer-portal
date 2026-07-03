/**
 * Customer reviews carousel — React port of the server-rendered estimate's
 * "Customer reviews" card. Pulls the same rotating Google-review pool
 * (/api/reviews/featured, shared with wavespestcontrol.com), shows pages of
 * three with dot navigation and a 6s auto-advance, and falls back to GBP
 * profile cards when no reviews are available so the section never renders
 * broken or empty.
 */
import { useEffect, useRef, useState } from 'react';
import { estimateCard } from './cardStyles';

const W = {
  blueDeeper: '#1B2C5B', yellow: '#FFD700',
  textBody: '#3F4A65', textCaption: '#64748B',
  white: '#FFFFFF', warmBorder: '#E7E2D7',
};

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PAGE_SIZE = 3;
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
    <div style={{
      background: W.white, border: `1px solid ${W.warmBorder}`, borderRadius: 10,
      padding: 16, display: 'flex', flexDirection: 'column', minHeight: 150,
    }}>
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

export default function CustomerReviews() {
  const [reviews, setReviews] = useState(null);
  const [page, setPage] = useState(0);
  const timerRef = useRef(null);

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

  const pageCount = reviews ? Math.max(1, Math.ceil(reviews.length / PAGE_SIZE)) : 1;

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

  const start = page * PAGE_SIZE;
  const visibleCount = Math.min(PAGE_SIZE, reviews.length);
  const visible = Array.from({ length: visibleCount }, (_, offset) => reviews[(start + offset) % reviews.length]);

  return (
    <section style={estimateCard()}>
      <h2 style={{
        fontFamily: "'Source Serif 4', Georgia, serif",
        fontSize: 24, fontWeight: 500, lineHeight: 1.2,
        color: W.blueDeeper, margin: '0 0 6px',
      }}>
        Customer reviews
      </h2>
      <p style={{ fontSize: 14, color: W.textCaption, margin: '0 0 16px', lineHeight: 1.5 }}>
        Real Google reviews from homeowners across our service area.
      </p>
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      }}>
        {visible.map((review, i) => (
          <ReviewCard key={`${review.reviewerName || 'review'}-${start + i}`} review={review} />
        ))}
      </div>
      {pageCount > 1 ? (
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
