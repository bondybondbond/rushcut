import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RushCut",
  description: "From your rushes to a cut. In minutes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
        style={{ backgroundColor: "#0a0a0a", color: "#e5e5e5" }}
      >
        <Providers>
          <header
            className="border-b border-white/10 px-6 py-4 flex items-center justify-between"
            style={{ backgroundColor: "#0a0a0a" }}
          >
            {/* Batch 2: add cancel-and-leave confirm dialog when user is mid-flow */}
            <Link
              href="/"
              className="text-lg font-semibold tracking-tight text-[#e5e5e5] hover:text-white transition-colors duration-200"
            >
              RushCut
            </Link>
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
