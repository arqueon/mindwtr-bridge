# Carril de captura (v2) — tareas y proyectos nacidos en Mindwtr O en Vikunja

Diseño aprobado en concepto el 2026-07-26; pendiente de implementación.
Objetivo: capturar en Mindwtr **o en Vikunja** y que la tarea/proyecto
**nazca en Anytype**, entrando después al circuito normal. Vikunja se
mantiene como hub; la API de Anytype se usa **solo para crear**, no como
borde continuo de sincronización (evita el triángulo A↔V↔M). Tras la v2,
Anytype deja de ser la única sala de partos: los tres extremos pueden crear.

## Semántica de intención (cómo se opta al circuito)

- **Tarea**: una tarea creada en Mindwtr queda personal SALVO que la
  archives en un contenedor espejo — `projectId` de un proyecto espejo, o
  `areaId` de un área espejo (Space, va a «00 · Sin proyecto»). Archivar
  dentro del espejo = "esto es del circuito". Sin vocabulario nuevo.
- **Proyecto**: un proyecto creado en Mindwtr con `areaId` de un área
  espejo se captura como objeto Project del Space correspondiente. Sin
  área (o en área personal) queda personal.
- Cambio respecto a v1: hoy esas tareas/proyectos se ignoran; en v2
  colocarlos en el espejo es opt-in explícito. Documentarlo en README.

## Mecanismo

```
Mindwtr (captura en espejo)
  → bridge: crea objeto en Anytype (API anytype-cli, misma del atvk)
  → capture_map: mindwtr_uuid ↔ anytype_object_id (estado pending)
  → atvk bootstrap (≤3 min, límite 5/ciclo): objeto → tarea Vikunja
  → bridge: ADOPCIÓN — detecta la Vikunja task del objeto capturado
    (vía task_map de atvk, lectura), inserta task_map con el uuid
    EXISTENTE del espejo (no crea espejo nuevo), siembra field states
  → circuito normal
```

Latencia total ~6–9 min; el objeto existe en Anytype desde el primer ciclo.

## Piezas necesarias

1. **Acceso de solo lectura a `anytype_sync`** (BD de atvk) para:
   - `channel_map`: `vikunja_project_id` del contenedor → `anytype_space_id`
     + las property keys por Space (`done_property_key`, `due_property_key`,
     `priority_property_key`, `tags_property_key`, `project_property_key`).
   - `project_map`: proyecto Vikunja → `anytype_project_id` (para Linked
     Projects al crear).
   - `task_map`: `anytype_task_id` → `vikunja_task_id` (para la adopción).
   `GRANT SELECT` a `mindwtr_sync` sobre esas tablas; el bridge JAMÁS
   escribe en `anytype_sync`.
2. **Cliente Anytype** (`src/anytype-client.js`): subconjunto mínimo contra
   `http://anytype-cli:31012/v1` (create-object type_key `task`/`project`,
   update de propiedades). Secreto: compartir `anytype-api-key` (lectura del
   secreto de atvk o copia 0600 propia).
3. **Tabla nueva** en `mindwtr_sync`:
   ```sql
   CREATE TABLE capture_map (
       mindwtr_task_id uuid PRIMARY KEY,
       anytype_object_id text UNIQUE NOT NULL,
       anytype_space_id text NOT NULL,
       kind text NOT NULL CHECK (kind IN ('task','project')),
       state text NOT NULL DEFAULT 'pending' CHECK (state IN
           ('pending',   -- creado en Anytype, esperando a atvk
            'adopted',   -- ya en task_map; fila histórica
            'failed')),
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
   );
   ```
4. **Fase nueva del ciclo** (entre el plan y las escrituras):
   - Detectar tareas Mindwtr sin mapeo con destino espejo y sin fila en
     `capture_map` → crear en Anytype (título, done, due date con hora
     canónica, priority, Linked Projects; tags/contextos en un update
     posterior a la adopción, vía labels de Vikunja — más simple que
     ensureTag directo).
   - Adopción: para cada `capture_map` pending, buscar su
     `vikunja_task_id` en el task_map de atvk; si existe → insertar en
     nuestro `task_map` con el uuid del espejo original + field states
     sembrados desde el snapshot Vikunja; marcar `adopted`.
   - Anti-doble-espejo: el paso «create_mirror» debe ignorar tareas
     Vikunja cuyo anytype_task_id tenga capture pending/adopted reciente.

