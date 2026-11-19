/**
 * The API client, in modules under src/api/: the fetch client and cache (client), the lag-aware periods (periods), the
 * contract's types (types), geographies and outlines (geographies), what the map draws (map), statistics (statistics) and
 * a sale's evidence (evidence). This barrel keeps `import … from "../api"` as the one import path.
 */
export * from "./api/client";
export * from "./api/periods";
export * from "./api/types";
export * from "./api/geographies";
export * from "./api/map";
export * from "./api/statistics";
export * from "./api/evidence";
