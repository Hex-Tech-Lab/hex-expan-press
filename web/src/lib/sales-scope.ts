/**
 * The buyer-facing country restriction message, the single copy shared by the proxy (pay-host checkout gate) and the checkout
 * route (buyerCountryError). Pure string, no imports, so the edge proxy and the route can both use it.
 */
export const COUNTRY_RESTRICTION_MESSAGE =
  "We currently sell only to buyers in the United States, its territories, and the District of Columbia.";
