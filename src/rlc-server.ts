/**
 * MCP server for ReimaginedLC (the user's own client layer). Reads and drives the shell through `window.__rlc`, which
 * only the dev build (`vite build --mode client`) installs, and runs the dev cycle: check, build into Pengu, reload,
 * and put the release (auto-updating loader) back at the end. Generic DOM/input/screenshot tools live in the lol-cdp
 * server; this one adds what only makes sense for ReimaginedLC.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Client, sleep } from './client.ts';
import { BUSY_PHASES } from './guard.ts';

const RLC_DIR = process.env.RLC_DIR ?? 'C:\\Users\\Admin\\dev\\ReimaginedLC';
const PENGU_DIR = process.env.PENGU_DIR ?? 'C:\\Program Files\\Pengu Loader';
const REPO = process.env.RLC_REPO ?? 'kyso1/ReimaginedLC';

const client = new Client();
await client.init();
const server = new McpServer({ name: 'rlc', version: '0.1.0' });

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<string>, readOnly = false) {
  server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, (async (a: any) => {
    try {
      return { content: [{ type: 'text', text: await run(a) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }) as any);
}

const json = (v: unknown) => JSON.stringify(v, null, 1);

/** Calls `window.__rlc.<expr>`; explains how to get the hook when the release build is loaded. */
async function rlc<T = any>(expr: string): Promise<T> {
  const has = await client.cdp.evaluate<boolean>('!!window.__rlc');
  if (!has) {
    const root = await client.cdp.evaluate<boolean>(`!!document.getElementById('rlc-root')`);
    throw new Error(
      root
        ? 'ReimaginedLC is loaded but window.__rlc is missing: this is the release build. Run rlc_build to load the dev build.'
        : 'ReimaginedLC is not loaded in the client (no #rlc-root). Is the plugin installed and the client up?',
    );
  }
  return client.cdp.evaluate<T>(`(async () => window.__rlc.${expr})()`);
}

/** Runs a command line through the shell in the ReimaginedLC repo; arguments are fixed strings from this file. */
function run(line: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(line, { cwd: RLC_DIR, shell: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
    let out = '';
    const add = (d: Buffer) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') });
    });
  });
}

const tail = (s: string, n = 6000) => (s.length > n ? `…${s.slice(-n)}` : s);

async function guardPhase(action: string): Promise<string> {
  const phase = await client.phase();
  if (BUSY_PHASES.includes(phase)) throw new Error(`Refusing to ${action} during ${phase}.`);
  return phase;
}

async function reloadAndWait(): Promise<string> {
  await client.reload();
  const start = Date.now();
  while (!(await client.cdp.evaluate<boolean>(`!!document.getElementById('rlc-root')`).catch(() => false))) {
    if (Date.now() - start > 30_000) return 'reloaded, but #rlc-root did not appear within 30 s';
    await sleep(300);
  }
  await sleep(1500);
  const hook = await client.cdp.evaluate<boolean>('!!window.__rlc');
  return `reloaded; ReimaginedLC up, ${hook ? 'dev build (window.__rlc present)' : 'release build (no window.__rlc)'}`;
}

// ---- state and control --------------------------------------------------------------------------------------------

tool(
  'rlc_state',
  'ReimaginedLC shell state: version, layer (enabled/shown/hideRiot), gameflow phase, current screen/page/view, open panel, chat, profile, settings area, last captured error, LCU endpoint count. Needs the dev build.',
  {},
  async () => json(await rlc('state()')),
  true,
);

tool(
  'rlc_go',
  'Navigates the ReimaginedLC shell: "home", "play" (mode picker), "custom" (custom game list), "phase" (the screen the gameflow phase shows: lobby, champ select, post game), or a rail view: profile, collection, loot, events, clash, store, settings.',
  { to: z.string() },
  async (a) => {
    await rlc(`go(${JSON.stringify(a.to)})`);
    await sleep(600);
    const s = await rlc('state()');
    return json({ page: s.page, view: s.view, panel: s.panel });
  },
);

