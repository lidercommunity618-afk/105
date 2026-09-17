/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary — deep electric blue for actions / accents
        primary: {
          50: '#eef6ff', 100: '#d9ebff', 200: '#bcdcff', 300: '#8ec6ff',
          400: '#59a6ff', 500: '#3385ff', 600: '#1d66f5', 700: '#1551e1',
          800: '#1843b6', 900: '#1a3c8f', 950: '#142657',
        },
        // Secondary — teal for secondary info / chart elements
        secondary: {
          50: '#effefb', 100: '#c8fef5', 200: '#93fce9', 300: '#52f5d8',
          400: '#1de6c2', 500: '#06cca6', 600: '#01a887', 700: '#06856e',
          800: '#0b6a59', 900: '#0d564b', 950: '#003330',
        },
        // Accent — amber for highlights / active states
        accent: {
          50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d',
          400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309',
          800: '#92400e', 900: '#78350f', 950: '#451a03',
        },
        // Success — Pocket Option style green (400/600/700 recalculated to
        // preserve the original tonal step pattern around the new 500 anchor)
        success: {
          400: '#69c09e', 500: '#2ebd85', 600: '#1ca16d', 700: '#17875b',
        },
        warning: {
          400: '#fbbf24', 500: '#f59e0b', 600: '#d97706',
        },
        // Error — Pocket Option style red (400/600/700 recalculated to
        // preserve the original tonal step pattern around the new 500 anchor)
        error: {
          400: '#f17276', 500: '#e5484d', 600: '#ce2e34', 700: '#aa2529',
        },
        // Neutral base — the terminal dark canvas (Pocket Option graphite-blue).
        // 50-500 unchanged (used for light text); 600-950 recalculated to the
        // new anchors while preserving the original hue family and step logic.
        base: {
          50: '#f5f7fa', 100: '#eaeef4', 200: '#d4dbe6', 300: '#aeb9cc',
          400: '#94a4be', 500: '#8090ad', 600: '#445773', 700: '#36455c',
          800: '#212c3d', 900: '#161f2c', 950: '#0e1621',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        '3xs': ['0.5625rem', { lineHeight: '0.75rem' }],
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.25s ease-out',
        'slide-up': 'slide-up 0.3s ease-out',
        'flash-green': 'flash-green 0.5s ease-out',
        'flash-red': 'flash-red 0.5s ease-out',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'flash-green': {
          '0%': { backgroundColor: 'rgba(16, 185, 129, 0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(239, 68, 68, 0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
    },
  },
  plugins: [],
};
