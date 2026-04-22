import React, { forwardRef, useState } from 'react';

// 44px tap-target input with optional icon slot and --brand-ring focus state.
const BrandInput = forwardRef(function BrandInput(
  {
    icon,
    error,
    type = 'text',
    fullWidth = true,
    style,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const [focused, setFocused] = useState(false);

  const wrapStyle = {
    display: 'flex',
    alignItems: 'center',
    height: 44,
    padding: '0 12px',
    background: 'var(--surface)',
    border: `1px solid ${error ? 'var(--danger)' : focused ? 'var(--brand)' : 'var(--border-strong)'}`,
    borderRadius: 'var(--radius-md)',
    boxShadow: focused
      ? `0 0 0 3px ${error ? 'rgba(200, 16, 46, 0.18)' : 'var(--brand-ring)'}`
      : 'none',
    transition: 'border-color 120ms ease, box-shadow 120ms ease',
    width: fullWidth ? '100%' : 'auto',
    boxSizing: 'border-box',
    gap: 8,
  };

  const inputStyle = {
    flex: 1,
    minWidth: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text)',
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 'var(--text-md)',
    fontWeight: 400,
    height: '100%',
  };

  return (
    <label style={{ display: 'block', width: fullWidth ? '100%' : 'auto', ...style }}>
      <div style={wrapStyle}>
        {icon && (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--text-subtle)',
            }}
          >
            {icon}
          </span>
        )}
        <input
          ref={ref}
          type={type}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={inputStyle}
          {...rest}
        />
      </div>
    </label>
  );
});

export default BrandInput;
