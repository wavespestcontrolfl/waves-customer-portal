import React from 'react';

// Surface card primitive — border, radius-xl, shadow-card, 32–36px padding.
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

  return (
    <section
      {...rest}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: shadow,
        padding,
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
