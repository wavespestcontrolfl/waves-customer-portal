import React from 'react';

export default function WavesMark({ size = 28, fill, title = 'Waves' }) {
  const brandFill = fill || 'var(--brand)';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      role="img"
      aria-label={title}
      style={{ display: 'block' }}
    >
      <rect width="28" height="28" rx="6" fill={brandFill} />
      <path
        d="M5 17.5c1.7 0 1.7-1.6 3.5-1.6s1.8 1.6 3.5 1.6 1.8-1.6 3.5-1.6 1.8 1.6 3.5 1.6 1.8-1.6 3.5-1.6"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 13c1.7 0 1.7-1.6 3.5-1.6s1.8 1.6 3.5 1.6 1.8-1.6 3.5-1.6 1.8 1.6 3.5 1.6 1.8-1.6 3.5-1.6"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.65"
      />
    </svg>
  );
}
