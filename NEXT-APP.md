# Combined AT-track app

Open https://dazzlingfields.github.io/AT-track/next/ for the combined live map and performance app. The original map remains at the site root.

The static app uses the existing Cloudflare Worker for its cached public route catalogue and authenticated performance APIs. See performance/next/README.md for setup, build and login details.

Rebuild with `node scripts/build-pages.cjs` and update `next/` from `dist/pages/next/`. Deploy backend changes through the existing performance/cloud/deploy.ps1 workflow. Do not publish credential files or local databases.
