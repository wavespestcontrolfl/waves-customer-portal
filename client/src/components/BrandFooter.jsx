import { COLORS as B, FONTS } from '../theme-brand';

export default function BrandFooter({ borderColor, variant }) {
  const onDark = variant === 'dark';
  const headingColor = onDark ? '#fff' : B.navy;
  const accentColor = onDark ? B.yellow : B.wavesBlue;
  const bodyColor = onDark ? 'rgba(255,255,255,0.78)' : B.grayDark;
  const mutedColor = onDark ? 'rgba(255,255,255,0.55)' : B.grayMid;
  const logoOpacity = onDark ? 0.85 : 0.6;
  const defaultBorder = onDark ? 'rgba(255,255,255,0.2)' : B.grayLight;
  const socialBg = onDark ? 'rgba(255,255,255,0.15)' : B.wavesBlue;
  const socialFg = onDark ? B.yellow : '#fff';

  const socials = [
    { name: 'Facebook', url: 'https://facebook.com/wavespestcontrol', path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
    { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
    { name: 'YouTube', url: 'https://youtube.com/@wavespestcontrol', path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
    { name: 'TikTok', url: 'https://tiktok.com/@wavespestcontrol', path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
    { name: 'X', url: 'https://x.com/wavespest', path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
  ];

  return (
    <div style={{
      textAlign: 'center', marginTop: 32, paddingTop: 20,
      borderTop: `1px solid ${borderColor || defaultBorder}`,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: headingColor, fontFamily: FONTS.heading, marginBottom: 10 }}>🌊 Stay in the loop</div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 12 }}>
        {socials.map(s => (
          <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" title={s.name} aria-label={s.name} style={{
            width: 36, height: 36, borderRadius: '50%',
            background: socialBg, color: socialFg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            textDecoration: 'none',
          }}>
            <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><path d={s.path} /></svg>
          </a>
        ))}
      </div>
      <div style={{ fontSize: 15, color: accentColor, fontWeight: 700, fontFamily: FONTS.heading, marginBottom: 10 }}>Wave Goodbye to Pests!</div>
      <img src="/waves-logo.png" alt="" style={{ height: 28, opacity: logoOpacity, marginBottom: 6 }} />
      <div style={{ fontSize: 13, fontWeight: 700, color: headingColor, fontFamily: FONTS.heading }}>Waves Pest Control, LLC</div>
      <div style={{ fontSize: 12, color: bodyColor, marginTop: 4, lineHeight: 1.6 }}>Family-owned pest control &amp; lawn care · Southwest Florida</div>
      <div style={{ fontSize: 12, color: bodyColor, marginTop: 6, lineHeight: 1.6 }}>Lakewood Ranch · Parrish · Sarasota · Venice</div>
      <div style={{ fontSize: 11, color: mutedColor, marginTop: 10 }}>© {new Date().getFullYear()} Waves Pest Control, LLC · All rights reserved</div>
    </div>
  );
}
