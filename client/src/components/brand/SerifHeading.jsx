import React, { useEffect, useRef } from 'react';
import { useWavesShell } from './WavesShellContext';

// Single-use Instrument Serif H1 for customer surfaces. Per §2, exactly one
// per page. Throws a dev warning if used inside <WavesShell variant="admin">
// (admin surfaces are Inter-only per §4).
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
        '[SerifHeading] Instrument Serif is reserved for customer surfaces (§4). ' +
          'Do not use <SerifHeading> inside <WavesShell variant="admin">. ' +
          'Use Inter headings on admin surfaces.',
      );
    }
  }, [variant]);

  return (
    <Tag
      {...rest}
      style={{
        fontFamily: "'Instrument Serif', Georgia, 'Times New Roman', serif",
        fontWeight: 400,
        fontSize: size || 'var(--h1-serif)',
        letterSpacing: '-0.01em',
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
