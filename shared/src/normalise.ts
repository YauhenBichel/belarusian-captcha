// The answer normaliser of docs/DESIGN.md section 3.3. Both sides of a comparison are folded,
// so a visitor on a Russian, Ukrainian, Polish or English keyboard can still type the answer.
// The same table is in tests/fixtures/normalise.json for the Python content pipeline.
//
// Step 8 (Łacinka input transliterated to Cyrillic) is phase 2 work, with the typed-word
// challenge: until then a word written only in Latin letters is left as it is.

const STRESS_MARKS = /[̀́]/g; // combining grave and acute
const APOSTROPHES = /['’ʼ‘`ʹъ]/g; // ' ’ ʼ ‘ ` ʹ and Russian ъ
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN_LOOKALIKES: Record<string, string> = {
  a: 'а',
  e: 'е',
  i: 'і',
  o: 'о',
  p: 'р',
  c: 'с',
  x: 'х',
  y: 'у',
};

/** Folds an answer for comparison. Never shown to anyone. */
export function normaliseAnswer(input: string): string {
  // 1. Unicode NFC, trim, collapse spaces.
  let s = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  // 2. Remove stress marks (decompose so marks on precomposed letters go too, then recompose).
  s = s.normalize('NFD').replace(STRESS_MARKS, '').normalize('NFC');
  // 3. Lower case with the Belarusian locale.
  s = s.toLocaleLowerCase('be');
  // 4. One apostrophe for every apostrophe-like mark and Russian ъ.
  s = s.replace(APOSTROPHES, "'");
  // 5. ў -> у (a keyboard without ў).
  s = s.replace(/ў/g, 'у');
  // 6. Russian keyboard: и -> і, щ -> шч.
  s = s.replace(/и/g, 'і').replace(/щ/g, 'шч');
  // 7. Latin look-alikes -> Cyrillic, inside words that already contain Cyrillic (mixed script).
  s = s
    .split(' ')
    .map((word) =>
      CYRILLIC.test(word) ? word.replace(/[aeiopcxy]/g, (ch) => LATIN_LOOKALIKES[ch] ?? ch) : word,
    )
    .join(' ');
  // 8. (phase 2) Łacinka -> Cyrillic.
  // 9. ё -> е, for comparison only.
  s = s.replace(/ё/g, 'е');
  return s;
}

export function answersMatch(given: string, expected: string): boolean {
  return normaliseAnswer(given) === normaliseAnswer(expected);
}
