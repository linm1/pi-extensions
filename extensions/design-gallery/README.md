# design-gallery (Pi extension)

Browse the live `VoltAgent/awesome-design-md` catalog through getdesign.md in a
dedicated, disposable Chromium session, confirm a selection, and hand a
commit-pinned `DESIGN.md` off to this Pi agent. Design decisions and evidence
are recorded in `.wayfinder/`; this is the implementation.

## Setup (once per machine)

```bash
cd .pi/extensions/design-gallery
npm install
npx playwright install chromium
```

- `npm install` pulls the `playwright` runtime dependency into this
  extension's own `node_modules/` (jiti resolves it automatically; no global
  install needed).
- `npx playwright install chromium` downloads the bundled Chromium binary
  Playwright drives. Re-run it after upgrading the `playwright` version in
  `package.json`.
- **Windows:** the browser cache defaults to
  `%USERPROFILE%\AppData\Local\ms-playwright`. No admin rights are required;
  if corporate policy blocks the download, set `PLAYWRIGHT_DOWNLOAD_HOST` to
  an internal mirror, or ask an admin to pre-seed that cache directory. There
  is no fallback to a system Chrome/Edge channel in this extension by design
  (see `.wayfinder/Pi-owned browser runtime.md`) — Chromium must be
  installed.
- Optional: set `GITHUB_TOKEN` (a plain personal access token, no scopes
  needed for public repos) to raise the GitHub REST rate limit from
  60/hour to 5,000/hour.

Restart `pi`, or run `/reload`, so the project-local extension at
`.pi/extensions/design-gallery/` is picked up.

## Run

1. `/design-gallery`
   - Pins the current `awesome-design-md` catalog (branch head → commit →
     tree → README preview links).
   - Opens one headed, non-persistent Chromium window at `https://getdesign.md/`.
   - Click a design card. The extension only reacts to an exact
     `https://getdesign.md/<slug>/design-md` main-frame navigation for a slug
     that exists in the pinned catalog — nothing else is observed or scraped.
   - Confirm the import prompt. On "yes", `.pi/design-profile.json` is
     replaced atomically. On "no", keep browsing.
   - Closing the browser window cancels the session; nothing is written.
2. `/app-design <what to build>`
   - Validates `.pi/design-profile.json` (fixed repo, SHA formats, path,
     derived URLs).
   - Fetches `DESIGN.md` by its pinned `blobSha` only — never `main`, never
     the live getdesign.md preview — purely to confirm it is still
     retrievable.
   - Sends this Pi agent a user message with your request plus the
     `.pi/design-profile.json` path so it can read the profile and fetch the
     pinned content itself.

## Cleanup guarantees

The Chromium browser/context are closed on: normal completion (design
imported), the browser window being closed by the user, a thrown error
during discovery/browsing, and Pi's `session_shutdown` event (process exit,
`/new`, `/resume`, `/fork`). Re-running `/design-gallery` while a session is
still open closes the stale one first. No CDP, persistent profile, or
existing browser tab is ever used.

## Files

| File | Purpose |
| --- | --- |
| `src/index.ts` | Registers `/design-gallery` and `/app-design`, wires the modules below |
| `src/github.ts` | Catalog discovery + pinned `DESIGN.md` fetch (GitHub REST) |
| `src/browser-session.ts` | Headed non-persistent Playwright Chromium session lifecycle (has a runnable self-check) |
| `src/browser-session.selfcheck.ts` | Runnable check for popup capture, dedupe, and cleanup ordering |
| `src/url-allowlist.ts` | Exact getdesign.md selection-URL allow-list (has a runnable self-check) |
| `src/profile.ts` | `.pi/design-profile.json` build, atomic write, strict read/validate |
| `src/types.ts` | Shared types and the profile schema |

To exercise the self-checks in isolation (Node 22.6+, no browser or network needed):

```bash
node --experimental-strip-types src/url-allowlist.ts
node --experimental-strip-types src/browser-session.selfcheck.ts
```
