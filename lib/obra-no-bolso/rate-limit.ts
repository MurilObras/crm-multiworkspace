import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { validarConfigRedisRest } from "@/lib/redis-config";

let redis: Redis | null = null;

/** Este webhook não aceita o fallback em memória por instância do limitador geral. */
export async function checkObraAccessRate(integrationId: string): Promise<boolean> {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!validarConfigRedisRest(url, token).ok) throw new Error("rate_limit_unavailable");
  redis ??= new Redis({ url, token, retry: false });
  const minute = Math.floor(Date.now() / 60_000);
  const key = `obra-access:${integrationId}:${minute}`;
  try {
    const count = await redis.incr(key);
    await redis.expire(key, 120);
    return count <= 60;
  } catch {
    throw new Error("rate_limit_unavailable");
  }
}
