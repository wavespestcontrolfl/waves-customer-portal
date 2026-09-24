'use strict';

const CHECK_NAMES = Object.freeze([
  'answer_first',
  'source_support',
  'standalone_passages',
  'title_intent',
  'editorial_quality',
]);

const LIMITS = Object.freeze({
  documentChars: 120000,
  sourceUrls: 8,
  sourceChars: 20000,
  totalSourceChars: 100000,
  factsPackChars: 20000,
  sections: 80,
  passages: 180,
  claims: 220,
  timeoutMs: 60000,
});

const ALLOWED_TEMPLATE_TOKENS = new Set([
  'brand', 'brandName', 'brandShort', 'cityPhone', 'email', 'phone', 'primaryCity', 'siteUrl', 'tel',
]);

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claimInventoryComplete', 'checks', 'claims', 'sectionCoverage', 'passageCoverage'],
  properties: {
    claimInventoryComplete: { type: 'boolean' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'findings'],
        properties: {
          name: { type: 'string', enum: CHECK_NAMES },
          status: { type: 'string', enum: ['pass', 'fail'] },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['passage', 'detail', 'action', 'sourceIndexes', 'sourceQuote'],
              properties: {
                passage: { type: 'string' },
                detail: { type: 'string' },
                action: { type: 'string' },
                sourceIndexes: { type: 'array', items: { type: 'integer' } },
                sourceQuote: { type: 'string' },
              },
            },
          },
        },
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'passage', 'verdict', 'claimKind', 'sourceSuitability', 'sourceIndex', 'sourceQuote', 'action'],
        properties: {
          claimId: { type: 'string' },
          passage: { type: 'string' },
          verdict: { type: 'string', enum: ['supported', 'unsupported', 'non_external'] },
          claimKind: { type: 'string', enum: ['quantitative', 'expert_quote', 'named_example', 'general', 'non_external'] },
          sourceSuitability: { type: 'string', enum: ['primary_authoritative', 'suitable_secondary', 'unsuitable', 'not_applicable'] },
          sourceIndex: { type: 'integer' },
          sourceQuote: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
    sectionCoverage: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['sectionId', 'status'],
        properties: { sectionId: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail'] } },
      },
    },
    passageCoverage: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['passageId', 'status'],
        properties: { passageId: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail'] } },
      },
    },
  },
};

const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sectionPlan', 'body'],
  properties: {
    sectionPlan: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['section', 'answer'],
        properties: { section: { type: 'string' }, answer: { type: 'string' } },
      },
    },
    body: { type: 'string' },
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'findings', 'sectionCoverage'],
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sectionIndex', 'passage', 'detail', 'action'],
        properties: {
          sectionIndex: { type: 'integer' },
          passage: { type: 'string' },
          detail: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
    sectionCoverage: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['sectionIndex', 'status'],
        properties: { sectionIndex: { type: 'integer' }, status: { type: 'string', enum: ['pass', 'fail'] } },
      },
    },
  },
};

module.exports = {
  ALLOWED_TEMPLATE_TOKENS,
  CHECK_NAMES,
  LIMITS,
  PLAN_SCHEMA,
  REPAIR_SCHEMA,
  REVIEW_SCHEMA,
};

