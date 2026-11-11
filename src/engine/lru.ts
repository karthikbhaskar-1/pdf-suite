/**
 * Size-aware LRU map. `set` records the size of each value, and entries are evicted
 * from the least recently used end until the total fits the capacity.
 */
export class SizedLru<V> {
  private readonly map = new Map<string, { value: V; size: number }>();
  /** Values that eviction must skip, with the number of holders of each. */
  private readonly pins = new Map<V, number>();
  /** Values removed (replaced or deleted) while pinned, with their key. Released when the last pin goes. */
  private readonly released = new Map<V, string>();
  /** Pinned values a deleteWhere wanted gone, with their key. They are removed when their last pin goes. */
  private readonly doomed = new Map<V, string>();
  private total = 0;

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V, size: number): void {
    const previous = this.map.get(key);
    if (previous) {
      this.total -= previous.size;
      this.map.delete(key);
      // A replaced value is gone for good, so it is released the same way an eviction releases it.
      if (previous.value !== value) this.release(key, previous.value);
    }
    this.map.set(key, { value, size });
    this.total += size;
    this.trim();
  }

  /**
   * Keeps a value from eviction until every pin on it is released. A pinned value may take the total over capacity.
   * Pins are counted, so two holders can pin the same value.
   */
  pin(value: V): void {
    this.pins.set(value, (this.pins.get(value) ?? 0) + 1);
  }

  unpin(value: V): void {
    const count = this.pins.get(value) ?? 0;
    if (count > 1) {
      this.pins.set(value, count - 1);
      return;
    }
    this.pins.delete(value);
    // A pinned value that a deleteWhere skipped is removed now, unless its key was reused for another value meanwhile.
    const doomedKey = this.doomed.get(value);
    if (doomedKey !== undefined) {
      this.doomed.delete(value);
      if (this.map.get(doomedKey)?.value === value) this.delete(doomedKey);
    }
    // A value that was removed while pinned is released now, and a value that stayed over capacity is trimmed.
    const key = this.released.get(value);
    if (key !== undefined) {
      this.released.delete(value);
      this.onEvict?.(key, value);
    }
    this.trim();
  }

  isPinned(value: V): boolean {
    return this.pins.has(value);
  }

  /**
   * Removes every entry whose key matches, releasing each as an eviction does. A pinned entry is kept while it is
   * pinned (a caller that drops a value someone is still holding would release it under them), and is removed when
   * its last pin is released, so a stale value cannot outlive the screen that held it.
   */
  deleteWhere(predicate: (key: string, size: number) => boolean): void {
    for (const key of [...this.map.keys()]) {
      const entry = this.map.get(key);
      if (!entry) continue;
      if (!predicate(key, entry.size)) continue;
      if (this.pins.has(entry.value)) this.doomed.set(entry.value, key);
      else this.delete(key);
    }
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.size;
    this.release(key, entry.value);
  }

  /**
   * Releases a value that left the map. A pinned value is held until its last pin is dropped: its holder is still
   * drawing it, so closing it now would leave that holder with a dead bitmap.
   */
  private release(key: string, value: V): void {
    if (this.pins.has(value)) {
      this.released.set(value, key);
      return;
    }
    this.onEvict?.(key, value);
  }

  /** Every entry with its value and size, least recently used first. For memory reports. */
  *entries(): IterableIterator<[string, V, number]> {
    for (const [key, entry] of this.map) yield [key, entry.value, entry.size];
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Evicts the oldest unpinned entries until the total is within capacity. The newest entry is always kept, and a
   * pinned entry is never evicted.
   */
  private trim(): void {
    if (this.total <= this.capacity) return;
    // The newest entry is last in the map, so it is never the one dropped here.
    const newest = [...this.map.keys()].at(-1);
    for (const [key, entry] of [...this.map]) {
      if (this.total <= this.capacity || this.map.size <= 1) return;
      if (key === newest || this.pins.has(entry.value)) continue;
      this.delete(key);
    }
  }
}

export interface SizedEntry {
  key: string;
  size: number;
  lastUsed: number;
}

/**
 * Chooses which keys to evict so that the remaining total fits `capacity`.
 * Oldest `lastUsed` goes first. Used by the persisted file cache.
 */
export function selectEvictions(entries: readonly SizedEntry[], capacity: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  let remaining = total;
  const evict: string[] = [];
  const byAge = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of byAge) {
    if (remaining <= capacity) break;
    evict.push(entry.key);
    remaining -= entry.size;
  }
  return evict;
}
