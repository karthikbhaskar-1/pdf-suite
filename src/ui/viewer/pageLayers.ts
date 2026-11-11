import type { ComponentType } from 'react';

/** Props every overlay layer receives. Layers draw on top of a page, in `order`. */
export interface PageLayerProps {
  paneId: string;
  pageId: string;
  docId: string;
  srcIndex: number;
  /** Extra rotation the page is shown with (the pane's view rotation). */
  rotation: number;
  /** Rendered page size in CSS pixels. */
  width: number;
  height: number;
  zoom: number;
}

export interface PageLayerDef {
  id: string;
  /** Lower draws first (below). */
  order: number;
  component: ComponentType<PageLayerProps>;
}

/**
 * Overlay stack for each page. Annotations, form fields and editing tools (later milestones)
 * register a layer here. The viewer itself does not know what the layers do.
 */
class PageLayerRegistry {
  private readonly layers = new Map<string, PageLayerDef>();

  register(def: PageLayerDef): () => void {
    this.layers.set(def.id, def);
    return () => {
      this.layers.delete(def.id);
    };
  }

  list(): PageLayerDef[] {
    return [...this.layers.values()].sort((a, b) => a.order - b.order);
  }
}

export const pageLayers = new PageLayerRegistry();
