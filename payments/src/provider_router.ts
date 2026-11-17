import { MatrixRouter } from "../../src/infrastructure/matrix_router/matrix_router.ts";
import { expanRedis } from "../../src/infrastructure/redis/redis.client.ts";
import { PAYMENT_PROVIDERS } from "./settings_registry.ts";

export interface RailWeight {
  provider: string;
  weight: number;
}

export async function nextRail(productId: string, rails: RailWeight[]): Promise<string> {
  if (typeof productId !== "string" || productId.trim() === "") {
    throw new Error("rails: productId must be a non-empty string");
  }
  if (!Array.isArray(rails) || rails.length === 0) {
    throw new Error(`rails: nextRail(${productId}) needs a non-empty rails array`);
  }
  for (const r of rails) {
    if (typeof r?.provider !== "string" || r.provider.trim() === "" || typeof r?.weight !== "number" || !Number.isFinite(r.weight) || r.weight <= 0) {
      throw new Error(`rails: nextRail(${productId}) rails entries must be {provider: non-empty string, weight: finite number > 0}`);
    }
  }

  return MatrixRouter.getNextProvider("payments", productId, rails);
}

export async function skipRail(productId: string, provider: string, rails: RailWeight[], durationMs: number = 15 * 60 * 1000): Promise<void> {
  if (!rails.some((r) => r.provider === provider)) {
    throw new Error(`rails: skipRail(${productId}, ${provider}) — provider is not one of the product rails`);
  }
  await MatrixRouter.markProviderDown("payments", productId, provider, durationMs);
}

export async function resetRails(providers: readonly string[] = Object.keys(PAYMENT_PROVIDERS)): Promise<void> {
  const ids = ["t_ratio_2", "t_ratio_3", "t_skip", "t_all_down"];
  const uniqueProviders = [...new Set(providers)];
  const keys = ids.flatMap((id) => [
    `matrix:payments:${id}`,
    `matrix:payments:${id}:counter`,
    ...uniqueProviders.map((provider) => `matrix:payments:${id}:down:${provider}`),
  ]);
  await Promise.all(keys.map((key) => expanRedis.del(key)));
}
