# Inactive amount relationship candidates

`recognizeEmailReplyAmountRelations(text = '')` calls the bounded pricing
phrase recognizer once. It forwards scanner failures unchanged and always
returns `disposition: 'needs_review'` on success. It has no runtime caller,
provider call, database operation, or authority to approve customer copy.

## Evidence contract

Each clause retains the complete original `tokens` and `phrases` and adds
`amountRelations`. Every scanner `money` or `number` token gets one record:

```js
{
  amount: { start, end, kind, text },
  candidates: []
}
```

An empty candidate array means no supported local relationship was found.
It does not mean the amount is compliant. Measurements are not amounts;
unit, timing, application, and period evidence remains in the original tokens.
Ranges that the existing amount lexer combines remain single amount tokens.
`costs 90 to 120` and `costs from 90 to 120` can link. A leading
`from` or `between` is retained as connector evidence. Separate currency
endpoints remain separate amount records; no complete range is inferred.

A candidate has `relation`, `start`, `end`, `anchor`, `connector`, and
`qualifier`. Its anchor is an existing phrase candidate. Connector evidence
retains the intervening token span and normalized text, or is null for an
adjacent anchor and amount. A qualifier is an existing qualifier candidate
or null. All indexes are clause-local scanner token indexes, with inclusive
starts and exclusive ends; none are original source character offsets.

Candidates preserve lexical alternatives. A noun/action head may generate
both head and predicate relationships. They are not resolved billing claims.
Predicate anchors retain their explicit negation evidence; a copular
connector retains its actual tokens without claiming semantic polarity.

## Finite supported forms

- `predicate_amount`: a predicate, optionally one participant, optionally
  `at`, optionally `a`/`an`, optionally one qualifier, optionally
  `from`/`between`, then an amount. For example, `charge $98`, `pay you $98`,
  and `costs up to $98`.
- `head_amount`: a noun-role billing head, optionally a copula or one of
  `of`, colon, or hyphen, optionally `a`/`an`, optionally one qualifier,
  optionally `from`/`between`, then an amount. For example, `fee $98` or `total is $98`.
- `amount_head`: an amount, optionally a copula, optionally `a`, `an`, or
  `the`, then a noun-role billing head. For example, `$98 fee` or
  `$98 is the price`.

A copula is one scanner `be` token, optionally followed by one explicit
`not` or `never` token. Scanner tokens can contain several normalized words.
A leading `not` in a supported qualifier such as `not more than` remains
part of that qualifier when it precedes an amount.
These are local lexical forms, not a complete English grammar. Boundaries,
unknown words, other amounts, units, and clause separators cannot be skipped
to manufacture an attachment. In particular, an intervening visit unit is
not treated as a participant.

## Limits and ownership

This layer does not attach amounts to visits, applications, or periods;
resolve coordination; interpret refunds or posted payments; infer service
plan subjects; compute totals; or decide exemptions/compliance. A matched
base amount in `$98 plus tax` does not consume or validate the tax addend.
All unresolved words and tokens remain visible for later consumers.

The shared scanner still owns normalization and amount/unit lexing. The
phrase recognizer owns billing vocabulary, qualifiers, participants, and
bounded predicates. Existing `comms-lint.js` and frozen policy adapters are
unchanged. Inherited finite amount grammar and newline-normalization limits
remain. Absence of a candidate can never authorize sending a reply.

Run `npx jest server/tests/email-reply-amount-relations.test.js --runInBand`
for the finite relation contract and boundary controls, and ESLint on the
new source and tests. Integration with policy adapters is a later review unit.
