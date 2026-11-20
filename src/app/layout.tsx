import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, EB_Garamond } from "next/font/google";
import { connection } from "next/server";
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

// Every page is rendered for its own request (D-70): Next.js can only put the per-response nonce of the
// Content-Security-Policy on scripts of pages it renders at request time, never on pages built in advance.
export const instant = false;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html lang="en" className={`${hanken.variable} ${garamond.variable}`}>
      <body>{children}</body>
    </html>
  );
}
