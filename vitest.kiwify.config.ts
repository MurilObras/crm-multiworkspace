import { defineConfig } from "vitest/config";
import path from "node:path";

// Alternativa nativa ao Docker: MESMO PostgreSQL/prelude/baseline, nunca PGlite/mock.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/invariants/kiwify*.test.ts", "tests/invariants/kiwify*.integration.ts", "tests/invariants/automation*.test.ts", "tests/invariants/webhooks-rls.test.ts", "tests/invariants/lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ["./tests/db/kiwify-native-reset.ts"],
    env: {
      KIWIFY_TEST_NATIVE: "1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-not-for-production",
      SENTRY_DSN: "off",
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
