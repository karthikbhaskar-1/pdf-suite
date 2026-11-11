import { useUiStore } from '../core/stores/uiStore';
import { getDesktopBridge } from './desktop/bridge';

/**
 * Puts text on the clipboard. The desktop app writes through the main process, because the page is
 * not granted clipboard permission there. Returns false when the write did not happen.
 */
export async function copyText(text: string): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge) {
    try {
      return await bridge.clipboard.writeText(text);
    } catch {
      return false;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copies text. When the copy fails, shows `failure` as a toast, so the user knows nothing was copied. */
export async function copyOrReport(text: string, failure: string): Promise<boolean> {
  const ok = await copyText(text);
  if (!ok) useUiStore.getState().pushToast(failure);
  return ok;
}
