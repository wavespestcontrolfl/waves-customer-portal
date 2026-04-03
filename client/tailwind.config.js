/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  corePlugins: {
    preflight: false, // Don't reset browser defaults — the portal uses inline styles
  },
  theme: { extend: {} },
  plugins: [],
};
