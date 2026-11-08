import type { Metadata } from "next";
import { ConstructionExplorerClient } from "@/components/construction/construction-explorer-client";

export const metadata: Metadata = {
  title: "Gradbeni projekti | DOMOGLASNIK",
  description: "Vpisane nove stavbe, izdana gradbena dovoljenja in javna gradbena naročila v Sloveniji po uradnih virih.",
};

export default function ConstructionPage() {
  return <ConstructionExplorerClient />;
}
