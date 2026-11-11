import { useFloatingStore } from '../../core/stores/floatingStore';
import { LoupeWindow } from './LoupeWindow';
import { PanZoomWindow } from './PanZoomWindow';

/** Mounts the floating windows that are open. */
export function FloatingWindows() {
  const loupe = useFloatingStore((s) => s.windows.loupe.open);
  const panZoom = useFloatingStore((s) => s.windows.panZoom.open);
  return (
    <>
      {loupe && <LoupeWindow />}
      {panZoom && <PanZoomWindow />}
    </>
  );
}
