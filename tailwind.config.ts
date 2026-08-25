import type { Config } from "tailwindcss";

/**
 * The brand palette, exposed as utilities.
 *
 * Every colour resolves to a CSS variable defined in `globals.css` rather than
 * a literal here, so the palette has exactly one definition. A hex repeated in
 * two files is a hex that eventually differs in one of them.
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        amber: {
          brand: "var(--skip-amber)",
          dark: "var(--skip-amber-dark)",
        },
        ink: "var(--skip-ink)",
        heading: "var(--skip-heading)",
        body: "var(--skip-body)",
        surface: "var(--skip-surface)",
        canvas: "var(--skip-canvas)",
        edge: "var(--skip-border)",
        tint: "var(--skip-tint)",

        // Status. Named by what they mean, not by hue -- `flag` moved off amber
        // when amber became the chrome, and callers should not have to notice.
        flag: "var(--skip-flag)",
        "flag-bg": "var(--skip-flag-bg)",
        danger: "var(--skip-danger)",
        "danger-bg": "var(--skip-danger-bg)",
        ok: "var(--skip-ok)",
        "ok-bg": "var(--skip-ok-bg)",
        info: "var(--skip-info)",
        "info-bg": "var(--skip-info-bg)",
      },
      fontFamily: {
        sans: ["var(--font-karla)", "var(--font-geist-sans)", "system-ui", "sans-serif"],
        heading: ["var(--font-rubik)", "var(--font-geist-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-baloo)", "var(--font-geist-sans)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        pill: "30px",
      },
    },
  },
  plugins: [],
};
export default config;
