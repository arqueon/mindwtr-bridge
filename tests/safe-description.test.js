'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeDescriptionFromVikunja } = require('../src/safe-description');

test('conserva el contenido útil y elimina por completo el bloque técnico de atvk', () => {
  const input = [
    '<h2>Preparar mini servidor</h2>',
    '<p>Instalar <strong>actualizaciones</strong> &amp; verificar servicios.</p>',
    '<ul><li>Respaldar datos</li><li>Reiniciar</li></ul>',
    '<p><strong>Origen Anytype</strong></p>',
    '<p><a href="https://object.any.coop/invite/?inviteId=secret#invite_key">Abrir tarea original en Anytype</a></p>',
    '<p>URI local: <code>anytype://object?objectId=abc</code></p>',
    '<!-- atvk:v6 object=abc -->',
  ].join('');

  const result = safeDescriptionFromVikunja(input);
  assert.match(result, /Preparar mini servidor/);
  assert.match(result, /Instalar actualizaciones & verificar servicios/);
  assert.match(result, /- Respaldar datos/);
  assert.doesNotMatch(result, /object\.any\.coop|inviteId|invite_key|anytype:\/\/|atvk|Origen Anytype/i);
});

test('elimina capabilities aun sin el encabezado esperado y neutraliza HTML ejecutable', () => {
  const input = '<p>Nota válida</p><script>alert(1)</script>'
    + '<p>https://object.any.coop/invite/?inviteId=uno#invite_key=dos</p>'
    + '<p>anytype://object?objectId=abc</p><!-- secreto -->';
  const result = safeDescriptionFromVikunja(input);

  assert.equal(result, 'Nota válida');
  assert.doesNotMatch(result, /alert|object\.any\.coop|invite|anytype|secreto/i);
});

test('convierte HTML y Markdown básico a texto legible', () => {
  const input = '**Resumen**\n\n> Revisar [documento](https://example.org/doc)\n\n`código`';
  assert.equal(
    safeDescriptionFromVikunja(input),
    'Resumen\n\nRevisar documento (https://example.org/doc)\n\ncódigo',
  );
});

test('devuelve null para contenido vacío o puramente técnico', () => {
  assert.equal(safeDescriptionFromVikunja(''), null);
  assert.equal(safeDescriptionFromVikunja('<p><strong>Origen Anytype</strong></p><p>secreto</p>'), null);
});

test('una entidad numérica fuera de Unicode no interrumpe el saneamiento', () => {
  assert.equal(safeDescriptionFromVikunja('<p>Texto &#x110000;</p>'), 'Texto &#x110000;');
});
