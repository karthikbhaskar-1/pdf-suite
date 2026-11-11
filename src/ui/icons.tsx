import type { ReactNode } from 'react';

/**
 * Icon set licence note (ticket 1.2.2): every icon in this file is an original drawing made for PDF Suite on a 16 by 16
 * grid (1.5 px round strokes, currentColor). No third-party icon set is used, so nothing here needs an attribution, and
 * the drawings are part of the project under its own licence (AGPL-3.0). No Adobe assets. The toolbar shows them at
 * 18 px and the status bar and menus at 16 px, so they follow the theme.
 */

interface IconProps {
  size?: number;
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** A page with a plus: Insert. */
export const FilePlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 1.5h6l3 3v10h-9z" />
    <path d="M8 7v5M5.5 9.5h5" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
  </Svg>
);

export const RotateIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </Svg>
);

export const CropIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 1.5v10h10M1.5 4.5h10v10" />
  </Svg>
);

export const RulerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 10.5 10.5 2 14 5.5 5.5 14z" />
    <path d="M5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5" />
  </Svg>
);

/** Two pages joined into one by an arrow: Combine files. */
export const MergeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 1.5h5v5H2zM9 1.5h5v5H9z" />
    <path d="M4.5 6.5v2.5l3.5 2.5 3.5-2.5V6.5" />
    <path d="M8 11.5v3M6.5 13l1.5 1.5L9.5 13" />
  </Svg>
);

/** A page with a dashed line down its centre: Cut Pages in Half. */
export const CutHalfIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 1.5h9v13h-9z" />
    <path d="M8 1.5v13" strokeDasharray="1.8 1.6" />
  </Svg>
);

/** Two sheets one over the other: Overlay to Compare. */
export const LayersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 3.5h7v7h-7z" />
    <path d="M6.5 6.5h7v7h-7z" />
  </Svg>
);

/** One page that becomes several: Split into Files. */
export const PageToPagesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 3.5h5v9h-5z" />
    <path d="M7.5 8h2" />
    <path d="M9 6.5 10.5 8 9 9.5" />
    <path d="M11 2.5h3.5v4H11z" />
    <path d="M11 9.5h3.5v4H11z" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Svg>
);

export const UndoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 4 2.5 7l3 3" />
    <path d="M2.5 7h7a4 4 0 0 1 0 8H7" />
  </Svg>
);

export const RedoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 4l3 3-3 3" />
    <path d="M13.5 7h-7a4 4 0 0 0 0 8H9" />
  </Svg>
);

export const ExtractIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
  </Svg>
);

/** A folder: Open. */
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 12.5v-9h4l1.5 1.5h6.5v2" />
    <path d="M1.5 12.5l2-5.5h11.5l-2 5.5z" />
  </Svg>
);

/** A floppy disk: Save. */
export const SaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 2.5h9l2 2v9h-11z" />
    <path d="M5 2.5v3.5h5V2.5M5 13.5v-4h6v4" />
  </Svg>
);

/** A clock: Recent files. */
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Svg>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 10l4.5-4.5 4.5 4.5" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6l4.5 4.5L12.5 6" />
  </Svg>
);

/** A magnifying glass: Search. */
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Svg>
);

/** A circle filled on one side: light or dark theme. */
export const ThemeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
  </Svg>
);

/** A small square joined to a large one by two lines that spread apart (an area shown bigger): Loupe. No circle, no plus. */
export const LoupeIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.5" y="1.5" width="4" height="4" />
    <rect x="7.5" y="7.5" width="7" height="7" />
    <path d="M5.5 1.5L14.5 7.5M1.5 5.5L7.5 14.5" />
  </Svg>
);

/** Four arrows from the middle: Pan and zoom. */
export const PanZoomIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
  </Svg>
);

/** A frame with a line down the middle: Split. */
export const SplitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 3h12v10H2zM8 3v10" />
  </Svg>
);

/** A drop: Page colors (recolor). */
export const RecolorIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2l4 5.2a4.8 4.8 0 1 1-8 0z" />
  </Svg>
);

/** Four corners: fit the whole page in the window. */
export const FitPageIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />
  </Svg>
);

/** Two sides with arrows between: fit the page width to the window. */
export const FitWidthIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 3v10M14 3v10M4.5 8h7M6.5 6l-2 2 2 2M9.5 6l2 2-2 2" />
  </Svg>
);

export const ZoomInIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h10M8 3v10" />
  </Svg>
);

export const ZoomOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h10" />
  </Svg>
);
