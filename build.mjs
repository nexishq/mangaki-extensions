#!/usr/bin/env node
// Build script — bundles each `sources/<id>/source.ts` into a single
// IIFE-wrapped JS file under `dist/sources/<id>/source.js`, copies the
// manifest, and emits the top-level `versioning.json` index.
//
// The native iOS side fetches `versioning.json` to discover what's
// available, then downloads the specific bundle URLs listed inside it.

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const sourcesDir = join(root, "sources");
const distDir = join(root, "dist");
const distSourcesDir = join(distDir, "sources");

mkdirSync(distSourcesDir, { recursive: true });

const sources = readdirSync(sourcesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const indexEntries = [];

for (const id of sources) {
  const sourceDir = join(sourcesDir, id);
  const entry = join(sourceDir, "source.ts");
  const manifestPath = join(sourceDir, "manifest.json");

  if (!existsSync(entry) || !existsSync(manifestPath)) {
    console.warn(`[skip] ${id}: missing source.ts or manifest.json`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const outDir = join(distSourcesDir, id);
  const outFile = join(outDir, "source.js");
  mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    // Expose the default export as `globalThis.MangakiExtension` so the
    // native ExtensionRuntime can find and instantiate it.
    globalName: "__source",
    footer: { js: "globalThis.MangakiExtension = __source.default;" },
    platform: "neutral",
    target: ["es2020"],
    minify: false,
    sourcemap: false,
    outfile: outFile,
    logLevel: "info",
  });

  // Copy manifest into dist for parity with the source folder.
  copyFileSync(manifestPath, join(outDir, "manifest.json"));

  // Build the index entry with the bundle path relative to repo root.
  indexEntries.push({
    ...manifest,
    bundle: `sources/${id}/source.js`,
  });

  console.log(`[build] ${id} v${manifest.version}`);
}

// Top-level index served at `<repo-root>/versioning.json` and also
// inside dist for static-hosting deploys.
const index = {
  version: 1,
  sources: indexEntries,
};
writeFileSync(join(distDir, "versioning.json"), JSON.stringify(index, null, 2));
writeFileSync(join(root, "versioning.json"), JSON.stringify(index, null, 2));

console.log(`[done] ${indexEntries.length} source(s) built`);
