import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DataStatusBanner, dataNotice, type DataStatus } from "./DataStatusBanner";

const release = (extra: Partial<NonNullable<DataStatus["activeRelease"]>> = {}) => ({
  id: "a", status: "published" as const, stage: "published", startedAt: "2026-11-08T16:00:00Z",
  analyticsSaleThrough: "2026-10-01T00:00:00Z", ...extra,
});
const now = new Date("2026-11-09T12:00:00Z");

afterEach(() => { cleanup(); window.sessionStorage.clear(); });

it("says nothing when the published data is current", () => {
  expect(dataNotice({ status: "current", activeRelease: release() }, now)).toBeUndefined();
  expect(dataNotice(undefined, now)).toBeUndefined();
});

it("describes a release in progress, a failed update and stale data", () => {
  const processing = dataNotice({ status: "processing", activeRelease: release(),
    pendingRelease: release({ id: "p", status: "processing", stage: "models", sourceSaleThrough: "2026-11-01T00:00:00Z" }) }, now);
  expect(processing?.tone).toBe("processing");
  expect(processing?.title).toBe("Novi podatki GURS so v obdelavi");
  expect(processing?.text).toContain("1. 11. 2026");
  expect(processing?.text).toContain("učenje in preverjanje modelov");
  expect(dataNotice({ status: "processing", activeRelease: release(), pendingRelease: release({ id: "p", stage: "source" }) }, now)?.title)
    .toBe("Preverjamo nove podatke GURS");
  expect(dataNotice({ status: "failed", activeRelease: release(), lastFailedRelease: release({ id: "f", status: "failed" }) }, now)?.tone).toBe("failed");
  expect(dataNotice({ status: "current", activeRelease: release({ analyticsSaleThrough: "2026-05-01T00:00:00Z" }) }, now)?.tone).toBe("stale");
});

it("renders a polite, dismissible notice", () => {
  render(<DataStatusBanner status={{ status: "failed", activeRelease: release(), lastFailedRelease: release({ id: "f", status: "failed" }) }}/>);
  const region = screen.getByRole("status");
  expect(region).toHaveTextContent("Zadnja posodobitev podatkov ni uspela");
  fireEvent.click(screen.getByRole("button", { name: "Zapri obvestilo" }));
  expect(region).toBeEmptyDOMElement();
  expect(window.sessionStorage.getItem("sreo-data-notice-dismissed")).toBe("failed:f");
});

it("renders an empty live region when all is well", () => {
  render(<DataStatusBanner status={{ status: "current", activeRelease: release({ analyticsSaleThrough: new Date().toISOString() }) }}/>);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});
