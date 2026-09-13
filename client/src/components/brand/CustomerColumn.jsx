import React from 'react';
import { DOC_COLUMN_MAX, FLOW_COLUMN_MAX, PAGE_GUTTER, PAGE_TOP, PAGE_BOTTOM } from '../../theme-doc';

// The one customer page-column primitive (audit G-01, DECISIONS 2026-09-11
// "R2a: one customer page column"). Every glass customer page used to author
// its own wrapper — eleven-plus inline recipes plus five index.css classes,
// giving five different phone gutters and several widths. This component IS
// the recipe: one 16px gutter at every viewport, 28px top clearance, 56px
// bottom clearance, and the two named widths (document 760 / flow 640) —
// never re-author a column wrapper by hand.
//
// `flex: 1` matters: WavesShell's <main> is a flex column, and a page-level
// column must grow to fill it so the shell's footer follows the content
// instead of floating up under short pages (DECISIONS 2026-09-04, "page
// roots use flex: 1").
// The named widths are CONTENT widths (the audit measured card edges, and
// `DOC_COLUMN = 'min(100% - 32px, 760px)'` yields exactly 760 of content at
// desktop). The box is border-box and carries the gutter as padding, so its
// outer cap is content + both gutters — otherwise a 760 cap would render
// 728 of content once the viewport clears 792px.
const COLUMN_MAX = {
  document: DOC_COLUMN_MAX + PAGE_GUTTER * 2,
  flow: FLOW_COLUMN_MAX + PAGE_GUTTER * 2,
};

export default function CustomerColumn({
  column = 'document',
  as: Tag = 'div',
  className,
  style,
  children,
  ...rest
}) {
  const maxWidth = COLUMN_MAX[column] ?? COLUMN_MAX.document;

  return (
    <Tag
      className={className}
      style={{
        boxSizing: 'border-box',
        width: '100%',
        maxWidth,
        margin: '0 auto',
        padding: `${PAGE_TOP}px ${PAGE_GUTTER}px ${PAGE_BOTTOM}px`,
        flex: 1,
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
