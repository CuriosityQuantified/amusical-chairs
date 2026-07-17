import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, levenshtein, clusterAnswers } from '../shared/cluster.js';

test('normalizeAnswer: case, whitespace, punctuation, articles, plurals', () => {
  assert.equal(normalizeAnswer('  The   EGGS! '), 'egg');
  assert.equal(normalizeAnswer('an omelette'), 'omelette');
  assert.equal(normalizeAnswer('Pancakes'), 'pancake');
  assert.equal(normalizeAnswer('french fries'), 'french fry');
});

test('levenshtein basics', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('same', 'same'), 0);
});

test('clusterAnswers groups equivalent and near answers, splits distinct ones', () => {
  const clusters = clusterAnswers([
    { id: 'p1', answer: 'Eggs' },
    { id: 'p2', answer: 'egg' },
    { id: 'p3', answer: ' the eggs ' },
    { id: 'p4', answer: 'egss' },       // typo within distance 2
    { id: 'p5', answer: 'bacon' },
    { id: 'p6', answer: 'waffles' },
  ]);
  const eggCluster = clusters.find((c) => c.members.includes('p1'));
  assert.equal(eggCluster.size, 4);
  assert.ok(['p2', 'p3', 'p4'].every((id) => eggCluster.members.includes(id)));
  const bacon = clusters.find((c) => c.members.includes('p5'));
  assert.equal(bacon.size, 1);
  assert.equal(clusters.length, 3);
});

test('unique scoring follows 1000 / cluster size', () => {
  const clusters = clusterAnswers([
    { id: 'a', answer: 'toast' },
    { id: 'b', answer: 'Toast!' },
    { id: 'c', answer: 'cereal' },
  ]);
  const toast = clusters.find((c) => c.members.includes('a'));
  assert.equal(1000 / toast.size, 500);
  const cereal = clusters.find((c) => c.members.includes('c'));
  assert.equal(1000 / cereal.size, 1000);
});