tool(
  'rlc_open',
  'Opens a ReimaginedLC surface with an argument: chat (friend id, or null to close the dock), profile (puuid, null = own), settings (area id, null = settings home).',
  { what: z.enum(['chat', 'profile', 'settings']), id: z.string().nullable().optional() },
  async (a) => {
    const fn = { chat: 'openChat', profile: 'openProfile', settings: 'openSettings' }[a.what];
    await rlc(`${fn}(${JSON.stringify(a.id ?? null)})`);
    await sleep(500);
    const s = await rlc('state()');
    return json({ view: s.view, chat: s.chat, profilePuuid: s.profilePuuid, settingsArea: s.settingsArea });
  },
);

tool(
  'rlc_layer',
  'Turns the ReimaginedLC layer on or off (off shows the native Riot client). Works on the release build too (via the Ctrl+Shift+F12 hotkey).',
  { on: z.boolean() },
  async (a) => {
    const has = await client.cdp.evaluate<boolean>('!!window.__rlc');
    if (has) await rlc(`setLayer(${a.on})`);
    else {
      const shown = (await client.page<{ shown?: boolean }>('layer')).shown ?? false;
      if (shown !== a.on) await client.cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',ctrlKey:true,shiftKey:true})), true`);
    }
    await sleep(600);
    return json(await client.page('layer'));
  },
);

tool(
  'rlc_prefs',
  'Reads the ReimaginedLC preferences, or applies a partial patch and returns the previous values of the changed keys. Restore them when done testing (call again with the returned object): prefs persist in the Pengu DataStore.',
  { patch: z.record(z.string(), z.any()).optional() },
  async (a) => json(a.patch ? { previous: await rlc(`setPrefs(${JSON.stringify(a.patch)})`) } : await rlc('prefs()')),
);

