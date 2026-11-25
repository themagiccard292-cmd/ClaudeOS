/** Claude-app palette (docs/ARCHITECTURE.md C8). Colors resolve through CSS variables so light/dark flips with one class. */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
      },
      fontFamily: {
        serif: ['Newsreader', '"Tiempos Text"', 'Georgia', 'serif'],
        sans: ['Inter', '"Styrene B"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
