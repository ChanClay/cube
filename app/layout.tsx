import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cube · Mirror of Dreams',
  description: 'Mirror of Dreams',
};

export const viewport: Viewport = {
  themeColor: '#f4f6fb',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
