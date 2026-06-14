import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
        },
        pink: {
          500: "#ec4899",
          600: "#db2777",
        },
        // Dark teal green — deep, premium accent.
        dteal: {
          50: "#e6f2f0",
          100: "#c2ded9",
          400: "#1f8a7d",
          500: "#0f766e",
          600: "#0c5d52",
          700: "#0a4a42",
          800: "#073a34",
        },
        // McDonald's golden yellow.
        mcyellow: {
          50: "#fff8e6",
          100: "#ffefbf",
          400: "#ffd24d",
          500: "#ffc72c",
          600: "#e6ab1f",
          700: "#bd8a16",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.02)",
        card: "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(15,23,42,0.04)",
      },
      keyframes: {
        wiggle: {
          "0%, 100%": { transform: "rotate(-12deg)" },
          "50%": { transform: "rotate(12deg)" },
        },
      },
      animation: {
        wiggle: "wiggle 0.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
