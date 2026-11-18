import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, EB_Garamond } from "next/font/google";
import { PRODUCT_NAME } from "@/config/brand";
import "./globals.css";

// The AlterMe type pairing. next/font downloads the files at build time and serves them from this
// app, so no visitor's browser ever contacts a font host.
const hanken = Hanken_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-hanken", display: "swap" });
const garamond = EB_Garamond({ subsets: ["latin", "latin-ext"], style: ["normal", "italic"], variable: "--font-garamond", display: "swap" });

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "Send, sign and verify business documents.",
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${hanken.variable} ${garamond.variable}`}>
      <body>{children}</body>
    </html>
  );
}
