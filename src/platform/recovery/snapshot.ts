import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { Pane, SplitOrientation, Tab, ViewRotation, ViewState, FitMode } from '../../core/model/types';
import { clampSplitRatio } from '../../features/split/syncMath';
import { CACHE_TIMEOUT_MS, withDeadline } from './fileCache';

/**
 * What survives a crash: tab order, where each file lives, and where each pane was looking.
 * Path origins store only the path. Byte origins store the document id, which is the key of the
 * file in the IndexedDB cache. Passwords are never stored.
 */
export type SnapshotOrigin = { kind: 'path'; path: string } | { kind: 'bytes'; docId: string };

export interface SnapshotSplit {
  orientation: SplitOrientation;
  ratio: number;
  syncScroll: boolean;
  /** The second pane. Its file may differ from the tab's file. */
  second: { title: string; origin: SnapshotOrigin; view: ViewState };
}

export interface SnapshotTab {
  title: string;
  origin: SnapshotOrigin;
  view: ViewState;
  /** Present when the tab was split and the second pane's file is known. */
  split?: SnapshotSplit;
}

export interface Snapshot {
  version: 1;
  activeIndex: number;
  tabs: SnapshotTab[];
}

const FIT_MODES: readonly FitMode[] = ['none', 'width', 'page'];
const ROTATIONS: readonly ViewRotation[] = [0, 90, 180, 270];
const ORIENTATIONS: readonly SplitOrientation[] = ['horizontal', 'vertical'];

function viewOf(pane: Pane): ViewState {
  const v = pane.view;
  return { pageId: v.pageId, zoom: v.zoom, fit: v.fit, offset: v.offset, rotation: v.rotation };
}

function originOfTab(tab: Tab): SnapshotOrigin {
  const pane = tab.panes[0];
  return tab.origin.kind === 'path'
    ? { kind: 'path', path: tab.origin.path }
    : { kind: 'bytes', docId: pane?.docId ?? '' };
}

/**
 * Where a document can be reopened from: the first ready tab that shows it. Returns undefined when
 * no ready tab shows it, so the split is left out rather than restored half-way.
 */
function sourceForDoc(docId: string, tabs: readonly Tab[]): { title: string; origin: SnapshotOrigin } | undefined {
  const tab = tabs.find((t) => t.panes[0]?.docId === docId);
  return tab ? { title: tab.title, origin: originOfTab(tab) } : undefined;
}

const DEFAULT_VIEW: ViewState = { pageId: null, zoom: 1, fit: 'width', offset: 0, rotation: 0 };

/**
 * Tabs that belong in the snapshot. A path tab is always kept, whatever its state, so a file that
 * failed to open (moved or deleted) comes back as a tab showing its message, and does not vanish.
 * A byte tab can only be restored from the file cache, so it is kept only while it is open.
 */
function isRestorable(tab: Tab): boolean {
  if (tab.origin.kind === 'path') return true;
  return tab.status.kind === 'ready' && tab.panes[0] !== undefined;
}

export function buildSnapshot(tabs: readonly Tab[], activeTabId: string | null): Snapshot {
  const restorable = tabs.filter(isRestorable);
  const snapshotTabs: SnapshotTab[] = restorable.map((t) => {
    const first = t.panes[0];
    const entry: SnapshotTab = { title: t.title, origin: originOfTab(t), view: first ? viewOf(first) : { ...DEFAULT_VIEW } };
    const second = t.panes[1];
    if (first && t.split && second) {
      const source = sourceForDoc(second.docId, restorable);
      if (source) {
        entry.split = {
          orientation: t.split.orientation,
          ratio: t.split.ratio,
          syncScroll: t.split.syncScroll,
          second: { title: source.title, origin: source.origin, view: viewOf(second) },
        };
      }
    }
    return entry;
  });
  const active = restorable.findIndex((t) => t.id === activeTabId);
  return { version: 1, activeIndex: active < 0 ? 0 : active, tabs: snapshotTabs };
}

function parseOrigin(value: unknown): SnapshotOrigin | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (o.kind === 'path' && typeof o.path === 'string') return { kind: 'path', path: o.path };
  if (o.kind === 'bytes' && typeof o.docId === 'string') return { kind: 'bytes', docId: o.docId };
  return null;
}

function parseView(value: unknown): ViewState {
  const v = (value ?? {}) as Partial<ViewState>;
  return {
    pageId: typeof v.pageId === 'string' ? v.pageId : null,
    zoom: typeof v.zoom === 'number' && Number.isFinite(v.zoom) ? v.zoom : 1,
    fit: v.fit && FIT_MODES.includes(v.fit) ? v.fit : 'width',
    offset: typeof v.offset === 'number' && Number.isFinite(v.offset) ? v.offset : 0,
    rotation: ROTATIONS.includes(v.rotation as ViewRotation) ? (v.rotation as ViewRotation) : 0,
  };
}

function parseSplit(value: unknown): SnapshotSplit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Record<string, unknown>;
  const second = (s.second ?? {}) as Record<string, unknown>;
  const origin = parseOrigin(second.origin);
  if (!ORIENTATIONS.includes(s.orientation as SplitOrientation) || !origin || typeof second.title !== 'string') {
    return undefined;
  }
  return {
    orientation: s.orientation as SplitOrientation,
    ratio: typeof s.ratio === 'number' && Number.isFinite(s.ratio) ? clampSplitRatio(s.ratio) : 0.5,
    syncScroll: s.syncScroll === true,
    second: { title: second.title, origin, view: parseView(second.view) },
  };
}

/** Checks the shape of a stored snapshot. Anything unexpected is dropped rather than trusted. */
export function parseSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Snapshot>;
  if (raw.version !== 1 || !Array.isArray(raw.tabs)) return null;
  const tabs: SnapshotTab[] = [];
  for (const item of raw.tabs as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const origin = parseOrigin(t.origin);
    if (typeof t.title !== 'string' || !origin) continue;
    const entry: SnapshotTab = { title: t.title, origin, view: parseView(t.view) };
    const split = parseSplit(t.split);
    if (split) entry.split = split;
    tabs.push(entry);
  }
  const activeIndex = typeof raw.activeIndex === 'number' ? raw.activeIndex : 0;
  return { version: 1, activeIndex, tabs };
}

let store: UseStore | null = null;
const getStore = (): UseStore => (store ??= createStore('pdf-suite', 'session'));
const SNAPSHOT_KEY = 'snapshot';
/** Where a new snapshot is written before it replaces the current one. See saveSnapshot. */
const PENDING_KEY = 'snapshot-pending';

/**
 * Writes the snapshot as a temp record first, then swaps it in as the current record, then removes
 * the temp record. A process killed between the steps leaves the complete new record under the
 * pending key, and loadSnapshot prefers it. A write cut short never replaces a good record.
 */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  try {
    const db = getStore();
    await set(PENDING_KEY, snapshot, db);
    await set(SNAPSHOT_KEY, snapshot, db);
    await del(PENDING_KEY, db);
  } catch {
    // Storage may be unavailable. Recovery is best effort.
  }
}

async function readLatest(): Promise<Snapshot | null> {
  const db = getStore();
  // The pending record is only left behind by an interrupted save, and it is always the newest one attempted.
  const pending = parseSnapshot(await get(PENDING_KEY, db));
  if (pending) return pending;
  return parseSnapshot(await get(SNAPSHOT_KEY, db));
}

/** Reads the last session. A read that stalls counts as no session, so the restore cannot hang. */
export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    return await withDeadline(readLatest(), CACHE_TIMEOUT_MS, null);
  } catch {
    return null;
  }
}
