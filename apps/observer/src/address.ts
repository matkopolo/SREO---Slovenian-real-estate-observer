import { titleCase } from "./format";

/** A building's address as one line ("Dunajska cesta 221, Ljubljana"; rural: "Kozje 144"). Kept apart from the search, so pages that only show addresses do not load it. */
export function addressLabel(item: { street?: string | null; houseNumber?: string | null; houseNumberSuffix?: string | null; settlement?: string | null }) {
  const number = `${item.houseNumber ?? ""}${item.houseNumberSuffix ?? ""}`.trim();
  const settlement = titleCase(item.settlement);
  // Rural addresses have no street: the settlement carries the house number ("Kozje 144").
  if (!item.street) return [settlement, number].filter(Boolean).join(" ");
  const street = `${titleCase(item.street)} ${number}`.trim();
  return [street, settlement && settlement !== street ? settlement : ""].filter(Boolean).join(", ");
}
