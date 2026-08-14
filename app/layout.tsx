import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Clearance Conformance Monitor',
  description: 'Live ADS-B clearance conformance monitoring around SFO',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">{children}</body>
    </html>
  )
}
