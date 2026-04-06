/**
 * Migration 081 — Knowledge Base "Claudeopedia" upgrade
 *
 * The knowledge_base table already exists from migration 035 with a different schema.
 * This migration adds new columns needed by the Claudeopedia service (slug, confidence,
 * status, source, search_vector, etc.) and creates the knowledge_base_audits table.
 *
 * token_credentials already exists from migration 079 — we add any missing columns
 * but do NOT recreate it.
 */

exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // ── Upgrade knowledge_base table with Claudeopedia columns ──
  const hasKB = await knex.schema.hasTable('knowledge_base');
  if (hasKB) {
    await knex.schema.alterTable('knowledge_base', t => {
      // New columns — only add if missing
    });

    // Add columns one by one with hasColumn checks
    const cols = {
      slug: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'slug'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.string('slug', 200).unique();
          });
          // Populate slug from title or path for existing rows
          await knex.raw(`
            UPDATE knowledge_base
            SET slug = LOWER(REGEXP_REPLACE(COALESCE(title, 'untitled'), '[^a-z0-9]+', '-', 'gi'))
            WHERE slug IS NULL
          `);
        }
      },
      source: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'source'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.string('source', 50).defaultTo('manual');
          });
        }
      },
      confidence: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'confidence'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.string('confidence', 20).defaultTo('medium');
          });
        }
      },
      last_verified_at: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'last_verified_at'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.timestamp('last_verified_at');
          });
        }
      },
      verified_by: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'verified_by'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.string('verified_by', 100);
          });
        }
      },
      supersedes: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'supersedes'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.uuid('supersedes').references('id').inTable('knowledge_base').onDelete('SET NULL');
          });
        }
      },
      status: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'status'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.string('status', 20).defaultTo('active');
          });
        }
      },
      metadata: async () => {
        if (!(await knex.schema.hasColumn('knowledge_base', 'metadata'))) {
          await knex.schema.alterTable('knowledge_base', t => {
            t.jsonb('metadata').defaultTo('{}');
          });
        }
      },
    };

    for (const [, addCol] of Object.entries(cols)) {
      await addCol();
    }

    // Add indexes if not already present (safe — Postgres ignores duplicate index names)
    try { await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kb_status ON knowledge_base (status)`); } catch {}
    try { await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kb_confidence ON knowledge_base (confidence)`); } catch {}
    try { await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kb_last_verified ON knowledge_base (last_verified_at)`); } catch {}

    // Full-text search vector (generated column)
    const hasSearchVector = await knex.schema.hasColumn('knowledge_base', 'search_vector');
    if (!hasSearchVector) {
      try {
        await knex.raw(`
          ALTER TABLE knowledge_base ADD COLUMN search_vector tsvector
            GENERATED ALWAYS AS (
              setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(content, '')), 'B')
            ) STORED
        `);
        await knex.raw(`CREATE INDEX idx_kb_search ON knowledge_base USING GIN (search_vector)`);
      } catch (err) {
        // If the generated column fails (e.g. on older Postgres), skip gracefully
        console.warn('Could not add search_vector generated column:', err.message);
      }
    }
  } else {
    // Table doesn't exist at all — create from scratch (unlikely given migration 035)
    await knex.schema.createTable('knowledge_base', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.string('slug', 200).notNullable().unique();
      t.string('title', 500).notNullable();
      t.string('category', 100).notNullable().defaultTo('general');
      t.text('content');
      t.jsonb('tags').defaultTo('[]');
      t.string('source', 50).defaultTo('manual');
      t.string('confidence', 20).defaultTo('medium');
      t.timestamp('last_verified_at');
      t.string('verified_by', 100);
      t.uuid('supersedes').references('id').inTable('knowledge_base').onDelete('SET NULL');
      t.string('status', 20).defaultTo('active');
      t.jsonb('metadata').defaultTo('{}');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index('category');
      t.index('status');
      t.index('confidence');
      t.index('last_verified_at');
    });

    await knex.raw(`
      ALTER TABLE knowledge_base ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(content, '')), 'B')
        ) STORED
    `);
    await knex.raw(`CREATE INDEX idx_kb_search ON knowledge_base USING GIN (search_vector)`);
  }

  // ── KB Audit Log ──
  const hasAudits = await knex.schema.hasTable('knowledge_base_audits');
  if (!hasAudits) {
    await knex.schema.createTable('knowledge_base_audits', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.uuid('kb_entry_id').references('id').inTable('knowledge_base').onDelete('CASCADE');
      t.string('audit_type', 50).notNullable();
      t.text('findings');
      t.string('result', 30);
      t.string('audited_by', 100);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index('kb_entry_id');
      t.index('audit_type');
    });
  }

  // ── Token Credentials — upgrade existing table from migration 079 ──
  const hasTokens = await knex.schema.hasTable('token_credentials');
  if (hasTokens) {
    // Add any missing columns from the Claudeopedia spec
    if (!(await knex.schema.hasColumn('token_credentials', 'credential_type'))) {
      await knex.schema.alterTable('token_credentials', t => {
        t.string('credential_type', 50);
      });
      // Copy token_type into credential_type for existing rows
      await knex.raw(`UPDATE token_credentials SET credential_type = COALESCE(token_type, 'oauth-token') WHERE credential_type IS NULL`);
    }
    if (!(await knex.schema.hasColumn('token_credentials', 'metadata'))) {
      await knex.schema.alterTable('token_credentials', t => {
        t.jsonb('metadata').defaultTo('{}');
      });
    }
  }
  // Do NOT create token_credentials — already exists from migration 079
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('knowledge_base_audits');

  // Remove added columns (don't drop the whole table — 035 owns it)
  const hasKB = await knex.schema.hasTable('knowledge_base');
  if (hasKB) {
    const colsToDrop = ['slug', 'source', 'confidence', 'last_verified_at', 'verified_by', 'supersedes', 'status', 'metadata', 'search_vector'];
    for (const col of colsToDrop) {
      if (await knex.schema.hasColumn('knowledge_base', col)) {
        await knex.schema.alterTable('knowledge_base', t => { t.dropColumn(col); });
      }
    }
  }
};
