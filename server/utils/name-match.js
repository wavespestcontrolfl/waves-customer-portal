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
// Byte-identical twin of the SQL normalization in call-recording-processor
// (LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g'))) — the two must
// agree, so this deliberately does NOT fold diacritics.
function normalizeNamePart(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Diacritic-folding variant for comparisons that never touch SQL (the Zelle
// payer corroboration): NFD splits "é" into "e" + a combining mark, so
// "José Nuñez" and "Jose Nunez" normalize identically instead of the
// accented letters vanishing ("jos nuez").
// Latin letters NFD does not decompose — folded by table so "Søren" is
// "soren", not "sren".
const NON_DECOMPOSING = { 'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE', 'ß': 'ss', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'TH', 'ı': 'i' };
function normalizeNameFolded(value) {
  const folded = String(value || '')
    .replace(/[øØłŁœŒæÆßđĐðÐþÞı]/g, (c) => NON_DECOMPOSING[c] || c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return normalizeNamePart(folded);
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
// How many nickname groups a token belongs to. "pat" (Patrick / Patricia),
// "chris", "sam", "alex" span two — that merge is fine for the call processor
// (a phone already narrows the household) but NOT for money: a bank name must
// map to ONE canonical given name or match the customer exactly.
const NICKNAME_GROUP_COUNT = new Map();
for (const group of NICKNAME_GROUPS) {
  for (const name of group) NICKNAME_GROUP_COUNT.set(name, (NICKNAME_GROUP_COUNT.get(name) || 0) + 1);
}
function payerFirstNameCompatible(payerRun, customerFirst) {
  if (!payerRun || !customerFirst) return false;
  if (payerRun === customerFirst) return true;
  if ((NICKNAME_GROUP_COUNT.get(payerRun) || 0) !== 1) return false;
  return sameFirstName(payerRun, customerFirst);
}
function sameFirstName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const variants = NICKNAME_LOOKUP.get(a);
  return !!variants && variants.has(b);
}

// Bank-notice payer name ("RAAKESH DUSHYANTHAN", "Pat & Sam Doe", "Doe, Robert",
// "MARIA DE LA CRUZ", "ALICE JONES & ROBERT DOE") vs an invoice's customer.
// The line is split into PERSONS first (on "&" / "and"), and both name parts
// must belong to the SAME person: the customer's last name must be that
// person's surname — the trailing token run, or everything before the comma
// in "Last, First" form — and the LEADING run of the remaining tokens must be
// first-name-compatible — equal, or a nickname that belongs to exactly ONE
// group ("Bob" → Robert; never "Pat", "Chris", "Sam", "Alex", which span two
// names); compound "Mary Ann" joins; a middle name never counts. Generational suffixes (Jr, Sr, II…) are ignored. A single-token person shares the surname of the last person on
// the line ("Pat & Robert Doe"). Initials never satisfy the first-name leg;
// a missing customer name part never corroborates (amount alone is not
// identity).
// Surname particles: a run that starts right after one of these is a fragment
// of a compound surname, never the whole surname.
const SURNAME_PARTICLES = new Set(['de', 'del', 'della', 'di', 'da', 'do', 'dos', 'das', 'la', 'le', 'van', 'von', 'der', 'den', 'du', 'st', 'san', 'santa', 'mac', 'mc', 'al', 'el', 'bin', 'ibn']);
// Generational suffixes are never part of a surname on the customer record.
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
function tokensOf(text) {
  return String(text || '').split(/\s+/).map(normalizeNameFolded).filter((t) => t.length > 1 && !NAME_SUFFIXES.has(t));
}
// The given name is the LEADING run of a person's given tokens ("Mary Ann"
// joins; "Robert James" is Robert with a middle name, never James) — so a
// middle name can never satisfy the first-name leg.
function givenNameRuns(tokens) {
  const runs = [];
  for (let j = 1; j <= tokens.length; j += 1) runs.push(tokens.slice(0, j).join(''));
  return runs;
}
// [{ given: [tokens], surname: [tokens] }] per person on the line.
function personsOf(payerName) {
  // Joint-line separators: "&", "and", "or", "/", "+", ";" (case-insensitive).
  const people = String(payerName || '').split(/\s*[&/+;]\s*|\s+(?:and|or)\s+/i).map((p) => p.trim()).filter(Boolean);
  const parsed = people.map((person) => {
    const comma = person.indexOf(',');
    if (comma > -1) {
      const given = tokensOf(person.slice(comma + 1));
      // "Doe, Robert" is Last, First; "Robert Doe, Sr." is a suffix comma —
      // nothing but suffixes after it means the line is First Last.
      if (given.length) return { surname: tokensOf(person.slice(0, comma)), given, fixedSurname: true };
    }
    return { all: tokensOf(person) };
  });
  // Shared surname ONLY for single-token people ("PAT & ROBERT DOE"). A
  // multi-token earlier person ("MARY ANN & ROBERT SMITH", "ALICE JONES &
  // ROBERT DOE") is ambiguous — "Ann" and "Jones" are indistinguishable
  // without a dictionary — so it is read as written and, when that reading
  // corroborates nobody, the notice parks for a human. Borrowing the final
  // surname there would let "Alice Jones" settle Alice Doe's invoice.
  // Only a TWO-token final name ("ROBERT DOE") lends its surname; with a
  // middle name ("ROBERT JAMES DOE") the surname is ambiguous — nothing is
  // borrowed and a single-token person parks for a human.
  const last = parsed[parsed.length - 1];
  const borrowed = last && !last.fixedSurname && last.all && last.all.length === 2 ? last.all.slice(1) : null;
  return parsed.map((p) => (p.all && p.all.length === 1 && borrowed ? { all: [...p.all, ...borrowed] } : p));
}
function personCorroborates(person, customerFirst, customerLast) {
  if (person.fixedSurname) {
    return person.surname.join('') === customerLast && givenNameRuns(person.given).some((r) => payerFirstNameCompatible(r, customerFirst));
  }
  const tokens = person.all || [];
  // The surname is a trailing run; the given name lives in what precedes it.
  // A run whose preceding token is a surname particle ("de la Cruz", "van
  // Dyke") is not a surname by itself — "Cruz" must not corroborate a Maria
  // Cruz when the bank says Maria De La Cruz.
  for (let k = tokens.length - 1; k >= 1; k -= 1) {
    if (tokens.slice(k).join('') === customerLast) {
      if (SURNAME_PARTICLES.has(tokens[k - 1])) continue;
      if (givenNameRuns(tokens.slice(0, k)).some((r) => payerFirstNameCompatible(r, customerFirst))) return true;
    }
  }
  return false;
}
function payerNameCorroborates(payerName, customer = {}) {
  const customerLast = normalizeNameFolded(customer.last_name);
  const customerFirst = normalizeNameFolded(customer.first_name);
  if (!customerLast || !customerFirst) return false;
  return personsOf(payerName).some((person) => personCorroborates(person, customerFirst, customerLast));
}

module.exports = {
  normalizeNamePart,
  normalizeNameFolded,
  firstNameVariants,
  sameFirstName,
  payerNameCorroborates,
};
