import { COLORS as B, FONTS } from '../theme-brand';

export default function BrandFooter({ borderColor, variant }) {
  const onDark = variant === 'dark';
  const headingColor = onDark ? '#fff' : B.navy;
  const accentColor = onDark ? B.yellow : B.wavesBlue;
  const bodyColor = onDark ? 'rgba(255,255,255,0.78)' : B.grayDark;
  const mutedColor = onDark ? 'rgba(255,255,255,0.55)' : B.grayMid;
  const logoOpacity = onDark ? 0.85 : 0.6;
  const defaultBorder = onDark ? 'rgba(255,255,255,0.2)' : B.grayLight;

  return (
    <div style={{
      textAlign: 'center', marginTop: 32, paddingTop: 20,
      borderTop: `1px solid ${borderColor || defaultBorder}`,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: headingColor, fontFamily: FONTS.heading, marginBottom: 6 }}>🌊 Stay in the loop</div>
      <div style={{ fontSize: 15, color: accentColor, fontWeight: 700, fontFamily: FONTS.heading, marginBottom: 10 }}>Wave Goodbye to Pests! 🌊</div>
      <img src="/waves-logo.png" alt="" style={{ height: 28, opacity: logoOpacity, marginBottom: 6 }} />
      <div style={{ fontSize: 13, fontWeight: 700, color: headingColor, fontFamily: FONTS.heading }}>Waves Pest Control, LLC</div>
      <div style={{ fontSize: 12, color: bodyColor, marginTop: 4, lineHeight: 1.6 }}>Family-owned pest control &amp; lawn care · Southwest Florida</div>
      <div style={{ fontSize: 12, color: bodyColor, marginTop: 6, lineHeight: 1.6 }}>Lakewood Ranch · Parrish · Sarasota · Venice</div>
      <div style={{ fontSize: 11, color: mutedColor, marginTop: 10 }}>© {new Date().getFullYear()} Waves Pest Control, LLC · All rights reserved</div>
    </div>
  );
}
