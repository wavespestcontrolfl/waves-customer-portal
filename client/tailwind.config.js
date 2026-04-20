/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: false,
  corePlugins: {
    preflight: false, // Don't reset browser defaults — the portal uses inline styles
  },
  theme: {
    extend: {
      colors: {
        waves: {
          blue: '#0A7EC2',
          'blue-dark': '#065A8C',
          'blue-deeper': '#04395E',
          'blue-light': '#E8F4FC',
          'blue-50': '#F0F7FC',
          red: '#C0392B',
          'red-light': '#FDECEA',
          gold: '#F0A500',
          'gold-light': '#FEF7E0',
        },
        zinc: {
          50: '#FAFAFA',
          100: '#F4F4F5',
          200: '#E4E4E7',
          300: '#D4D4D8',
          400: '#A1A1AA',
          500: '#71717A',
          600: '#52525B',
          700: '#3F3F46',
          800: '#27272A',
          900: '#18181B',
          950: '#09090B',
        },
        alert: {
          bg: '#FCEBEB',
          fg: '#C8312F',
          hover: '#A32D2D',
        },
        surface: {
          page: '#FAFAFA',
          card: '#FFFFFF',
          hover: '#F4F4F5',
          sunken: '#F4F4F5',
        },
        ink: {
          primary: '#18181B',
          secondary: '#52525B',
          tertiary: '#71717A',
          disabled: '#A1A1AA',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      fontWeight: {
        normal: '400',
        medium: '500',
      },
      fontSize: {
        '11': ['11px', { lineHeight: '1.4' }],
        '12': ['12px', { lineHeight: '1.4' }],
        '13': ['13px', { lineHeight: '1.5' }],
        '14': ['14px', { lineHeight: '1.5' }],
        '16': ['16px', { lineHeight: '1.5' }],
        '18': ['18px', { lineHeight: '1.4' }],
        '22': ['22px', { lineHeight: '1.3' }],
        '28': ['28px', { lineHeight: '1.25' }],
      },
      letterSpacing: {
        display: '-0.02em',
        h1: '-0.015em',
        tight: '-0.01em',
        normal: '0',
        label: '0.06em',
      },
      borderRadius: {
        xs: '3px',
        sm: '4px',
        md: '6px',
        lg: '8px',
      },
      borderWidth: {
        hairline: '0.5px',
      },
      ringWidth: {
        focus: '2px',
      },
    },
  },
  plugins: [],
};
