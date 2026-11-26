import clsx from 'clsx';

/**
 * The coral Claude starburst: 12 slightly irregular tapered rays around a common centre.
 * Ray lengths / widths / angles are fixed (not random) so it renders identically every time.
 */
const RAYS: { angle: number; length: number; width: number }[] = [
  { angle: 0, length: 46, width: 7.2 },
  { angle: 31, length: 40, width: 6.4 },
  { angle: 58, length: 44, width: 7.0 },
  { angle: 91, length: 38, width: 6.2 },
  { angle: 121, length: 45, width: 7.4 },
  { angle: 149, length: 41, width: 6.6 },
  { angle: 182, length: 46, width: 7.0 },
  { angle: 209, length: 39, width: 6.2 },
  { angle: 240, length: 44, width: 7.2 },
  { angle: 271, length: 40, width: 6.4 },
  { angle: 299, length: 45, width: 7.0 },
  { angle: 330, length: 38, width: 6.0 },
];

function rayPath(length: number, width: number): string {
  // A ray pointing up from the centre (50,50): narrow at the hub, widest ~60% out, rounded tip.
  const hub = 50;
  const tipY = hub - length;
  const w = width / 2;
  const shoulder = hub - length * 0.62;
  return [
    `M ${hub - w * 0.35} ${hub}`,
    `L ${hub - w} ${shoulder}`,
    `Q ${hub - w * 0.9} ${tipY} ${hub} ${tipY}`,
    `Q ${hub + w * 0.9} ${tipY} ${hub + w} ${shoulder}`,
    `L ${hub + w * 0.35} ${hub}`,
    'Z',
  ].join(' ');
}

export interface ClaudeStarburstProps {
  size?: number;
  className?: string;
  /** Gentle rotate-in on mount (disabled by prefers-reduced-motion via CSS). */
  animateIn?: boolean;
  /** Slow pulse + spin while Claude is thinking/streaming. */
  thinking?: boolean;
  title?: string;
}

export function ClaudeStarburst({ size = 40, className, animateIn, thinking, title }: ClaudeStarburstProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={clsx('shrink-0 text-accent', animateIn && 'animate-starburst-in', thinking && 'animate-thinking', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="currentColor"
    >
      {RAYS.map((r) => (
        <path key={r.angle} d={rayPath(r.length, r.width)} transform={`rotate(${r.angle} 50 50)`} />
      ))}
    </svg>
  );
}
