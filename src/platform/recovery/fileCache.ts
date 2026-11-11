import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import { selectEvictions } from '../../engine/lru';

/** Total bytes of file content kept for crash recovery. Least recently used files go first. */
export const FILE_CACHE_BYTES = 200 * 1024 * 1024;

export interface CachedFileInfo {
  docId: string;
  name: string;
  size: number;
  lastUsed: number;
}

const INDEX_KEY = 'file-index';
const fileKey = (docId: string) => `file:${docId}`;

let store: UseStore | null = null;
function getStore(): UseStore {
  store ??= createStore('pdf-suite', 'files');
  return store;
}

/**
 * Longest a cache call may take before it gives its fallback. Storage can stall without failing
 * (a blocked or busy database), and a restore waits on these reads, so a stall must not hang it.
 */
export const CACHE_TIMEOUT_MS = 20_000;

/** Storage can be unavailable (private windows, blocked site data). Every call then does nothing. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  const run = chain.then(async () => {
    try {
      return await task();
    } catch {
      return fallback;
    }
  });
  chain = run;
  return withDeadline(run, CACHE_TIMEOUT_MS, fallback);
}

/** Resolves with `value`, or with `fallback` if `value` has not settled within `ms`. Never rejects. */
export function withDeadline<T>(value: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    value.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function readIndex(): Promise<CachedFileInfo[]> {
  const value = await get<CachedFileInfo[]>(INDEX_KEY, getStore());
  return Array.isArray(value) ? value : [];
}

/** Stores a file's bytes, evicting the least recently used files to stay under the cap. */
export function putFile(docId: string, name: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > FILE_CACHE_BYTES) return Promise.resolve();
  return serial(async () => {
    const index = (await readIndex()).filter((e) => e.docId !== docId);
    index.push({ docId, name, size: bytes.byteLength, lastUsed: Date.now() });

    const evict = new Set(selectEvictions(
      index.map((e) => ({ key: e.docId, size: e.size, lastUsed: e.lastUsed })),
      FILE_CACHE_BYTES,
    ));
    for (const id of evict) await del(fileKey(id), getStore());
    const kept = index.filter((e) => !evict.has(e.docId));

    await set(INDEX_KEY, kept, getStore());
    await set(fileKey(docId), bytes, getStore());
  }, undefined);
}

/** Reads a cached file and marks it as recently used. Undefined if it is not cached. */
export function getFile(docId: string): Promise<Uint8Array | undefined> {
  return serial(async () => {
    const index = await readIndex();
    const entry = index.find((e) => e.docId === docId);
    if (!entry) return undefined;
    const bytes = await get<Uint8Array>(fileKey(docId), getStore());
    if (!bytes) return undefined;
    entry.lastUsed = Date.now();
    await set(INDEX_KEY, index, getStore());
    return bytes;
  }, undefined);
}

/** Recently cached files, newest first. */
export function listRecentFiles(limit: number): Promise<CachedFileInfo[]> {
  return serial(async () => {
    const index = await readIndex();
    return [...index].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit);
  }, []);
}
