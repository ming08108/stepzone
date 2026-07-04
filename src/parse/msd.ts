/**
 * MSD tokenizer: turns `#TAG:v1:v2;` text into a flat list of values.
 *
 * A faithful port of ITGmania `MsdFile::ReadBuf` (src/MsdFile.cpp). See spec
 * doc 1 (§1.1). Semantics-free: it knows nothing about tag meanings.
 *
 * For a value written `#TAG:v1:v2;`, params[0] === "TAG" (leading `#` stripped),
 * params[1] === "v1", params[2] === "v2".
 */

export interface MsdValue {
  params: string[];
}

/** params[i], or "" when out of range (matches the engine's forgiving reads). */
export function param(value: MsdValue, i: number): string {
  return i < value.params.length ? value.params[i] : '';
}

/** The tag name (params[0]), upper-cased for case-insensitive dispatch. */
export function tagName(value: MsdValue): string {
  return (value.params.length > 0 ? value.params[0] : '').toUpperCase();
}

const TRAILING_WS = /\s+$/;

export function tokenizeMsd(text: string, unescape = true): MsdValue[] {
  const values: MsdValue[] = [];
  let current: string[] | null = null; // params of the value being read
  let acc = ''; // current param accumulator
  let reading = false;

  const pushParam = () => {
    if (current !== null) current.push(acc);
    acc = '';
  };
  const endValue = () => {
    if (current !== null) {
      pushParam();
      values.push({ params: current });
    }
    current = null;
    acc = '';
    reading = false;
  };
  const startValue = () => {
    current = [];
    acc = '';
    reading = true;
  };

  const isFirstNonWsOnLine = (idx: number): boolean => {
    for (let j = idx - 1; j >= 0; j--) {
      const ch = text[j];
      if (ch === '\n' || ch === '\r') return true;
      if (ch !== ' ' && ch !== '\t') return false;
    }
    return true; // start of buffer
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];

    // `//` line comment, inside or outside a value.
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue;
    }

    if (!reading) {
      if (ch === '#') {
        startValue();
        i++;
      } else if (unescape && ch === '\\') {
        i += 2; // skip the escape outside a value
      } else {
        i++; // nothing else is meaningful outside a value
      }
      continue;
    }

    // Reading a value.
    switch (ch) {
      case '#':
        if (isFirstNonWsOnLine(i)) {
          // Missing-semicolon recovery: this `#` starts a new tag.
          acc = acc.replace(TRAILING_WS, '');
          endValue();
          startValue();
        } else {
          acc += ch; // literal `#`
        }
        i++;
        break;
      case ':':
        pushParam();
        i++;
        break;
      case ';':
        endValue();
        i++;
        break;
      case '\\':
        if (unescape) {
          if (i + 1 < n) {
            acc += text[i + 1]; // next char is literal
            i += 2;
          } else {
            i++;
          }
        } else {
          acc += ch;
          i++;
        }
        break;
      default:
        acc += ch;
        i++;
        break;
    }
  }

  // EOF: a trailing `;` is optional.
  if (reading) endValue();

  return values;
}
