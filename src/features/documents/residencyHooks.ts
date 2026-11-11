/**
 * The two events of the document registry that the tab residency (tabResidency.ts) follows: a document got an engine (opened, or
 * opened again), and a document closed (its last reference was released). The registry's owner (app/services.ts) calls these;
 * tabResidency.ts registers the real handlers when it loads. They live apart, with no imports, so that services.ts does not
 * import the module that imports services (the same arrangement as features/compare/compareHooks.ts).
 */
export interface ResidencyHooks {
  opened: (docId: string) => void;
  closed: (docId: string) => void;
  /** A released document came back from a file that is not the one that was closed: what was read from the old file is stale. */
  changed: (docId: string) => void;
}

const nothing = (): void => undefined;

export const residencyHooks: ResidencyHooks = { opened: nothing, closed: nothing, changed: nothing };
