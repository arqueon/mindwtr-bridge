BEGIN;

ALTER TABLE capture_map
    ALTER COLUMN anytype_space_id DROP NOT NULL;

COMMENT ON COLUMN capture_map.anytype_space_id IS
    'Dato histórico del carril v2; el carril v3 no accede a Anytype.';
COMMENT ON COLUMN capture_map.anytype_object_id IS
    'Dato histórico del carril v2; el carril v3 registra vikunja_id directamente.';

COMMIT;
