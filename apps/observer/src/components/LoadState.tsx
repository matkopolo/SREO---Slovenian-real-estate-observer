import type { ReactNode } from "react";
import type { Load } from "../hooks/useLoad";
import { t } from "../i18n";

/** A visible failure with a way to try again (instead of "Nalagam …" forever). */
export function LoadFailed({ retry, children }: { retry: () => void; children?: ReactNode }) {
  return <p className="error" role="alert">{children ?? t("Podatkov ni bilo mogoče naložiti.")}{" "}
    <button type="button" className="link" onClick={retry}>{t("Poskusi znova")}</button></p>;
}

/** Loading text, a failure with retry, or the content for the loaded data. */
export function LoadState<T>({ load, loading, children }: { load: Load<T>; loading?: ReactNode; children: (data: T) => ReactNode }) {
  if (load.error) return <LoadFailed retry={load.retry}/>;
  if (load.data === undefined) return <p className="muted" role="status">{loading ?? t("Nalagam …")}</p>;
  return <>{children(load.data)}</>;
}
