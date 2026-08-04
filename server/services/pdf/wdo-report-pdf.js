/**
 * FDACS-13645 Wood-Destroying Organisms Inspection Report — official PDF filler.
 *
 * Takes a `wdo_inspection` project's structured findings and stamps them onto
 * the genuine state form (server/assets/forms/fdacs-13645-fillable.pdf — the
 * decrypted, fillable AcroForm version of forms.fdacs.gov/13645.pdf). The
 * output is the real FDACS form, filled and flattened (locked) so it can be
 * filed / handed to a realtor or buyer.
 *
 * Signature protocol (Rule 5E-14.142, F.A.C. / Ch. 482.226, F.S.): the report
 * must carry the signature of the licensee/cardholder who performed the
 * inspection. We DO NOT auto-forge a signature — the printed name, ID-card
 * number, and date are filled, but the signature line is left blank for the
 * licensee to sign (wet or e-sign) before filing.
 *
 * Field mapping is intentionally defensive: a missing/renamed field in a future
 * form revision is logged and skipped, never thrown, so one bad field can't
 * fail the whole report.
 *
 * Long values never silently shrink/clip: free-text findings word-flow across
 * the form's printed lines at no smaller than FORM_FONT_FLOOR, and anything
 * that doesn't fit ends with a "(continued on attached page)" marker and is
 * printed in full on appended continuation page(s) — the mechanism the form
 * itself prescribes. All field text is WinAnsi-sanitized (sanitizeText), so
 * unicode/emoji typed on a phone can't make pdfDoc.save() throw.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const logger = require('../logger');
const {
  WAVES_BUSINESS_NAME,
  WAVES_FDACS_LICENSE_NUMBER,
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
} = require('../../constants/business');
const { formatDisplayDate } = require('../../utils/date-only');
const {
  stripInternalFindingKeys,
  redactInspectionFeeCues,
  redactSpecificAmounts,
  projectRecordedFeeValues,
  projectTypeFreeTextKeys,
} = require('../project-types');

// The emailed/archived FDACS PDF is a customer deliverable — it gets the
// same internal-key strip + fee-cue scrub as the public /data payload, or a
// fee typed into the free-text comments prints into Section 5 even though
// the web rendering hides it (codex #2817). WDO is the fee-carrying type, so
// the value scrub is unconditional here. The FDACS-13645 form has no fee
// field of its own, and the disclosure-of-interest statements in comments
// don't carry amounts, so nothing the form REQUIRES is touched.
function customerSafeFindings(rawFindings, feeValues = []) {
  return stripInternalFindingKeys(asObject(rawFindings), {
    redactValues: true,
    feeValues,
    // value pass on free-prose fields only — a structured address can
    // legitimately contain the fee's digits ("175 Main Street")
    freeTextKeys: projectTypeFreeTextKeys('wdo_inspection'),
  }) || {};
}

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'forms', 'fdacs-13645-fillable.pdf');

let cachedTemplateBytes = null;
function loadTemplateBytes() {
  if (!cachedTemplateBytes) {
    cachedTemplateBytes = fs.readFileSync(TEMPLATE_PATH);
  }
  return cachedTemplateBytes;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Split "13649 Luxe Ave #110, Bradenton, FL 34211" into street / city-state-zip.
function splitCompanyAddress(line) {
  const raw = clean(line);
  const idx = raw.indexOf(',');
  if (idx < 0) return { street: raw, cityStateZip: '' };
  return {
    street: raw.slice(0, idx).trim(),
    cityStateZip: raw.slice(idx + 1).trim(),
  };
}

function displayDate(value) {
  if (!value) return '';
  return formatDisplayDate(value, { fallback: '' });
}

function joinMulti(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return clean(value);
}

/**
 * Build the field value map: FDACS AcroForm field name -> value/instruction.
 * Text fields take a string. Checkboxes/radios are handled separately below.
 */
function buildTextValues({ findings, customer, project, applicator }) {
  const addr = splitCompanyAddress(WAVES_ADDRESS_LINE);
  const propertyAddress = clean(findings.property_address)
    || [customer?.address_line1, [customer?.city, customer?.state].filter(Boolean).join(', '), customer?.zip]
      .filter(Boolean).join(' ');
  const inspectionDate = displayDate(findings.inspection_date || project?.project_date || project?.created_at);

  return {
    // Section 1 — inspection company / inspector
    'Inspection Company Name': WAVES_BUSINESS_NAME,
    'Business License Number': WAVES_FDACS_LICENSE_NUMBER,
    'Company Address': addr.street,
    'Company City State and Zip Code': addr.cityStateZip,
    'Phone Number': WAVES_SUPPORT_PHONE_DISPLAY,
    'Date of Inspection': inspectionDate,
    'Print Name': clean(applicator.name),
    'ID Card No': clean(applicator.idCardNo),

    // Property + requester
    'Address of Property Inspected': propertyAddress,
    'addrofpropinspected': propertyAddress,
    'inspecdate8': inspectionDate,
    'Structures on Property Inspected': clean(findings.structures_inspected),
    'Name and Contact Information': clean(findings.requested_by),
    'Name and Contact Information if different from above': clean(findings.report_sent_to),

    // Section 4 — notice of inspection + treatment. The two "notice" blanks are
    // distinct on the form (verified against a self-labeled render of the
    // template's AcroForm):
    //   - "A Notice of Inspection has been affixed to the structure at: ___"
    //     is the field auto-named from the sentence that FOLLOWS the blank
    //     ("should be contacted ..."). Rule 5E-14.142 requires this location.
    //   - "Specify Treatment Notice Location: ___" is 'undefined_9'.
    //   - 'locationtreatment' is the description blank after the "Spot
    //     treatment" checkbox; the findings collect no spot-treatment
    //     description, so it intentionally stays blank.
    'should be contacted for information on treatment history and any warranty or service agreement which may be in place':
      clean(findings.notice_location),
    'undefined_9': clean(findings.treatment_notice_location),
    'comorgtreated': joinMulti(findings.organism_treated),
    'pesticideused': clean(findings.pesticide_used),
    'termscondtreat': clean(findings.treatment_terms),

    'Date': inspectionDate,

    // Signature intentionally left blank — licensee signs before filing.
    // 'signaturelicensee': '',
  };
}

