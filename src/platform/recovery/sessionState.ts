let markRestored: () => void = () => undefined;
const restored = new Promise<void>((resolve) => {
  markRestored = resolve;
});

/**
 * Resolves once the last session has been restored (or found empty, or failed). Files opened from
 * outside the app wait for it, so restored tabs cannot take focus back from the file that was opened.
 */
export function whenSessionRestored(): Promise<void> {
  return restored;
}

/** Called by boot when the restore has finished. */
export function markSessionRestored(): void {
  markRestored();
}
