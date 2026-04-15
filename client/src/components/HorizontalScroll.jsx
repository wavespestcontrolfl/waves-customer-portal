import React from 'react';

/**
 * Horizontal-scroll wrapper for filter pills, tab bars, action card rows.
 * Hides the scrollbar and bleeds to the viewport edges via negative margin.
 */
export default function HorizontalScroll({ children, gap = 8, edgeBleed = 16, style = {}, className = '' }) {
  return (
    <div
      className={`horizontal-scroll ${className}`}
      style={{
        display: 'flex',
        gap,
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        marginLeft: -edgeBleed,
        marginRight: -edgeBleed,
        paddingLeft: edgeBleed,
        paddingRight: edgeBleed,
        paddingBottom: 4,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
