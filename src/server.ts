import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Client, fmtNet, sleep, type Target } from './client.ts';
import { BUSY_PHASES } from './guard.ts';
import { goTo, loadMap, MAP_DIR, patchOf, searchMap, waitFor, type CrawlMap } from './map.ts';

const client = new Client();
await client.init();

const server = new McpServer({ name: 'lol-cdp', version: '0.1.0' });

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<string | Content[]>,
  readOnly = false,
) {
  server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, (async (args: any) => {
    try {
      const out = await run(args);
      return { content: typeof out === 'string' ? [{ type: 'text', text: out }] : out };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }) as any);
}

// ---- shared argument shapes ---------------------------------------------------------------------------------------

const target = {
  ref: z.string().optional().describe('Ref from the last `snapshot` (e.g. "e12"). Most reliable.'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector. Searches inside every shadow root; use " >>> " to step into a specific shadow root.'),
  text: z.string().optional().describe('Visible text or label of the element (case-insensitive substring).'),
  exact: z.boolean().optional().describe('With `text`: require the whole label to match.'),
  nth: z.number().int().optional().describe('Pick the nth match (0-based) when several match.'),
  within: z.string().optional().describe('Selector of a container to search in (e.g. a modal).'),
  x: z.number().optional().describe('Viewport x in CSS px (same as screenshot pixels at the default scale).'),
  y: z.number().optional().describe('Viewport y in CSS px.'),
};
type TargetArgs = Target & { x?: number; y?: number };
const toTarget = (a: TargetArgs): Target | { x: number; y: number } =>
  a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : { ref: a.ref, selector: a.selector, text: a.text, exact: a.exact, nth: a.nth, within: a.within };

let cachedMap: CrawlMap | null | undefined;
async function patch(): Promise<string> {
  return patchOf(await client.cdp.evaluate<string>('navigator.userAgent'));
}
async function map(): Promise<CrawlMap | null> {
  if (cachedMap === undefined) cachedMap = loadMap(await patch());
  return cachedMap;
}

function describeEffect(o: Awaited<ReturnType<Client['observe']>>): string {
  const lines: string[] = [];
  if (o.nav) lines.push(`Nav tab: ${o.nav.from} → ${o.nav.to}`);
  for (const ov of o.opened) lines.push(`Opened ${ov.tag}: ${ov.text || ov.selector}`);
  for (const c of o.closed) lines.push(`Closed: ${c}`);
  if (o.requests.length) lines.push(`LCU requests:\n  ${o.requests.join('\n  ')}`);
  return lines.length ? lines.join('\n') : 'No visible effect (no overlay, nav change or LCU request).';
}

// ---- reading ------------------------------------------------------------------------------------------------------

tool(
  'state',
  'Where the client is right now: gameflow phase, patch, active Riot nav tab and all tabs, ReimaginedLC layer, open overlays (modals, flyouts, tooltips), viewport. Start here.',
  {},
  async () => {
    const [phase, nav, layer, overlays, view, p] = await Promise.all([
      client.phase(),
      client.page('nav'),
      client.page('layer'),
      client.page('overlays'),
      client.cdp.evaluate('({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})'),
      patch(),
    ]);
    const m = await map();
    return JSON.stringify(
      {
        phase,
        patch: p,
        busy: BUSY_PHASES.includes(phase),
        nav,
        reimaginedLC: layer,
        overlays,
        viewport: view,
        map: m ? `${m.screens.length} screens (patch ${m.patch}); use map/navigate` : 'no crawl map yet',
      },
      null,
      1,
    );
  },
  true,
);

tool(
  'snapshot',
  'Lists the visible interactive elements (buttons, tabs, inputs, cards, nav items), piercing shadow DOM, each with a ref usable by click/hover/type/query. Repeated items (grids, lists) collapse after a few. Take a new snapshot after the screen changes: refs go stale.',
  {
    within: z.string().optional().describe('Only inside this container selector (e.g. a modal from `state`).'),
    collapse: z.number().int().optional().describe('Keep this many of each repeated item (default 3, 0 = all).'),
    selectors: z.boolean().optional().describe('Include a stable CSS selector per element.'),
    max: z.number().int().optional().describe('Max items (default 400).'),
  },
  async (a) => {
    const s = await client.page('snapshot', { within: a.within, collapse: a.collapse, max: a.max });
    const lines = s.items.map((i: any) => {
      const state = i.state.length ? ` [${i.state.join(',')}]` : '';
      const sim = i.similar ? ` (+${i.similar} similar)` : '';
      const frame = i.frame ? ` iframe ${i.frame}` : '';
      const sel = a.selectors ? `  ${i.selector}` : '';
      return `${i.ref} ${i.tag} "${i.label}"${state}${sim}${frame}${sel}`;
    });
    if (s.hidden) lines.push(`(${s.hidden} more not listed; narrow with "within" or raise collapse/max)`);
    return lines.join('\n') || 'No visible interactive elements.';
  },
  true,
);

tool(
  'query',
  'Details of one element: label, selector, box, state, and optionally its text or HTML (shadow root included).',
  { ...target, show: z.enum(['info', 'text', 'html']).optional().describe('Default info.'), all: z.boolean().optional().describe('Count all matches.') },
  async (a) => {
    const t = toTarget(a);
    if ('x' in t) return JSON.stringify(await client.cdp.evaluate(`document.elementFromPoint(${t.x},${t.y})?.outerHTML.slice(0,1500)`));
    if (a.show === 'text') return client.page('text', t);
    if (a.show === 'html') return client.page('html', t);
    const p = await client.page('point', t);
    const count = a.all ? await client.page('count', t) : undefined;
    return JSON.stringify({ ...p.element, center: [Math.round(p.x), Math.round(p.y)], onTop: p.onTop, covering: p.covering, count }, null, 1);
  },
  true,
);

tool(
  'wait_for',
  'Waits until an element appears (or disappears with gone=true).',
  { ...target, gone: z.boolean().optional(), timeoutMs: z.number().int().optional().describe('Default 10000.') },
  async (a) => {
    const ok = await waitFor(client, toTarget(a) as Target, a.timeoutMs ?? 10_000, a.gone);
    if (!ok) throw new Error(`Timed out waiting for ${a.gone ? 'disappearance of ' : ''}${JSON.stringify(toTarget(a))}`);
    return 'OK';
  },
  true,
);

// ---- input --------------------------------------------------------------------------------------------------------

tool(
  'click',
  'Real mouse click (CDP Input) on an element, scrolled into view. Reports what it caused: overlays opened/closed, nav change, LCU requests. Dangerous writes (purchases, loot crafting, reports, invites, chat, real queue, logout) are blocked at the network level.',
  {
    ...target,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().optional().describe('2 for double click.'),
    force: z.boolean().optional().describe('Click even if another element covers the target center.'),
  },
  async (a) => {
    const o = await client.observe(() => client.click(toTarget(a), { button: a.button, count: a.count, force: a.force }));
    const el = (o.result as any)?.element;
    return `Clicked ${el ? `${el.tag} "${el.label}"` : `(${a.x}, ${a.y})`}\n${describeEffect(o)}`;
  },
);

tool(
  'hover',
  'Moves the real mouse over an element and reports tooltips/flyouts that appeared.',
  { ...target, waitMs: z.number().int().optional().describe('How long to wait for a tooltip (default 800).') },
  async (a) => {
    const o = await client.observe(
      async () => {
        const p = await client.hover(toTarget(a));
        await sleep(a.waitMs ?? 800);
        return p;
      },
      { maxMs: (a.waitMs ?? 800) + 1500 },
    );
    return describeEffect(o);
  },
);

tool(
  'type',
  'Types text into an input (focuses it first when a target is given).',
  { ...target, value: z.string(), clear: z.boolean().optional().describe('Select existing text first so it gets replaced.'), enter: z.boolean().optional().describe('Press Enter afterwards.') },
  async (a) => {
    const t = toTarget(a);
    if (!('x' in t) && (t.ref || t.selector || t.text)) {
      await client.click(t).catch(() => {});
      await client.page(a.clear ? 'clear' : 'focus', t);
    }
    await client.type(a.value);
    if (a.enter) await client.key('Enter');
    return 'Typed.';
  },
);

tool(
  'key',
  'Presses a key or combo on the page: "Escape", "Enter", "Tab", "ArrowDown", "Ctrl+A", "Ctrl+Shift+F12" (toggles the ReimaginedLC layer).',
  { combo: z.string() },
  async (a) => {
    const o = await client.observe(() => client.key(a.combo), { maxMs: 2000 });
    return describeEffect(o);
  },
);

tool(
  'scroll',
  'Scrolls with the real mouse wheel over an element (deltaY > 0 scrolls down).',
  { ...target, deltaY: z.number(), deltaX: z.number().optional() },
  async (a) => {
    await client.scroll(toTarget(a), a.deltaY, a.deltaX);
    await sleep(300);
    return 'Scrolled.';
  },
);

// ---- navigation and map -------------------------------------------------------------------------------------------

tool(
  'navigate',
  'Goes to a screen. Accepts a Riot nav tab id ("rcp-fe-lol-collections", "rcp-fe-lol-loot", "rcp-fe-lol-store", "rcp-fe-lol-profiles-main", "rcp-fe-lol-tft", "home"...; see `state`) or a screen id from the crawl map (see `map`).',
  { to: z.string() },
  async (a) => {
    const m = await map();
    const screen = m?.screens.find((s) => s.id === a.to);
    const o = await client.observe(async () => (screen ? goTo(client, screen) : client.page('navigate', a.to)), { maxMs: 6000 });
    return `${screen ? `Screen ${screen.id} (${screen.title})` : `Nav ${a.to}`}\n${describeEffect(o)}`;
  },
);

tool(
  'map',
  'The crawled map of the native client: every screen, how to reach it, each control with its hover text, what clicking it does and which LCU requests it fires (blocked ones show the endpoint a dangerous button would call). Without arguments lists screens; `screen` gives one screen in full; `query` searches labels, hovers and endpoints.',
  { screen: z.string().optional(), query: z.string().optional() },
  async (a) => {
    const m = await map();
    if (!m) return 'No map yet. Run `npm run crawl` in the lol-cdp-mcp repo.';
    if (a.screen) {
      const s = m.screens.find((x) => x.id === a.screen);
      if (!s) throw new Error(`Unknown screen ${a.screen}`);
      return JSON.stringify(s, null, 1);
    }
    if (a.query) {
      const hits = searchMap(m, a.query);
      return hits.map((h) => `${h.screen.id} — ${h.screen.title}\n  ${h.hits.slice(0, 12).join('\n  ')}`).join('\n') || 'No match.';
    }
    return `Patch ${m.patch}, crawled ${m.crawledAt}\n` + m.screens.map((s) => `${s.id} — ${s.title} (${s.controls.length} controls)`).join('\n');
  },
  true,
);

// ---- LCU ----------------------------------------------------------------------------------------------------------

tool(
  'lcu',
  'Calls the LCU API from inside the client (auth handled). Dangerous writes (purchases, loot crafting, reports, invites, chat messages, real queue, logout, client quit) are refused.',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().describe('e.g. /lol-gameflow/v1/session'),
    body: z.any().optional(),
    maxChars: z.number().int().optional().describe('Truncate the response (default 20000).'),
  },
  async (a) => {
    const r = await client.lcu(a.method, a.path, a.body);
    const text = JSON.stringify(r.data, null, 1) ?? 'null';
    const max = a.maxChars ?? 20_000;
    return `HTTP ${r.status}\n${text.length > max ? text.slice(0, max) + `\n… (${text.length} chars)` : text}`;
  },
);

