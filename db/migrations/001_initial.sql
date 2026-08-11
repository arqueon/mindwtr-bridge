-- mindwtr-bridge · esquema inicial (BD mindwtr_sync)
-- Modelo derivado de vikunja-anytype-sync (task_field_state / three-way merge)
-- adaptado al canal único Vikunja[ANYTYPE] ⟷ Mindwtr.

BEGIN;

CREATE TABLE IF NOT EXISTS bridge_state (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    device_uuid uuid NOT NULL,
    last_etag text,
    last_written_sha256 text,
    gtd_label_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Contenedor de Space bajo ANYTYPE ↔ Area de Mindwtr.
CREATE TABLE IF NOT EXISTS area_map (
    vikunja_project_id bigint PRIMARY KEY,
    mindwtr_area_id uuid UNIQUE NOT NULL,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Proyecto Anytype (bajo su Space) ↔ Project de Mindwtr.
CREATE TABLE IF NOT EXISTS project_map (
    vikunja_project_id bigint PRIMARY KEY,
    mindwtr_project_id uuid UNIQUE NOT NULL,
    area_vikunja_project_id bigint NOT NULL REFERENCES area_map (vikunja_project_id),
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_map (
    vikunja_task_id bigint PRIMARY KEY,
    mindwtr_task_id uuid UNIQUE NOT NULL,
    state text NOT NULL DEFAULT 'active' CHECK (state IN
        ('active',    -- espejo vivo
         'retired',   -- done/fuera de alcance en Vikunja; archivada en el espejo; puede resucitar
         'dismissed'  -- tombstone local en Mindwtr; NUNCA recrear, no tocar Vikunja
        )),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_field_state (
    vikunja_task_id bigint NOT NULL REFERENCES task_map ON DELETE CASCADE,
    field_name text NOT NULL CHECK (field_name IN
        ('title', 'description', 'done', 'gtd_status', 'priority', 'due_date', 'start_time',
         'contexts', 'tags', 'focus', 'project', 'area')),
    last_vikunja_value jsonb,
    last_mindwtr_value jsonb,
    last_common_value jsonb,
    last_origin text CHECK (last_origin IN
        ('vikunja', 'mindwtr', 'bootstrap', 'reconcile',
         'vikunja_sanitized', 'mindwtr_local_preserved')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vikunja_task_id, field_name)
);

CREATE TABLE IF NOT EXISTS sync_run (
    id bigserial PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text CHECK (status IN ('ok', 'partial', 'error', 'skipped_locked', 'skipped_etag')),
    dry_run boolean NOT NULL DEFAULT false,
    vikunja_writes integer NOT NULL DEFAULT 0,
    mindwtr_mutations integer NOT NULL DEFAULT 0,
    detail jsonb
);

CREATE TABLE IF NOT EXISTS sync_error (
    id bigserial PRIMARY KEY,
    run_id bigint REFERENCES sync_run (id),
    vikunja_task_id bigint,
    field_name text,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_error_task_idx ON sync_error (vikunja_task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sync_run_started_idx ON sync_run (started_at DESC);

COMMIT;
