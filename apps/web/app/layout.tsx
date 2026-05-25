import "./globals.css";
import Providers from "./providers";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "AgentMesh AI",
  description: "A real-time chat application built with Next.js, Socket.IO, and MongoDB.",
  icons: {
    icon: [{ url: "/favicon.png?v=2", type: "image/png" }],
    shortcut: "/favicon.png?v=2",
    apple: "/favicon.png?v=2",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning >
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}