type Endpoint = { name: string; method: string; url: string; args: string; returns: string };
let catalog: Endpoint[] | null = null;
async function lcuCatalog(): Promise<Endpoint[]> {
  if (catalog) return catalog;
  const file = join(MAP_DIR, await patch(), 'lcu.json');
  if (existsSync(file)) return (catalog = JSON.parse(readFileSync(file, 'utf8')));
  catalog = await client.cdp.evaluate(
    `(async () => {
      const t = (x) => !x ? '' : x.elementType ? x.type + '<' + x.elementType + '>' : x.type;
      const help = await (await fetch('/help?format=Full')).json();
      const fns = help.functions.filter((f) => /^(Get|Post|Put|Patch|Delete)[A-Z]/.test(f.name));
      const out = [];
      for (let i = 0; i < fns.length; i += 32) {
        const batch = await Promise.all(fns.slice(i, i + 32).map(async (f) => {
          const d = (await (await fetch('/help?target=' + encodeURIComponent(f.name) + '&format=Console')).json())[f.name];
          return d && d.url ? { name: f.name, method: d.http_method, url: d.url,
            args: (f.arguments || []).map((a) => a.name + (a.optional ? '?' : '') + ': ' + t(a.type)).join(', '),
            returns: t(f.returns) } : null;
        }));
        out.push(...batch.filter(Boolean));
      }
      return out.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
    })()`,
    180_000,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(catalog, null, 1));
  return catalog!;
}

