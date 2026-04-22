import React, { useState } from 'react';

// 44px tap-target button primitive. variant: "primary" | "secondary" | "ghost".
// Per §2, only one primary per page — enforce in composition, not here.
export default function BrandButton({
  variant = 'primary',
  children,
  leftIcon,
  rightIcon,
  disabled,
  fullWidth,
  type = 'button',
  onClick,
  style,
  ...rest
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const base = {
    height: 44,
    padding: '0 20px',
    borderRadius: 'var(--radius-md)',
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 'var(--text-md)',
    fontWeight: 500,
    letterSpacing: '-0.005em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease',
    transform: active && !disabled ? 'translateY(1px)' : 'none',
    width: fullWidth ? '100%' : 'auto',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
  };

  let variantStyle;
  if (variant === 'primary') {
    variantStyle = {
      background: hover && !disabled ? 'var(--brand-hover)' : 'var(--brand)',
      color: '#FFFFFF',
      border: '1px solid transparent',
    };
  } else if (variant === 'secondary') {
    variantStyle = {
      background: hover && !disabled ? 'var(--brand-soft)' : 'var(--surface)',
      color: 'var(--brand)',
      border: '1px solid var(--border-strong)',
    };
  } else {
    variantStyle = {
      background: hover && !disabled ? 'var(--brand-soft)' : 'transparent',
      color: 'var(--text)',
      border: '1px solid transparent',
    };
  }

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{ ...base, ...variantStyle, ...style }}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
