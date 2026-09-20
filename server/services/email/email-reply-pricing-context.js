const { recognizeEmailReplyPeriodPhrases } = require('./email-reply-period-phrases');

const CONTEXT_WORDS = {
  plan: ['plan', 'program', 'package'],
  account: ['account', 'balance', 'payment', 'refund', 'credit', 'deposit', 'receipt', 'received', 'pay', 'due'],
  account_event: ['posted', 'cleared', 'received', 'refunded', 'credited', 'pay'],
  activity: ['reminder', 'reminders', 'update', 'updates', 'schedule', 'scheduling',
    'appointment', 'appointments', 'service', 'services', 'treatment', 'treatments'],
  adjustment: ['reduce', 'reduced', 'reduction', 'reductions', 'save', 'saves', 'saving', 'savings',
    'discount', 'discounts', 'discounted', 'increase', 'increased', 'decrease', 'decreased'],
  measurement: ['percent', 'percentage', 'mile', 'miles', 'kilometer', 'kilometers',
    'kilometre', 'kilometres', 'foot', 'feet', 'inch', 'inches', 'yard', 'yards'],
};
const ROLES = new Map();
for (const [role, words] of Object.entries(CONTEXT_WORDS)) {
  for (const word of words) ROLES.set(word, [...(ROLES.get(word) ?? []), role]);
}

function recognizeClause(clause) {
  const contextPhrases = clause.tokens.flatMap((token, start) => {
    const roles = token.kind === 'word' ? ROLES.get(token.text)
      : token.kind === 'barrier' && token.text === '%' ? ['measurement'] : null;
    return roles ? [{ start, end: start + 1, text: token.text, token, roles: [...roles] }] : [];
  });
  return { ...clause, contextPhrases };
}

// Context roles may overlap and never establish a price, account event or exemption.
function recognizeEmailReplyPricingContext(text = '') {
  const result = recognizeEmailReplyPeriodPhrases(text);
  if (!result.ok) return result;
  return { ...result, disposition: 'needs_review', clauses: result.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyPricingContext };
