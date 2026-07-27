-- Carril de captura v2: tareas y proyectos nacidos en Mindwtr o Vikunja
-- que el bridge da a luz en Anytype (docs/capture-lane-v2.md).

BEGIN;

CREATE TABLE IF NOT EXISTS capture_map (
    id bigserial PRIMARY KEY,
    origin text NOT NULL CHECK (origin IN ('mindwtr', 'vikunja')),
    kind text NOT NULL CHECK (kind IN ('task', 'project')),
    -- uuid en Mindwtr (tarea espejo/proyecto espejo original); NULL para
    -- origen vikunja hasta que el bridge espeja.
    mindwtr_id uuid,
    -- id en Vikunja (tarea/proyecto); NULL para origen mindwtr hasta adopción.
    vikunja_id bigint,
    anytype_space_id text NOT NULL,
    -- NULL mientras 'creating' (pre-registro para idempotencia).
    anytype_object_id text,
    state text NOT NULL DEFAULT 'creating' CHECK (state IN
        ('creating',  -- fila pre-registrada; la llamada a la API está en vuelo
         'pending',   -- objeto creado en Anytype; esperando adopción por atvk
         'adopted',   -- circuito completo; fila histórica
         'failed')),
    detail jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS capture_map_mindwtr_idx
    ON capture_map (mindwtr_id) WHERE mindwtr_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capture_map_vikunja_idx
    ON capture_map (kind, vikunja_id) WHERE vikunja_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capture_map_object_idx
    ON capture_map (anytype_object_id) WHERE anytype_object_id IS NOT NULL;

COMMIT;