// Free-text findings that flow across the form's printed writing lines. Each
// section's lines are separate single-line AcroForm fields (names verified
// against a self-labeled render); text is word-flowed across them at no
// smaller than FORM_FONT_FLOOR, and anything that doesn't fit continues on an
// appended continuation page — the mechanism the form itself prescribes
// ("use additional page, if needed") — instead of pdf-lib auto-shrinking the
// whole value to an unreadable ~3pt and clipping the rest.
const LINE_POOLS = {
  live_wdo: {
    label: 'Section 2.B.1 - Live WDO(s) (common name of organism and location)',
    order: 20,
    fields: [
      'Common Name of Organism and Location  use additional page if needed',
      'undefined',
    ],
  },
  wdo_evidence: {
    label: 'Section 2.B.2 - Evidence of WDO(s) (common name, description and location)',
    order: 21,
    fields: [
      'Common Name Description and Location  Describe evidence',
      'use additional page if needed 1',
      'use additional page if needed 2',
    ],
  },
  wdo_damage: {
    label: 'Section 2.B.3 - Damage caused by WDO(s) (common name, description and location)',
    order: 22,
    fields: [
      'Common Name Description and Location of all visible damage  Describe damage',
      'use additional page if needed 1_2',
      'use additional page if needed 2_2',
      'use additional page if needed 3',
      'use additional page if needed 4',
      'use additional page if needed 5',
      'use additional page if needed 6',
      'use additional page if needed 7',
    ],
  },
  // Section 3 is NOT a LINE_POOLS entry — its findings value is one blob that
  // has to be split across five independently-checkboxed rows. See
  // INACCESSIBLE_ROWS / fillInaccessibleAreas below.
  // "List what was observed" line 1 is the field auto-named from the label
  // text ('EVIDENCE of previous treatment observed'); the previously-mapped
  // 'treatment List what was observed' is its continuation line 2.
  previous_treatment_notes: {
    label: 'Section 4 - Previous treatment: what was observed',
    order: 40,
    fields: [
      'EVIDENCE of previous treatment observed',
      'treatment List what was observed',
    ],
  },
  // Comments line 1 is the field auto-named from the section header; the
  // previously-mapped 'Comments 1' is line 2.
  comments: {
    label: 'Section 5 - Comments',
    order: 50,
    fields: [
      'SECTION 5  COMMENTS AND FINANCIAL DISCLOSURE',
      'Comments 1',
      'Comments 2',
      'Comments 3',
      'Comments 4',
    ],
  },
};

// Section 3 has FIVE checkbox-labelled rows, each owning THREE writing lines.
// Field names were verified against the bundled template's widget geometry
// (page 2, y 685 down to 475) — they are NOT guessable from the names alone:
// each row's "SPECIFIC AREAS" line is the field the form's auto-namer took
// from the text above it ('not visible andor accessible ...' for Attic,
// 'undefined_2'..'undefined_5' for the rest), so the field literally called
// 'SPECIFIC AREAS_n' sits on the REASON line and 'REASON_n' on the row's
// third line. Mapping by name instead of geometry puts text a line low.
//
// The findings collect ONE free-text blob, so it has to be split back out per
// row — otherwise every category's text prints on the Attic row and the form
// reads as if wall voids / soffits / substructure were all attic limitations.
const INACCESSIBLE_ROWS = [
  {
    key: 'attic',
    checkbox: 'Attic',
    label: 'Section 3 - Attic (specific areas and reasons)',
    order: 30,
    fields: [
      'not visible andor accessible for inspection The descriptions and reasons for inaccessibility are stated below',
      'SPECIFIC AREAS',
      'REASON',
    ],
  },
  {
    key: 'interior',
    checkbox: 'Interior',
    label: 'Section 3 - Interior (specific areas and reasons)',
    order: 31,
    fields: ['undefined_2', 'SPECIFIC AREAS_2', 'REASON_2'],
  },
  {
    key: 'exterior',
    checkbox: 'Exterior',
    label: 'Section 3 - Exterior (specific areas and reasons)',
    order: 32,
    fields: ['undefined_3', 'SPECIFIC AREAS_3', 'REASON_3'],
  },
  {
    key: 'crawlspace',
    checkbox: 'Crawlspace',
    label: 'Section 3 - Crawlspace (specific areas and reasons)',
    order: 33,
    fields: ['undefined_4', 'SPECIFIC AREAS_4', 'REASON_4'],
  },
  {
    key: 'other',
    checkbox: 'Other',
    label: 'Section 3 - Other (specific areas and reasons)',
    order: 34,
    fields: ['undefined_5', 'SPECIFIC AREAS_5', 'REASON_5'],
  },
];

