import { canonicalPath } from '../../engine/canonicalPath';
import { sha256Hex } from '../../engine/documentRegistry';

/**
 * Which recovery log belongs to which file. A log is stored under a key, the SHA-256 of the file's path. One file can be
 * reached under two spellings of its path (forward or back slashes, repeated separators, a "." or ".." part, a different
 * letter case, a trailing separator), and each spelling used to give its own key, so a log written under one was not found
 * under the other. The key is now made from the canonical form of the path: the same normalisation the main process
 * uses for its path grants (pathGrants.grantKey), written here because the page cannot import Node's path module.
 *
 * Logs written before this change used the path exactly as typed. recoveryKeysFor lists both keys, canonical first, so a
 * restore can still find an old log and a clean-up removes both.
 */

export { canonicalPath };

/** The key of a log by the canonical form of the path. */
export function canonicalRecoveryKey(path: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalPath(path)));
}

/** The key an earlier version used: the path exactly as given. */
export function legacyRecoveryKey(path: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(path));
}

/** Every key a file's log may be under: the canonical key first, then the earlier one when it differs. */
export async function recoveryKeysFor(path: string): Promise<string[]> {
  const canonical = await canonicalRecoveryKey(path);
  const legacy = await legacyRecoveryKey(path);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}
