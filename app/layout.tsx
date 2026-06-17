import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Decent Poker",
  description: "Texas Hold'em · Provably fair · Play with friends",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: "#0a0a0f", color: "#e2e8f0", overflowX: "hidden" }}>
        {children}
      </body>
    </html>
  );
}
