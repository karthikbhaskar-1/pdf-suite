import { useMemo } from 'react';
import { useRecolorStore } from '../../core/stores/recolorStore';
import { matrixValues, recolorMatrix } from '../../features/recolor/recolorFilter';
import { RECOLOR_FILTER_ID } from './recolorFilterCss';

/**
 * Hidden SVG that defines the recolor filter. Pages reference it through CSS `filter: url(#...)`.
 * Only the page layer and the loupe use it, so thumbnails keep their colors.
 */
export function RecolorFilterDefs() {
  // Primitive selectors: a selector that builds a new object on each call would re-render forever.
  const mode = useRecolorStore((s) => s.mode);
  const background = useRecolorStore((s) => s.background);
  const text = useRecolorStore((s) => s.text);
  const values = useMemo(() => {
    const matrix = recolorMatrix({ mode, background, text });
    return matrix ? matrixValues(matrix) : '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0';
  }, [mode, background, text]);
  return (
    <svg className="svg-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id={RECOLOR_FILTER_ID} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={values} />
        </filter>
      </defs>
    </svg>
  );
}
