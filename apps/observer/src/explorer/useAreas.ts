import { useMemo } from "react";
import { ApiError, loadDistrictList, loadGeography, loadMunicipalityList, loadRegions, loadShapes, type Geography } from "../api";
import { useLoad } from "../hooks/useLoad";

export interface GeographyLists { regions: Geography[]; municipalities: Geography[]; districts: Geography[] }

/** Regions, municipalities and city districts (search, breadcrumbs and rankings), loaded once. */
export function useGeographyLists() {
  return useLoad("geography-lists", async (signal): Promise<GeographyLists> => {
    const [regions, municipalities, districts] = await Promise.all([loadRegions(signal), loadMunicipalityList(signal), loadDistrictList(signal)]);
    return { regions: regions.items, municipalities: municipalities.items, districts: districts.items };
  });
}

/** Region and municipality outlines for the map. */
export function useShapes() {
  const municipalities = useLoad("shapes-municipality", (signal) => loadShapes("municipality", signal));
  const regions = useLoad("shapes-region", (signal) => loadShapes("statistical_region", signal));
  return { municipalities, regions };
}

/** Parents of an area, narrowest first, up to (not including) the country; from the loaded lists, else from the API. */
async function parentsOf(area: Geography, byId: Map<number, Geography>, signal: AbortSignal) {
  const parents: Geography[] = [];
  let parentId = area.parentId;
  while (parentId && parents.length < 4) {
    const parent = byId.get(parentId) ?? await loadGeography(parentId, signal);
    if (parent.level === "country") break;
    parents.push(parent);
    parentId = parent.parentId;
  }
  return parents;
}

type AreaChain =
  | { status: "none" | "loading" }
  | { status: "ok"; unit: Geography; chain: Geography[] }
  | { status: "missing" }
  | { status: "failed"; retry: () => void };

/**
 * The selected area and its parents (breadcrumb, comparison lines). Districts, municipalities and regions are in the
 * lists already, so a link to them needs no extra request; only a settlement (or a failed list) is fetched.
 */
export function useAreaChain(g: number | undefined, lists: { data?: GeographyLists; error?: unknown }): AreaChain {
  const byId = useMemo(() => new Map([...(lists.data?.regions ?? []), ...(lists.data?.municipalities ?? []), ...(lists.data?.districts ?? [])]
    .map((item) => [item.id, item])), [lists.data]);
  const listed = g ? byId.get(g) : undefined;
  const settled = !!lists.data || !!lists.error;
  const local = useMemo(() => {
    if (!listed) return undefined;
    const chain: Geography[] = [];
    for (let parent = listed.parentId ? byId.get(listed.parentId) : undefined; parent && chain.length < 4; parent = parent.parentId ? byId.get(parent.parentId) : undefined) chain.push(parent);
    return { unit: listed, chain };
  }, [byId, listed]);
  const remote = useLoad(g && settled && !listed ? `area-${g}` : null, async (signal) => {
    const unit = await loadGeography(g!, signal);
    return { unit, chain: await parentsOf(unit, byId, signal) };
  });
  if (!g) return { status: "none" };
  if (local) return { status: "ok", ...local };
  if (remote.data) return { status: "ok", ...remote.data };
  // Only a 404 means the area does not exist; anything else is a temporary failure with a retry.
  if (remote.error) return remote.error instanceof ApiError && remote.error.status === 404 ? { status: "missing" } : { status: "failed", retry: remote.retry };
  return { status: "loading" };
}
