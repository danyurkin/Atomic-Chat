# llama.cpp backends manifest

## What it is

`backends.json` is a small, self-hosted **mirror of one ggml-org/llama.cpp GitHub
release** (its tag and the list of asset filenames). The desktop app reads it to
discover the newest llama.cpp build it can download, **instead of calling
`api.github.com` at runtime**.

Why: the unauthenticated GitHub API is rate-limited to 60 requests/hr/IP. Fresh
installs (especially on shared/NAT'd Windows networks) hit that limit and silently
got *zero* downloadable backends -- a no-backend dead-end (GH #56 / ATO-199). A
single static asset has no such limit.

Note: only the **index lookup** moved. The actual backend archives still download
from the ggml-org CDN -- the app reconstructs each download URL from the asset name
in the manifest against `github.com/ggml-org/llama.cpp/releases/download/<tag>/...`.

## Shape contract (do not break)

The app parser (`extensions/llamacpp-upstream-extension/src/backend.ts`) reads
`release.tag_name` and iterates `release.assets[].name`, regex-matching the GitHub
asset filenames. The manifest therefore **mirrors GitHub's release JSON shape**:

```json
{
  "schemaVersion": 1,
  "generatedAt": "<ISO-8601 UTC>",
  "tag_name": "<ggml-org release tag, e.g. b9690>",
  "assets": [ { "name": "llama-<tag>-bin-win-cpu-x64.zip" }, ... ]
}
```

A keyed `{ backends, cudart }` URL map would be read by the parser as **zero
assets** and every fetch would return `[]` -- the exact dead-end this change fixes.
Keep the mirror shape.

## Stable URL

The app fetches this permanent URL (fixed release tag `backend-manifest`, fixed
asset name `backends.json` -- only the contents change):

```
https://github.com/AtomicBot-ai/Atomic-Chat/releases/download/backend-manifest/backends.json
```

## How it's updated

`.github/workflows/update-backends-manifest.yml` runs hourly (cron `37 * * * *`)
and on manual dispatch. Each run:

1. Runs `scripts/update-backends-manifest.mjs`, which:
   - lists the latest 100 ggml-org/llama.cpp releases,
   - picks the newest non-draft / non-prerelease whose **fully-uploaded** assets
     include **every** required backend + cudart file,
   - **verifies every download URL is reachable** (redirect-safe ranged GET) before
     writing,
   - writes `backends.json` atomically (temp file + rename).
2. Ensures the `backend-manifest` release exists (creates it once if missing).
3. Uploads `backends.json` to that release with `--clobber` (in-place replace).
4. On failure, opens/updates a tracking GitHub issue so a frozen manifest is
   visible (the only other signal is a red Actions run nobody watches).

The script needs Node 20+ and **no npm dependencies**.

## Invariants

- **No-overwrite-on-failure.** Any error (network, missing/partial asset,
  unreachable URL, unparseable response) makes the generator exit non-zero *before*
  writing, and the workflow's later create/upload steps never run. The previously
  published (last-good) `backends.json` is left untouched.
- **Token never leaves api.github.com.** The `GITHUB_TOKEN` is sent only to the
  releases API. Download-URL verification sends no auth, so the bearer token is
  never forwarded across the redirect to the asset CDN.
- **Never cache empty (app side).** The app keeps a disk cache of the last
  *non-empty* catalog and falls back to it when the manifest is unreachable. It
  **never** caches an empty result: callers treat an empty catalog as the canonical
  "offline / release stream unreachable" signal, so caching `[]` would poison it.
  Offline resolution order: live manifest -> last-good disk cache -> `[]`
  (bundled/local only).
- **macOS is bundled-only.** The app never fetches the manifest on macOS; the
  resolver returns `[]` before any network call there, by design.

## Known limits / follow-ups

- **CUDA minors (`12.4`, `13.3`) are pinned** in the generator's required-asset
  list. When ggml-org bumps a minor (e.g. `12.4 -> 12.6`), no scanned release will
  match -> the generator exits non-zero -> last-good is preserved (safe) and the
  failure-issue is filed. Resolution requires editing the script. The app-side
  regex is already minor-agnostic; deriving the minors from the release contents is
  a worthwhile follow-up.
- **First-run upload failure** leaves the `backend-manifest` release with no asset
  -> the URL 404s and apps fall back to cache/local. Not a regression for existing
  users (the asset already exists, so `create` is skipped).
- **No Linux CUDA build** -- ggml-org publishes none; Linux NVIDIA users use the
  Vulkan backend. The app currently surfaces this silently; a user-facing note is a
  possible follow-up.
