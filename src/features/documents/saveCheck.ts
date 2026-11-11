import type { FileStat } from '../../platform/desktop/contract';

/**
 * The check a save makes before it writes (ticket 1.2.2, from the 1.2.1 sign-off): is the file on disk still the one the
 * app last saw? The disk watch looks only every few seconds, so a Save pressed right after another program changed the
 * file would otherwise write over that change without asking.
 *
 * True when a save must not write: the file was seen before and is still there, but its size or modified time differs.
 * Nothing seen, or a file that is gone, is not a reason to refuse: there is nothing of anyone else's to overwrite, and the
 * save puts the file back.
 */
export function changedBeforeSave(seen: FileStat | undefined, now: FileStat | null): boolean {
  if (seen === undefined || now === null) return false;
  return now.size !== seen.size || now.modified !== seen.modified;
}

/**
 * True when the file is not the one that was seen, for a reopen or the release of a worker (1.5.4): its size or modified time
 * differs, or, when both stamps carry a content sample, the sample does. Nothing seen, or a file that is gone, is not "changed"
 * here (the caller decides what a missing file means).
 */
export function changedSinceSeen(seen: FileStat | undefined, now: FileStat | null): boolean {
  if (seen === undefined || now === null) return false;
  if (now.size !== seen.size || now.modified !== seen.modified) return true;
  return seen.sample !== undefined && now.sample !== undefined && seen.sample !== now.sample;
}
