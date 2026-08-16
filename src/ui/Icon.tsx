import type { SVGProps } from 'react';

/**
 * One stroke-based icon set for the whole app. 24×24 grid, `currentColor`,
 * round caps — so icons inherit tone from whatever surface they sit on.
 */
const PATHS = {
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4L16 11l4 4M9 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  folderPlus: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 11v5M9.5 13.5h5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16.2 16.2 21 21',
  more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
  share: 'M12 15V4M8.5 7.5 12 4l3.5 3.5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6',
  download: 'M12 4v11M8.5 11.5 12 15l3.5-3.5M5 20h14',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  edit: 'M4 20h4L20 8l-4-4L4 16zM14.5 5.5l4 4',
  rotateCw: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  rotateCcw: 'M4 12a8 8 0 1 0 2.6-5.9M4 4v4h4',
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14',
  sliders: 'M4 8h10M18 8h2M4 16h4M12 16h8M15 5.5v5M8.5 13.5v5',
  text: 'M5 6V5h14v1M12 5v14M9 19h6',
  signature: 'M3 17c3 0 4-9 7-9s2 7 4.5 7c1.5 0 2-2 3.5-2s2 1.5 3 1.5M4 21h16',
  check: 'M5 12.5 10 17.5 19 7',
  close: 'M6 6l12 12M18 6 6 18',
  chevronLeft: 'M14.5 5.5 8 12l6.5 6.5',
  chevronRight: 'M9.5 5.5 16 12l-6.5 6.5',
  chevronDown: 'M5.5 9.5 12 16l6.5-6.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M4 6h16M4 12h16M4 18h16',
  star: 'm12 4 2.4 5.1 5.6.8-4 4 .9 5.6-4.9-2.7-4.9 2.7.9-5.6-4-4 5.6-.8z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-1.9M5 11h14v9H5z',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.4-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L14.2 2h-4l-.3 2.6a7.6 7.6 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.4a7.6 7.6 0 0 0 0 3l-2 1.4 2 3.4 2.3-1a7.6 7.6 0 0 0 2.6 1.5l.3 2.8h4l.3-2.8a7.6 7.6 0 0 0 2.6-1.5l2.3 1 2-3.4z',
  sort: 'M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3',
  merge: 'M7 4v6a4 4 0 0 0 4 4h6M17 4v6a4 4 0 0 1-4 4H7M13.5 10.5 17 14l-3.5 3.5',
  split: 'M6 4v5a3 3 0 0 0 3 3h9M6 20v-5a3 3 0 0 1 3-3M14.5 8.5 18 12l-3.5 3.5',
  textScan: 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 9h8M8 12.5h8M8 16h5',
  pdf: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15.5h6M9 19h3',
  torch: 'M8 3h8l-1 5 2 3-5 10v-8H8.5L10 8z',
  torchOff: 'M8 3h8l-1 5 2 3-2.5 5M11 13v8M4 4l16 16',
  switchCamera: 'M4 8h3l2-3h6l2 3h3v11H4zM10 12.5a2.5 2.5 0 0 1 4.6-1.3M14 12.5a2.5 2.5 0 0 1-4.6 1.3M9 10v2.5h2.5M15 15v-2.5h-2.5',
  gridOverlay: 'M4 4h16v16H4zM9.3 4v16M14.6 4v16M4 9.3h16M4 14.6h16',
  magic: 'm5 19 9-9M13 5l.8 2.2L16 8l-2.2.8L13 11l-.8-2.2L10 8l2.2-.8zM19 12l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  book: 'M12 6c-2-1.5-4.5-2-8-2v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2V4c-3.5 0-6 .5-8 2zM12 6v14',
  idCard: 'M3 6h18v12H3zM7.5 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4.5 16c.6-1.6 1.8-2.4 3-2.4s2.4.8 3 2.4M14 10h4M14 13.5h4',
  undo: 'M9 8H5V4M5.5 8.5A8 8 0 1 1 4 13',
  redo: 'M15 8h4V4M18.5 8.5A8 8 0 1 0 20 13',
  drag: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  eye: 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  tag: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  refresh: 'M20 11a8 8 0 0 0-14-4M4 13a8 8 0 0 0 14 4M4 7v4h4M20 17v-4h-4',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  contrast: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18a9 9 0 0 0 0-18z',
  droplet: 'M12 3.5 6.8 9.4a7 7 0 1 0 10.4 0z',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5 12 22l9-4.5',
  shield: 'M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6z',
  cloudOff: 'M4 4l16 16M7 18a4 4 0 0 1-.6-8 6 6 0 0 1 9.3-3.4M20 15.5a4 4 0 0 0-2.3-5.4M11 18h6',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  fileText: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15.5h6M9 19h3',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  print: 'M7 8V3h10v5M7 18H5a1 1 0 0 1-1-1v-6h16v6a1 1 0 0 1-1 1h-2M7 14h10v7H7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z',
  arrowLeft: 'M20 12H4M10 6l-6 6 6 6',
  arrowRight: 'M4 12h16M14 6l6 6-6 6',
  highlight: 'M4 20h16M6.5 16.5 15 8l3 3-8.5 8.5H6.5zM14 5.5 18.5 10',
  eraser: 'M8 20H4l10-10 6 6-4 4H8zM10 14l6 6',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16.2 16.2 21 21M11 8v6M8 11h6',
  pen: 'M4 20h4L20 8l-4-4L4 16z',
  save: 'M5 4h11l3 3v13H5zM8 4v6h8V4M8 20v-6h8v6',
  page: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  camera2: 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  cards: 'M4 8h12v12H4zM8 8V4h12v12h-4',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Fill the shape instead of stroking it — used for the active star. */
  filled?: boolean;
}

export function Icon({ name, size = 22, filled = false, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];
