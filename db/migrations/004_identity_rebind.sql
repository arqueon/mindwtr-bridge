BEGIN;

ALTER TABLE task_map
    ADD COLUMN IF NOT EXISTS provenance_marker text;

CREATE UNIQUE INDEX IF NOT EXISTS task_map_provenance_marker_idx
    ON task_map (provenance_marker)
    WHERE provenance_marker IS NOT NULL;

ALTER TABLE task_field_state
    DROP CONSTRAINT IF EXISTS task_field_state_vikunja_task_id_fkey;
ALTER TABLE task_field_state
    ADD CONSTRAINT task_field_state_vikunja_task_id_fkey
    FOREIGN KEY (vikunja_task_id) REFERENCES task_map(vikunja_task_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

COMMIT;
