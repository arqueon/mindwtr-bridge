-- Checkpoint de descripciones saneadas V→M y conservación explícita de notas
-- locales. Las restricciones se recrean para instalaciones existentes.

BEGIN;

ALTER TABLE task_field_state
    DROP CONSTRAINT IF EXISTS task_field_state_field_name_check;
ALTER TABLE task_field_state
    ADD CONSTRAINT task_field_state_field_name_check CHECK (field_name IN
        ('title', 'description', 'done', 'gtd_status', 'priority', 'due_date',
         'start_time', 'contexts', 'tags', 'focus', 'project', 'area'));

ALTER TABLE task_field_state
    DROP CONSTRAINT IF EXISTS task_field_state_last_origin_check;
ALTER TABLE task_field_state
    ADD CONSTRAINT task_field_state_last_origin_check CHECK (last_origin IN
        ('vikunja', 'mindwtr', 'bootstrap', 'reconcile',
         'vikunja_sanitized', 'mindwtr_local_preserved'));

COMMIT;