tool(
  'lcu_endpoints',
  'Searches the LCU endpoint catalog of the installed client (built from /help on first use, then cached per patch). Every word must match the path or function name.',
  { query: z.string().describe('e.g. "lobby custom", "loot craft", "champ-select session"'), method: z.string().optional(), limit: z.number().int().optional() },
  async (a) => {
    const words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (await lcuCatalog()).filter(
      (e) => (!a.method || e.method === a.method.toUpperCase()) && words.every((w) => `${e.url} ${e.name}`.toLowerCase().includes(w)),
    );
    const lim = a.limit ?? 40;
    return (
      hits.slice(0, lim).map((e) => `${e.method} ${e.url}${e.args ? `  (${e.args})` : ''} → ${e.returns}`).join('\n') +
      (hits.length > lim ? `\n… ${hits.length - lim} more` : '') || 'No match.'
    );
  },
  true,
);

// ---- page ---------------------------------------------------------------------------------------------------------

tool(
  'screenshot',
  'Screenshot of the client (or one element). At the default scale one image pixel = one CSS px, so image coordinates can be passed to click/hover as x/y.',
  {
    ref: target.ref,
    selector: target.selector,
    text: target.text,
    scale: z.number().optional().describe('Relative to CSS px (default 1).'),
    format: z.enum(['jpeg', 'png']).optional(),
    quality: z.number().int().optional().describe('JPEG quality (default 80).'),
    save: z.string().optional().describe('Also write the image to this file path.'),
  },
  async (a) => {
    const view = await client.cdp.evaluate<{ w: number; h: number }>('({w: innerWidth, h: innerHeight})');
    // Clip rects are in zoomed units: CSS px (what getBoundingClientRect and Input use) times the page zoom.
    const zoom: number = (await client.cdp.send('Page.getLayoutMetrics')).cssVisualViewport.zoom ?? 1;
    let clip = { x: 0, y: 0, width: view.w, height: view.h };
    if (a.ref || a.selector || a.text) {
      const p = await client.page('point', { ref: a.ref, selector: a.selector, text: a.text });
      const [x, y, w, h] = p.element.rect;
      clip = { x, y, width: w, height: h };
    }
    const format = a.format ?? 'jpeg';
    const r = await client.cdp.send('Page.captureScreenshot', {
      format,
      quality: format === 'jpeg' ? (a.quality ?? 80) : undefined,
      clip: { x: clip.x * zoom, y: clip.y * zoom, width: clip.width * zoom, height: clip.height * zoom, scale: (a.scale ?? 1) / zoom },
      captureBeyondViewport: false,
    });
    if (a.save) {
      mkdirSync(dirname(a.save), { recursive: true });
      writeFileSync(a.save, Buffer.from(r.data, 'base64'));
    }
    return [
      { type: 'image', data: r.data, mimeType: `image/${format}` },
      { type: 'text', text: `${Math.round(clip.width * (a.scale ?? 1))}x${Math.round(clip.height * (a.scale ?? 1))}${a.save ? `, saved to ${a.save}` : ''}` },
    ];
  },
  true,
);

