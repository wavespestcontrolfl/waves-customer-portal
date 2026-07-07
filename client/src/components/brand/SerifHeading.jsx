import React, { useEffect, useRef } from 'react';
import { useWavesShell } from './WavesShellContext';

// Customer-surface H1. The component name is retained for compatibility with
// existing pages, but the visual treatment is now the cleaner Inter portal
// heading rather than an ornamental serif.
export default function SerifHeading({
  children,
  as: Tag = 'h1',
  size,
  style,
  ...rest
}) {
  const { variant } = useWavesShell();
  const warned = useRef(false);

  useEffect(() => {
    if (
      variant === 'admin' &&
      !warned.current &&
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production'
    ) {
      warned.current = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[SerifHeading] Customer display headings are reserved for customer surfaces (§4). ' +
          'Do not use <SerifHeading> inside <WavesShell variant="admin">. ' +
          'Use Inter headings on admin surfaces.',
      );
    }
  }, [variant]);

  return (
    <Tag
      {...rest}
      style={{
        fontFamily: "'Inter', system-ui, sans-serif",
        fontWeight: 600,
        fontSize: size || 'var(--h1-serif)',
        letterSpacing: 0,
        lineHeight: 1.1,
        color: 'var(--text)',
        margin: 0,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
