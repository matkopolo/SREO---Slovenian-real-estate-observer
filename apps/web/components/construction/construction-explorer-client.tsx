"use client";

import dynamic from "next/dynamic";

// Restores its filters from the URL and loads every figure in the browser (see market-dashboard-client).
export const ConstructionExplorerClient = dynamic(
  () => import("./construction-explorer").then((module) => module.ConstructionExplorer),
  { ssr: false, loading: () => <div className="app-shell" aria-busy="true" /> },
);
