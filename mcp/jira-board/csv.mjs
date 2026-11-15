// Writes CSV the way Deadline Séance's importer reads it (RFC 4180, comma, CRLF, no byte order mark).
// This is a file format, not the rule: the importer itself lives in the vendored Deadline Séance server.

/** The header Deadline Séance writes on export and reads on import (EXPORT_HEADERS in src/engine/csv.ts). */
export const HEADERS = [
  'Issue key',
  'Summary',
  'Story Points',
  'Value',
  'Urgency',
  'Risk',
  'Cost of Delay',
  'Must Have',
  'Depends On',
  'Times Postponed',
  'Fix Version/s',
  'Resolution',
];

/** One leading apostrophe on a text a spreadsheet would read as a formula; the importer takes it back. */
export function guardCell(text) {
  return /^'*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Replaces lone UTF-16 surrogates with U+FFFD. */
function wellFormed(text) {
  return typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
}

export function serializeCsv(records) {
  let out = '';
  records.forEach((record, r) => {
    out += record
      .map((raw, c) => {
        const field = wellFormed(String(raw));
        const hint = r === 0 && c === 0 && /^sep=/i.test(field);
        const special = /[,;"\r\n]/.test(field) || field.startsWith(' ') || field.endsWith(' ') || hint;
        return special ? `"${field.replace(/"/g, '""')}"` : field;
      })
      .join(',');
    out += '\r\n';
  });
  return out;
}
