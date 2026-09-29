/**
 * ConsistentRing — consistent hashing with virtual nodes.
 *
 * Design decisions (stated plainly so the tests and README agree):
 *
 * 1. Hash function is injectable. The default is a synchronous FNV-1a 32-bit
 *    hash returning an unsigned integer in [0, 2^32). Callers may pass any
 *    function (key: string) => number. This keeps the library dependency-free
 *    and makes tests deterministic without mocking crypto.
 *
 * 2. Replicas (virtual nodes) default to 160. Each physical node contributes
 *    `replicas` entries on the ring, keyed as `node#i` for i in [0, replicas).
 *    The `#` separator is deliberate: it is illegal in typical node identifiers
 *    (hostnames, ip:port strings) and avoids collisions between a node named
 *    "a#3" and node "a" replica 3. We do not attempt to escape user-chosen `#`
 *    in node names; callers should not use `#` in node identifiers.
 *
 * 3. The ring is a sorted array of {hash, node} entries. Lookup is binary
 *    search. This is O(log n) per lookup and O(n log n) to build, which is
 *    fine for rings up to a few hundred thousand entries. For larger rings a
 *    tree would help, but that is out of scope.
 *
 * 4. remove() is O(n) because it filters the array. This is intentional:
 *    removals are rare relative to lookups, and keeping the data structure a
 *    flat sorted array makes the common path (get) simple and fast.
 *
 * 5. When the ring is empty, get() returns undefined. Callers must handle this.
 *    We do not throw because "no node for this key" is a legitimate runtime
 *    state for a ring that has been drained.
 */

/**
 * Default hash: FNV-1a, 32-bit.
 *
 * We use FNV-1a rather than e.g. a simple polynomial hash because it distributes
 * well for short strings (like "node#42") and has no external dependencies.
 * The output is forced into an unsigned 32-bit integer with `>>> 0` so that
 * comparisons and binary search behave consistently regardless of the engine's
 * internal int representation.
 *
 * @param {string} key
 * @returns {number}
 */
export function defaultHash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    // FNV prime multiplication. Math.imul gives correct 32-bit multiply in JS
    // without floating-point precision loss.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @typedef {{ hash: number, node: string }} RingEntry
 */

export class ConsistentRing {
  /**
   * @param {object} [opts]
   * @param {number} [opts.replicas=160] Virtual nodes per physical node.
   * @param {(key: string) => number} [opts.hash] Hash function for keys and nodes.
   * @param {Iterable<string>} [opts.nodes] Initial set of physical nodes.
   */
  constructor(opts = {}) {
    const replicas = opts.replicas ?? 160;
    if (!Number.isInteger(replicas) || replicas <= 0) {
      throw new RangeError('replicas must be a positive integer');
    }
    const hash = opts.hash ?? defaultHash;
    if (typeof hash !== 'function') {
      throw new TypeError('hash must be a function');
    }

    this._replicas = replicas;
    this._hash = hash;
    /** @type {RingEntry[]} */
    this._ring = [];
    /** @type {Set<string>} */
    this._nodes = new Set();

    if (opts.nodes) {
      for (const n of opts.nodes) this.add(n);
    }
  }

  /**
   * Number of physical nodes currently on the ring.
   * @returns {number}
   */
  get size() {
    return this._nodes.size;
  }

  /**
   * Total number of virtual-node entries on the ring.
   * Equal to size * replicas unless the ring is empty.
   * @returns {number}
   */
  get ringSize() {
    return this._ring.length;
  }

  /**
   * Add a physical node. Idempotent: adding a node already present is a no-op.
   * @param {string} node
   */
  add(node) {
    if (typeof node !== 'string' || node.length === 0) {
      throw new TypeError('node must be a non-empty string');
    }
    if (this._nodes.has(node)) return;
    this._nodes.add(node);
    const newEntries = [];
    for (let i = 0; i < this._replicas; i++) {
      newEntries.push({ hash: this._hash(`${node}#${i}`), node });
    }
    // Merge the new entries into the already-sorted ring in O(n). We rebuild
    // the array rather than splicing each entry because repeated splice is O(n^2).
    if (this._ring.length === 0) {
      newEntries.sort((a, b) => a.hash - b.hash);
      this._ring = newEntries;
      return;
    }
    newEntries.sort((a, b) => a.hash - b.hash);
    const merged = new Array(this._ring.length + newEntries.length);
    let i = 0, j = 0, k = 0;
    while (i < this._ring.length && j < newEntries.length) {
      merged[k++] = this._ring[i].hash <= newEntries[j].hash
        ? this._ring[i++]
        : newEntries[j++];
    }
    while (i < this._ring.length) merged[k++] = this._ring[i++];
    while (j < newEntries.length) merged[k++] = newEntries[j++];
    this._ring = merged;
  }

  /**
   * Remove a physical node and all its virtual nodes.
   * No-op if the node is not present.
   * @param {string} node
   */
  remove(node) {
    if (!this._nodes.has(node)) return;
    this._nodes.delete(node);
    this._ring = this._ring.filter((e) => e.node !== node);
  }

  /**
   * Find the physical node responsible for `key`.
   *
   * Returns undefined if the ring is empty. We considered throwing, but a
   * drained ring is a normal operational state during shutdown and callers
   * are better placed to decide whether "no node" is an error.
   *
   * @param {string} key
   * @returns {string|undefined}
   */
  get(key) {
    if (this._ring.length === 0) return undefined;
    const h = this._hash(key);
    // Binary search for the first entry with hash >= h.
    let lo = 0, hi = this._ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    // Wrap around: if every entry has hash < h, the key belongs to the first entry.
    const idx = lo === this._ring.length ? 0 : lo;
    return this._ring[idx].node;
  }

  /**
   * Return up to `count` distinct physical nodes responsible for `key`,
   * in ring order starting at the first match. Used for replication where
   * you want the primary plus fallbacks.
   *
   * Returns fewer than `count` entries if the ring has fewer physical nodes.
   * Returns an empty array if the ring is empty.
   *
   * @param {string} key
   * @param {number} count
   * @returns {string[]}
   */
  getReplicas(key, count) {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError('count must be a positive integer');
    }
    if (this._ring.length === 0) return [];
    const max = Math.min(count, this._nodes.size);
    const h = this._hash(key);
    let lo = 0, hi = this._ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    const result = [];
    const seen = new Set();
    let idx = lo === this._ring.length ? 0 : lo;
    // Walk the ring, collecting distinct physical nodes. We cap iterations at
    // ring.length to guarantee termination even if (hypothetically) the ring
    // held duplicate entries.
    for (let step = 0; step < this._ring.length && result.length < max; step++) {
      const node = this._ring[idx].node;
      if (!seen.has(node)) {
        seen.add(node);
        result.push(node);
      }
      idx = (idx + 1) % this._ring.length;
    }
    return result;
  }

  /**
   * Snapshot of the current physical node set. Order is insertion order.
   * @returns {string[]}
   */
  nodes() {
    return Array.from(this._nodes);
  }
}
