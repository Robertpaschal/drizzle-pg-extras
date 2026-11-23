import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: [/^drizzle-orm/],
  },
  {
    entry: { cli: "src/bin.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
    external: [/^drizzle-orm/, "jiti"],
  },
]);
