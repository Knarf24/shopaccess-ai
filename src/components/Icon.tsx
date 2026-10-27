/**
 * Small local line icons (24px grid, 1.75 stroke). Decorative only: hidden from assistive technology and never the sole
 * label of anything, so every control keeps its text. Names match what the screen really does: no cart, rating,
 * discount, delivery or security imagery.
 */
const PATHS = {
  send: "m3 3 19 9-19 9 4-9-4-9ZM7 12h15",
  laptop: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V15H4V6.5ZM2.5 18h19",
  plug: "M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8ZM12 17v4",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20",
  budget: "M12 3v18M16 7.5C15 6.5 13.7 6 12 6c-2.2 0-4 1-4 2.8s1.6 2.4 4 3 4 1.2 4 3.2S14.2 18 12 18c-1.9 0-3.3-.6-4.3-1.7",
  limits: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6",
  check: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.5l3 3 5-6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01",
  alert: "M12 4 21 19H3L12 4ZM12 10v4M12 16.5h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { readonly name: IconName; readonly className?: string }) {
  return (
    <svg
      className={`ui-icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
