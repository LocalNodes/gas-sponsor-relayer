// The pass rule is one function, shared in meaning with PHP: passed <=> closed, final, scores_total >= quorum and
// For > Against, Abstain counting toward the quorum (GOV-04). Every case comes from the shared vector file.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { passed } from '../../src/passRule.js';

const vector = JSON.parse(readFileSync(new URL('../fixtures/vectors/pass-rule.json', import.meta.url), 'utf8'));

describe('pass-rule', () => {
  test('pass-rule: the vector file holds the rule text and the edges', () => {
    assert.ok(vector.cases.length >= 12);
    for (const edge of ['total equal to quorum passes', 'total one below quorum fails', 'For equal to Against fails', 'Abstain counts toward quorum', 'closed with empty scores never passes']) {
      assert.ok(vector.cases.some((c) => c.name === edge), edge);
    }
  });

  for (const c of vector.cases) {
    test(`pass-rule: ${c.name}`, () => {
      assert.deepEqual(passed(c.input), c.expected);
    });
  }

  test('pass-rule: anything that is not a plain finite number never passes', () => {
    const base = { state: 'closed', scores_state: 'final', scores: [3, 1, 0], scores_total: 4, quorum: 4 };
    assert.equal(passed(base).passed, true);
    for (const patch of [
      { scores: ['3', 1, 0] },
      { scores: [3, null, 0] },
      { scores: [Number.NaN, 1, 0] },
      { scores_total: '4' },
      { scores_total: Number.NaN },
      { quorum: undefined },
      { quorum: '4' },
      { scores: 'not an array' },
    ]) {
      assert.equal(passed({ ...base, ...patch }).passed, false, JSON.stringify(patch));
    }
  });

  test('pass-rule: a missing proposal object never passes', () => {
    assert.equal(passed(null).passed, false);
    assert.equal(passed(undefined).passed, false);
    assert.equal(passed({}).passed, false);
  });
});
