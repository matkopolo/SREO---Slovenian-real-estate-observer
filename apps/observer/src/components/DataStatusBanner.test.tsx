import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DataStatusBanner, dataNotice, type DataStatus } from "./DataStatusBanner";

const release = (extra: Partial<NonNullable<DataStatus["activeRelease"]>> = {}) => ({
  id: "a", status: "published" as const, stage: "published", startedAt: "2026-11-08T16:00:00Z",
  analyticsSaleThrough: "2026-10-01T00:00:00Z", ...extra,
});
const now = new Date("2026-11-09T12:00:00Z");

afterEach(() => cleanup());

it("says nothing when the published data is current", () => {
  expect(dataNotice({ status: "current", activeRelease: release() }, now)).toBeUndefined();
  expect(dataNotice(undefined, now)).toBeUndefined();
});

it("keeps a quiet, dated note while a release is published: in progress, failed and stale", () => {
  const processing = dataNotice({ status: "processing", activeRelease: release(),
    pendingRelease: release({ id: "p", status: "processing", stage: "models", sourceSaleThrough: "2026-11-01T00:00:00Z" }) }, now);
  expect(processing?.tone).toBe("note");
  expect(processing?.text).toBe("Podatki do 1. 10. 2026 · podatki se osvežujejo");
  expect(processing?.detail).toContain("1. 11. 2026");
  expect(processing?.detail).toContain("učenje in preverjanje modelov");
  expect(dataNotice({ status: "processing", activeRelease: release(), pendingRelease: release({ id: "p", stage: "source" }) }, now)?.text)
    .toBe("Podatki do 1. 10. 2026 · nova posodobitev čaka na GURS");
  const failed = dataNotice({ status: "failed", activeRelease: release(), lastFailedRelease: release({ id: "f", status: "failed" }) }, now);
  expect(failed?.tone).toBe("note");
  expect(failed?.text).toBe("Podatki do 1. 10. 2026 · posodobitev bomo ponovili");
  const stale = dataNotice({ status: "current", activeRelease: release({ analyticsSaleThrough: "2026-05-01T00:00:00Z" }) }, now);
  expect(stale?.tone).toBe("note");
  expect(stale?.text).toBe("Podatki do 1. 5. 2026 · nova posodobitev čaka na GURS");
});

it("is prominent only when there is no release at all", () => {
  expect(dataNotice({ status: "processing" }, now)?.tone).toBe("missing");
  render(<DataStatusBanner status={{ status: "processing" }}/>);
  expect(screen.getByRole("status").firstElementChild).toHaveClass("missing");
  expect(screen.getByRole("status")).toHaveTextContent("Podatki še niso objavljeni");
});

it("renders a failed update as a muted line with the detail as its tooltip, never as an outage box", () => {
  render(<DataStatusBanner status={{ status: "failed", activeRelease: release(), lastFailedRelease: release({ id: "f", status: "failed" }) }}/>);
  const region = screen.getByRole("status");
  expect(region).toHaveTextContent("Podatki do 1. 10. 2026 · posodobitev bomo ponovili");
  const line = region.firstElementChild!;
  expect(line).toHaveClass("note");
  expect(line).not.toHaveClass("missing");
  expect(line).toHaveAttribute("title", expect.stringContaining("ni uspela"));
  expect(region.querySelector("button")).toBeNull();
});

it("renders an empty live region when all is well", () => {
  render(<DataStatusBanner status={{ status: "current", activeRelease: release({ analyticsSaleThrough: new Date().toISOString() }) }}/>);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});
