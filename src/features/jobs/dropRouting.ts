/**
 * Files dropped on the main window (UI spec section 0, "Drops"). They still open as before. Two or more PDFs also get a toast that
 * offers Combine; pictures and text files cannot be opened on their own, so they get a toast that opens Combine with them listed.
 */
import type { DocumentSource } from '../../engine/types';
import type { InputType, JobInputInfo } from '../../platform/desktop/contract';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import { useUiStore } from '../../core/stores/uiStore';
import { openPicked } from '../documents/documentService';
import { openCombine } from './combineFlow';

export interface DropPlan {
  /** Paths opened in tabs, as always. */
  open: string[];
  /** The toast, when there is one: its message, the button and the paths Combine opens with. */
  toast: { message: string; label: string; combine: string[] } | null;
}

/** Decides what a drop does. `kinds` maps a path to what main says it is; a path main did not answer for counts as a PDF (it opens as before). */
export function planDrop(paths: readonly string[], kinds: ReadonlyMap<string, InputType>): DropPlan {
  const kindOf = (path: string): InputType => kinds.get(path) ?? 'pdf';
  const pictureOrText = paths.filter((p) => kindOf(p) === 'image' || kindOf(p) === 'text');
  const pdfs = paths.filter((p) => kindOf(p) === 'pdf');
  if (pictureOrText.length > 0) {
    return {
      open: paths.filter((p) => !pictureOrText.includes(p)),
      toast: { message: "Pictures and text files can't be opened on their own", label: 'Combine into a PDF…', combine: paths.filter((p) => pdfs.includes(p) || pictureOrText.includes(p)) },
    };
  }
  if (pdfs.length >= 2) return { open: [...paths], toast: { message: `Opened ${pdfs.length} files`, label: 'Combine them…', combine: pdfs } };
  return { open: [...paths], toast: null };
}

export const COMBINE_BUSY_TOAST = 'PDF Suite is still working on your files. Wait for it to finish, or cancel it.';

/** The button of a drop toast: opens Combine with the dropped files, or says why it cannot while a job runs. */
export function combineFromToast(paths: readonly string[], open: (paths: readonly string[]) => boolean = openCombine, say: (message: string) => void = (m) => useUiStore.getState().pushToast(m)): void {
  if (!open(paths)) say(COMBINE_BUSY_TOAST);
}

/** The drop handler of the app window. */
export async function routeDroppedSources(sources: DocumentSource[]): Promise<void> {
  const api = getDesktopBridge();
  const paths = sources.filter((s): s is Extract<DocumentSource, { kind: 'path' }> => s.kind === 'path').map((s) => s.path);
  if (!api || paths.length !== sources.length || paths.length < 1) {
    await openPicked(sources);
    return;
  }
  let infos: JobInputInfo[] = [];
  try {
    infos = await api.jobs.describeInputs(paths);
  } catch {
    infos = [];
  }
  const plan = planDrop(paths, new Map(infos.map((i) => [i.path, i.kind])));
  const bySource = new Map(sources.map((s) => [s.kind === 'path' ? s.path : '', s]));
  const toOpen = plan.open.map((p) => bySource.get(p)).filter((s): s is DocumentSource => s !== undefined);
  if (plan.toast) {
    const { combine } = plan.toast;
    useUiStore.getState().pushToast(plan.toast.message, { label: plan.toast.label, run: () => combineFromToast(combine) });
  }
  await openPicked(toOpen);
}
