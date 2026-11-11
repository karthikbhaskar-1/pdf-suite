import { keymap } from '../../app/services';
import type { MenuEntry, ToolbarItem } from '../../core/layout/topBarRegistry';
import { useFloatingStore } from '../../core/stores/floatingStore';
import { useRecolorStore } from '../../core/stores/recolorStore';
import { selectActiveTab, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { RECOLOR_MODES } from '../../features/recolor/recolorFilter';
import { LoupeIcon, PanZoomIcon, RecolorIcon, SplitIcon } from '../icons';
import { ICON_PX, MenuButton, ToolbarButton } from './toolbarControls';

/**
 * The View group of the top bar: Split, Loupe, Pan and zoom and Page colors. These are tools, not zoom controls (the zoom controls
 * are in the status bar). Split is a high item; the other three are normal items and collapse first.
 */

const isSplit = () => (selectActiveTab(useWorkspaceStore.getState())?.panes.length ?? 0) >= 2;
const syncOn = () => selectActiveTab(useWorkspaceStore.getState())?.split?.syncScroll ?? false;

/** The rows of the Split menu. */
function splitRows(): MenuEntry[] {
  return [
    { kind: 'command', command: 'split.toggle', label: isSplit() ? 'Turn split off' : 'Turn split on' },
    { kind: 'command', command: 'split.horizontal', label: 'Split horizontal' },
    { kind: 'command', command: 'split.vertical', label: 'Split vertical' },
    { kind: 'command', command: 'split.toggleSync', label: `Sync scroll: ${isSplit() && syncOn() ? 'on' : 'off'}` },
  ];
}

/** The rows of the Recolor menu: the modes as radio choices, then the two color pickers of the custom mode. */
function recolorRows(): MenuEntry[] {
  const { mode, background, text } = useRecolorStore.getState();
  // "Custom" leaves the menu open, so that its two color pickers (which follow it) can be used straight away.
  const row = (id: string, label: string): MenuEntry => ({ kind: 'command', command: `view.recolor.${id}`, label, check: 'radio', checked: mode === id, stay: id === 'custom' });
  return [
    ...RECOLOR_MODES.filter((m) => m.mode !== 'custom').map((m) => row(m.mode, m.label)),
    row('custom', 'Custom'),
    {
      kind: 'color',
      label: 'Background',
      ariaLabel: 'Custom background color',
      value: background,
      onChange: (value) => useRecolorStore.getState().setColors({ background: value }),
    },
    { kind: 'color', label: 'Text', ariaLabel: 'Custom text color', value: text, onChange: (value) => useRecolorStore.getState().setColors({ text: value }) },
  ];
}

function LoupeButton() {
  const open = useFloatingStore((s) => s.windows.loupe.open);
  return <ToolbarButton commandId="view.loupe" label="Loupe" icon={<LoupeIcon size={ICON_PX} />} pressed={open} />;
}

function PanZoomButton() {
  const open = useFloatingStore((s) => s.windows.panZoom.open);
  return <ToolbarButton commandId="view.panZoom" label="Pan and zoom" icon={<PanZoomIcon size={ICON_PX} />} pressed={open} />;
}

function RecolorMenu() {
  const mode = useRecolorStore((s) => s.mode);
  const modeLabel = RECOLOR_MODES.find((m) => m.mode === mode)?.label ?? '';
  return <MenuButton label="Page colors" name={`Page colors: ${modeLabel}`} icon={<RecolorIcon size={ICON_PX} />} entries={recolorRows} tip={`Page colors: ${modeLabel}`} />;
}

export const viewItems: ToolbarItem[] = [
  {
    id: 'view.split',
    priority: 'high',
    label: 'Split',
    render: ({ labels }) => (
      <MenuButton
        label="Split"
        icon={<SplitIcon size={ICON_PX} />}
        showLabel={labels}
        entries={splitRows}
        tip={`Split${keymap.shortcutFor('split.toggle') ? ` (${keymap.shortcutFor('split.toggle')})` : ''}`}
      />
    ),
    menu: () => [{ kind: 'heading', label: 'Split' }, ...splitRows()],
  },
  {
    id: 'view.loupe',
    priority: 'normal',
    label: 'Loupe',
    render: () => <LoupeButton />,
    menu: () => [{ kind: 'command', command: 'view.loupe', label: 'Loupe', check: 'check', checked: useFloatingStore.getState().windows.loupe.open }],
  },
  {
    id: 'view.panZoom',
    priority: 'normal',
    label: 'Pan and zoom',
    render: () => <PanZoomButton />,
    menu: () => [{ kind: 'command', command: 'view.panZoom', label: 'Pan and zoom', check: 'check', checked: useFloatingStore.getState().windows.panZoom.open }],
  },
  {
    id: 'view.recolor',
    priority: 'normal',
    label: 'Page colors',
    render: () => <RecolorMenu />,
    menu: () => [{ kind: 'heading', label: 'Page colors' }, ...recolorRows()],
  },
];
