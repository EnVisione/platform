import { defineConfig } from "vite";
export default defineConfig({
  base: "/__staff/",
  build: {
    assetsInlineLimit: 0,
    rollupOptions: { input: { staff: "index.html", public: "public.html" } },
  },
});
