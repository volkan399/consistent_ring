# Consistent Ring

Consistent hashing with virtual nodes for stable key-to-node assignment in JavaScript (ESM).

```js
import { ConsistentRing } from 'consistent-ring';

const ring = new ConsistentRing({ replicas: 160 });
ring.add('cache-a');
ring.add('cache-b');
ring.add('cache-c');

const primary = ring.get('user:42');        // -> 'cache-b'
const [p1, p2] = ring.getReplicas('user:42', 2); // -> ['cache-b', 'cache-a']

ring.remove('cache-b');
ring.get('user:42'); // now resolves to another existing node
```

Exports: `ConsistentRing` (class) and `defaultHash` (the built-in FNV-1a 32-bit hash).

## Why this exists

When you shard data or route requests across a set of nodes, a naive `hash(key) % N` mapping remaps nearly every key whenever `N` changes. Consistent hashing limits the churn: adding or removing one node only moves the keys that node was responsible for. Virtual nodes (replicas) spread each physical node across the ring so a small cluster still balances load.

The trade-off here is simplicity over scale. The ring is a flat sorted array with binary-search lookup — O(log n) per `get`, O(n) per `add`/`remove`. That is fine up to a few hundred thousand virtual-node entries. Past that you would want a tree, which this library does not provide.

The hash function is injectable. The default is a dependency-free FNV-1a 32-bit hash. If you need cryptographic properties or cross-language parity, pass your own `(key: string) => number`.

## Edge cases worth knowing

- `get()` returns `undefined` when the ring is empty. This is intentional — a drained ring is a normal state during shutdown — so callers must handle it.
- Node identifiers must not contain `#`. The library keys virtual nodes as `"<node>#<i>"`; a node literally named `a#3` would collide with replica 3 of node `a`. There is no escaping.
- `getReplicas(key, count)` returns at most `min(count, physicalNodeCount)` distinct nodes, never duplicates.
- Hash collisions (two virtual nodes landing on the same hash) are tolerated: the ring stores both entries and lookup picks the first by position.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

