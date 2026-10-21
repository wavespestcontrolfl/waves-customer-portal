import React from 'react';
import { WAVES_FL_LICENSE_LINE } from '../../constants/business';

// GATE_REPORT_WEB_TOP (owner 2026-10-20): the screen trims of the simple web report, kept out of ServiceReportDocument
// so the document gains no decisions. The server sends `webTop` (an object, even an empty one) only to the web view
// while the gate is live. A trim is SCREEN-ONLY: the cut part stays in the markup, marked `doc-print-only` (hidden
// under @media screen), and its screen replacement is marked `doc-screen-only` (hidden under @media print), so a
// browser Print of the live page is the full document. The PDF never carries webTop, so its markup is unchanged.

/** One view of the trims for a render: whether they apply, and the two class strings the document appends. */
export function webCutView(web, data) {
  const on = web && Boolean(data?.webTop);
  return { on, rootClass: on ? ' is-cut' : '', printOnly: on ? ' doc-print-only' : '' };
}

/** A div the screen trims hide (print keeps it). With no trim it renders exactly the plain div. */
export function PrintOnly({ cut, className, children, ...rest }) {
  const classes = [className, cut.on ? 'doc-print-only' : ''].filter(Boolean).join(' ');
  return <div {...rest} className={classes || undefined}>{children}</div>;
}

/** The identity line the web page's own footer already says (Waves, the service area, the license). */
export function FooterIdentity({ cut }) {
  const line = (
    <>
      <br />
      Waves Pest Control, LLC · Family-owned pest control and lawn care in Southwest Florida · Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}
    </>
  );
  return cut.on ? <span className="doc-print-only">{line}</span> : line;
}
