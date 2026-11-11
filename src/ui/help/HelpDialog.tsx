import { useEffect, useLayoutEffect, useRef } from 'react';
import { commands } from '../../core/commands/registry';
import { keymap } from '../../app/services';
import { APP_VERSION } from '../../core/appInfo';
import { COPYRIGHT_HOLDER, LICENSE_NAME, NO_WARRANTY_NOTICE, REPOSITORY_URL } from '../../core/repoInfo';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useUiStore } from '../../core/stores/uiStore';

/**
 * The Help menu's dialogs: Keyboard Shortcuts (every command with a shortcut) and About (version and the licenses of the
 * engines). They are panels, not modals: the app allows exactly two modals (the password prompt and the close prompt), so
 * these sit at the top right and do not dim the page. They take focus on open (the Close button), Esc closes only the panel,
 * and the focus goes back to where it was (1.5.5 C3).
 */
export function HelpDialog() {
  const dialog = useUiStore((s) => s.helpDialog);
  const setDialog = useUiStore((s) => s.setHelpDialog);

  const menuOpen = useOverlayStore((s) => s.menu !== null || s.paletteOpen);
  const modalOpen = useUiStore((s) => s.closePrompt || s.sourcePassword !== null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // Esc closes one thing: a menu, the palette or a modal has the key before this panel (1.5.5 section 0).
  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || menuOpen || modalOpen || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, setDialog, menuOpen, modalOpen]);

  // Focus goes to Close on open and back to the control that had it (else the page) on close.
  useLayoutEffect(() => {
    if (dialog) {
      if (!wasOpen.current) {
        wasOpen.current = true;
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      closeRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const back = openerRef.current;
      openerRef.current = null;
      if (back && back.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
      if (!back || document.activeElement !== back) document.querySelector<HTMLElement>('.main')?.focus();
    }
  }, [dialog]);

  if (!dialog) return null;
  const isAbout = dialog === 'about';
  const shortcuts = commands
    .list()
    .map((def) => ({ id: def.id, label: def.label, shortcut: keymap.shortcutFor(def.id) }))
    .filter((row) => row.shortcut !== undefined)
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <aside className="help-dialog" role="dialog" aria-label={isAbout ? 'About PDF Suite' : 'Keyboard Shortcuts'}>
      <header className="help-head">
        <h2>{isAbout ? 'About PDF Suite' : 'Keyboard Shortcuts'}</h2>
        <button ref={closeRef} type="button" className="side-sheet-close" aria-label="Close" onClick={() => setDialog(null)}>
          ×
        </button>
      </header>
      {isAbout ? (
        <div className="help-body" role="region" aria-label="About PDF Suite" tabIndex={0}>
          <p>
            <strong>PDF Suite</strong> version {APP_VERSION}
          </p>
          <p>Copyright (c) {COPYRIGHT_HOLDER}.</p>
          <p>{NO_WARRANTY_NOTICE}</p>
          <p>
            License: {LICENSE_NAME}.
          </p>
          <p>
            Source code: <span className="help-source-url">{REPOSITORY_URL}</span>
          </p>
          <p>Page rendering, editing and saving use MuPDF, licensed under the GNU Affero General Public License (AGPL).</p>
          <p>Page text for search and XFA forms use pdf.js, licensed under the Apache License 2.0.</p>
        </div>
      ) : (
        <div className="help-body" role="region" aria-label="Keyboard Shortcuts list" tabIndex={0}>
          <table className="help-table">
            <tbody>
              {shortcuts.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td>
                    <kbd>{row.shortcut}</kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