tool(
  'eval',
  'Runs JavaScript in the client page and returns the JSON result. Wrap statements in an async IIFE or just write an expression; promises are awaited. `rcp.get("rcp-fe-lol-<plugin>")` returns Riot plugin APIs.',
  { code: z.string(), timeoutMs: z.number().int().optional().describe('Default 30000.') },
  async (a) => {
    const v = await client.cdp.evaluate(a.code, a.timeoutMs ?? 30_000);
    return v === undefined ? 'undefined' : JSON.stringify(v, null, 1);
  },
);

tool(
  'css',
  'Adds (or with remove=true removes) a <style> in the document head under an id. Note: styles do not reach inside shadow roots; target hosts or use ::part where available.',
  { id: z.string(), css: z.string().optional(), remove: z.boolean().optional(), persist: z.boolean().optional().describe('Re-apply after reloads while this server runs.') },
  async (a) => {
    const elId = `lolmcp-css-${a.id}`;
    if (a.remove) {
      await client.removeScript(`css:${a.id}`);
      await client.cdp.evaluate(`document.getElementById(${JSON.stringify(elId)})?.remove(), true`);
      return 'Removed.';
    }
    const src = `(() => { const apply = () => { let s = document.getElementById(${JSON.stringify(elId)}); if (!s) { s = document.createElement('style'); s.id = ${JSON.stringify(elId)}; document.head.appendChild(s); } s.textContent = ${JSON.stringify(a.css ?? '')}; }; document.head ? apply() : document.addEventListener('DOMContentLoaded', apply); })()`;
    if (a.persist) await client.addScript(`css:${a.id}`, src);
    else await client.cdp.evaluate(src);
    return 'Applied.';
  },
);