tool(
  'rlc_store',
  'Reads one of ReimaginedLC\'s LCU stores (the signals the UI renders from): status, data, error. Without a name, lists them.',
  { name: z.string().optional(), maxChars: z.number().int().optional() },
  async (a) => {
    if (!a.name) return (await rlc<string[]>('stores')).join(', ');
    const text = json(await rlc(`store(${JSON.stringify(a.name)})`));
    const max = a.maxChars ?? 15_000;
    return text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars)` : text;
  },
  true,
);

tool(
  'rlc_supports',
  'Whether the installed client has an LCU endpoint, as ReimaginedLC sees it (capabilities from /help). Path uses {braces} for parameters.',
  { method: z.string(), path: z.string() },
  async (a) => String(await rlc(`supports(${JSON.stringify(a.method)}, ${JSON.stringify(a.path)})`)),
  true,
);

tool(
  'rlc_snapshot',
  'Visible interactive elements of the ReimaginedLC layer only (#rlc-root). The refs live in the page, so the lol-cdp server tools (click, hover, type, query) accept them until the next snapshot from either server.',
  { within: z.string().optional().describe('Selector inside the layer (default #rlc-root).'), collapse: z.number().int().optional() },
  async (a) => {
    const layer = await client.page<{ present: boolean; shown?: boolean }>('layer');
    if (!layer.shown) return `The ReimaginedLC layer is ${layer.present ? 'off (rlc_layer on=true shows it)' : 'not loaded'}.`;
    const s = await client.page('snapshot', { within: a.within ?? '#rlc-root', collapse: a.collapse ?? 3, max: 300 });
    return s.items.map((i: any) => `${i.ref} ${i.tag} "${i.label}"${i.state.length ? ` [${i.state}]` : ''}${i.similar ? ` (+${i.similar} similar)` : ''}  ${i.selector}`).join('\n') || 'Nothing visible (layer off?).';
  },
  true,
);

tool(
  'rlc_errors',
  'ReimaginedLC errors: the last error that turned a screen or the layer off (sessionStorage), plus recent console lines tagged [rlc] and uncaught exceptions seen by this server.',
  {},
  async () => {
    const last = await client.cdp.evaluate<string | null>(`(() => { try { return sessionStorage.getItem('rlc:lastError') } catch { return null } })()`);
    const lines = client.logs.filter((l) => /\[rlc\]|exception/i.test(l)).slice(-40);
    return `Last error: ${last ?? 'none'}\n\nConsole:\n${lines.join('\n') || '(nothing since this server connected)'}`;
  },
  true,
);

// ---- dev cycle ----------------------------------------------------------------------------------------------------

tool(
  'rlc_check',
  'Typechecks (tsc --noEmit) and runs the vitest suite of the ReimaginedLC repo; optional filter limits vitest to matching test files.',
  { filter: z.string().regex(/^[\w./-]+$/, 'letters, digits, . / _ - only').optional(), skipTypecheck: z.boolean().optional() },
  async (a) => {
    const out: string[] = [];
    if (!a.skipTypecheck) {
      const t = await run('npx tsc --noEmit', 300_000);
      out.push(`tsc: ${t.code === 0 ? 'OK' : `FAILED (exit ${t.code})\n${tail(t.out)}`}`);
    }
    const v = await run(`npx vitest run${a.filter ? ` ${a.filter}` : ''}`, 600_000);
    const summary = v.out.split('\n').filter((l) => /Test Files|Tests |FAIL|Error/.test(l)).slice(-30).join('\n');
    out.push(`vitest: ${v.code === 0 ? 'OK' : `FAILED (exit ${v.code})`}\n${v.code === 0 ? summary : tail(v.out, 8000)}`);
    return out.join('\n\n');
  },
  true,
);

tool(
  'rlc_build',
  'Builds ReimaginedLC in dev mode (vite build --mode client), which copies it into the Pengu plugin folder and replaces the auto-update loader, then reloads the client (refused in champ select, queue or game) so the dev build with window.__rlc is live. Run rlc_restore_release when done.',
  { reload: z.boolean().optional().describe('Default true.') },
  async (a) => {
    await guardPhase('build and reload');
    const b = await run('npx vite build --mode client', 600_000);
    if (b.code !== 0) throw new Error(`vite build failed (exit ${b.code})\n${tail(b.out)}`);
    const built = b.out.split('\n').filter((l) => /built in|copiado|error/i.test(l)).join('\n');
    if (a.reload === false) return `Built.\n${built}`;
    return `Built.\n${built}\n${await reloadAndWait()}`;
  },
);

tool(
  'rlc_restore_release',
  'Puts the latest GitHub release of ReimaginedLC (the auto-updating loader) back into the Pengu plugin folder, replacing a dev build, then reloads the client (refused in champ select, queue or game).',
  { tag: z.string().regex(/^v?[\d.]+$/).optional().describe('Release tag like v0.2.25; default latest.') },
  async (a) => {
    await guardPhase('restore the release and reload');
    const dir = mkdtempSync(join(tmpdir(), 'rlc-release-'));
    try {
      const d = await run(`gh release download ${a.tag ?? ''} -R ${REPO} --pattern "ReimaginedLC-*.zip" -D "${dir}"`, 120_000);
      if (d.code !== 0) throw new Error(`gh release download failed:\n${tail(d.out)}`);
      const zip = readdirSync(dir).find((f) => f.endsWith('.zip'));
      if (!zip) throw new Error('release has no ReimaginedLC-*.zip');
      const x = await run(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${join(dir, zip)}' -DestinationPath '${join(dir, 'x')}' -Force"`, 120_000);
      if (x.code !== 0) throw new Error(`extract failed:\n${tail(x.out)}`);
      cpSync(join(dir, 'x', 'ReimaginedLC'), join(PENGU_DIR, 'plugins', 'ReimaginedLC'), { recursive: true });
      return `Installed ${zip}.\n${await reloadAndWait()}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`[rlc] ready on CDP port ${client.cdp.port}, repo ${RLC_DIR}`);
