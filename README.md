# pi-extensions

Personal collection of [Pi](https://pi.dev) extensions, packaged as one
installable `pi install` source instead of separate auto-discovered folders.

## Layout

```
pi-extensions/
├── package.json          # single pi package manifest (name, dependencies, pi.extensions glob)
└── extensions/
    └── design-gallery/   # one extension per subfolder
        └── src/
```

Adding a new extension: create `extensions/<name>/src/index.ts` exporting a
default factory function (see `extensions/design-gallery/src/index.ts`). The
root `package.json`'s `"pi": { "extensions": ["extensions/*/src/index.ts"] }`
glob picks it up automatically — no manifest edit needed. If it needs its own
npm dependency, add it to the root `package.json`'s `dependencies` (one
`node_modules/` and one `npm install` for the whole repo).

## Install

Local path (no remote needed):

```bash
pi install /c/Users/LinM1/pi-extensions
```

Once pushed to a git remote, switch to:

```bash
pi install git:github.com/<user>/pi-extensions
```

Either form runs `npm install` for you and adds the source to
`~/.pi/agent/settings.json`. Playwright's Chromium binary is not part of
`npm install`; run once per machine:

```bash
npx playwright install chromium
```
(from this repo's directory, or wherever `pi` cloned/installed it — see
`pi list` to find the install path).

`pi update --extensions` reconciles a git-installed copy to this repo's
latest commit on its pinned ref; `pi remove /c/Users/LinM1/pi-extensions` (or
the git source once switched) uninstalls it.

## Extensions

| Extension | Commands | Purpose |
| --- | --- | --- |
| [design-gallery](extensions/design-gallery/README.md) | `/design-gallery`, `/app-design` | Browse the VoltAgent/awesome-design-md catalog via getdesign.md, pin a commit-exact `DESIGN.md`, hand it to the current agent |
