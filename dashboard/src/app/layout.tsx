import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Confluence", template: "%s | Confluence" },
  description: "Polymarket wallet-edge research dashboard — where's the edge, right now.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Runs before hydration so the stored theme applies with no flash of the
            wrong mode. type flips to text/plain on the client so the script never
            re-runs (or warns) on hydration/re-render — see Next's own
            preventing-flash-before-hydration.md guide. */}
        <script
          type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t&&t!=='system')document.documentElement.setAttribute('data-theme',t);}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col md:flex-row bg-[var(--page-plane)]">
        <Sidebar />
        <main className="relative flex-1 min-w-0 px-4 py-6 md:px-10 md:py-10">
          {/* Very subtle radial glow, not a texture -- depth without competing with the data. */}
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 -z-10 opacity-[0.06]"
            style={{ background: "radial-gradient(1200px circle at 15% 0%, var(--diverging-pos), transparent 60%)" }}
          />
          {children}
        </main>
      </body>
    </html>
  );
}
