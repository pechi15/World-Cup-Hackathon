/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#101820",
        panel: "#f7f9fb",
        line: "#d8e0e8",
        accent: "#0f766e",
        warn: "#b45309",
        danger: "#b91c1c",
      },
    },
  },
  plugins: [],
};
