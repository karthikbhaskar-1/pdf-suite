import { PageView } from './PageView';
import { useViewerController, type ViewerModel } from './useViewerController';

/**
 * One document pane: the scrolling page sheet. The state, scroll geometry and commands live in
 * useViewerController; this file only renders what the controller returns.
 */
export function ViewerPane({ paneId }: { paneId: string }) {
  const model = useViewerController(paneId);
  if (!model) return null;
  return <ViewerView model={model} />;
}

function ViewerView({ model }: { model: ViewerModel }) {
  const { scrollerProps, sheetWidth, sheetHeight, slots } = model;
  const { paneId, scrollerRef, ...handlers } = scrollerProps;
  return (
    <div ref={scrollerRef} className="viewer" data-pane={paneId} {...handlers}>
      <div className="sheet" style={{ width: sheetWidth, height: sheetHeight }}>
        {slots.map(({ key, ...slot }) => (
          <PageView key={key} {...slot} />
        ))}
      </div>
    </div>
  );
}
