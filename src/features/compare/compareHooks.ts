/**
 * The three events of the document registry that a Compare session follows: the document was replaced (a save opened the saved
 * bytes in a new worker), re-keyed (Save As) or closed. The registry's owner (app/services.ts) calls these; compareSession.ts
 * registers the real handlers when it loads. They live apart, with no imports, so that services.ts does not import the
 * session (which imports services: a cycle that left a constant used before it was set when the app started).
 */
export interface CompareHooks {
  replaced: (docId: string) => void;
  rekeyed: (oldId: string, newId: string) => void;
  closed: (docId: string) => void;
}

const nothing = (): void => undefined;

export const compareHooks: CompareHooks = { replaced: nothing, rekeyed: nothing, closed: nothing };
