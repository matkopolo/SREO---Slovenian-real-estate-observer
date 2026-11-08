"use client";

import dynamic from "next/dynamic";

// The dashboard restores its state from the URL (window.location) on the first render
// and loads every figure in the browser. Rendering it on the server produced different
// text for shared links with query parameters (React hydration error #418), so render
// it client-side only; the server sends the page shell.
export const MarketDashboardClient = dynamic(
  () => import("./market-dashboard").then((module) => module.MarketDashboard),
  { ssr: false, loading: () => <div className="app-shell" aria-busy="true" /> },
);
