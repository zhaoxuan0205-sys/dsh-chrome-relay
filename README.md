# dsh-chrome-relay

Drive **your already signed-in Chrome** from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — without re-login, without exporting cookies, and without storing any credential.

> Status: experimental. Verified on macOS with DSH 0.2.x, Chrome + the official Playwright extension.

## Why

Most browser-automation setups either launch a fresh browser (so every site is logged out) or copy your profile/cookies (so credentials leave the browser). This bundle takes a third path: the agent talks to the Chrome you are already using, and **you pick which tab it may touch**.

## Security model

| Concern | What this bundle does |
| --- | --- |
| Login state | stays in Chrome; the relay borrows it, never copies it |
| Cookies / storage | never read, exported or written to disk |
| Tokens | none required or stored; optional env var for power users only |
| Scope | the Playwright extension asks the user to select a tab; only that tab becomes visible to the agent |
| Frequency | one approval per DSH start, reused for the session |
| Vendor | official Microsoft extension + official `@playwright/mcp`; no third-party extension |

What it **does not** protect against: once a tab is approved, the agent can act inside it (read the DOM, click, type). Only approve tabs you are comfortable exposing, and revoke by closing the tab or removing the extension.

## How it works

```
DSH ── dsh-mcp-client ── ~/.dsh/bin/browser-bridge-launch.sh
                              └─ node @playwright/mcp --extension
                     └─ Playwright extension relay (local WebSocket)
                          └─ the tab the user selected, with its live session
```

Tools appear as `mcp__browser__browser_*` (`browser_tabs`, `browser_navigate`, `browser_evaluate`, …).

## Requirements

- DSH 0.2.x with a profile at `~/.dsh/profiles/<name>` (default `desktop`)
- Google Chrome with the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
- Node.js ≥ 20

## Install

```bash
# 1. dependency (pinned, no browser download)
pnpm add @playwright/mcp@0.0.84 --ignore-scripts

# 2. register the bundle (backs up profile package.json first)
node install.mjs                       # or: node install.mjs --profile <dir>
#    if @playwright/mcp lives somewhere unusual:
#    node install.mjs --cli /path/to/@playwright/mcp/cli.js

# 3. link it into the profile
cd ~/.dsh/profiles/desktop && pnpm install

# 4. restart DSH
```

`install.mjs` generates machine-specific files **under `~/.dsh`** (`bin/browser-bridge-launch.sh`, `browser-output/`, and this package's `cordis.patch.yml`). None of them are meant to be committed — `cordis.patch.yml` is in `.gitignore`.

## Use

```bash
node bin/check.mjs            # MCP discovery only, ~1s
node bin/check.mjs --browser  # full handshake: approve a tab in Chrome
node bin/eval.mjs --js "() => location.href"
```

Exit codes: `0` ok, `2` MCP failed to start, `3` browser handshake failed.

Recommended per-task protocol:

1. `bin/check.mjs` first; only continue on exit 0.
2. On handshake failure retry **once**, then stop and report.
3. Redirected to a login page or `401` → stop; never switch accounts or browsers.
4. Never copy cookies, `storageState` or profile databases.

## Uninstall

```bash
# remove from the profile list and dependencies
cd ~/.dsh/profiles/desktop
# edit package.json: drop "dsh-chrome-relay" from dependencies and dsh.profile.bundles
pnpm install
rm -f ~/.dsh/bin/browser-bridge-launch.sh
# restart DSH
```

## Known limitations

- `@playwright/mcp --extension` connects to Chrome; it cannot create tabs in a profile that has no extension installed.
- Each DSH start needs one tab approval (by design).
- Ports/launcher paths are machine-specific and generated at install time; do not commit them.
- Windows is untested (the launcher is a POSIX `sh` script).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Google, Microsoft, or DeepSeek; "Chrome" and "Playwright" are trademarks of their owners.

## Risks you accept by installing

- **The agent acts with your logged-in identity in the approved tab.** Anything that tab can do (post, delete, pay, change settings), the agent can do too.
- **Page content is untrusted input.** A malicious page can contain text crafted to steer the model (prompt injection). This bundle disables page-provided tools (--no-webmcp) but cannot sanitize prose.
- **The MCP server is a local Node process** started by DSH; it inherits your user permissions.
- **Approval is per DSH start, not per action.** Revoke by closing the tab, removing the extension, or restarting DSH.
- No sandbox is applied to the page itself; only approve tabs you would hand to a contractor.
