#!/usr/bin/env node
// scripts/update-backends-manifest.mjs
//
// Generates backends.json: a static, self-hosted MIRROR of one ggml-org/llama.cpp
// GitHub release, so the Atomic Chat desktop app never calls api.github.com at
// runtime (the unauthenticated API's 60 req/hr/IP limit silently dead-ended fresh
// Windows installs -- GH #56 / ATO-199).
//
// SHAPE CONTRACT (critical): the app's parser (extensions/llamacpp-upstream-extension/
// src/backend.ts) reads `release.tag_name` and iterates `release.assets[].name`,
// regex-matching the GitHub asset filenames. Therefore this manifest MUST mirror
// GitHub's release JSON exactly:
//   { schemaVersion, generatedAt, tag_name, assets: [ { name } ... ] }
// Do NOT emit a {backends,cudart} keyed-URL map -- the parser would read it as
// zero assets and every fetch would return [] (the exact dead-end we are fixing).
//
// Resolves the newest ggml-org/llama.cpp release whose FULLY-UPLOADED assets include
// every required backend + cudart file, verifies every download URL is reachable
// (ranged GET, redirect-safe), then writes backends.json atomically.
//
// No-overwrite-on-failure: on ANY error (network, missing asset, unreachable URL)
// the process exits non-zero WITHOUT touching backends.json, so the last-good
// manifest is preserved and the workflow's publish steps never run.
//
// Requires Node 20+ (global fetch). No npm dependencies.
// Auth: uses process.env.GITHUB_TOKEN if present (raises rate limits / avoids 403)
//       for the api.github.com listing ONLY -- never for asset-CDN requests.

import { writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const OWNER = "ggml-org";
const REPO = "llama.cpp";
const PER_PAGE = 100; // M2 fix: scan deep enough to skip churn / partial releases.

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "backends.json");

// Required backend asset filenames (functions of the release tag). Keys are only
// labels for error messages; the app keys off the filenames themselves.
// CUDA minors (12.4, 13.3) are what ggml-org currently ships. There is
// intentionally NO linux-cuda entry: ggml-org publishes no ubuntu CUDA build
// (Linux NVIDIA users use the Vulkan backend).
const REQUIRED_BACKENDS = {
  "win-cpu-x64": (t) => `llama-${t}-bin-win-cpu-x64.zip`,
  "win-cuda-12.4-x64": (t) => `llama-${t}-bin-win-cuda-12.4-x64.zip`,
  "win-cuda-13.3-x64": (t) => `llama-${t}-bin-win-cuda-13.3-x64.zip`,
  "win-vulkan-x64": (t) => `llama-${t}-bin-win-vulkan-x64.zip`,
  "ubuntu-x64": (t) => `llama-${t}-bin-ubuntu-x64.tar.gz`,
  "ubuntu-vulkan-x64": (t) => `llama-${t}-bin-ubuntu-vulkan-x64.tar.gz`,
};

// CUDA runtime companion zips (Windows only; tag-independent filenames).
const REQUIRED_CUDART = {
  "win-cuda-12.4-x64": () => `cudart-llama-bin-win-cuda-12.4-x64.zip`,
  "win-cuda-13.3-x64": () => `cudart-llama-bin-win-cuda-13.3-x64.zip`,
};

// api.github.com headers: token is fine here (same origin we authenticate to).
function apiHeaders() {
  const h = {
    "User-Agent": "atomic-chat-backends-manifest",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function fetchReleases() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=${PER_PAGE}`;
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub releases API returned ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Unexpected releases API response (not an array)");
  }
  return data;
}

// Required filenames for a given tag (backends + cudart), in a stable order.
function requiredFilenames(tag) {
  return [
    ...Object.values(REQUIRED_BACKENDS).map((make) => make(tag)),
    ...Object.values(REQUIRED_CUDART).map((make) => make()),
  ];
}

// True iff this release has every required asset AND each is fully uploaded.
// M1 fix: ignore assets still in `state: "uploading"/"starting"` so we skip an
// in-progress release and pick the prior complete one instead of going red.
function releaseHasAllAssets(release) {
  const tag = release.tag_name;
  if (!tag) return false;
  const ready = new Set(
    (release.assets || [])
      .filter((a) => a.state === "uploaded")
      .map((a) => a.name)
  );
  return requiredFilenames(tag).every((name) => ready.has(name));
}

function downloadUrl(tag, filename) {
  return `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${filename}`;
}

// Verify a download URL is reachable.
// C1 fix: NEVER send Authorization / api Accept here. These URLs 302-redirect to
//   objects.githubusercontent.com (signed CDN); forwarding a bearer token across
//   that redirect leaks it, and signed URLs reject extra auth (-> false failures).
// C2 fix: many CDN signed URLs reject HEAD (403/405) but serve GET. Use a ranged
//   GET (1 byte) following redirects; accept 200 or 206.
async function verifyUrl(url) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "atomic-chat-backends-manifest",
      Range: "bytes=0-0",
    },
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`GET ${url} -> ${res.status} (expected 200/206)`);
  }
  // Drain/cancel the (tiny) body so the socket can be reused/closed promptly.
  try {
    await res.body?.cancel?.();
  } catch {
    /* ignore */
  }
}

async function main() {
  const releases = await fetchReleases();

  // Newest-first; first non-draft, non-prerelease with every fully-uploaded asset.
  const chosen = releases.find(
    (r) => !r.draft && !r.prerelease && releaseHasAllAssets(r)
  );
  if (!chosen) {
    throw new Error(
      `No release among the latest ${PER_PAGE} has all required (fully-uploaded) assets`
    );
  }

  const tag = chosen.tag_name;
  const filenames = requiredFilenames(tag);

  // Verify every download URL BEFORE writing anything. Any failure throws -> no write.
  await Promise.all(filenames.map((name) => verifyUrl(downloadUrl(tag, name))));

  // GitHub-MIRROR shape: tag_name + assets[].name. This is exactly what the app's
  // parser consumes, so backend.ts needs no shape-specific logic.
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tag_name: tag,
    assets: filenames.map((name) => ({ name })),
  };

  // Atomic local write (temp + rename). The published artifact is whatever
  // `gh release upload --clobber` reads; this just guarantees the workspace file
  // is never left partial if the process is interrupted mid-write.
  const json = JSON.stringify(manifest, null, 2) + "\n";
  const tmp = `${OUT_PATH}.tmp`;
  writeFileSync(tmp, json, "utf8");
  renameSync(tmp, OUT_PATH);

  console.log(
    `Wrote ${OUT_PATH} for llama.cpp ${tag} (${filenames.length} assets verified)`
  );
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  console.error("backends.json was NOT modified (last-good preserved).");
  process.exit(1);
});
