/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
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
      },
    },
  },
  plugins: [],
};
