// Public newsletter landing page — mirrors the existing
// wavespestcontrol.com/newsletter/ page for the portal domain. Linkable
// from emails, social, paid ads, footer.
//
// Sections (top → bottom):
//   - Hero: headline + subhead + NewsletterSignup
//   - Value props: 4 bullets on what's in the newsletter
//   - Past issues: most recent sent campaigns from /api/feed/newsletter
//   - BrandFooter (own signup is hidden via the page's source attribution)

import { useEffect, useState } from 'react';
import BrandFooter from '../components/BrandFooter';
import NewsletterSignup from '../components/NewsletterSignup';
import { COLORS as B, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const VALUE_PROPS = [
  { emoji: '📅', label: "Local SWFL events", body: "Bradenton, Sarasota, Lakewood Ranch, Venice — what's worth your weekend." },
  { emoji: '🦟', label: "Seasonal pest alerts", body: 'When mosquito season ramps, when termites swarm, when palmetto bugs come indoors.' },
  { emoji: '🌱', label: 'Lawn-care timing', body: "St. Augustine, Bahia, chinch bug season, nitrogen-blackout months — straight from the truck." },
  { emoji: '🎁', label: 'Subscriber-only deals', body: 'The occasional discount we only run for folks on the list.' },
];

function Hero() {
  return (
    <section
      style={{
        background: `linear-gradient(180deg, ${B.blueDeeper} 0%, ${B.wavesBlue} 100%)`,
        color: '#fff',
        padding: 'clamp(56px, 9vw, 96px) 24px clamp(48px, 7vw, 72px)',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div
          style={{
            display: 'inline-block',
            padding: '6px 14px',
            borderRadius: 9999,
            background: 'rgba(255,255,255,0.15)',
            color: B.yellow,
            fontFamily: FONTS.ui,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: 18,
          }}
        >
          The Waves Newsletter
        </div>
        <h1
          style={{
            fontFamily: FONTS.display,
            fontSize: 'clamp(34px, 6vw, 60px)',
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '0.01em',
            margin: '0 0 14px',
          }}
        >
          Your SWFL life,<br />made easier.
        </h1>
        <p
          style={{
            fontFamily: FONTS.body,
            fontSize: 'clamp(15px, 1.6vw, 18px)',
            lineHeight: 1.55,
            color: 'rgba(255,255,255,0.85)',
            margin: '0 auto 28px',
            maxWidth: 560,
          }}
        >
          Local events, seasonal pest tips, and lawn-care timing — straight from
          our trucks to your inbox. Free, no spam, unsubscribe anytime.
        </p>
        <div
          style={{
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.20)',
            borderRadius: 16,
            padding: '20px 18px',
            backdropFilter: 'blur(4px)',
          }}
        >
          <NewsletterSignup
            variant="dark"
            source="newsletter_landing"
            heading={null}
            blurb={null}
          />
          <div
            style={{
              marginTop: 12,
              fontFamily: FONTS.body,
              fontSize: 11,
              color: 'rgba(255,255,255,0.65)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            Free · No spam · Unsubscribe anytime
          </div>
        </div>
      </div>
    </section>
  );
}

function ValueProps() {
  return (
    <section style={{ background: B.sand, padding: 'clamp(48px, 7vw, 80px) 24px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <h2
          style={{
            fontFamily: FONTS.display,
            fontSize: 'clamp(26px, 3.8vw, 38px)',
            fontWeight: 700,
            color: B.blueDeeper,
            textAlign: 'center',
            margin: '0 0 28px',
            letterSpacing: '0.01em',
          }}
        >
          What you'll get
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
          }}
        >
          {VALUE_PROPS.map((v) => (
            <div
              key={v.label}
              style={{
                background: '#fff',
                border: `1px solid ${B.grayLight}`,
                borderRadius: 14,
                padding: '20px 18px',
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 10 }}>{v.emoji}</div>
              <div
                style={{
                  fontFamily: FONTS.heading,
                  fontSize: 16,
                  fontWeight: 700,
                  color: B.blueDeeper,
                  marginBottom: 6,
                }}
              >
                {v.label}
              </div>
              <div
                style={{
                  fontFamily: FONTS.body,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: B.slate600,
                }}
              >
                {v.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PastIssue({ post }) {
  const dateLabel = post.pubDate
    ? new Date(post.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  const cardStyle = {
    display: 'block',
    background: '#fff',
    border: `1px solid ${B.grayLight}`,
    borderRadius: 12,
    padding: '14px 16px',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'border-color 150ms ease-out',
  };
  // Beehiiv-imported rows link to the original Beehiiv archive URL;
  // in-house sends link to /newsletter/archive/:id. The link-less
  // branch below is a defensive fallback for any malformed row.
  const inner = (
    <>
      <div
        style={{
          fontFamily: FONTS.heading,
          fontSize: 15,
          fontWeight: 700,
          color: B.blueDeeper,
          lineHeight: 1.35,
          marginBottom: 6,
        }}
      >
        {post.title || '(untitled)'}
      </div>
      {post.description && (
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 13,
            color: B.slate600,
            lineHeight: 1.55,
            marginBottom: 8,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {post.description}
        </div>
      )}
      {dateLabel && (
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 11,
            color: B.grayMid,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {dateLabel}
        </div>
      )}
    </>
  );

  if (post.link) {
    return (
      <a
        href={post.link}
        target="_blank"
        rel="noopener noreferrer"
        style={cardStyle}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = B.wavesBlue; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = B.grayLight; }}
      >{inner}</a>
    );
  }
  return <div style={cardStyle}>{inner}</div>;
}

function PastIssues() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/public/newsletter/posts`)
      .then((r) => r.ok ? r.json() : { posts: [] })
      .then((d) => setPosts(d.posts || []))
      .catch(() => setPosts([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && !posts.length) return null;

  return (
    <section style={{ background: '#fff', padding: 'clamp(48px, 7vw, 80px) 24px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <h2
          style={{
            fontFamily: FONTS.display,
            fontSize: 'clamp(26px, 3.8vw, 38px)',
            fontWeight: 700,
            color: B.blueDeeper,
            textAlign: 'center',
            margin: '0 0 8px',
            letterSpacing: '0.01em',
          }}
        >
          Past issues
        </h2>
        <p
          style={{
            fontFamily: FONTS.body,
            fontSize: 14,
            color: B.slate600,
            textAlign: 'center',
            margin: '0 0 24px',
          }}
        >
          A taste of what lands in your inbox.
        </p>
        {loading ? (
          <div style={{ textAlign: 'center', color: B.grayMid, padding: 24, fontSize: 13 }}>Loading…</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 12,
            }}
          >
            {posts.slice(0, 6).map((p, i) => <PastIssue key={p.link || i} post={p} />)}
          </div>
        )}
      </div>
    </section>
  );
}

export default function NewsletterLandingPage() {
  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <Hero />
      <ValueProps />
      <PastIssues />
      <div style={{ background: B.sand, padding: '24px 24px 48px' }}>
        <div style={{ maxWidth: 880, margin: '0 auto' }}>
          <BrandFooter />
        </div>
      </div>
    </div>
  );
}