// Category labels as written in the findings blob. Longest-first so
// "crawl space" wins over a bare "crawl", and the alternation can't match a
// prefix of a longer label.
//
// TWO forms, because the findings blob has two writers:
//  1. Line-anchored, separator OPTIONAL — the property-intelligence emitter
//     (client/src/lib/wdoProfileToFindings.js) appends whole lines like
//     "Crawlspace present — verify access and clearance on site.", where a
//     filler word sits between the category and the dash. Each appended note
//     is its own line, so a line STARTING with a category word is that
//     category's row. Without this, such a note folds into whatever labelled
//     segment preceded it and its box never ticks.
//  2. Inline, separator REQUIRED — "Attic: insulation. Interior: wall voids."
//     typed by the tech. A bare category word mid-sentence ("areas of the
//     interior") must NOT split, so here the colon/dash is mandatory.
// A dash separator MUST have whitespace on both sides. Without that, ordinary
// hyphenated compounds parse as labels: "inaccessible at exterior-facing
// eaves" split at "exterior-", stranding "inaccessible at" on the Attic row
// and ticking Exterior with the remainder. A colon needs no surrounding space.
const INACCESSIBLE_CATEGORY_WORDS = String.raw`crawl[-\s]*spaces?|crawlspaces?|crawl|attics?|interiors?|exteriors?|other`;
const INACCESSIBLE_LABEL_PATTERN = new RegExp(
  // Line-anchored: a colon, OR whitespace when a spaced dash follows one filler
  // word — the emitter's "Crawlspace present — …" shape (the lookahead keeps
  // "present" in the row text). Requiring one of those is what stops a sentence
  // that merely BEGINS with a category word ("Attic, interior and exterior
  // areas were blocked") from being read as a single-category label, which
  // would drop the other categories.
  String.raw`(?:^|\n)[\s;,]*(${INACCESSIBLE_CATEGORY_WORDS})\b(?:[ \t]*:[ \t]*|[ \t]+(?=\w+[ \t]+[—–-][ \t]+))`
  // Inline: colon, or a dash with whitespace on BOTH sides.
  + String.raw`|\b(${INACCESSIBLE_CATEGORY_WORDS})\b(?:[ \t]*:[ \t]*|\s+[—–-]\s+)`,
  'gi'
);

function inaccessibleRowKeyFor(word) {
  const w = word.toLowerCase().replace(/\s+/g, '');
  if (w.startsWith('crawl')) return 'crawlspace';
  if (w.startsWith('attic')) return 'attic';
  if (w.startsWith('interior')) return 'interior';
  if (w.startsWith('exterior')) return 'exterior';
  return 'other';
}

/**
 * Split the single Section 3 findings blob into per-row text.
 *
 * ONE parser drives BOTH the checkboxes and the line routing — a second
 * independent matcher would drift out of sync and re-create the exact bug this
 * fixes (a row ticked with its text printed on a different row).
 *
 * Labelled form ("Attic: insulation. Interior: wall voids.") routes each
 * segment to its own row. Unlabelled text falls back to keyword detection and
 * is written to the FIRST matching row, so the text always lands on a row that
 * is actually ticked. Text matching nothing goes to Other.
 *
 * Returns { rows: {key: text}, ticked: Set<key> }.
 */
