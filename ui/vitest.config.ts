import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"], environment: "node", testTimeout: 30000 },
});
