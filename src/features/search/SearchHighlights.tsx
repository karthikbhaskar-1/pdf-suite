import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { rotateRect, swapsAxes } from '../viewer/rotation';
import { currentHit, useSearchStore } from './searchStore';

interface HighlightProps {
  paneId: string;
  pageId: string;
  /** Rendered page size in CSS pixels, after the view rotation. */
  width: number;
  height: number;
  zoom: number;
}

/**
 * Overlay layer for one page: every match on the page is tinted, and the current match is drawn
 * stronger. Match rectangles are stored in unrotated page points, so they are mapped through the
 * pane's view rotation and then scaled by the zoom. They line up with the rendered page at any zoom and rotation.
 */
export function SearchHighlights({ paneId, pageId, width, height, zoom }: HighlightProps) {
  const hits = useSearchStore((s) => s.byPage[pageId]);
  const currentId = useSearchStore((s) => currentHit(s)?.id);
  const viewRotation = useWorkspaceStore((s) => selectPane(s, paneId)?.view.rotation ?? 0);
  if (!hits || hits.length === 0) return null;
  // Size of the page before the view rotation, in points.
  const swapped = swapsAxes(viewRotation);
  const baseWidth = (swapped ? height : width) / zoom;
  const baseHeight = (swapped ? width : height) / zoom;
  return (
    <div className="search-layer" aria-hidden="true">
      {hits.flatMap((hit) =>
        hit.rects.map((raw, i) => {
          const rect = rotateRect(raw, baseWidth, baseHeight, viewRotation);
          return (
            <div
              key={`${hit.id}-${i}`}
              className={`search-hit${hit.id === currentId ? ' search-hit-current' : ''}`}
              style={{
                left: rect.x * zoom,
                top: rect.y * zoom,
                width: rect.width * zoom,
                height: rect.height * zoom,
              }}
            />
          );
        }),
      )}
    </div>
  );
}
