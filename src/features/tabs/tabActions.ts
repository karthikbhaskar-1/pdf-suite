import { closeTabsWithPrompt } from '../documents/closeFlow';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';

function tabIds(): string[] {
  return useWorkspaceStore.getState().tabs.map((t) => t.id);
}

/** Closes every tab but this one. Documents with unsaved changes are asked about first (one prompt); Cancel closes nothing. */
export async function closeOtherTabs(tabId: string): Promise<void> {
  if (!(await closeTabsWithPrompt(tabIds().filter((id) => id !== tabId)))) return;
  if (tabIds().includes(tabId)) useWorkspaceStore.getState().setActiveTab(tabId);
}

/** Closes the tabs to the right of this one, asking about unsaved changes first like closeOtherTabs. */
export async function closeTabsToRight(tabId: string): Promise<void> {
  const ids = tabIds();
  const index = ids.indexOf(tabId);
  if (index < 0) return;
  await closeTabsWithPrompt(ids.slice(index + 1));
}

/** Moves the active tab forward or back, wrapping at the ends. */
export function cycleTab(direction: 1 | -1): void {
  const { tabs, activeTabId, setActiveTab } = useWorkspaceStore.getState();
  if (tabs.length === 0) return;
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const next = (Math.max(index, 0) + direction + tabs.length) % tabs.length;
  const target = tabs[next];
  if (target) setActiveTab(target.id);
}
