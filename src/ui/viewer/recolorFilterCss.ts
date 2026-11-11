import { useRecolorStore } from '../../core/stores/recolorStore';

/** id of the SVG filter that recolors pages. Defined once by RecolorFilterDefs. */
export const RECOLOR_FILTER_ID = 'pdf-recolor';

/** CSS `filter` for page content, or undefined when recoloring is off. Re-renders on change. */
export function useRecolorFilterCss(): string | undefined {
  const mode = useRecolorStore((s) => s.mode);
  return mode === 'off' ? undefined : `url(#${RECOLOR_FILTER_ID})`;
}
