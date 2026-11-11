import { commands } from '../../core/commands/registry';
import type { MenuItem } from '../../core/stores/overlayStore';

/**
 * The page organizer's items, shown in the thumbnail right-click menu and in the page right-click menu's "Pages" submenu.
 * Each item runs a registered command, so it is disabled exactly when the command is.
 */
export function pagesMenuItems(idPrefix: string): MenuItem[] {
  const item = (id: string, label: string, commandId: string): MenuItem => ({
    id: `${idPrefix}.${id}`,
    label,
    disabled: !commands.isEnabled(commandId),
    onSelect: () => void commands.run(commandId),
  });
  const separator = (id: string): MenuItem => ({ id: `${idPrefix}.${id}`, label: '', separator: true });
  return [
    item('insert', 'Insert blank page…', 'pages.insert'),
    item('insertPdf', 'Insert pages from a PDF…', 'pages.insertFromPdf'),
    item('duplicate', 'Duplicate', 'pages.duplicate'),
    item('replace', 'Replace…', 'pages.replace'),
    separator('sep1'),
    item('rotate', 'Rotate right 90°', 'pages.rotateRight'),
    item('crop', 'Crop…', 'pages.crop'),
    item('cutHalf', 'Cut pages in half…', 'pages.cutHalf'),
    separator('sep2'),
    item('extract', 'Extract…', 'pages.extract'),
    item('delete', 'Delete', 'pages.delete'),
  ];
}
