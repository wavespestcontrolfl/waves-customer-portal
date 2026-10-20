/* eslint-disable complexity, max-depth -- a faithful port of the published Double Metaphone rules: one flat switch, one branch per spelling rule. */
// Double Metaphone: a phonetic key for English / European personal names.
//
// Algorithm: Lawrence Philips, "The Double Metaphone Search Algorithm",
// C/C++ Users Journal, June 2000. This is a compact, dependency-free JavaScript
// rendering of that published algorithm, with the rule order of the widely
// ported reference implementations (Apache Commons Codec DoubleMetaphone,
// Apache-2.0; the `double-metaphone` npm package, MIT). It is vendored here, not
// installed, because the Intelligence Bar name matcher is the only user.
//
// doubleMetaphone('Smith') -> ['SM0', 'XMT'], the pair [primary, secondary].
// The secondary key is the alternate reading (Germanic / Slavic / Italian
// spelling) and equals the primary when there is none. Input is folded to
// A-Z first; digits and punctuation are dropped. No I/O.

const MAX_KEY = 6;

function doubleMetaphone(input) {
  const value = String(input || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z]/g, '');
  const length = value.length;
  const last = length - 1;
  if (!length) return ['', ''];

  let primary = '';
  let secondary = '';
  let index = 0;

  const at = (i) => (i >= 0 && i < length ? value[i] : '');
  const isVowel = (i) => 'AEIOUY'.includes(at(i)) && at(i) !== '';
  // True when value[start .. start+len) is one of the options. Out of range is false.
  const contains = (start, len, options) => start >= 0 && start + len <= length && options.includes(value.slice(start, start + len));
  const add = (p, s) => { primary += p; secondary += s === undefined ? p : s; };

  const slavoGermanic = /W|K|CZ|WITZ/.test(value);
  const germanicStart = contains(0, 4, ['VAN ', 'VON ']) || contains(0, 3, ['SCH']) || /^(VAN|VON)/.test(value);

  // Silent first letter of GN, KN, PN, WR, PS.
  if (contains(0, 2, ['GN', 'KN', 'PN', 'WR', 'PS'])) index += 1;
  // Initial X is pronounced Z, which maps to S.
  if (at(0) === 'X') { add('S'); index += 1; }

  while (index < length) {
    const c = at(index);
    switch (c) {
      case 'A': case 'E': case 'I': case 'O': case 'U': case 'Y':
        if (index === 0) add('A');
        index += 1;
        break;

      case 'B':
        add('P');
        index += at(index + 1) === 'B' ? 2 : 1;
        break;

      case 'C':
        if (index > 1 && !isVowel(index - 2) && contains(index - 1, 3, ['ACH'])
          && at(index + 2) !== 'I' && (at(index + 2) !== 'E' || contains(index - 2, 6, ['BACHER', 'MACHER']))) {
          add('K'); index += 2;
        } else if (index === 0 && contains(index, 6, ['CAESAR'])) {
          add('S'); index += 2;
        } else if (contains(index, 4, ['CHIA'])) {
          add('K'); index += 2;
        } else if (at(index + 1) === 'H') {
          if (index > 0 && contains(index, 4, ['CHAE'])) {
            add('K', 'X');
          } else if (index === 0
            && (contains(index + 1, 5, ['HARAC', 'HARIS']) || contains(index + 1, 3, ['HOR', 'HYM', 'HIA', 'HEM']))
            && !contains(0, 5, ['CHORE'])) {
            add('K');
          } else if (germanicStart || contains(index - 2, 6, ['ORCHES', 'ARCHIT', 'ORCHID'])
            || contains(index + 2, 1, ['T', 'S'])
            || ((contains(index - 1, 1, ['A', 'O', 'U', 'E']) || index === 0)
              && (contains(index + 2, 1, ['L', 'R', 'N', 'M', 'B', 'H', 'F', 'V', 'W']) || index + 1 === last))) {
            add('K');
          } else if (index > 0) {
            if (contains(0, 2, ['MC'])) add('K'); else add('X', 'K');
          } else {
            add('X');
          }
          index += 2;
        } else if (contains(index, 2, ['CZ']) && !contains(index - 2, 4, ['WICZ'])) {
          add('S', 'X'); index += 2;
        } else if (contains(index + 1, 3, ['CIA'])) {
          add('X'); index += 3;
        } else if (at(index + 1) === 'C' && !(index === 1 && at(0) === 'M')) {
          if (contains(index + 2, 1, ['I', 'E', 'H']) && !contains(index + 2, 2, ['HU'])) {
            if ((index === 1 && at(index - 1) === 'A') || contains(index - 1, 5, ['UCCEE', 'UCCES'])) add('KS'); else add('X');
            index += 3;
          } else {
            add('K'); index += 2;
          }
        } else if (contains(index, 2, ['CK', 'CG', 'CQ'])) {
          add('K'); index += 2;
        } else if (contains(index, 2, ['CI', 'CE', 'CY'])) {
          if (contains(index, 3, ['CIO', 'CIE', 'CIA'])) add('S', 'X'); else add('S');
          index += 2;
        } else {
          add('K');
          if (contains(index + 1, 2, [' C', ' Q', ' G'])) index += 3;
          else {
            index += contains(index + 1, 1, ['C', 'K', 'Q']) && !contains(index + 1, 2, ['CE', 'CI']) ? 2 : 1;
          }
        }
        break;

      case 'D':
        if (contains(index, 2, ['DG'])) {
          if (contains(index + 2, 1, ['I', 'E', 'Y'])) { add('J'); index += 3; } else { add('TK'); index += 2; }
        } else if (contains(index, 2, ['DT', 'DD'])) {
          add('T'); index += 2;
        } else {
          add('T'); index += 1;
        }
        break;

      case 'F':
        add('F');
        index += at(index + 1) === 'F' ? 2 : 1;
        break;

      case 'G':
        if (at(index + 1) === 'H') {
          if (index > 0 && !isVowel(index - 1)) {
            add('K'); index += 2;
          } else if (index === 0) {
            add(at(index + 2) === 'I' ? 'J' : 'K'); index += 2;
          } else if ((index > 1 && contains(index - 2, 1, ['B', 'H', 'D']))
            || (index > 2 && contains(index - 3, 1, ['B', 'H', 'D']))
            || (index > 3 && contains(index - 4, 1, ['B', 'H']))) {
            index += 2; // silent: "Hugh", "bough"
          } else {
            if (index > 2 && at(index - 1) === 'U' && contains(index - 3, 1, ['C', 'G', 'L', 'R', 'T'])) add('F');
            else if (index > 0 && at(index - 1) !== 'I') add('K');
            index += 2;
          }
        } else if (at(index + 1) === 'N') {
          if (index === 1 && isVowel(0) && !slavoGermanic) add('KN', 'N');
          else if (!contains(index + 2, 2, ['EY']) && at(index + 1) !== 'Y' && !slavoGermanic) add('N', 'KN');
          else add('KN');
          index += 2;
        } else if (contains(index + 1, 2, ['LI']) && !slavoGermanic) {
          add('KL', 'L'); index += 2;
        } else if (index === 0 && (at(index + 1) === 'Y'
          || contains(index + 1, 2, ['ES', 'EP', 'EB', 'EL', 'EY', 'IB', 'IL', 'IN', 'IE', 'EI', 'ER']))) {
          add('K', 'J'); index += 2;
        } else if ((contains(index + 1, 2, ['ER']) || at(index + 1) === 'Y')
          && !contains(0, 6, ['DANGER', 'RANGER', 'MANGER'])
          && !contains(index - 1, 1, ['E', 'I']) && !contains(index - 1, 3, ['RGY', 'OGY'])) {
          add('K', 'J'); index += 2;
        } else if (contains(index + 1, 1, ['E', 'I', 'Y']) || contains(index - 1, 4, ['AGGI', 'OGGI'])) {
          if (germanicStart || contains(index + 1, 2, ['ET'])) add('K');
          else if (contains(index + 1, 4, ['IER'])) add('J');
          else add('J', 'K');
          index += 2;
        } else {
          index += at(index + 1) === 'G' ? 2 : 1;
          add('K');
        }
        break;

      case 'H':
        if ((index === 0 || isVowel(index - 1)) && isVowel(index + 1)) { add('H'); index += 2; } else index += 1;
        break;

      case 'J':
        if (contains(index, 4, ['JOSE']) || contains(0, 4, ['SAN '])) {
          if ((index === 0 && at(index + 4) === ' ') || length === 4 || contains(0, 4, ['SAN '])) add('H'); else add('J', 'H');
          index += 1;
        } else {
          if (index === 0) add('J', 'A');
          else if (isVowel(index - 1) && !slavoGermanic && (at(index + 1) === 'A' || at(index + 1) === 'O')) add('J', 'H');
          else if (index === last) add('J', '');
          else if (!contains(index + 1, 1, ['L', 'T', 'K', 'S', 'N', 'M', 'B', 'Z']) && !contains(index - 1, 1, ['S', 'K', 'L'])) add('J');
          index += at(index + 1) === 'J' ? 2 : 1;
        }
        break;

      case 'K':
        add('K');
        index += at(index + 1) === 'K' ? 2 : 1;
        break;

      case 'L':
        if (at(index + 1) === 'L') {
          if ((index === length - 3 && contains(index - 1, 4, ['ILLO', 'ILLA', 'ALLE']))
            || ((contains(last - 1, 2, ['AS', 'OS']) || contains(last, 1, ['A', 'O'])) && contains(index - 1, 4, ['ALLE']))) {
            add('L', '');
          } else {
            add('L');
          }
          index += 2;
        } else {
          add('L'); index += 1;
        }
        break;

      case 'M':
        add('M');
        if ((contains(index - 1, 3, ['UMB']) && (index + 1 === last || contains(index + 2, 2, ['ER']))) || at(index + 1) === 'M') index += 2;
        else index += 1;
        break;

      case 'N':
        add('N');
        index += at(index + 1) === 'N' ? 2 : 1;
        break;

      case 'P':
        if (at(index + 1) === 'H') { add('F'); index += 2; } else {
          add('P');
          index += contains(index + 1, 1, ['P', 'B']) ? 2 : 1;
        }
        break;

      case 'Q':
        add('K');
        index += at(index + 1) === 'Q' ? 2 : 1;
        break;

      case 'R':
        if (index === last && !slavoGermanic && contains(index - 2, 2, ['IE']) && !contains(index - 4, 2, ['ME', 'MA'])) add('', 'R');
        else add('R');
        index += at(index + 1) === 'R' ? 2 : 1;
        break;

      case 'S':
        if (contains(index - 1, 3, ['ISL', 'YSL'])) {
          index += 1;
        } else if (index === 0 && contains(index, 5, ['SUGAR'])) {
          add('X', 'S'); index += 1;
        } else if (at(index + 1) === 'H') {
          if (contains(index + 1, 4, ['HEIM', 'HOEK', 'HOLM', 'HOLZ'])) add('S'); else add('X');
          index += 2;
        } else if (contains(index, 3, ['SIO', 'SIA']) || contains(index, 4, ['SIAN'])) {
          if (slavoGermanic) add('S'); else add('S', 'X');
          index += 3;
        } else if ((index === 0 && contains(index + 1, 1, ['M', 'N', 'L', 'W'])) || at(index + 1) === 'Z') {
          add('S', 'X');
          index += at(index + 1) === 'Z' ? 2 : 1;
        } else if (contains(index, 2, ['SC'])) {
          if (at(index + 2) === 'H') {
            if (contains(index + 3, 2, ['OO', 'ER', 'EN', 'UY', 'ED', 'EM'])) {
              if (contains(index + 3, 2, ['ER', 'EN'])) add('X', 'SK'); else add('SK');
            } else if (index === 0 && !isVowel(3) && at(3) !== 'W') add('X', 'S');
            else add('X');
          } else if (contains(index + 2, 1, ['I', 'E', 'Y'])) {
            add('S');
          } else {
            add('SK');
          }
          index += 3;
        } else {
          if (index === last && contains(index - 2, 2, ['AI', 'OI'])) add('', 'S'); else add('S');
          index += contains(index + 1, 1, ['S', 'Z']) ? 2 : 1;
        }
        break;

      case 'T':
        if (contains(index, 4, ['TION'])) {
          add('X'); index += 3;
        } else if (contains(index, 3, ['TIA', 'TCH'])) {
          add('X'); index += 3;
        } else if (contains(index, 2, ['TH']) || contains(index, 3, ['TTH'])) {
          if (contains(index + 2, 2, ['OM', 'AM']) || germanicStart) add('T'); else add('0', 'T');
          index += 2;
        } else {
          add('T');
          index += contains(index + 1, 1, ['T', 'D']) ? 2 : 1;
        }
        break;

      case 'V':
        add('F');
        index += at(index + 1) === 'V' ? 2 : 1;
        break;

      case 'W':
        if (at(index + 1) === 'R') {
          add('R'); index += 2;
        } else {
          if (index === 0 && (isVowel(index + 1) || contains(index, 2, ['WH']))) {
            if (isVowel(index + 1)) add('A', 'F'); else add('A');
          }
          if ((index === last && isVowel(index - 1)) || contains(index - 1, 5, ['EWSKI', 'EWSKY', 'OWSKI', 'OWSKY']) || contains(0, 3, ['SCH'])) {
            add('', 'F'); index += 1;
          } else if (contains(index, 4, ['WICZ', 'WITZ'])) {
            add('TS', 'FX'); index += 4;
          } else {
            index += 1;
          }
        }
        break;

      case 'X':
        if (!(index === last && (contains(index - 3, 3, ['IAU', 'EAU']) || contains(index - 2, 2, ['AU', 'OU'])))) add('KS');
        index += contains(index + 1, 1, ['C', 'X']) ? 2 : 1;
        break;

      case 'Z':
        if (at(index + 1) === 'H') {
          add('J'); index += 2;
        } else {
          if (contains(index + 1, 2, ['ZO', 'ZI', 'ZA']) || (slavoGermanic && index > 0 && at(index - 1) !== 'T')) add('S', 'TS'); else add('S');
          index += at(index + 1) === 'Z' ? 2 : 1;
        }
        break;

      default:
        index += 1;
    }
  }

  primary = primary.slice(0, MAX_KEY);
  secondary = secondary.slice(0, MAX_KEY);
  return [primary, secondary];
}

module.exports = { doubleMetaphone };