function splitInaccessibleAreas(value) {
  const text = formText(value);
  const rows = {};
  const ticked = new Set();
  if (!text) return { rows, ticked };

  const append = (key, chunk, joiner = ' ') => {
    // Strip separator punctuation the label split leaves behind. A period is
    // only separator noise when it is NOT a decimal point — stripping the one
    // in "Interior: .5-inch opening" would record "5-inch" and misstate a
    // measurement by a factor of ten on a signed filing.
    const piece = chunk.trim().replace(/^(?:[;,\s]|\.(?!\d))+/, '').replace(/[;,\s]+$/, '').trim();
    if (!piece) return;
    rows[key] = rows[key] ? `${rows[key]}${joiner}${piece}` : piece;
  };

  // NOTE: only ever called on a preamble or an UNLABELLED clause — never on the
  // body of an explicit label. That is what keeps "Attic: inaccessible at
  // exterior-facing eaves" from ticking Exterior: the body never reaches here.
  // So a hyphenated form IS a real classification signal in this context
  // ("Exterior-facing eaves were inaccessible" is an Exterior limitation) and
  // must not be suppressed.
  const categoriesMentionedIn = (chunk) => {
    const lower = chunk.toLowerCase();
    return INACCESSIBLE_ROWS.filter((row) => (
      row.key === 'crawlspace'
        ? /\bcrawl[-\s]?spaces?\b|\bcrawl\b/i.test(lower)
        : new RegExp(String.raw`\b${row.key}\w*\b`, 'i').test(lower)
    ));
  };

  // Line by line, then clause by clause within a line. The blob is built by
  // appending whole lines (the property-intelligence emitter) and by a tech
  // typing prose, and a semicolon starts a new claim inside a line.
  // The row the previous clause spoke about, so an unlabelled clause naming no
  // category reads as a CONTINUATION of it ("Crawlspace: skirting was closed;
  // the area beneath was not inspected") rather than a new area. It carries
  // ACROSS lines too — a tech wrapping one reason onto a second line is still
  // describing the same row. A line that is labelled, or that names a
  // category, overrides it.
  let lastKey = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // A blank line is a paragraph boundary between separate entries — the next
    // one is a new limitation, not a continuation of the last row.
    if (!line) { lastKey = null; continue; }

    const clauses = line.split(';');
    for (let ci = 0; ci < clauses.length; ci += 1) {
      const clause = clauses[ci].trim();
      if (!clause) continue;
      // A semicolon-split clause rejoins with its semicolon; a wrapped LINE
      // (ci === 0) is mid-sentence and rejoins with a plain space.
      const contJoiner = ci === 0 ? ' ' : '; ';

      INACCESSIBLE_LABEL_PATTERN.lastIndex = 0;
      const marks = [];
      let m;
      while ((m = INACCESSIBLE_LABEL_PATTERN.exec(clause)) !== null) {
        // m[1] = line-anchored form, m[2] = inline form (see the pattern above).
        marks.push({ key: inaccessibleRowKeyFor(m[1] || m[2]), start: m.index, bodyStart: m.index + m[0].length });
      }

      if (marks.length) {
        // Text before the first label continues the PREVIOUS clause's row when
        // there is one ("Crawlspace: skirting closed; the area beneath was not
        // inspected. Interior: ..." — that middle sentence is crawlspace, not
        // interior). With no previous row it attaches to the first label rather
        // than being dropped.
        const preamble = clause.slice(0, marks[0].start);
        if (preamble.trim()) {
          // A preamble that NAMES categories is a list, not stray text — the
          // repo's own placeholder is exactly this shape ("Attic, interior,
          // exterior, crawlspace, other: specific areas and reasons"), where
          // only the final "other:" is an explicit label. Routing it to that
          // label alone would leave the four named categories unticked.
          const named = categoriesMentionedIn(preamble);
          if (named.length) {
            // List shape: "Attic, interior, exterior, crawlspace, other: blocked
            // by stored goods". The categories are the LIST and the text after
            // the label is the shared REASON — so each listed row gets the
            // reason. Writing the name list into those rows would tick four
            // boxes whose FDACS rows state no limitation at all.
            const reason = clause.slice(marks[0].bodyStart).trim();
            const markKeys = new Set(marks.map((mk) => mk.key));
            for (const hit of named) {
              if (markKeys.has(hit.key)) continue; // the marks loop fills these
              append(hit.key, reason || preamble);
            }
          } else {
            append(lastKey || marks[0].key, preamble, lastKey ? contJoiner : ' ');
          }
        }
        marks.forEach((mark, i) => {
          const end = i + 1 < marks.length ? marks[i + 1].start : clause.length;
          append(mark.key, clause.slice(mark.bodyStart, end));
        });
        lastKey = marks[marks.length - 1].key;
        continue;
      }

      // Unlabelled clause. If it NAMES categories it is a shared statement and
      // must tick every one of them — the checkbox matcher this replaced did,
      // and quietly dropping one removes a disclosed inspection limitation
      // from a signed FDACS filing.
      const hits = categoriesMentionedIn(clause);
      if (hits.length) {
        for (const hit of hits) append(hit.key, clause);
        lastKey = hits[hits.length - 1].key;
      } else if (lastKey) {
        // One sentence continuing — keep the semicolon that split it, or a
        // plain space when the break was a line wrap.
        append(lastKey, clause, contJoiner);
      } else {
        append('other', clause);
        lastKey = 'other';
      }
    }
  }

  for (const row of INACCESSIBLE_ROWS) {
    if (formText(rows[row.key])) ticked.add(row.key);
  }
  // Uncategorised text still has to be disclosed under some box.
  if (!ticked.size) {
    append('other', text);
    ticked.add('other');
  }
  return { rows, ticked };
}

// Findings-driven single-blank fields: fitted at FORM_FONT_FLOOR with overflow
// onto the continuation page. Value `null` = fit/truncate but don't record a
// continuation entry (footer duplicates of fields recorded once already).
const FITTED_FIELDS = {
  'Address of Property Inspected': { label: 'Section 1 - Address of property inspected', order: 10 },
  'addrofpropinspected': null,
  'Structures on Property Inspected': { label: 'Section 1 - Structure(s) on property inspected', order: 11 },
  'Name and Contact Information': { label: 'Section 1 - Inspection and report requested by', order: 12 },
  'Name and Contact Information if different from above': { label: 'Section 1 - Report sent to requestor and to', order: 13 },
  'should be contacted for information on treatment history and any warranty or service agreement which may be in place':
    { label: 'Section 4 - Notice of Inspection affixed to the structure at', order: 41 },
  'comorgtreated': { label: 'Section 4 - Common name of organism treated', order: 42 },
  'pesticideused': { label: 'Section 4 - Name of pesticide used', order: 43 },
  'termscondtreat': { label: 'Section 4 - Terms and conditions of treatment', order: 44 },
  'undefined_9': { label: 'Section 4 - Treatment notice location', order: 45 },
};

// Every FDACS field is a single-line text box, so newlines from the findings
// textareas become "; " separators when a value lands in one blank (the line
// pools convert them to real line breaks instead).
function formText(value) {
  return clean(sanitizeText(value));
}

function setText(form, name, value) {
  const v = formText(value).replace(/\s*\n+\s*/g, '; ');
  if (!v) return;
  try {
    const field = form.getTextField(name);
    field.setText(v);
  } catch (err) {
    logger.warn(`[wdo-pdf] text field skipped "${name}": ${err.message}`);
  }
}

