import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answersMatch, normaliseAnswer } from './normalise.js';

interface Case {
  step: number;
  input: string;
  expected: string;
  note?: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/normalise.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('normaliseAnswer (shared fixture, design section 3.3)', () => {
  it.each(fixture.cases.map((c) => [c.step, c.input, c.expected] as const))(
    'step %i: %j -> %j',
    (_step, input, expected) => {
      expect(normaliseAnswer(input)).toBe(expected);
    },
  );

  it('is idempotent on every fixture output', () => {
    for (const c of fixture.cases) expect(normaliseAnswer(c.expected)).toBe(c.expected);
  });
});

describe('answersMatch', () => {
  it('matches across the folded variants', () => {
    expect(answersMatch('сямъя', 'сям’я')).toBe(true);
    expect(answersMatch('  МО́ВА ', 'мова')).toBe(true);
  });

  it('does not match different letters', () => {
    expect(answersMatch('мова', 'мава')).toBe(false);
    expect(answersMatch('й', 'і')).toBe(false);
  });
});
