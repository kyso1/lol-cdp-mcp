# lol-cdp-mcp

Two MCP servers that drive the League of Legends client over the plain Chrome DevTools Protocol. No in-client plugin
and no bridge: Pengu Loader opens a debugging port and the servers talk to the client page directly.

- **lol-cdp**: the native client. Real mouse and keyboard input, a shadow-DOM-aware snapshot with refs, screenshots in
  click coordinates, the LCU API, an endpoint catalog, and a crawled map of every screen.
- **rlc**: [ReimaginedLC](https://github.com/kyso1/ReimaginedLC). Shell state and navigation through the dev build's
  `window.__rlc`, LCU stores, prefs, and the dev cycle (check, build into Pengu, restore the release).

## Install

Needs Windows, [Pengu Loader](https://github.com/PenguLoader/PenguLoader) and Node.js 22 or newer.

**1. Open the debugging port** (once). This writes `RemoteDebuggingPort=9222` to Pengu Loader's `config` file; run the
terminal as administrator if Pengu lives in `Program Files`. Then restart the League client.

```
npx -y -p github:kyso1/lol-cdp-mcp lol-cdp-mcp --setup
```

**2. Add the server to your MCP client.** Claude Code:

```
claude mcp add -s user lol-cdp -- npx -y -p github:kyso1/lol-cdp-mcp lol-cdp-mcp
```

Cursor, Claude Desktop, VS Code and others (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "lol-cdp": { "command": "npx", "args": ["-y", "-p", "github:kyso1/lol-cdp-mcp", "lol-cdp-mcp"] }
  }
}
```

**3. (ReimaginedLC developers) the rlc server.** Clone ReimaginedLC, `npm install` in it, then:

```
claude mcp add -s user rlc -e RLC_DIR=C:/path/to/ReimaginedLC -- npx -y -p github:kyso1/lol-cdp-mcp rlc-mcp
```

Without `RLC_DIR` the server uses the folder the MCP client starts it in.

Check: with the client open, `http://127.0.0.1:9222/json` lists the client page, and the `state` tool answers.

> **Security:** the debugging port has no authentication. Any program on your PC can drive the client through it, and
> the page URL listed by `/json` contains the LCU credentials. It only listens on 127.0.0.1. Remove the line from the
> Pengu `config` to close it.

Environment: `LOL_CDP_PORT` (default: read from the Pengu config, else 9222), `PENGU_DIR`, `LOL_CDP_MAP_DIR` (default
`~/.lol-cdp-mcp/map`), `RLC_DIR`, `RLC_REPO`.

### From source

```
git clone https://github.com/kyso1/lol-cdp-mcp && cd lol-cdp-mcp && npm install
claude mcp add -s user lol-cdp -- node C:/path/to/lol-cdp-mcp/src/server.ts
```

Node 24 runs the TypeScript sources directly; `npm run build` produces `dist/` for Node 22.

## lol-cdp tools

| Tool | What it does |
|---|---|
| `state` | Phase, patch, Riot nav tabs, ReimaginedLC layer, open overlays, viewport. |
| `snapshot` | Visible interactive elements with refs (e.g. `e12`), piercing shadow roots; repeated items collapse. |
| `query`, `wait_for` | Inspect one element (info, text, HTML); wait for one to appear or go away. |
| `click`, `hover`, `type`, `key`, `scroll` | Real input through `Input.*`. Each reports what it caused: overlays opened or closed, nav change, LCU requests. |
| `navigate` | A Riot nav tab id (`rcp-fe-lol-collections`, ...) or a screen id from the map. |
| `map` | The crawled map: screens, paths, controls with hover text, click effect and LCU requests. Search with `query`. |
| `lcu`, `lcu_endpoints` | Call the LCU from inside the client; search the endpoint catalog of the installed client. |
| `screenshot` | One image pixel is one CSS px, so image coordinates work as `click` x/y. |
| `eval`, `css`, `script` | Run JavaScript, add styles, register a script that survives reloads. |
| `reload`, `console`, `network`, `metrics` | Phase-guarded reload, console log, LCU request log, renderer counters. |

Targets accept `ref`, `selector` (use ` >>> ` to step into a shadow root), `text` (+`exact`, `nth`, `within`), or `x`/`y`.

### Account safety

Guarded at the network level, by method and path, because labels change with locale and patch:

- `lcu` refuses dangerous writes, and input tools arm a filter for a few seconds after each action that fails them:
  purchases, loot crafting/disenchanting/opening, rerolls, reports, honor, chat messages, friend and invite changes,
  real queue search, name changes, reward claims, logout, client quit, and any write to a remote host.
- `reload` is refused in Matchmaking, ReadyCheck, ChampSelect, GameStart, InProgress and Reconnect.

## The crawl map

```
npx -y -p github:kyso1/lol-cdp-mcp lol-cdp-crawl [--only=rcp-fe-lol-loot,shell] [--max-screens=150] [--max-controls=40] [--depth=3] [--no-hover]
```

Starts only in None or Lobby and stops if the phase changes. It turns the ReimaginedLC layer off and back on, then
for each screen hovers and clicks every control (one sample of each repeated item), follows tabs, overlays and
dropdowns, and writes `~/.lol-cdp-mcp/map/<patch>/map.json` (plus screenshots in `shots/`). `--only` merges into the
existing map. The map holds personal data (friend names, chat, account ids): it stays on your PC and is never part of
this repo.

While crawling, every write request outside a short allowlist (create/leave lobby, custom champ select, loot refresh)
is recorded and failed. Purchase, craft, report, invite and settings buttons are therefore pressed, but nothing
reaches the server; the map still shows the endpoint and body they would send. The crawler never clicks inside
iframes (the store pages), which the guard cannot see. A reload at the end resyncs the client.

## rlc tools

`rlc_state`, `rlc_go`, `rlc_open`, `rlc_layer`, `rlc_prefs`, `rlc_store`, `rlc_supports`, `rlc_snapshot`,
`rlc_errors`, `rlc_check`, `rlc_build`, `rlc_restore_release`. Everything except `rlc_layer`, `rlc_snapshot`,
`rlc_errors` and the dev-cycle tools needs the dev build (`rlc_build`); put the release back with
`rlc_restore_release` so the client keeps auto-updating.

## Tests

`npm test` (safety rules), `npm run typecheck`.
