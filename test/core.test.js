import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsistentRing, defaultHash } from '../src/index.js';

// A tiny deterministic hash for tests that need to control ring layout.
// Maps each distinct string to a unique small integer by summing char codes.
// Not a good hash in general, but perfect for assertions about ordering.
function sumHash(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i);
  return n >>> 0;
}

test('defaultHash is deterministic and returns unsigned 32-bit ints', () => {
  const a = defaultHash('hello');
  const b = defaultHash('hello');
  assert.equal(a, b);
  assert.equal(typeof a, 'number');
  assert.ok(Number.isInteger(a));
  assert.ok(a >= 0 && a < 0x100000000);
});

test('constructor rejects non-positive replicas', () => {
  assert.throws(() => new ConsistentRing({ replicas: 0 }), RangeError);
  assert.throws(() => new ConsistentRing({ replicas: -1 }), RangeError);
  assert.throws(() => new ConsistentRing({ replicas: 1.5 }), RangeError);
});

test('constructor rejects bad hash option', () => {
  assert.throws(() => new ConsistentRing({ hash: 'nope' }), TypeError);
});

test('add rejects empty or non-string nodes', () => {
  const r = new ConsistentRing({ replicas: 4 });
  assert.throws(() => r.add(''), TypeError);
  assert.throws(() => r.add(123), TypeError);
});

test('add is idempotent', () => {
  const r = new ConsistentRing({ replicas: 4 });
  r.add('a');
  r.add('a');
  assert.equal(r.size, 1);
  assert.equal(r.ringSize, 4);
});

test('ringSize equals size * replicas', () => {
  const r = new ConsistentRing({ replicas: 5 });
  r.add('a');
  r.add('b');
  r.add('c');
  assert.equal(r.ringSize, 15);
});

test('get returns undefined on an empty ring', () => {
  const r = new ConsistentRing();
  assert.equal(r.get('any-key'), undefined);
});

test('get returns the only node when one is present', () => {
  const r = new ConsistentRing({ replicas: 8 });
  r.add('solo');
  for (const k of ['x', 'y', 'zzz', '']) {
    assert.equal(r.get(k), 'solo');
  }
});

test('get wraps around at the end of the ring', () => {
  // Use sumHash so we can reason about layout. With replicas:1 each node has
  // one entry. sumHash('a')=97, sumHash('b')=98, sumHash('c')=99.
  const r = new ConsistentRing({ replicas: 1, hash: sumHash });
  r.add('a'); r.add('b'); r.add('c');
  // A key whose hash exceeds the largest entry (99) must wrap to the first (97 -> 'a').
  // We craft a key that sums to > 99.
  assert.equal(r.get('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), 'a');
});

test('get is stable: same key always maps to same node', () => {
  const r = new ConsistentRing({ replicas: 20 });
  r.add('n1'); r.add('n2'); r.add('n3');
  const first = r.get('user:42');
  for (let i = 0; i < 50; i++) {
    assert.equal(r.get('user:42'), first);
  }
});

test('removing a node redistributes its keys among remaining nodes only', () => {
  const r = new ConsistentRing({ replicas: 40 });
  r.add('a'); r.add('b'); r.add('c');
  const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
  const before = new Map(keys.map((k) => [k, r.get(k)]));
  r.remove('b');
  assert.equal(r.size, 2);
  assert.equal(r.ringSize, 80);
  for (const k of keys) {
    const after = r.get(k);
    assert.notEqual(after, 'b');
    // Keys that were on 'b' move somewhere; keys that were on a/c stay put.
    if (before.get(k) !== 'b') {
      assert.equal(after, before.get(k));
    }
  }
});

test('remove is a no-op for unknown nodes', () => {
  const r = new ConsistentRing({ replicas: 4 });
  r.add('a');
  r.remove('nope');
  assert.equal(r.size, 1);
});

test('adding a node does not move keys already assigned to other nodes', () => {
  // With a fixed hash and replicas:1 we can check exactly which keys move.
  const r = new ConsistentRing({ replicas: 1, hash: sumHash });
  r.add('a'); r.add('c');
  const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
  const before = new Map(keys.map((k) => [k, r.get(k)]));
  r.add('b'); // inserts at hash 98, between a(97) and c(99)
  for (const k of keys) {
    const after = r.get(k);
    // A key only changes if the new node now owns its slot.
    if (after !== 'b') {
      assert.equal(after, before.get(k));
    }
  }
});

test('getReplicas returns distinct physical nodes in ring order', () => {
  const r = new ConsistentRing({ replicas: 4, hash: sumHash });
  r.add('a'); r.add('b'); r.add('c');
  const reps = r.getReplicas('some-key', 2);
  assert.equal(reps.length, 2);
  assert.equal(new Set(reps).size, 2);
  // Every returned name must be a real node.
  for (const n of reps) assert.ok(['a','b','c'].includes(n));
});

test('getReplicas caps at the number of physical nodes', () => {
  const r = new ConsistentRing({ replicas: 4 });
  r.add('a'); r.add('b');
  const reps = r.getReplicas('k', 5);
  assert.equal(reps.length, 2);
});

test('getReplicas returns empty array on empty ring', () => {
  const r = new ConsistentRing();
  assert.deepEqual(r.getReplicas('k', 3), []);
});

test('getReplicas rejects non-positive count', () => {
  const r = new ConsistentRing({ replicas: 2 });
  r.add('a');
  assert.throws(() => r.getReplicas('k', 0), RangeError);
  assert.throws(() => r.getReplicas('k', -1), RangeError);
});

test('nodes() returns insertion-order snapshot', () => {
  const r = new ConsistentRing({ replicas: 2 });
  r.add('x'); r.add('y'); r.add('z');
  assert.deepEqual(r.nodes(), ['x', 'y', 'z']);
  r.remove('y');
  assert.deepEqual(r.nodes(), ['x', 'z']);
});

test('initial nodes can be passed via constructor', () => {
  const r = new ConsistentRing({ replicas: 3, nodes: ['a', 'b'] });
  assert.equal(r.size, 2);
  assert.equal(r.ringSize, 6);
  assert.ok(['a', 'b'].includes(r.get('anything')));
});

test('distribution is reasonably balanced across nodes', () => {
  // Sanity check, not a strict guarantee of consistent hashing. With 5 nodes
  // and 160 replicas, no node should own more than 40% of 1000 keys.
  const r = new ConsistentRing({ replicas: 160 });
  r.add('n1'); r.add('n2'); r.add('n3'); r.add('n4'); r.add('n5');
  const counts = new Map();
  for (let i = 0; i < 1000; i++) {
    const n = r.get(`key-${i}`);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  for (const [, c] of counts) {
    assert.ok(c < 400, `node owned ${c}/1000 keys, expected < 400`);
  }
});

test('hash collisions do not crash and still return a valid node', () => {
  // Force every key to hash to the same value. The ring must still function.
  const r = new ConsistentRing({ replicas: 3, hash: () => 42 });
  r.add('a'); r.add('b');
  assert.equal(r.ringSize, 6);
  const got = r.get('anything');
  assert.ok(got === 'a' || got === 'b');
  const reps = r.getReplicas('anything', 2);
  assert.equal(reps.length, 2);
});
