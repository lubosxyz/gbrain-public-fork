import type { Migration } from './types.ts';
import { protectTables } from './v275-rls-backfill-unguarded-tables.ts';

export const v277: Migration = {
    version: 277,
    name: 'fork_upstream_v150_reconciliation',
    // Converge the historical fork and upstream schema lineages. Both used
    // the same scalar versions for different idempotent DDL.
    idempotent: true,
    sql: `
      -- upstream v131: drop_job_wide_subagent_tool_use_id_unique (#4155)
      ALTER TABLE subagent_tool_executions
        DROP CONSTRAINT IF EXISTS uniq_subagent_tools_use_id;

      -- upstream v132: session_context_state_checkpoint_manifest (Cathedral 5)
      ALTER TABLE session_context_state ADD COLUMN IF NOT EXISTS checkpoint_manifest JSONB NOT NULL DEFAULT '[]'::jsonb;

      -- fork v131: fork_upstream_v128_reconciliation
      CREATE TABLE IF NOT EXISTS mcp_request_log_purged (
        token_name          TEXT PRIMARY KEY,
        purged_requests     BIGINT NOT NULL DEFAULT 0,
        purged_last_used_at TIMESTAMPTZ
      );

      UPDATE minion_jobs
         SET timeout_ms = CASE name
               WHEN 'subagent'                     THEN 1800000
               WHEN 'subagent_aggregator'          THEN 1800000
               WHEN 'embed-backfill'               THEN 1800000
               WHEN 'autopilot-cycle'              THEN 1800000
               WHEN 'autopilot-global-maintenance' THEN 1800000
               WHEN 'chronicle_extract'            THEN 600000
               WHEN 'facts-absorb'                 THEN 600000
               WHEN 'contextual_reindex_per_chunk' THEN 3600000
             END,
             updated_at = now()
       WHERE timeout_ms IS NULL
         AND status IN ('waiting','active','delayed','waiting-children','paused')
         AND name IN ('subagent','subagent_aggregator','embed-backfill',
                      'autopilot-cycle','autopilot-global-maintenance',
                      'chronicle_extract','facts-absorb',
                      'contextual_reindex_per_chunk');

      UPDATE minion_jobs
         SET status = 'cancelled',
             finished_at = now(),
             updated_at = now(),
             error_text = 'v131: superseded duplicate autopilot cycle'
       WHERE status = 'waiting' AND parent_job_id IS NULL
         AND name IN ('autopilot-cycle','autopilot-global-maintenance')
         AND (idempotency_key LIKE 'autopilot-cycle:%' OR idempotency_key LIKE 'autopilot-global:%')
         AND data->>'sourceId' IS NULL
         AND id NOT IN (
           SELECT id FROM (
             SELECT DISTINCT ON (name, queue, COALESCE(data->>'source_id','')) id
             FROM minion_jobs
             WHERE status = 'waiting' AND parent_job_id IS NULL
               AND name IN ('autopilot-cycle','autopilot-global-maintenance')
               AND (idempotency_key LIKE 'autopilot-cycle:%' OR idempotency_key LIKE 'autopilot-global:%')
               AND data->>'sourceId' IS NULL
             ORDER BY name, queue, COALESCE(data->>'source_id',''), created_at DESC, id DESC
           ) keep
         );
      -- fork v132: tenant_scoped_tokens_and_auth_audit
      ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS company_slug TEXT;
      ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS minted_by TEXT;

      -- Structural tenant invariants (drop-then-add idempotent pattern, v7
      -- precedent). App-layer validation is the first line — these CHECKs make
      -- a hand-edited or partially-written tenant row unrepresentable rather
      -- than relying on every verify path to reject it: a tenant row must
      -- carry a well-formed slug, a real expiry, and the exact read-only
      -- grant. All-NULL grandfathered rows satisfy all three trivially.
      ALTER TABLE access_tokens DROP CONSTRAINT IF EXISTS chk_access_tokens_company_slug_format;
      ALTER TABLE access_tokens ADD CONSTRAINT chk_access_tokens_company_slug_format
        CHECK (company_slug IS NULL OR company_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');
      ALTER TABLE access_tokens DROP CONSTRAINT IF EXISTS chk_access_tokens_tenant_expiry;
      ALTER TABLE access_tokens ADD CONSTRAINT chk_access_tokens_tenant_expiry
        CHECK ((company_slug IS NULL AND expires_at IS NULL AND minted_by IS NULL) OR (company_slug IS NOT NULL AND expires_at IS NOT NULL AND minted_by IS NOT NULL));
      ALTER TABLE access_tokens DROP CONSTRAINT IF EXISTS chk_access_tokens_tenant_read_only;
      ALTER TABLE access_tokens ADD CONSTRAINT chk_access_tokens_tenant_read_only
        CHECK (company_slug IS NULL OR (scopes IS NOT NULL AND scopes = ARRAY['read']::text[]));

      CREATE TABLE IF NOT EXISTS auth_audit (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        correlation_id TEXT NOT NULL,
        decision       TEXT NOT NULL,
        method         TEXT,
        reason         TEXT,
        token_id       TEXT,
        token_name     TEXT,
        company_slug   TEXT,
        actor          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit (created_at DESC);
    `,
    // The fork's tables are not in v275's frozen list, and on a brain without
    // the auto-RLS event trigger only the schema blob would enable their RLS.
    handler: async engine => { await protectTables(engine, ['auth_audit', 'mcp_request_log_purged'], 'v277'); },
  };
