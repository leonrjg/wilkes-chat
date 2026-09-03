// Inline, so the package brings no icon library into an application that
// already has one. Every host has its own set and its own sizes; these exist
// to keep the pane legible on its own, and `currentColor` is what lets a host
// restyle them without replacing them.

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: ReactNode, { size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

export const PlusIcon = (props: IconProps) =>
  svg(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    props,
  );

export const ClockIcon = (props: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>,
    props,
  );

export const TrashIcon = (props: IconProps) =>
  svg(
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </>,
    props,
  );

export const SendIcon = (props: IconProps) =>
  svg(
    <>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </>,
    props,
  );

export const StopIcon = (props: IconProps) =>
  svg(<rect x="5" y="5" width="14" height="14" rx="2" />, props);

export const CopyIcon = (props: IconProps) =>
  svg(
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
    props,
  );

export const CheckIcon = (props: IconProps) =>
  svg(<polyline points="20 6 9 17 4 12" />, props);

export const ChevronIcon = (props: IconProps) =>
  svg(<polyline points="6 9 12 15 18 9" />, props);

export const RefreshIcon = (props: IconProps) =>
  svg(
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>,
    props,
  );

export const DownloadIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>,
    props,
  );

export const ToolIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </>,
    props,
  );

export const CloseIcon = (props: IconProps) =>
  svg(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    props,
  );
