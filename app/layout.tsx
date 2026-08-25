import type { Metadata } from "next";
import { Baloo_Bhaijaan_2, Karla, Rubik } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

/**
 * The three faces the brand site loads: Karla for body, Rubik for headings,
 * Baloo Bhaijaan 2 for buttons and nav.
 *
 * `next/font/google` downloads and self-hosts these at build time rather than
 * linking to fonts.googleapis.com, so a build produces the same bytes every
 * time and the running app makes no third-party request for a stylesheet.
 * `display: swap` matches the brand site, and means text paints in the fallback
 * rather than waiting.
 */
const karla = Karla({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-karla",
  display: "swap",
});

const rubik = Rubik({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-rubik",
  display: "swap",
});

const baloo = Baloo_Bhaijaan_2({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-baloo",
  display: "swap",
});

/**
 * Kept as the fallback rather than removed. It is bundled in the repo, so a
 * build with no network still renders in something deliberate instead of
 * dropping to Times.
 */
const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Skip Studio",
  description: "AI-powered content operations for a content agency.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${karla.variable} ${rubik.variable} ${baloo.variable} ${geistSans.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
