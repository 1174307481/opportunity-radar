import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "机会雷达",
  description: "个人机会雷达：把信号变成今天能做的第一步",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#0a0a0a] text-neutral-200 antialiased">
        <header className="border-b border-neutral-800">
          <nav className="mx-auto flex h-14 w-full max-w-3xl items-center gap-6 px-4">
            <Link
              href="/"
              className="text-sm font-semibold tracking-tight text-neutral-100"
            >
              📡 机会雷达
            </Link>
            <div className="flex items-center gap-4 text-sm text-neutral-400">
              <Link href="/" className="transition-colors hover:text-neutral-100">
                首页
              </Link>
              <Link href="/opportunities" className="transition-colors hover:text-neutral-100">
                机会
              </Link>
              <Link href="/library" className="transition-colors hover:text-neutral-100">
                信息库
              </Link>
              <Link href="/actions" className="transition-colors hover:text-neutral-100">
                行动账本
              </Link>
              <Link href="/settings" className="transition-colors hover:text-neutral-100">
                设置
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-3xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
