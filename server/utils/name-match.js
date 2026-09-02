/**
 * Person-name matching shared across the portal — the ONE place for
 * "is this the same person?" name logic (rule 15). Extracted 2026-09-02 from
 * call-recording-processor.js (where it matched call-extracted names against
 * customer records) so the Zelle payment-notice reconciler corroborates a
 * bank-notice payer name against an invoice's customer with the same policy.
 *
 * Policy: names are compared on normalized parts (lowercase, alphanumerics
 * only). First names are compatible when equal or in the same NANP nickname
 * group ("Bob" ↔ "Robert"). Last names must be exactly equal where both are
 * known — typo variants are a conflict on purpose (a near-miss is a lead for
 * a human, never a match).
 */
function normalizeNamePart(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Common NANP nickname/diminutive groups — "Bob" calling from a line whose
// record says "Robert" is the same person for phone-scoped matching (the
// phone already narrows candidates to one household/office; last-name
// agreement is still enforced where both are known).
const NICKNAME_GROUPS = [
  ['robert', 'rob', 'bob', 'bobby', 'robbie'],
  ['william', 'will', 'bill', 'billy', 'willie', 'liam'],
  ['michael', 'mike', 'mikey', 'mick'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['thomas', 'tom', 'tommy'],
  ['david', 'dave', 'davey'],
  ['daniel', 'dan', 'danny'],
  ['christopher', 'chris', 'topher'],
  ['christine', 'christina', 'chris', 'chrissy', 'tina'],
  ['katherine', 'catherine', 'kate', 'kathy', 'cathy', 'katie', 'kat', 'kitty'],
  ['elizabeth', 'liz', 'beth', 'lizzie', 'eliza', 'betsy'],
  ['margaret', 'peggy', 'meg', 'maggie', 'marge'],
  ['john', 'jack', 'johnny', 'jon'],
  ['jonathan', 'jon', 'johnny'],
  ['richard', 'rick', 'rich', 'dick', 'ricky'],
  ['anthony', 'tony'],
  ['steven', 'stephen', 'steve'],
  ['joseph', 'joe', 'joey'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam', 'sammy'],
  ['alexander', 'alex', 'al'],
  ['alexandra', 'alex', 'lexi', 'sandra'],
  ['matthew', 'matt'],
  ['andrew', 'andy', 'drew'],
  ['gregory', 'greg'],
  ['jeffrey', 'jeff'],
  ['edward', 'ed', 'eddie', 'ted', 'ned'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie'],
  ['kenneth', 'ken', 'kenny'],
  ['lawrence', 'larry'],
  ['gerald', 'jerry'],
  ['terrence', 'terry'],
  ['patrick', 'pat', 'paddy'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['susan', 'sue', 'susie', 'suzy'],
  ['deborah', 'debra', 'deb', 'debbie'],
  ['barbara', 'barb', 'babs'],
  ['jennifer', 'jen', 'jenny'],
  ['jessica', 'jess', 'jessie'],
  ['victoria', 'vicky', 'tori'],
  ['nicholas', 'nick', 'nicky'],
  ['timothy', 'tim', 'timmy'],
  ['benjamin', 'ben', 'benny'],
  ['charles', 'charlie', 'chuck', 'chas'],
  ['frederick', 'fred', 'freddie'],
  ['raymond', 'ray'],
  ['walter', 'walt', 'wally'],
  ['harold', 'hal', 'harry'],
  ['henry', 'hank', 'harry'],
  ['francis', 'frank', 'frankie'],
  ['frances', 'fran', 'frannie'],
  ['dorothy', 'dot', 'dottie'],
  ['florence', 'flo'],
  ['virginia', 'ginny', 'ginger'],
  ['pamela', 'pam'],
  ['cynthia', 'cindy'],
  ['sandra', 'sandy'],
  ['linda', 'lindy'],
  ['rebecca', 'becky', 'becca'],
  ['kimberly', 'kim'],
  ['michelle', 'shelly'],
  ['stephanie', 'steph'],
  ['melissa', 'mel', 'missy'],
  ['amanda', 'mandy'],
  ['abigail', 'abby'],
  ['gabriel', 'gabe'],
  ['gabriella', 'gabby'],
  ['isabella', 'izzy', 'bella'],
  ['zachary', 'zach', 'zack'],
  ['joshua', 'josh'],
  ['nathaniel', 'nathan', 'nate', 'nat'],
  ['leonard', 'leo', 'lenny'],
  ['theodore', 'ted', 'theo', 'teddy'],
  ['albert', 'al', 'bert'],
  ['arthur', 'art', 'artie'],
  ['eugene', 'gene'],
  ['vincent', 'vince', 'vinny'],
  ['peter', 'pete'],
  ['philip', 'phil'],
  ['douglas', 'doug'],
  ['russell', 'russ', 'rusty'],
  ['martin', 'marty'],
  ['stanley', 'stan'],
  ['norman', 'norm'],
  ['dennis', 'denny'],
  ['glenn', 'glen'],
  ['carolyn', 'caroline', 'carol', 'carrie'],
  ['eleanor', 'ellie', 'nora'],
  ['emily', 'em', 'emmy'],
  ['natalie', 'nat'],
  ['angela', 'angie'],
  ['brenda', 'bren'],
  ['sharon', 'shari'],
  ['diane', 'diana', 'di'],
  ['janet', 'jan'],
  ['janice', 'jan'],
  ['judith', 'judy'],
  ['carol', 'carole'],
  ['ann', 'anne', 'annie', 'anna'],
  ['mary', 'marie', 'maria', 'molly', 'polly'],
  ['martha', 'marty', 'mattie'],
  ['helen', 'nell', 'nellie'],
  ['ruth', 'ruthie'],
  ['gerald', 'gerry'],
  ['gordon', 'gordy'],
  ['leslie', 'les'],
  ['wesley', 'wes'],
  ['curtis', 'curt'],
  ['calvin', 'cal'],
  ['bernard', 'bernie'],
  ['clifford', 'cliff'],
  ['duane', 'dwayne'],
  ['randall', 'randy'],
  ['rodney', 'rod'],
  ['roger', 'rodge'],
  ['bradley', 'brad'],
  ['brandon', 'bran'],
  ['jacob', 'jake'],
  ['lucas', 'luke'],
  ['maxwell', 'max'],
  ['oliver', 'ollie'],
  ['sebastian', 'seb'],
  ['veronica', 'ronnie'],
  ['gwendolyn', 'gwen'],
  ['jacqueline', 'jackie'],
  ['josephine', 'jo', 'josie'],
  ['kathleen', 'kathy', 'kate'],
  ['lillian', 'lily'],
  ['madeline', 'maddie'],
  ['penelope', 'penny'],
  ['priscilla', 'cilla'],
  ['rosemary', 'rose', 'rosie'],
  ['suzanne', 'sue', 'suzy'],
  ['valerie', 'val'],
  ['yvonne', 'vonnie'],
];
const NICKNAME_LOOKUP = new Map();
for (const group of NICKNAME_GROUPS) {
  for (const name of group) {
    const set = NICKNAME_LOOKUP.get(name) || new Set();
    for (const variant of group) set.add(variant);
    NICKNAME_LOOKUP.set(name, set);
  }
}
function firstNameVariants(normalizedFirst) {
  const variants = NICKNAME_LOOKUP.get(normalizedFirst);
  return variants ? [...variants] : [normalizedFirst];
}
function sameFirstName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const variants = NICKNAME_LOOKUP.get(a);
  return !!variants && variants.has(b);
}

// Bank-notice payer name ("RAAKESH DUSHYANTHAN", "Pat & Sam Doe", "J. Doe")
// vs an invoice's customer. Corroborates only when the customer's last name
// appears as a whole token AND some other token is first-name-compatible
// (nickname-aware). Initials never satisfy the first-name leg; a missing
// customer last name never corroborates (amount alone is not identity).
function payerNameCorroborates(payerName, customer = {}) {
  const customerLast = normalizeNamePart(customer.last_name);
  const customerFirst = normalizeNamePart(customer.first_name);
  if (!customerLast || !customerFirst) return false;
  const tokens = String(payerName || '')
    .split(/[\s,&]+|\band\b/i)
    .map(normalizeNamePart)
    .filter((t) => t.length > 1);
  if (!tokens.includes(customerLast)) return false;
  return tokens.some((t) => t !== customerLast && sameFirstName(t, customerFirst));
}

module.exports = {
  normalizeNamePart,
  NICKNAME_GROUPS,
  firstNameVariants,
  sameFirstName,
  payerNameCorroborates,
};
