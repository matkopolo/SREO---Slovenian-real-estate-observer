import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { t, tx } from "./index";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); window.localStorage.removeItem("sreo-language"); });

it("fills placeholders by name, leaves an unknown one verbatim and ignores prototype keys", () => {
  expect(t("{a} in {b}", { a: 1, b: "dva" })).toBe("1 in dva");
  expect(t("{a} in {b}", { a: 1 })).toBe("1 in {b}");
  expect(t("{constructor}", {})).toBe("{constructor}");
  expect(t("{a}", { a: null })).toBe("");
  // A value that itself contains braces is not expanded again.
  expect(t("{a}", { a: "{b}" })).toBe("{b}");
});

it("renders nodes into a template without parsing HTML", () => {
  render(<p>{tx("Vir {licence}, {raw}", { licence: <abbr title="CC">CC BY 4.0</abbr>, raw: "<b>x</b>" })}</p>);
  expect(screen.getByText("CC BY 4.0").tagName).toBe("ABBR");
  expect(screen.getByText(/<b>x<\/b>/)).toBeInTheDocument();
  expect(document.querySelector("b")).toBeNull();
});

it("in English falls back to the Slovenian text for a missing entry and logs it once", async () => {
  window.localStorage.setItem("sreo-language", "en");
  vi.resetModules();
  const english = await import("./index");
  await english.loadEnglish();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(english.LANG).toBe("en");
  expect(english.t("Jezik")).toBe("Language");
  expect(english.t("Tega ključa ni")).toBe("Tega ključa ni");
  expect(english.t("Tega ključa ni")).toBe("Tega ključa ni");
  expect(error).toHaveBeenCalledTimes(1);
  expect(english.missing.has("Tega ključa ni")).toBe(true);
});
