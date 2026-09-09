/**
 * Shared, pure vendor-pitch detector for inbound SMS.
 * Explicit vendor markers stand alone. Ambiguous pricing, capacity, or
 * detail wording needs two distinct categories, including an outreach clue.
 * Ambiguous messages remain eligible for the caller's normal handling.
 */

const SOLICITATION_MARKERS = [
  { key: 'leads_pitch', strong: true, re: /\b(?:exclusive|qualified|unlimited)\s+(?:\w+\s+){0,3}leads?\b/i },
  // Referring neighbors is ordinary intake; more leads or "leads for you"
  // needs independent vendor evidence, such as a supplier offer or footer.
  { key: 'lead_referral', strong: false, re: /\b(?:more|extra)\s+(?:[\w-]+\s+){0,3}leads?\b|\bleads?\s+for\s+(?:you|your)\b/i },
  // A sender's own neighbors/neighborhood establishes referral context
  // across the message, including when the sender offers to deliver leads.
  { key: 'lead_supplier', strong: false, outreach: true, re: /^(?![\s\S]*\b(?:my|our)\s+neighbou?r(?:s|hood)?\b)[\s\S]*\b(?:we|i|our\s+(?:network|team|company))\s+(?:(?:can|could|will)\s+)?(?:provide|offer|send|bring)s?\s+(?:you\s+(?:with\s+)?)?(?:more|extra)\s+(?:[\w-]+\s+){0,3}leads?\b/i },
  { key: 'ad_spend', strong: true, re: /\bfund\s+your\s+ads?\b|\bad[\s-]?spend\b/i },
  // A prospect can offer enough service work to fill our schedule.
  // This needs an independent outreach clue, like other capacity wording.
  { key: 'grow_business', strong: false, re: /\b(?:grow|scale|book(?:ing)?\s+more|fill)\s+(?:your\s+)?(?:business|schedule|calendar)\b/i },
  { key: 'sender_growth_offer', strong: true, re: /\b(?:we|i)\s+(?:(?:can|could|will)\s+)?(?:help\s+(?:you\s+)?)?(?:grow|scale)\s+your\s+business\b/i },
  { key: 'vendor_tool', strong: true, re: /\b(?:having|offer(?:ing)?|provid(?:e|ing)|try)\s+(?:an?\s+|our\s+)?ai\s+receptionist\b|\breview\s+system\b[^.!?]{0,80}\bfor\s+your\s+business\b/i },
  // Matching homeowners to contractors is lead generation; connecting us
  // with a property manager for access is ordinary quote coordination.
  { key: 'connects_you', strong: true, re: /\bconnect(?:s|ing)?\s+(?:you\s+with\s+(?:local\s+)?homeowners?\s+(?:requesting|seeking)\s+(?:quotes?|estimates?)|local\s+homeowners\s+with\s+(?:local\s+)?(?:contractors?|professionals?))\b/i },
  // A tenant's service request is not a pitch without recruitment copy.
  { key: 'service_requested_by', strong: true, re: /\bservice\s+is\s+being\s+requested\s+by\b[\s\S]{0,160}\b(?:apply\s+(?:here|now|today)|\d+\s*min(?:ute)?s?\s+to\s+apply)\b/i },
  // Jobs, customers, and estimates can describe a prospect's own needs.
  // Even "exclusive rates for new customers" or "unlimited estimates"
  // needs a separate outreach clue before it can establish a pitch.
  { key: 'additional_work', strong: false, re: /\b(?:handle|open\s+to)\s+(?:\d+(?:\s*[-–]\s*\d+)?\s+)?(?:more|extra)\s+(?:[\w-]+\s+){0,3}(?:jobs?|customers?|estimates?)\b|\b(?:exclusive|qualified|unlimited)\s+(?:[\w-]+\s+){0,3}(?:jobs?|customers?|estimates?)\b/i },
  { key: 'sender_work_offer', strong: true, re: /\b(?:we|i|our\s+(?:network|team|company))\s+(?:(?:can|could|will)\s+)?(?:have|offer|provide)s?\s+(?:you\s+(?:with\s+)?)?(?:exclusive|qualified|unlimited)\s+(?:[\w-]+\s+){0,3}jobs?\s+available\b/i },
  // Offering customers is vendor evidence; having customers or asking
  // whether they qualify for a discount is ordinary service context.
  { key: 'sender_customer_offer', strong: true, re: /\b(?:we|i|our\s+(?:network|team|company))\s+(?:(?:can|could|will)\s+)?(?:offer|provide)s?\s+(?:you\s+(?:with\s+)?)?(?:exclusive|qualified|unlimited)\s+(?:(?:pest(?:[\s-]+control)?|lawn(?:[\s-]+care)?|local|new)\s+)?customers?\b/i },
  // Explicit sender-side offers to contractors are outreach; a customer
  // asking whether WE offer estimates for their contractors is not.
  { key: 'contractor_offer', strong: false, outreach: true, re: /\b(?:we|i|our\s+(?:network|team|company))\s+(?:(?:can|could|will)\s+)?(?:provide|offer)s?\s+(?:you\s+(?:with\s+)?)?(?:(?:exclusive|qualified|unlimited)\s+)?(?:(?:pest[\s-]+control|lawn[\s-]+care|[\w-]+)\s+)?(?:jobs?|customers?|estimates?|leads?)\s+for\s+(?:local\s+)?contractors?\b/i },
  // "$" is not a word character, so the boundary sits inside the
  // alternation rather than in front of it (codex r2).
  { key: 'no_upfront', strong: false, re: /(?:\bno|\bzero|\$0)\s+(?:upfront|up-front|set-?up|monthly)\s+(?:cost|costs|fee|fees)?|\bfree\s+(?:setup|set-up|trial)\b/i },
  { key: 'reply_directive', strong: false, outreach: true, re: /\b(?:reply|say|text)\s+["']?(?:stop|no|byebye|end)["']?\s+(?:to\s+(?:opt[\s-]?out|stop|unsubscribe|be\s+removed)|if\s+you\s+(?:want|need)\s+(?:me|us)\s+to\s+stop)\b/i },
  { key: 'marketing_offer', strong: false, outreach: true, re: /\bour\s+(?:\w+\s+){0,3}(?:marketing|lead[\s-]?gen(?:eration)?)\s+(?:package|service|platform|program)\b/i },
  { key: 'more_details', strong: false, re: /\b(?:want|like)\s+(?:more\s+)?details\?/i },
];

/** Pure. A strong marker, or two weak categories including an outreach clue. */
function isSolicitationPitch(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const hits = SOLICITATION_MARKERS.filter((m) => m.re.test(t));
  return hits.some((m) => m.strong) || (hits.length >= 2 && hits.some((m) => m.outreach));
}

module.exports = { isSolicitationPitch };
