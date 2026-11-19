import type { components } from "../generated/api-schema";

type Schemas = components["schemas"];
export type Affordability = Schemas["Affordability"];
export type ConstructionSummary = Schemas["ConstructionSummaryResponse"];
export type TimePoint = Schemas["StatisticsTimeSeriesPoint"];
export type RentalTimePoint = Schemas["RentalStatisticsTimeSeriesPoint"];
export type Geography = Schemas["Geography"];
export type StatisticsOverview = Schemas["StatisticsOverview"];
export type RentalOverview = Schemas["RentalStatisticsOverview"];
export type Distribution = Schemas["Distribution"];
export type MarketIndex = Schemas["MarketIndex"];
export type BuildingStatistics = Schemas["BuildingStatistics"];
export type SaleTransaction = Schemas["SaleTransactionDetail"];
export type RentalTransaction = Schemas["RentalTransactionDetail"];
/** One agreement behind the current-market estimate, with its place on the map. */
export type MarketComparable = Schemas["MarketComparable"];
export type TransactionContext = Schemas["TransactionContext"];
export type PropertyHistory = Schemas["PropertyHistory"];
export type Valuation = Schemas["ValuationPrediction"];
export type Outlier = Schemas["Outlier"];
export type DemographicsResponse = Schemas["DemographicsResponse"];
export type MunicipalDemographics = Schemas["MunicipalDemographics"];
export type MapBuilding = Schemas["MapBuilding"];
export type RecentTransaction = Schemas["RecentTransactions"]["items"][number];
export type GeographyLevel = "statistical_region" | "municipality";
export type FineLevel = "city_district" | "settlement";
export type TransactionKind = "sale" | "rent";

/** Property type and optional floor-area band shared by every market call. */
export type PropertyGroup = "apartment" | "house" | "land" | "commercial" | "garage";
/** Land sales by registered use: buildable (ETN 1–2), agricultural, forest, or all land. */
export type LandScope = "strict" | "agricultural" | "forest" | "all";
/** Rentals also have rooms (sobe), which are never sold separately. */
export type RentGroup = "apartment" | "house" | "commercial" | "garage" | "room";
export interface Segment { propertyGroup: PropertyGroup; minArea?: number; maxArea?: number; landScope?: LandScope }
/** A rental segment: like a sale segment, but rooms are allowed. */
export interface RentSegment { propertyGroup: RentGroup; minArea?: number; maxArea?: number }
export const APARTMENTS: Segment = { propertyGroup: "apartment" };
/** Affordability (wages, lending rules) only applies to homes. */
export const isDwelling = (group: PropertyGroup): group is "apartment" | "house" => group === "apartment" || group === "house";
export const segmentQuery = (segment: Segment | RentSegment) => ({ propertyGroup: segment.propertyGroup, minArea: segment.minArea, maxArea: segment.maxArea,
  landScope: segment.propertyGroup === "land" ? segment.landScope ?? "strict" : undefined });
