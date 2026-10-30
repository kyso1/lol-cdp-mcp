# lol-cdp-mcp: design

Date: 2026-10-30. Client patch at design time: 16.21.

## Why

The `league-client-mcp` server (rumi-chan) drives the client through a Pengu plugin that relays commands over a
WebSocket bridge. In daily use it breaks in known ways: screenshots pick the wrong window when DevTools is open, every
call has a fixed 15 s timeout, reload does not look at the gameflow phase, and an agent has to guess selectors for a UI
that hides most of itself in shadow DOM. The user wants a replacement that controls *everything* in the native client
and is "as assertive as possible": an agent should know which screens exist, how to reach them, what each control does
and which LCU call it fires, instead of probing the DOM.

## Decisions taken with the user

- Plain Chrome DevTools Protocol over WebSocket. No in-client plugin. Pengu Loader opens the port with
  `RemoteDebuggingPort=9222` in `C:\Program Files\Pengu Loader\config` (verified: one `page` target, `Runtime.evaluate`,
  `Page.captureScreenshot`, `Input.*`, `Network.*` all work).
- A rewrite from scratch, in its own repo. The ReimaginedLC MCP is a separate server (separate design).
- Crawl the native Riot UI page by page, click by click, hover by hover, and ship the result as a map the MCP uses.
- Safety rule for the user's real account:
  - never complete anything that spends currency (RP with money, RP or essence purchases, loot craft/disenchant/reroll);
    walking the flow up to the final confirm is fine;
  - no real queues (champ select is mapped through a solo custom lobby);
  - nothing that reaches other people (reports, honor, invites, friend requests, chat messages);
  - settings may change only if the original is restored.

## Calls made by Claude (user can veto)

- TypeScript run directly by Node 24 type stripping (`node src/server.ts`), checked by `tsc --noEmit`. Dependencies:
  `@modelcontextprotocol/sdk`, `zod`. Node's built-in `WebSocket`, no `ws`.
- Repo at `C:\Users\Admin\dev\lol-cdp-mcp`. The old server stays in `~/.claude.json` until the new one covers it.
- Safety is enforced at the network layer, not by guessing button labels:
  - Crawler: every non-GET request is paused with `Fetch`, recorded (method, path, body) and failed, except a short
    allowlist the crawl needs (create/leave lobby, custom champ select, local refreshes). This also maps what a
    dangerous button *would* call without calling it. Settings writes are blocked the same way, so nothing needs
    restoring.
  - MCP input tools (`click`, `key`, `type`): a deny list of dangerous writes is armed for a few seconds after each
    action. `lcu` checks the same list before sending. No override flag.
- Reload is refused in Matchmaking, ReadyCheck, ChampSelect, GameStart, InProgress, Reconnect. The crawler starts only in
  None or Lobby and stops if the phase changes under it.
- The crawler turns the ReimaginedLC layer off (Ctrl+Shift+F12 dispatched in-page) and restores it at the end.

## Findings that shape the build

- Riot nav: `rcp.get('rcp-fe-lol-navigation').navigatePluginById(id)`; ids come from
  `._services.navigation.emberMenuItems` (loot, store, collections, activity-center, profiles-main, tft, event-hub,
  jade, yourshop, clash-full). Sub-tabs are `lol-uikit-navigation-item` inside section controllers.
- `getBoundingClientRect()` coordinates feed `Input.dispatchMouseEvent` unchanged (DPR 1.25 and html `zoom` 1.25 cancel
  out). Real hover works (`:hover` matches).
- 99 shadow hosts on the home screen; all element search must pierce shadow roots.
- Modals, flyouts and tooltips live under `#lol-uikit-layer-manager`.
- LCU calls from the Riot UI are XHR/fetch visible to `Network.requestWillBeSent`.
- `/json` exposes the LCU `riot:<token>` in the page URL; the port is loopback-only but unauthenticated.

## Shape

- `src/cdp.ts`: find the page target, connect, request/response, events, reconnect after a UX restart.
- `src/inpage.ts`: helper installed into the page (`window.__lolmcp`): shadow-piercing query, interactive-element
  snapshot with refs, element description, layer-manager diff.
- `src/guard.ts`: phase rules and the dangerous-request list (pure, unit-tested).
- `src/server.ts`: MCP tools.
- `src/crawl.ts`: crawler CLI, writes `map/<patch>/map.json` and compares with the previous patch.

Tools: `state`, `snapshot`, `query`, `click`, `hover`, `type`, `key`, `scroll`, `wait_for`, `navigate`, `map`,
`eval`, `lcu`, `lcu_endpoints`, `screenshot`, `css`, `script`, `reload`, `console`, `network`, `metrics`.

## Non-goals

- Exporting plugins into the Pengu folder (writing a file is enough).
- Game-client (in-match) control.
- ReimaginedLC-specific state (separate server).

## Left to the builder

Crawl heuristics (dedupe of repeated items, depth, settle detection), map schema details, tool output formats.
