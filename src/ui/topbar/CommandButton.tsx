import type { ReactNode } from 'react';
import { commands } from '../../core/commands/registry';
import { ariaShortcut, tooltipText } from './shortcutText';
import { useCommandState } from './toolbarControls';

interface CommandButtonProps {
  commandId: string;
  children?: ReactNode;
  label?: string;
  className?: string;
  /** Icon shown before the label, for buttons with both. */
  icon?: ReactNode;
}

/**
 * Button for a registered command, with its label as text (the thumbnails panel uses it). Its tooltip shows the label and
 * the shortcut for this platform. A disabled button's tooltip gives the reason when the command has one (for example a form
 * that cannot be edited). It re-checks enabled state when the active tab or pane changes. The top bar's icon buttons are
 * ToolbarButton (see toolbarControls.tsx).
 */
export function CommandButton({ commandId, children, label, className, icon }: CommandButtonProps) {
  const { enabled, reason, shortcut } = useCommandState(commandId);
  const text = label ?? commands.get(commandId)?.label ?? commandId;
  const tip = reason ?? tooltipText(text, shortcut);
  return (
    <span className="tb-tip" data-tooltip={tip}>
      <button
        type="button"
        className={className ?? 'tb-button'}
        disabled={!enabled}
        data-tooltip={tip}
        aria-label={text}
        aria-keyshortcuts={ariaShortcut(shortcut)}
        onClick={() => void commands.run(commandId)}
      >
        {icon}
        {children ?? text}
      </button>
    </span>
  );
}
