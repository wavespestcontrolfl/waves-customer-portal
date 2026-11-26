// Plain-English copy for every check code and error code the company facts routes answer.
// Codes come from server/services/company-facts-bank.js (checkFactText, approveChecks, FactError).

export const BLOCK_REASONS = {
  empty: "The fact is empty. Write one to three sentences.",
  too_long: "This is too long. Keep it to 400 characters or fewer.",
  too_many_sentences: "Too many sentences. Use one to three.",
  number_in_fact: "Facts can't include numbers, prices, counts or times. Say it without the number.",
  line_break: "Keep it on one line. Take out the line breaks.",
  dollar_amount: "Facts can't include dollar amounts. Say it without the price.",
  percent: "Facts can't include percentages. Say it without the percent.",
  phone_number: "Facts can't include phone numbers.",
  email_address: "Facts can't include email addresses.",
  link: "Facts can't include web links or website names.",
  handle: "Facts can't include @names or #tags.",
  safety_claim: "Don't say a treatment is safe, non-toxic or natural.",
  injection_shape: "This reads like an instruction to the agent. State a plain fact instead.",
  product_brand: "Facts can't name a product brand. Say it without the brand.",
  duplicate_code_line: "The agents already know this. A built-in fact says the same thing.",
  duplicate_bank_line: "Another fact in the bank already says this.",
  banned_copy: "This wording breaks our customer copy rules. Reword it, and keep it to what is plainly true.",
  section_banned_copy: "This fact is fine alone, but together with the approved facts the set breaks our copy rules. Reword it or retire another fact.",
  bank_full: "The bank already holds 20 approved facts, the most it can hold. Retire one first.",
};

export const WARNING_REASONS = {
  price_words: "Mentions price or cost words",
  promise_words: "Uses promise or guarantee words",
  handoff_words: "Uses words that usually need a person",
};

const ERROR_REASONS = {
  STALE_TEXT: "The wording changed after you opened it. The list was reloaded: read the new wording, then approve again.",
  HASH_MISMATCH: "The saved wording does not match its record. Do not approve it. Edit it and save again.",
  REVIEWED_TEXT_REQUIRED: "Approve needs the exact wording you read. Reload the page and try again.",
  ORIGINAL_NOT_APPROVED: "The fact this draft replaces is no longer approved. Discard this draft, or restore the old fact as a new draft.",
  WARNINGS_NOT_ACKNOWLEDGED: "Tick \"I checked this\" for the warnings first.",
  OWNER_ONLY: "Only the owner account can approve a fact.",
  NOT_A_DRAFT: "This is no longer a draft. Reload the list.",
  NOT_APPROVED: "This fact is no longer approved. Reload the list.",
  NOT_RETIRED: "This fact is not retired. Reload the list.",
  NOT_FOUND: "That fact is gone. Reload the list.",
  REASON_REQUIRED: "Write why you are retiring it (at least 3 letters).",
  INVALID_SOURCE: "That source is not allowed.",
  INVALID_CURSOR: "The list moved on. Reload it and try again.",
  TEXT_UNCHANGED: "The wording is the same as the approved fact. Change it first.",
  RETIRED_USE_RESTORE: "A retired fact can't be edited. Restore it as a new draft instead.",
  DUPLICATE: "A fact with exactly this wording already exists.",
  TOPIC_REQUIRED: "Add a short topic.",
  TEXT_REQUIRED: "Write the fact.",
  TEXT_TOO_LONG: "This is too long to save. Cut it down.",
};

export const blockReason = (code) => BLOCK_REASONS[code] || `This fact breaks a rule (${code}).`;

// One sentence for a failed request. BLOCKED lists each blocking reason.
export function errorMessage(error, fallback = "That did not work. Try again.") {
  const code = error?.code;
  if (code === "BLOCKED" && Array.isArray(error.details?.blocks)) {
    return `It can't be approved yet. ${error.details.blocks.map(blockReason).join(" ")}`;
  }
  if (code === "EDIT_IN_PROGRESS") return "A newer draft of this fact already exists. Edit or approve that one.";
  if (ERROR_REASONS[code]) return ERROR_REASONS[code];
  return error?.message && error.message !== code ? error.message : fallback;
}

export const ACTION_LABELS = {
  drafted: "Drafted",
  edited: "Edited",
  approved: "Approved",
  retired: "Retired",
  restored_as_draft: "Restored as a draft",
  discarded: "Discarded",
};
