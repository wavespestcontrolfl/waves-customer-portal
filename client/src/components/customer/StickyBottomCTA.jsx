import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../Button';
import { COLORS, FONTS } from '../../theme-brand';

const MOBILE_BREAKPOINT = 768;

export function StickyBottomCTA({
  primaryLabel,
  primaryAction,
  primaryVariant = 'primary',
  secondaryLabel,
  secondaryAction,
  priceDisplay,
  hideOnScrollUp = false,
  visible = true,
  primaryDisabled = false,
  primaryLoading = false,
}) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
  );
  const [scrollHidden, setScrollHidden] = useState(false);
  const lastScrollY = useRef(typeof window !== 'undefined' ? window.scrollY : 0);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!hideOnScrollUp) return;
    const onScroll = () => {
      const y = window.scrollY;
      const goingUp = y < lastScrollY.current;
      lastScrollY.current = y;
      if (y < 40) { setScrollHidden(false); return; }
      if (goingUp) setScrollHidden(true);
      else setScrollHidden(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [hideOnScrollUp]);

  if (!isMobile) return null;

  const hidden = !visible || scrollHidden;

  return (
    <div
      data-sticky-bottom-cta
      aria-hidden={hidden}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: COLORS.white,
        borderTop: `1px solid ${COLORS.slate200}`,
        padding: '12px 16px',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        transform: hidden ? 'translateY(100%)' : 'translateY(0)',
        opacity: hidden ? 0 : 1,
        transition: 'transform 300ms cubic-bezier(0, 0, 0.2, 1), opacity 200ms ease-in',
        pointerEvents: hidden ? 'none' : 'auto',
      }}
    >
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          [data-sticky-bottom-cta] {
            transition: opacity 150ms linear !important;
            transform: none !important;
          }
          [data-sticky-bottom-cta][aria-hidden="true"] {
            transform: none !important;
          }
        }
      `}</style>

      <div style={{
        maxWidth: 560,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        {priceDisplay && (
          <div style={{
            flex: '0 0 auto',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontVariantNumeric: 'tabular-nums',
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.blueDeeper,
            lineHeight: 1.1,
            whiteSpace: 'nowrap',
          }}>
            {priceDisplay}
          </div>
        )}

        <Button
          variant={primaryVariant}
          onClick={primaryAction}
          disabled={primaryDisabled || primaryLoading}
          fullWidthMobile
          style={{ flex: 1, minHeight: 48 }}
        >
          {primaryLoading ? 'Processing…' : primaryLabel}
        </Button>
      </div>

      {secondaryLabel && secondaryAction && (
        <div style={{
          maxWidth: 560,
          margin: '6px auto 0',
          textAlign: 'center',
        }}>
          <button
            type="button"
            onClick={secondaryAction}
            className="btn btn-tertiary"
            style={{
              fontSize: 14,
              fontFamily: FONTS.ui,
              background: 'transparent',
              minHeight: 'auto',
              padding: '4px 8px',
            }}
          >
            {secondaryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export default StickyBottomCTA;
