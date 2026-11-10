import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { clearApiCache } from "./api";

// Fixtures are dated 2026: the clock is pinned so "this year" and "five years" never drift (Date only; timers stay real).
vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
// Every test starts without the previous test's shared requests and answers.
beforeEach(() => clearApiCache());
afterEach(() => clearApiCache());