## Carril Vikunja (simétrico, más simple que el de Mindwtr)

- **Intención**: una tarea creada en Vikunja dentro del subtree ANYTYPE
  (proyecto mapeado o «00 · Sin proyecto» de un Space) es del circuito por
  colocación — igual que en Mindwtr. Un proyecto creado bajo un contenedor
  de Space, ídem.
- **Mecanismo — adopción vía marcador de procedencia de atvk**: el carril
  crea el objeto en Anytype (Space/proyecto deducidos de la posición) y
  añade a la descripción de la tarea Vikunja EXISTENTE el marcador
  `<!-- atvk:v1:sha256(spaceId␀objectId)[..40] -->` (formato de
  `canonical.js:provenanceMarker` de atvk). El bootstrap de atvk busca ese
  marcador en las tareas de Vikunja (es su mecanismo de recuperación
  idempotente) y **adopta la tarea existente en su task_map en vez de crear
  un duplicado**. Proyectos: igual con `atvk-project:v1:…` y
  `ensureDestinationProject`. Cero cambios en atvk.
  - VERIFICAR en implementación (bootstrap-service.js): que la ruta de
    recuperación por marcador realmente adopte tareas no nacidas del propio
    atvk, y qué campos reescribe al adoptar (description es anytype_wins:
    atvk la regenerará desde el cuerpo del objeto + bloque de contexto —
    aceptable; el capturador puede copiar el texto original al objeto
    Anytype ANTES de marcar, para no perderlo).
- **Lado Mindwtr, gratis**: el bridge ya espeja las tareas Vikunja-nacidas
  del subtree (create_mirror por posición, sin preguntar a atvk), y su
  mapeo es por `vikunja_task_id`, que no cambia con la adopción → no
  necesita lógica nueva; la tarea pasa de ciudadana ⅔ a circuito completo
  retroactivamente.
- `capture_map` gana columna `origin IN ('mindwtr','vikunja')`; para el
  origen vikunja, `mindwtr_task_id` es NULL hasta que el bridge espeja.
- Detección: tarea pendiente del subtree cuyo `vikunja_task_id` no está en
  el `task_map` de atvk (lectura-solo ya requerida) ni en `capture_map`.
  Dar un ciclo de gracia (~5 min de antigüedad) para no capturar tareas que
  atvk esté a punto de crear él mismo en su bootstrap.

## Decisiones y límites

- **Proyectos vacíos**: atvk solo materializa un proyecto en Vikunja cuando
  una tarea lo referencia. Un proyecto capturado sin tareas existirá en
  Anytype pero no aparecerá en Vikunja/espejo hasta su primera tarea.
  Documentar; no es bug.
- **Borrado antes de la adopción**: si el usuario borra la tarea capturada
  en Mindwtr antes de adoptarla, la captura NO se revierte (el objeto ya
  vive en Anytype); tras la adopción aplica la regla normal (`dismissed`).
- **Un solo sentido**: la captura es un acto único; después la tarea es un
  espejo normal regido por el contrato v1.
- **Idempotencia**: si el ciclo muere entre crear en Anytype y grabar
  `capture_map`, el reintento crearía un duplicado → grabar `capture_map`
  ANTES de crear (estado con `anytype_object_id` NULL) o usar un marcador
  de procedencia en el objeto (patrón atvk). Decidir en implementación.
- **Qué NO hace**: mover/renombrar/borrar vía API de Anytype; sincronizar
  descripciones; nada continuo contra Anytype.

## Verificación (cuando se implemente)

Piloto: capturar 1 tarea en un proyecto espejo y 1 proyecto en un área
espejo → verificar objeto en Anytype con propiedades correctas → adopción
sin espejo duplicado → circuito completo (estado GTD, done) → `retire-task`
+ borrado del objeto para revertir.
