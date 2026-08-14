---
name: dsh-feishu-connect-release
description: Use before publishing, releasing, or maintaining dsh-feishu-connect — the Feishu (Lark) bot bridge plugin for DeepSeek Harness. Covers npm publish flow, credential/token handling, the ~/.cc-connect config convention, full install verification, deployment sync, and git hygiene.
---

# dsh-feishu-connect Release & Maintenance

Maintainer-facing skill for the `dsh-feishu-connect` plugin repository. It is
written for the author (or an agent maintaining this repo), not for plugin
users — users only need the README install section.

## Repository layout

```
index.js            Host plugin (node half): helper management, commands,
                    session matching, typing reaction, feishu_send tool,
                    /feishu/admin/* routes
helper.cjs          Lark SDK WSClient long-connection subprocess (CJS;
                    package is ESM, so it must stay .cjs)
client.js           Browser bundle (hand-authored __ModuleLoader__.load,
                    no build step) — settings-page UI, admin RPC via fetch
cordis.patch.yml    Bundle patch layer: one insert row (id: feishu-bridge,
                    name: dsh-feishu-connect); drives BOTH halves
package.json        dsh.bundle.patch + dsh.client.platform manifest;
                    @larksuiteoapi/node-sdk dependency,
                    @deepseek-ai/dsh-tools peerDependency
feishu.config.example.json  Config template (no real secrets)
README.md           User-facing install/publish docs
.dsh/skills/        This maintainer skill (git-tracked, never ignore it)
```

## Config convention (cc-connect alignment)

- Config: `~/.cc-connect/feishu.config.json` — `{ workspace, appId, appSecret, reactionEmoji? }`
- Session state: `~/.cc-connect/state.json` (chat→session mapping)
- Resolved with `os.homedir()` in `index.js`; never in the workspace root or
  any code repository. `reactionEmoji` may be `'none'` to disable the typing
  reaction. Both files are re-read/written on demand; `mkdirSync(recursive)`
  creates `~/.cc-connect` on first save.
- Do NOT move config back into the workspace: that was the old design and
  leaks credentials into the harness repo.

## Publish flow

```sh
# 1. Edit code, run syntax checks
node --check index.js client.js helper.cjs

# 2. Bump version (working tree must be clean, or use --no-git-tag-version)
npm version patch            # or minor/major

# 3. Publish to the OFFICIAL registry — the local npm config points at
#    npmmirror which cannot publish; the .npmrc token is what npm actually
#    reads (NOT the NODE_AUTH_TOKEN env var alone)
npm publish --registry https://registry.npmjs.org

# 4. Commit + push (including package.json version bump)
git add -A && git commit -m "..." && git push origin main
```

### Token / 2FA facts (learned the hard way)

- The npm account (`lmber`) has 2FA enabled. Publishing requires a Granular
  Access Token with **"Bypass 2FA when using this token"** checked, or an
  interactive OTP.
- **`~/.npmrc` wins over `NODE_AUTH_TOKEN`.** If publish 403s with a 2FA
  error while `npm whoami` succeeds, the `.npmrc` line
  `//registry.npmjs.org/:_authToken=...` is stale — update it to the current
  token. A fresh `npm login --registry https://registry.npmjs.org` also fixes
  it (interactive).
- `npm whoami` succeeding proves auth, NOT publish permission. The 403 text
  "granular access token with bypass 2fa enabled is required" means exactly
  that: the token lacks the bypass flag.
- NEVER commit `.npmrc`, tokens, `feishu.config.json`, or any file containing
  appSecret. `.gitignore` must stay in force (see Git hygiene).

### Registry propagation

After publish, `npm view dsh-feishu-connect version` may briefly show the
previous version due to registry cache; wait a few seconds and re-query
`dist-tags.latest` to confirm.

## Install verification (always run before tagging a release)

1. Create a throwaway profile and install from the registry tarball:

