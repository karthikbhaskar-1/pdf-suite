let counter = 0;

/** Unique id for tabs and panes within one session. Not persisted across sessions. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