tool(
  'script',
  'Registers JavaScript that runs now and on every page load (reload) while this server is connected: a live plugin prototype. remove=true unregisters it (effects already applied stay until a reload). list=true shows ids.',
  { id: z.string().optional(), code: z.string().optional(), remove: z.boolean().optional(), list: z.boolean().optional() },
  async (a) => {
    if (a.list) return client.scriptIds().filter((i) => !i.startsWith('css:')).join('\n') || 'None.';
    if (!a.id) throw new Error('id is required');
    if (a.remove) return (await client.removeScript(a.id)) ? 'Removed.' : 'No such script.';
    await client.addScript(a.id, a.code ?? '');
    return 'Registered and ran.';
  },
);

tool(
  'reload',
  'Reloads the client page (like Pengu\'s reload). Refused during Matchmaking, ReadyCheck, ChampSelect, GameStart, InProgress and Reconnect. Waits until the Riot UI is back.',
  {},
  async () => `Reloaded (phase was ${await client.reload()}).`,
);

tool(
  'console',
  'Recent console messages and uncaught exceptions from the client page.',
  { filter: z.string().optional(), limit: z.number().int().optional() },
  async (a) => {
    const rows = client.logs.filter((l) => !a.filter || l.toLowerCase().includes(a.filter.toLowerCase()));
    return rows.slice(-(a.limit ?? 50)).join('\n') || 'Nothing logged.';
  },
  true,
);

tool(
  'network',
  'Recent LCU requests made by the client page (assets excluded), newest last, including requests the safety guard blocked.',
  { filter: z.string().optional().describe('Substring of method or path.'), limit: z.number().int().optional() },
  async (a) => {
    const rows = client.net.filter((n) => !a.filter || `${n.method} ${n.path}`.toLowerCase().includes(a.filter.toLowerCase()));
    return rows.slice(-(a.limit ?? 50)).map((n) => `${new Date(n.time).toISOString().slice(11, 23)} ${fmtNet(n)}`).join('\n') || 'No requests.';
  },
  true,
);

tool(
  'metrics',
  'Renderer performance counters (JS heap, nodes, layout/style recalcs, script duration).',
  {},
  async () => {
    await client.cdp.send('Performance.enable');
    const r = await client.cdp.send('Performance.getMetrics');
    return r.metrics.map((m: any) => `${m.name}: ${Math.round(m.value * 100) / 100}`).join('\n');
  },
  true,
);

await server.connect(new StdioServerTransport());
console.error(`[lol-cdp] ready on CDP port ${client.cdp.port}`);
