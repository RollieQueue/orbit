import type { ReactNode } from 'react'

const paths: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  folder: <path d="M3 6h6l2 2h10v12H3z" />,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 8c0 6-12 2-12 7" /></>,
  chat: <path d="M21 4H3v14h5l4 4v-4h9z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  agents: <><circle cx="12" cy="5" r="3" /><circle cx="5" cy="19" r="3" /><circle cx="19" cy="19" r="3" /><path d="M12 8v4H5v4m7-4h7v4" /></>,
  memory: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  skill: <><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
  settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" /></>,
  refresh: <><path d="M20 10a8 8 0 1 0-1 8M20 3v7h-7" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  check: <path d="m5 12 4 4L19 6" />,
  terminal: <><path d="m4 6 6 6-6 6M13 18h7" /></>,
  index: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
  gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 18 4-6" /></>,
  pin: <><path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 12v9" /></>,
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">{paths[name] || paths.chat}</svg>
}
