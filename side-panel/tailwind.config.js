/** Claude-app palette (docs/ARCHITECTURE.md C8). Colors resolve through CSS variables so light/dark flips with `data-theme`. */
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        line: v('line'),
        accent: v('accent'),
        ink: v('ink'),
        muted: v('muted'),
        // Warm derived tints (see styles/index.css)
        bubble: v('bubble'),
        hover: v('hover'),
        sunken: v('sunken'),
        amber: v('amber'),
        danger: v('danger'),
        ok: v('ok'),
      },
      fontFamily: {
        serif: ['Newsreader', '"Tiempos Text"', 'Georgia', 'serif'],
        sans: ['Inter', '"Styrene B"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
    },
  },
  plugins: [],
};