// Smallest acceptable rendered size on the official form. pdf-lib's auto-size
// picks the largest size that fits, so guaranteeing the content FITS at the
// floor guarantees it renders at or above it — the old behavior crammed the
// full value in and let auto-size shrink to ~3pt before clipping the rest.
const FORM_FONT_FLOOR = 8;
// Progressively shorter continuation markers — narrow blanks (e.g. the 120pt
// Terms-and-Conditions box) get a shorter one so the line still carries
// meaningful content.
const CONTINUATION_SUFFIXES = [
  '... (continued on attached page)',
  '... (see attached page)',
  '... (cont.)',
];
// For unlabeled footer duplicates: plain truncation with no attached-page
// promise (no continuation entry is recorded for them).
const PLAIN_SUFFIXES = ['...'];

function fieldLineWidth(field) {
  const widget = field.acroField.getWidgets()[0];
  const rect = widget ? widget.getRectangle() : { width: 0 };
  // Leave a few points for the border + text padding pdf-lib applies.
  return Math.max(20, rect.width - 6);
}

// Drop trailing words until `text + suffix` fits the width at the floor size,
// trying each suffix candidate in order (longest first); a single over-wide
// token falls back to a character cut with the shortest suffix.
function cutToFit(text, font, maxWidth, suffixes) {
  for (const suffix of suffixes) {
    let cut = text;
    while (cut && font.widthOfTextAtSize(`${cut} ${suffix}`, FORM_FONT_FLOOR) > maxWidth) {
      const shorter = cut.replace(/\s*\S+$/, '');
      if (shorter === cut) { cut = ''; break; }
      cut = shorter;
    }
    if (cut) return `${cut} ${suffix}`;
  }
  const suffix = suffixes[suffixes.length - 1];
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut} ${suffix}`, FORM_FONT_FLOOR) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut ? `${cut} ${suffix}` : suffix;
}

// Fill a single blank, guaranteeing at-least-floor rendering: if the value
// doesn't fit on the line at FORM_FONT_FLOOR, the line ends with a
// continuation marker and the full value is recorded for the continuation
// page. `spec` null = unlabeled footer duplicate: it truncates with a plain
// ellipsis — never an attached-page promise, because no continuation entry is
// recorded for it (the labeled main field records its own when IT overflows,
// and the two have different widths, so one can overflow without the other).
function fillFittedText(form, font, name, value, spec, overflows) {
  const text = formText(value).replace(/\s*\n+\s*/g, '; ');
  if (!text) return;
  let field;
  try {
    field = form.getTextField(name);
  } catch (err) {
    logger.warn(`[wdo-pdf] text field skipped "${name}": ${err.message}`);
    return;
  }
  const maxWidth = fieldLineWidth(field);
  if (font.widthOfTextAtSize(text, FORM_FONT_FLOOR) <= maxWidth) {
    field.setText(text);
    return;
  }
  if (!spec) {
    field.setText(cutToFit(text, font, maxWidth, PLAIN_SUFFIXES));
    return;
  }
  field.setText(cutToFit(text, font, maxWidth, CONTINUATION_SUFFIXES));
  overflows.push({ label: spec.label, order: spec.order, text });
}

// Word-flow a findings value across a section's printed writing lines (each a
// separate AcroForm field with its own width). Newlines in the value force a
// new line. If the pool runs out of lines, the last one ends with the
// continuation marker and the FULL value is recorded for the continuation
// page, so the attached page reads complete rather than starting mid-sentence.
function fillLinePool(form, font, pool, value, overflows) {
  const text = formText(value);
  if (!text) return;
  const fields = [];
  for (const name of pool.fields) {
    try {
      fields.push(form.getTextField(name));
    } catch (err) {
      logger.warn(`[wdo-pdf] pool line skipped "${name}": ${err.message}`);
    }
  }
  if (!fields.length) {
    overflows.push({ label: pool.label, order: pool.order, text });
    return;
  }
  const widths = fields.map(fieldLineWidth);

  const tokens = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (tokens.length && words.length) tokens.push({ lineBreak: true });
    for (const word of words) tokens.push({ word });
  }

  const lines = fields.map(() => '');
  let ti = 0;
  for (let li = 0; li < lines.length && ti < tokens.length;) {
    const token = tokens[ti];
    if (token.lineBreak) {
      li += 1;
      ti += 1;
      continue;
    }
    const candidate = lines[li] ? `${lines[li]} ${token.word}` : token.word;
    if (font.widthOfTextAtSize(candidate, FORM_FONT_FLOOR) <= widths[li]) {
      lines[li] = candidate;
      ti += 1;
    } else if (!lines[li]) {
      // Single token wider than the whole line — hard-split it.
      let fit = token.word.length;
      while (fit > 1 && font.widthOfTextAtSize(token.word.slice(0, fit), FORM_FONT_FLOOR) > widths[li]) fit -= 1;
      lines[li] = token.word.slice(0, fit);
      tokens[ti] = { word: token.word.slice(fit) };
      li += 1;
    } else {
      li += 1;
    }
  }

  if (ti < tokens.length) {
    const last = lines.length - 1;
    lines[last] = cutToFit(lines[last], font, widths[last], CONTINUATION_SUFFIXES);
    overflows.push({ label: pool.label, order: pool.order, text });
  }

  lines.forEach((line, idx) => {
    if (line) fields[idx].setText(line);
  });
}

function checkBox(form, name) {
  try {
    form.getCheckBox(name).check();
  } catch (err) {
    logger.warn(`[wdo-pdf] checkbox skipped "${name}": ${err.message}`);
  }
}

function selectRadio(form, name, option) {
  try {
    form.getRadioGroup(name).select(option);
  } catch (err) {
    logger.warn(`[wdo-pdf] radio skipped "${name}"=${option}: ${err.message}`);
  }
}

/**
 * Section 3: route each category's text onto its OWN row's writing lines.
 * Each row overflows independently, so a long Interior note continues under an
 * "Interior" heading on the continuation page instead of silently truncating.
 */
function fillInaccessibleAreas(form, font, findings, overflows) {
  const { rows } = splitInaccessibleAreas(findings.inaccessible_areas);
  for (const row of INACCESSIBLE_ROWS) {
    fillLinePool(form, font, row, rows[row.key], overflows);
  }
}

function applyCheckboxes(form, findings) {
  // Section 2 finding (mutually exclusive checkboxes on the form)
  const finding = clean(findings.wdo_finding).toLowerCase();
  if (finding.startsWith('no visible')) {
    checkBox(form, 'NO visible signs of WDOs live evidence or damage observed');
  } else if (finding.startsWith('visible')) {
    checkBox(form, 'VISIBLE evidence of WDOs was observed as follows');
    // Tick the sub-findings that actually have content.
    if (clean(findings.live_wdo)) checkBox(form, '1 LIVE WDOs');
    if (clean(findings.wdo_evidence)) {
      checkBox(form, '2 EVIDENCE of WDOs dead wooddestroying insects or insect parts frass shelter tubes exit holes or other evidence');
    }
    if (clean(findings.wdo_damage)) checkBox(form, '3 DAMAGE caused by WDOs was observed and noted as follows');
  }

  // Inaccessible / obstructed areas — tick exactly the rows that splitInaccessibleAreas
  // routed text to. Sharing that one parser is what keeps a ticked box and its
  // printed text on the SAME row.
  const { ticked } = splitInaccessibleAreas(findings.inaccessible_areas);
  for (const row of INACCESSIBLE_ROWS) {
    if (ticked.has(row.key)) checkBox(form, row.checkbox);
  }

  // Treatment method
  const method = clean(findings.treatment_method).toLowerCase();
  if (method.includes('whole')) checkBox(form, 'Whole structure');
  if (method.includes('spot')) checkBox(form, 'Spot treatment');

  // Previous treatment evidence (Yes/No radio)
  const prev = clean(findings.previous_treatment_evidence).toLowerCase();
  if (prev === 'yes') selectRadio(form, 'evidprevtreat', 'Yes');
  else if (prev === 'no') selectRadio(form, 'evidprevtreat', 'No');

  // Treated at time of inspection (Yes_2/No_2 radio)
  const treated = clean(findings.treated_at_inspection).toLowerCase();
  if (treated === 'yes') selectRadio(form, 'cotreatatinspect', 'Yes_2');
  else if (treated === 'no') selectRadio(form, 'cotreatatinspect', 'No_2');
}

/**
 * Resolve the inspector identity for Section 1. Falls back through the
 * project's stored tech identity and structured findings.
 */
function resolveApplicator({ project = {}, findings = {} }) {
  return {
    name: clean(
      findings.inspector_name
      || findings.applicator_name
      || project.tech_name
      || project.technician_name,
    ),
    idCardNo: clean(findings.applicator_fdacs_id || findings.inspector_id_card),
  };
}

/**
 * Build the filled, flattened FDACS-13645 PDF as a Buffer.
 * @param {object} args
 * @param {object} args.project    projects row (findings may be JSON string)
 * @param {object} args.customer   customers row (for address fallback)
 * @param {object} [args.applicator]  resolved inspector identity ({ name, idCardNo }).
 *   The WDO findings don't collect the inspector and a plain `db('projects')`
 *   load has no `tech_name`, so callers resolve the technician and pass it in;
 *   we fall back to the project/findings only if it's omitted.
 */
async function buildWdoReportPDFBuffer({ project, customer, applicator: applicatorOverride, signature, photos = [] } = {}) {
  if (!project) throw new Error('project required for WDO report PDF');
  const findings = customerSafeFindings(project.findings, projectRecordedFeeValues(project));
  const resolved = resolveApplicator({ project, findings });
  const applicator = {
    name: clean(applicatorOverride?.name) || resolved.name,
    idCardNo: clean(applicatorOverride?.idCardNo) || resolved.idCardNo,
  };

  const pdfDoc = await PDFDocument.load(loadTemplateBytes());
  const form = pdfDoc.getForm();
  // Helvetica is the template's appearance font, so measuring with it tells us
  // exactly what pdf-lib's auto-size will be able to fit at render time.
  const measureFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const overflows = [];
  const textValues = buildTextValues({ findings, customer, project, applicator });
  for (const [name, value] of Object.entries(textValues)) {
    if (name in FITTED_FIELDS) {
      fillFittedText(form, measureFont, name, value, FITTED_FIELDS[name], overflows);
    } else {
      setText(form, name, value);
    }
  }
  for (const [key, pool] of Object.entries(LINE_POOLS)) {
    fillLinePool(form, measureFont, pool, findings[key], overflows);
  }
  fillInaccessibleAreas(form, measureFont, findings, overflows);
  applyCheckboxes(form, findings);

  // Stamp the licensee e-signature into the signature field BEFORE flattening,
  // if one was captured. The image is drawn onto the page (independent of the
  // form field), so it survives flatten(). A failure here is fatal — the send
  // gate treats the project as signed, so we must not silently emit an unsigned
  // form instead.
  if (signature?.image) {
    try {
      await stampSignature(pdfDoc, form, signature);
    } catch (err) {
      throw new Error(`WDO signature could not be stamped: ${err.message}`);
    }
  }

  // Flatten so the filed report is read-only. Fatal on failure: an editable
  // AcroForm must never be emailed as the official filing (the send routes
  // catch this and abort with "nothing was sent").
  try {
    form.flatten();
  } catch (err) {
    throw new Error(`WDO form could not be locked (flatten failed): ${err.message}`);
  }

  // Continuation page(s) for anything that didn't fit its printed lines at a
  // readable size — the "additional page" the form itself prescribes. Added
  // before the photo addendum so the filing reads form → text → photos.
  // Fatal on failure: the form now carries "(continued on attached page)"
  // markers, so emitting it WITHOUT the attached page would truncate findings
  // on a legal filing.
  if (overflows.length) {
    await appendContinuationPages(pdfDoc, {
      entries: overflows.sort((a, b) => (a.order || 0) - (b.order || 0)),
      propertyAddress: clean(textValues['Address of Property Inspected']),
      inspectionDate: clean(textValues['Date of Inspection']),
    });
  }

  // Append the Supplemental Photo Addendum (2 captioned photos per page).
  if (Array.isArray(photos) && photos.length) {
    await appendPhotoAddendum(pdfDoc, {
      photos,
      feeValues: projectRecordedFeeValues(project),
      propertyAddress: clean(textValues['Address of Property Inspected']),
    }).catch((err) => {
      logger.warn(`[wdo-pdf] photo addendum failed for project ${project.id}: ${err.message}`);
    });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// Decode a base64 PNG/JPEG data URL or raw base64 string into a Buffer.
function decodeImageInput(input) {
  if (Buffer.isBuffer(input)) return input;
  const str = String(input || '');
  const m = str.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
  const b64 = m ? m[2] : str;
  return Buffer.from(b64, 'base64');
}

async function embedImageAuto(pdfDoc, buffer, contentType) {
  const type = String(contentType || '').toLowerCase();
  // PNG magic: 89 50 4E 47
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (type.includes('png') || isPng) return pdfDoc.embedPng(buffer);
  return pdfDoc.embedJpg(buffer); // pdf-lib supports png + jpg only
}

// Draw the captured signature image into the FDACS 'signaturelicensee' field.
async function stampSignature(pdfDoc, form, signature) {
  const buffer = decodeImageInput(signature.image);
  const png = await embedImageAuto(pdfDoc, buffer, signature.contentType || 'image/png');
  const field = form.getTextField('signaturelicensee');
  const widget = field.acroField.getWidgets()[0];
  const rect = widget.getRectangle();
  const page = findWidgetPage(pdfDoc, widget) || pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
  // Fit inside the field box, preserving aspect, with a little vertical padding.
  const maxW = rect.width - 4;
  const maxH = rect.height - 2;
  const scale = Math.min(maxW / png.width, maxH / png.height);
  const w = png.width * scale;
  const h = png.height * scale;
  page.drawImage(png, { x: rect.x + 2, y: rect.y + (rect.height - h) / 2, width: w, height: h });
}

function findWidgetPage(pdfDoc, widget) {
  let pageRef = null;
  try { pageRef = widget.P(); } catch { pageRef = null; }
  if (!pageRef) return null;
  for (const page of pdfDoc.getPages()) {
    if (page.ref === pageRef) return page;
  }
  return null;
}

function sanitizeText(value) {
  // StandardFonts (WinAnsi) can't encode arbitrary unicode — one emoji typed
  // into a findings field on a phone would make pdfDoc.save() throw and the
  // whole report unsendable. Decompose accents, replace common smart
  // punctuation, and drop anything else outside the safe range (newlines
  // survive; callers decide whether they become line breaks or separators).
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks left by NFKD (é -> e)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[•·∙●▪]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\x20-\x7E\n]/g, '');
}

function wrapText(text, font, size, maxWidth) {
  const words = sanitizeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Append continuation page(s) carrying the complete text of every entry that
 * could not fit its printed form lines at a readable size. The FDACS-13645
 * itself prescribes this ("use additional page, if needed"); the form lines
 * end with "(continued on attached page)" wherever an entry overflows.
 * @param {Array<{ label:string, order:number, text:string }>} entries
 */
async function appendContinuationPages(pdfDoc, { entries, propertyAddress, inspectionDate }) {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 54;
  const contentW = PAGE_W - MARGIN * 2;
  const gray = rgb(0.4, 0.4, 0.4);

  let page = null;
  let y = 0;
  let pageNum = 0;
  const newPage = () => {
    pageNum += 1;
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const title = 'WDO INSPECTION REPORT - CONTINUATION PAGE';
    const titleW = bold.widthOfTextAtSize(title, 14);
    page.drawText(title, { x: (PAGE_W - titleW) / 2, y: PAGE_H - 50, size: 14, font: bold });
    const sub = sanitizeText(
      `FDACS-13645 - ${propertyAddress || ''}${inspectionDate ? ` - Inspected ${inspectionDate}` : ''}`,
    );
    const subW = font.widthOfTextAtSize(sub, 10);
    page.drawText(sub, { x: (PAGE_W - subW) / 2, y: PAGE_H - 66, size: 10, font, color: gray });
    const pageLabel = `Page C-${pageNum}`;
    page.drawText(pageLabel, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(pageLabel, 10), y: PAGE_H - 66, size: 10, font, color: gray });
    page.drawLine({ start: { x: MARGIN, y: PAGE_H - 76 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 76 }, thickness: 0.75, color: gray });
    y = PAGE_H - 96;
  };
  newPage();

  const note = 'Complete text of entries marked "(continued on attached page)" on the form:';
  page.drawText(note, { x: MARGIN, y, size: 9, font, color: gray });
  y -= 20;

  const drawLines = (lines, useFont, size, color) => {
    for (const ln of lines) {
      if (y < MARGIN + size) newPage();
      if (ln) page.drawText(ln, { x: MARGIN, y, size, font: useFont, color });
      y -= size + 4;
    }
  };

  for (const entry of entries) {
    if (y < MARGIN + 40) newPage();
    drawLines(wrapText(entry.label, bold, 11, contentW), bold, 11, rgb(0, 0, 0));
    const paragraphs = sanitizeText(entry.text).split('\n');
    for (const para of paragraphs) {
      const lines = para.trim() ? wrapText(para, font, 10, contentW) : [''];
      drawLines(lines, font, 10, rgb(0.1, 0.1, 0.1));
    }
    y -= 10;
  }
}

/**
 * Append "SUPPLEMENTAL PHOTO ADDENDUM" pages — 2 photos per page, each with a
 * "Photo N - {caption}" line, matching the supplied sample format.
 * @param {Array<{ buffer?:Buffer, image?:string, contentType?:string, caption?:string }>} photos
 */
async function appendPhotoAddendum(pdfDoc, { photos, propertyAddress, feeValues = [] }) {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 54;
  const contentW = PAGE_W - MARGIN * 2;
  const gray = rgb(0.4, 0.4, 0.4);

  // Each page holds 2 photo slots below the header.
  const headerBottom = PAGE_H - 96;
  const slotH = (headerBottom - MARGIN) / 2; // vertical space per photo+caption
  const captionH = 28;
  const imgBoxH = slotH - captionH;

  let photoNum = 0;
  let addendumPage = 0;
  for (let i = 0; i < photos.length; i += 2) {
    addendumPage += 1;
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

    // Header
    const title = 'SUPPLEMENTAL PHOTO ADDENDUM';
    const titleW = bold.widthOfTextAtSize(title, 14);
    page.drawText(title, { x: (PAGE_W - titleW) / 2, y: PAGE_H - 50, size: 14, font: bold });
    const sub = sanitizeText(`WDO Inspection Report - ${propertyAddress || ''}`);
    const subW = font.widthOfTextAtSize(sub, 10);
    page.drawText(sub, { x: (PAGE_W - subW) / 2, y: PAGE_H - 66, size: 10, font, color: gray });
    const pageLabel = `Page A-${addendumPage}`;
    page.drawText(pageLabel, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(pageLabel, 10), y: PAGE_H - 66, size: 10, font, color: gray });
    page.drawLine({ start: { x: MARGIN, y: PAGE_H - 76 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 76 }, thickness: 0.75, color: gray });

    for (let s = 0; s < 2; s += 1) {
      const photo = photos[i + s];
      if (!photo) break;
      photoNum += 1;
      const slotTop = headerBottom - s * slotH;
      const imgTop = slotTop;
      const imgBottom = slotTop - imgBoxH;

      try {
        const buffer = photo.buffer || decodeImageInput(photo.image);
        const img = await embedImageAuto(pdfDoc, buffer, photo.contentType);
        const scale = Math.min(contentW / img.width, imgBoxH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (PAGE_W - w) / 2, y: imgBottom + (imgBoxH - h), width: w, height: h });
      } catch (err) {
        logger.warn(`[wdo-pdf] could not embed addendum photo ${photoNum}: ${err.message}`);
        page.drawText(`[Photo ${photoNum} unavailable]`, { x: MARGIN, y: imgBottom + imgBoxH / 2, size: 10, font, color: gray });
      }

      // Caption under the image — technician free text, so it gets the same
      // cue+value scrub as the findings this PDF prints (codex #2817: this
      // archive is stamped pdf_renderer, so it MUST actually be clean). WDO
      // is the fee-carrying type and this builder is WDO-only.
      let safeCaption = redactInspectionFeeCues(photo.caption || '');
      if (feeValues.length) safeCaption = redactSpecificAmounts(safeCaption, feeValues);
      const captionText = `Photo ${photoNum} - ${safeCaption}`.trim();
      const lines = wrapText(captionText, font, 9, contentW).slice(0, 2);
      let cy = imgBottom - 12;
      for (const ln of lines) {
        page.drawText(ln, { x: MARGIN, y: cy, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
        cy -= 11;
      }
    }
  }
}

module.exports = {
  buildWdoReportPDFBuffer,
  // exported for tests
  _private: {
    splitCompanyAddress,
    resolveApplicator,
    buildTextValues,
    customerSafeFindings,
    decodeImageInput,
    wrapText,
    sanitizeText,
    cutToFit,
    LINE_POOLS,
    FITTED_FIELDS,
    splitInaccessibleAreas,
    INACCESSIBLE_ROWS,
  },
};
