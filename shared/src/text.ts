/**
 * Display-text hygiene (SEC-8). Names, notes and event names typed by guests and hosts are shown
 * on other people's screens, so they must not carry characters that rewrite how the rest of the
 * line renders (bidi overrides and isolates), invisible characters that make two names look the
 * same or a name look blank, or control characters. Emoji sequences (ZWJ, ZWNJ, variation
 * selectors) and accents are kept.
 */
const STRIP = new RegExp(
  [
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', // controls except \t \n \r
    '\\u034F|\\u17B4|\\u17B5|[\\u00AD\\u061C\\u115F\\u1160\\u180E]', // soft hyphen, fillers, ALM
    '[\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u206F]', // ZWSP, marks, bidi, invisibles
    '[\\u2800\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB]', // blank-looking letters, BOM, annotations
    '[\\u{E0000}-\\u{E007F}]', // tag characters
  ].join('|'),
  'gu',
);

/** Line and paragraph separators, tabs and (unless multiline) newlines become spaces. */
const SPACES = /[\t\u2028\u2029]/g;

export function cleanText(value: string, opts: { multiline?: boolean } = {}): string {
  let out = value.replace(STRIP, '').replace(SPACES, ' ');
  out = opts.multiline ? out.replace(/\r\n?/g, '\n') : out.replace(/[\r\n]/g, ' ');
  return out;
}
