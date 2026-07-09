// Public archive page for a single sent newsletter. Linked from the
// /newsletter past-issues grid and the authenticated Learn tab in
// PortalPage (via /api/feed/newsletter, which sets
// link=/newsletter/archive/:id for every sent campaign).
//
// The campaign body is operator-authored HTML. We render it inside a
// sandboxed iframe (srcdoc) — no scripts, no plugins, popups allowed
// only so anchor clicks open in a new tab. allow-same-origin is set
// so we can read scrollHeight after load and size the iframe to fit
// the content.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';
import NewsletterSignup from '../components/NewsletterSignup';
import { COLORS as B, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PAGE_BG = '#FAF8F3';
const BORDER = '#E7E2D7';
const TEXT = '#1B2C5B';
const BODY = '#3F4A65';

function ArchiveBody({ html }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const measure = () => {
      try {
        const doc = el.contentDocument;
        if (!doc) return;
        // scrollHeight is the rendered height; add a small buffer to
        // avoid an internal scrollbar from sub-pixel rounding.
        const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
        if (h && h !== height) setHeight(h + 16);
      } catch { /* sandbox blocked access — keep default */ }
    };
    el.addEventListener('load', measure);
    // Re-measure once images finish loading (they extend layout).
    const t = setTimeout(measure, 1500);
    return () => {
      el.removeEventListener('load', measure);
      clearTimeout(t);
    };
  }, [html]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wrap the operator HTML in a minimal document so font-family + max-width
  // apply consistently regardless of whether the body content has its own
  // styles. Email HTML rarely sets a viewport meta, which produces a
  // shrunken render on mobile — inject one.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff;color:${TEXT};}
    body{font-family:${FONTS.body};font-size:16px;line-height:1.6;padding:20px;}
    h1,h2,h3,h4{font-family:${FONTS.serif};color:${TEXT};line-height:1.25;letter-spacing:0;}
    a{color:${B.wavesBlue};}
    img{max-width:100%;height:auto;}
    *{box-sizing:border-box;}
  </style></head><body>${html}</body></html>`;

  return (
    <iframe
      ref={iframeRef}
      title="Newsletter content"
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      style={{
        width: '100%',
        height,
        border: 'none',
        display: 'block',
        background: '#fff',
      }}
    />
  );
}

export default function NewsletterArchivePage() {
  const { id } = useParams();
  const [post, setPost] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ok | notfound

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/public/newsletter/posts/${id}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) { setStatus('notfound'); return; }
        if (!r.ok) { setStatus('notfound'); return; }
        const d = await r.json();
        setPost(d);
        setStatus('ok');
      })
      .catch(() => { if (!cancelled) setStatus('notfound'); });
    return () => { cancelled = true; };
  }, [id]);

  if (status === 'loading') {
    return <div data-glass-clear="" style={{ background: PAGE_BG, minHeight: '100vh' }} />;
  }
  if (status === 'notfound') {
    return (
      <div data-glass-clear="" style={{ background: PAGE_BG, minHeight: '100vh', padding: '56px 24px', textAlign: 'center' }}>
        <h1 style={{ fontFamily: FONTS.serif, fontSize: 32, fontWeight: 500, letterSpacing: 0, color: TEXT, margin: '0 0 8px' }}>
          We couldn't find that issue.
        </h1>
        <p style={{ fontFamily: FONTS.body, color: BODY, marginBottom: 24 }}>
          It may have been removed or the link is incorrect.
        </p>
        <Link
          to="/newsletter"
          data-glass-accent=""
          style={{
            fontFamily: FONTS.ui,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: 0,
            color: '#fff',
            background: B.blueDeeper,
            border: `1px solid ${B.blueDeeper}`,
            borderRadius: 8,
            padding: '12px 22px',
            textDecoration: 'none',
            display: 'inline-block',
          }}
        >
          See the latest issues
        </Link>
      </div>
    );
  }

  const dateLabel = post?.sentAt
    ? new Date(post.sentAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div data-glass-clear="" style={{ background: PAGE_BG, minHeight: '100vh' }}>
      {/* Header strip */}
      <div style={{ background: B.blueDeeper, color: '#fff', padding: '16px 24px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <Link
            to="/newsletter"
            style={{
              fontFamily: FONTS.ui,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0,
              textTransform: 'uppercase',
              color: '#fff',
              textDecoration: 'none',
            }}
          >← The Waves Newsletter</Link>
          {dateLabel && (
            <span style={{ fontFamily: FONTS.body, fontSize: 12, color: 'rgba(255,255,255,0.78)' }}>
              {dateLabel}
            </span>
          )}
        </div>
      </div>

      {/* Subject + preview */}
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 24px 16px' }}>
        <h1 style={{
          fontFamily: FONTS.serif,
          fontSize: 34,
          fontWeight: 500,
          color: TEXT,
          letterSpacing: 0,
          lineHeight: 1.15,
          margin: '0 0 8px',
        }}>
          {post.subject}
        </h1>
        {post.previewText && (
          <p style={{
            fontFamily: FONTS.body,
            fontSize: 15,
            color: BODY,
            lineHeight: 1.55,
            margin: 0,
          }}>{post.previewText}</p>
        )}
      </div>

      {/* Body — sandboxed render of the email HTML */}
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px' }}>
        <div data-glass="card" style={{
          background: '#fff',
          border: `1px solid ${BORDER}`,
          borderRadius: 8,
          overflow: 'hidden',
        }}>
          <ArchiveBody html={post.htmlBody} />
        </div>
      </div>

      {/* Inline signup CTA */}
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '36px 24px 8px' }}>
        <div data-glass="card" style={{
          background: '#fff',
          border: `1px solid ${BORDER}`,
          borderRadius: 8,
          padding: '24px 20px',
          textAlign: 'center',
        }}>
          <NewsletterSignup
            variant="light"
            source="newsletter_archive"
            heading="Want the next one in your inbox?"
            blurb="Free, no spam, unsubscribe anytime."
          />
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px 40px' }}>
        <BrandFooter />
      </div>
    </div>
  );
}
