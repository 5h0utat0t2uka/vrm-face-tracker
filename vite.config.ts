import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  worker: { format: "es" },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep Three.js's core and renderer at their existing module boundaries.
          // Higher priorities claim shared dependencies before the VRM group does.
          groups: [
            {
              name: "three-core",
              test: /node_modules[\\/]three[\\/]build[\\/]three\.core\.js$/,
              priority: 30,
            },
            {
              name: "three-renderer",
              test: /node_modules[\\/]three[\\/]build[\\/]three\.module\.js$/,
              priority: 20,
            },
            {
              name: "three-vrm",
              test: /node_modules[\\/]@pixiv[\\/]three-vrm[^\\/]*[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
