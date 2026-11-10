import { useId, type ReactNode } from "react";
import { t } from "../i18n";

export const GLOSSARY = {
  mediana: t("Polovica poslov je bila dražja, polovica cenejša. Na mediano manj vplivajo posamezni zelo dragi posli kot na povprečje."),
  reprezentativni: t("Prodaje na prostem trgu z znano površino in ceno; brez prodaj med sorodniki, deležev in skrajnih odstopanj."),
  n: t("Število poslov, iz katerih je izračunana vrednost. Mediano objavimo šele od 30 poslov naprej."),
  modelna: t("Izračun iz statističnega modela, ne podatek iz evidence."),
  donos: t("12 × mediana mesečne najemnine na m², deljeno z mediano cene na m². Pred stroški, davki, vzdrževanjem in praznimi meseci."),
} as const;

/** A statistical term with its plain-language explanation in a native popover (keyboard and Esc handled by the browser). */
export function Term({ children, text }: { children: ReactNode; text: string }) {
  const id = useId();
  return <>
    <button type="button" className="term" popoverTarget={id}>{children}</button>
    <span id={id} popover="auto" role="tooltip" className="term-popover">{text}</span>
  </>;
}
