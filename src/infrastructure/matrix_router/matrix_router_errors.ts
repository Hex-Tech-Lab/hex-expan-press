/**
 * Thrown when every rail in a routing context is marked down by the circuit breaker, including the single-rail case.
 * Its own module (not matrix_router.ts) so callers can test `instanceof` against it, and so a module mock of the router
 * cannot hide it. Callers map it to 503 (unavailable); they must not fall back to a rail the breaker has taken out.
 */
export class MatrixRouterUnavailableError extends Error {
  readonly code = "MATRIX_ROUTER_UNAVAILABLE";
  readonly namespace: string;
  readonly contextId: string;

  constructor(namespace: string, contextId: string) {
    super(`MatrixRouter: every rail is marked down for ${namespace}/${contextId}`);
    this.name = "MatrixRouterUnavailableError";
    this.namespace = namespace;
    this.contextId = contextId;
  }
}
