import { paraglideVitePlugin } from "@inlang/paraglide-js";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";

// SvelteKit 3 no longer reads svelte.config.js — every kit option is passed to
// the plugin here.
//
// `@/` stays the import root, exactly as it was in the Next app, so the ported
// lib and components keep their imports untouched. tsconfig.json mirrors this
// alias for typechecking.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  ssr: {
    // bits-ui (behind every shadcn-svelte component) ships raw `.svelte` files in
    // dist/. Vite externalizes node_modules for SSR by default, which hands Node
    // a `.svelte` path it cannot load (ERR_UNKNOWN_FILE_EXTENSION) — so those
    // packages are bundled through the Svelte compiler instead.
    noExternal: ["bits-ui", "@lucide/svelte"],
  },
  plugins: [
    // i18n (Paraglide JS). The locale comes from a cookie, defaulting to the base
    // locale — deliberately NOT from a URL prefix: this is a local-first
    // single-user dashboard, so there is nobody to share a `/es/pipeline` link
    // with, and a prefix would have to be stripped before every one of the 48
    // API routes and re-added to every nav link. The middleware that reads the
    // cookie lives in src/hooks.server.ts, inside the origin guard.
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      emitTsDeclarations: true,
      strategy: ["cookie", "baseLocale"],
    }),
    tailwindcss(),
    sveltekit({
      adapter: adapter({ out: "build" }),
    }),
  ],
});
