'use strict';

// Las descripciones de Vikunja pueden contener HTML útil y, al final, el
// bloque técnico que atvk agrega para volver a Anytype. Ese bloque incluye
// una invitación/capability del Space y nunca debe salir de Sinope.

const MAX_DESCRIPTION_LENGTH = 60000;

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
});

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) {
        const codePoint = Number.parseInt(lower.slice(2), 16);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (lower.startsWith('#')) {
        const codePoint = Number.parseInt(lower.slice(1), 10);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return NAMED_ENTITIES[lower] ?? match;
    },
  );
}

function cutAtAnytypeSourceBlock(value) {
  const htmlMarker = /<p\b[^>]*>\s*<strong\b[^>]*>\s*Origen\s+Anytype\s*<\/strong>\s*<\/p>/i;
  const htmlMatch = htmlMarker.exec(value);
  if (htmlMatch) return value.slice(0, htmlMatch.index);

  const markdownMarker = /(?:^|\n)\s*(?:\*\*)?Origen\s+Anytype(?:\*\*)?\s*:?[ \t]*(?:\n|$)/i;
  const markdownMatch = markdownMarker.exec(value);
  return markdownMatch ? value.slice(0, markdownMatch.index) : value;
}

function removeCapabilityMaterial(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["'][^"']*(?:object\.any\.coop|anytype:)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<code\b[^>]*>[^<]*(?:object\.any\.coop|anytype:|inviteId=|invite_key=)[^<]*<\/code>/gi, '')
    .replace(/https?:\/\/object\.any\.coop\/[^\s<>"']*/gi, '')
    .replace(/anytype:\/\/[^\s<>"']*/gi, '')
    .replace(/\b(?:inviteId|invite_key)=[^\s&#<>"']+/gi, '');
}

function htmlToPlainText(value) {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n---\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|pre|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

function markdownToPlainText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')
    .replace(/(^|\n)[ \t]*>[ \t]?/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1$2');
}

function normalizePlainText(value) {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);
}

function safeDescriptionFromVikunja(description) {
  const source = String(description ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return null;

  const withoutSourceBlock = cutAtAnytypeSourceBlock(source);
  const withoutCapabilities = removeCapabilityMaterial(withoutSourceBlock);
  const plain = markdownToPlainText(decodeHtmlEntities(htmlToPlainText(withoutCapabilities)));
  return normalizePlainText(plain) || null;
}

module.exports = {
  MAX_DESCRIPTION_LENGTH,
  decodeHtmlEntities,
  safeDescriptionFromVikunja,
};
