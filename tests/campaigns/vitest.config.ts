import { defineConfig } from "vitest/config";
import path from "node:path";

// Nao carrega .env: todas as fronteiras externas sao dubladas nesta suite.
export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../..") } },
  test: {
    environment: "node",
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://campaigns-test.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    },
    include: ["tests/campaigns/*.test.ts", "tests/campaigns/*.test.tsx", "tests/unit/messages-handler-*.test.ts",
      "tests/unit/navegacao-*.test.ts", "tests/unit/mapas-de-arquitetura.test.ts"],
  },
});
