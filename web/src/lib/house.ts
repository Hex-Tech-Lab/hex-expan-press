/**
 * The one house check for every surface. Reads the operator-set creators.is_house column
 * (creators_is_house_guard), never the display name: a creator who types the brand name is not the house.
 * Lives in lib (not a component) so server-only modules such as book-assets can import it without a cycle.
 */
export function isHouse(flag: unknown): boolean {
  return flag === true;
}

export function isHouseCreator(creator: { is_house?: boolean | null }): boolean {
  return isHouse(creator.is_house);
}
