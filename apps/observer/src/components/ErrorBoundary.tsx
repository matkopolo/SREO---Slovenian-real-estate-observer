import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";
import { isChunkLoadError, reloadOnce } from "../reload";

/** "The page was updated": a fallback that reloads it. */
function ReloadNotice({ text }: { text?: string }) {
  return <div className="module open" role="alert">
    <p className="error">{text ?? t("Stran je bila medtem posodobljena. Osvežite jo, da naložite novo različico.")}</p>
    <button type="button" className="ghost" onClick={() => window.location.reload()}>{t("Osveži stran")}</button>
  </div>;
}

interface Props {
  children: ReactNode;
  /** Names the failing part in the console ("[SREO] area panel failed"). */
  name: string;
  /** What the reader sees instead; a stale lazy chunk always gets the reload notice. */
  fallback?: (reset: () => void) => ReactNode;
  /** A new key (another area, another page) renders the children again. */
  resetKey: string;
}

/** One failing part never blanks the whole page; the reader gets a way back, and the console gets the cause. */
export class ErrorBoundary extends Component<Props, { error?: unknown; key: string }> {
  override state: { error?: unknown; key: string } = { key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  static getDerivedStateFromProps(props: Props, state: { error?: unknown; key: string }) {
    return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null;
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[SREO] ${this.props.name} failed`, error, info.componentStack); // i18n-ignore (console log, not shown)
    if (isChunkLoadError(error)) reloadOnce();
  }
  override render() {
    if (this.state.error === undefined) return this.props.children;
    if (isChunkLoadError(this.state.error) || !this.props.fallback) return <ReloadNotice text={isChunkLoadError(this.state.error) ? undefined : t("Tega dela strani ni bilo mogoče prikazati.")}/>;
    return this.props.fallback(() => this.setState({ error: undefined }));
  }
}
