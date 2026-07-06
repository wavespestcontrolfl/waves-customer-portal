import React from 'react';

// Surface card primitive — border, compact radius, shadow-card, responsive padding.
// elevation="flat" drops the shadow (used inside /admin/login's single-card
// layout). elevation="modal" bumps to --shadow-modal for floating cards like
// /login's video-hero card.
export default function BrandCard({
  children,
  elevation = 'card',
  padding = 32,
  maxWidth,
  style,
  ...rest
}) {
  const shadow =
    elevation === 'modal'
      ? 'var(--shadow-modal)'
      : elevation === 'flat'
      ? 'none'
      : 'var(--shadow-card)';

  const resolvedPadding = typeof padding === 'number'
    ? `clamp(20px, 4vw, ${padding}px)`
    : padding;

  return (
    <section
      data-glass="card"
      {...rest}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: shadow,
        padding: resolvedPadding,
        maxWidth,
        width: '100%',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {children}
    </section>
  );
}