```sh
pnpm dsh plugin --profile probe-release add dsh-feishu-connect@latest
```

2. First run on a fresh profile hits pnpm ≥10's `ERR_PNPM_IGNORED_BUILDS`
   (protobufjs build script). Fix in the scratch profile's
   `pnpm-workspace.yaml` and re-run the add:

```yaml
allowBuilds:
  protobufjs: true
```

3. Confirm the loader composed the row:

```sh
pnpm dsh --profile probe-release --dump-config   # expect: id: feishu-bridge
```

4. Confirm `dsh.profile.bundles` auto-wrote the package name in
   `$DSH_HOME/profiles/probe-release/package.json`, then delete the scratch
   profile dir.

5. Never verify against the live `web` profile with a second plugin install —
   mixing a manual `insert` row with the bundle layer double-registers
   (`duplicate loader entry id: feishu-bridge`).

## Deployment sync (this machine)

The running dsh web loads the plugin from
`$DSH_HOME/profiles/web/node_modules/dsh-feishu-bridge/` (pnpm-installed from
the github: spec, package name is whatever it was at install time). After
editing `index.js`/`client.js`/`README.md`:

```sh
Copy-Item index.js client.js README.md "C:\Users\mbli.IFLYTEK\.dsh\profiles\web\node_modules\dsh-feishu-bridge\" -Force
```

Then **restart `dsh web`** — the running process keeps old code in memory
until then. Client-modules re-reads `client.js` bytes per request, so a
browser refresh picks up client changes without a full restart, but the host
half needs the restart.

## Helper / process facts

- `HELPER_PATH = fileURLToPath(new URL('./helper.cjs', import.meta.url))` —
  resolves next to `index.js` wherever the package is installed.
- Helper spawn: `node helper.cjs <appId> <appSecret>`; auto-restarts on crash
  (5s cooldown) and reconnects when credentials change. Status visible at
  `/feishu/admin/status` (`connection`, `helperRunning`).
- Typing reaction: added on message arrival, removed ONLY after the reply
  card is delivered (cc-connect EventResult-then-stop order), or on turn
  failure. Needs `im:message.reaction` permission; add failure is logged but
  non-fatal.

## Agent/session notes

- Session matching is exact: `pickAgent` compares `session.header.cwd`
  normalized to `cfg.workspace`. Never fall back to another workspace.
- Dedicated sessions (`/new`, `/switch`) must pass `defaultAgentOptions()` on
  both `agents.create` and `agents.resume`, else `{{model}}` has no value.
- Command parser strips a leading `/` before matching (`/n`, `/sw`, `/l`,
  `/h` prefixes allowed).

## Git hygiene

`.gitignore` MUST keep ignoring (add if a release touches these):

```gitignore
node_modules/
*.log
*.tgz
.npmrc
feishu.config.json
.dsh-feishu/
*.local
.DS_Store
```

- The `.dsh/skills/` directory is **tracked** — do not ignore it.
- Before `git add -A`, run `git status --short` and confirm no secret-bearing
  file (config with real appSecret, .npmrc, tgz) is staged. A real secret has
  leaked once via a manual-copy junction bug — never let it happen again via
  git.

## Troubleshooting quick reference

| Symptom | Cause / fix |
|---|---|
| `npm publish` 403 2FA | stale token in `~/.npmrc`; update it or `npm login --registry https://registry.npmjs.org` |
| `ERR_PNPM_IGNORED_BUILDS` | add `allowBuilds: { protobufjs: true }` to profile `pnpm-workspace.yaml`, re-run add |
| `duplicate loader entry id: feishu-bridge` | manual insert row + bundle layer both present; remove one |
| `Cannot find package '@deepseek-ai/cosmokit'` | vendored source moved by a junction-following file op; `git checkout -- vendor` in the harness repo |
| dump-config missing feishu row | bundle not in `dsh.profile.bundles`; re-run `dsh plugin add` (reconcile writes it) |
