/**
 * Whether the app may write to the Windows Recent list or Jump List (app.addRecentDocument, app.setJumpList,
 * app.clearRecentDocuments). Test mode (PDFSUITE_E2E=1) must never touch the user's list: every write sets off
 * explorer.exe CPU storms that cause false long frames in the timing tests, and test files do not belong there.
 * A normal launch is unchanged. The app's own recent-files store is separate and still used in both modes.
 */
export function mayWriteWindowsRecent(env: Record<string, string | undefined>): boolean {
  return env.PDFSUITE_E2E !== '1';
}
