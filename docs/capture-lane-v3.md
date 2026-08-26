# Carril de captura v3 — Mindwtr → Vikunja → Anytype

El bridge no se conecta a la API ni a la base de datos de Anytype. Una tarea o
un proyecto nuevo dentro de un área administrada de Mindwtr se crea primero en
Vikunja; ATVK lo incorpora después a Anytype.

```text
Mindwtr
  → mindwtr-bridge crea en Vikunja
  → ATVK adopta desde Vikunja
  → Anytype
  → ATVK distribuye los cambios posteriores
```

## Identidad e idempotencia

- `capture_map` se reserva antes de escribir en Vikunja.
- La descripción lleva un marcador
  `<!-- mindwtr-vikunja:v1:<kind>:<uuid> -->`.
- Si una llamada a Vikunja tuvo éxito pero el proceso cayó antes de cerrar la
  fila, el ciclo siguiente recupera el objeto por ese marcador.
- La tarea Vikunja se enlaza al UUID Mindwtr original; no nace un segundo
  espejo.
- ATVK añade después su propio marcador. El bridge lo conserva en
  `task_map.provenance_marker`; si Vikunja cambia el ID de una tarea al borrar
  un proyecto, el mismo espejo se reasigna por marcador.

## Alcance

- Los proyectos Mindwtr sólo se capturan si pertenecen a un área mapeada al
  contenedor de un Space bajo `ANYTYPE`.
- Las tareas con proyecto se crean en ese proyecto Vikunja.
- Las tareas con área y sin proyecto se crean en `00 · Sin proyecto`.
- Las tareas personales permanecen fuera.
- Campos y etiquetas terminan de converger mediante los ciclos ordinarios;
  Anytype nunca recibe una escritura directa desde este repositorio.

## Retiro del carril v2

`anytype-api-key`, `anytype_api_url`, `anytype_api_version` y `atvk_db_name`
ya no forman parte de la configuración del bridge. Las columnas Anytype de
`capture_map` se conservan sólo como historia de las capturas v2 previas.
