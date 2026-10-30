/**
 * Walks the native client screen by screen: hovers and clicks every control (one sample of each repeated item), records
 * tooltips, what each click opened and which LCU requests it fired, and writes map/<patch>/map.json.
 *
 * Safety: the crawl guard fails every write outside a tiny allowlist, so purchase/craft/report/invite/queue/settings
 * buttons are pressed but their request never leaves the page; the map still records the endpoint and body. Clicks
 * only land on elements of the main document (never inside the store iframes, which the guard cannot see).
 *
 *   node src/crawl.ts [--only=rcp-fe-lol-loot,rcp-fe-lol-collections] [--max-screens=150] [--max-controls=40]
 *                     [--depth=3] [--no-hover]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, sleep, type Target } from './client.ts';
import { BUSY_PHASES, CRAWL_PHASES } from './guard.ts';
import { MAP_DIR, patchOf, waitFor, type Control, type CrawlMap, type Screen, type Step } from './map.ts';

const arg = (name: string, def: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? (process.argv.includes(`--${name}`) ? 'true' : def);
const ONLY = arg('only', '').split(',').filter(Boolean);
const MAX_SCREENS = Number(arg('max-screens', '150'));
const MAX_CONTROLS = Number(arg('max-controls', '40'));
const DEPTH = Number(arg('depth', '3'));
const HOVER = arg('no-hover', 'false') !== 'true';

interface Node {
  id: string;
  title: string;
  path: Step[];
  /** Overlay this node lives in; its controls are searched only there. */
  within?: string;
}

interface Item {
  ref: string;
  tag: string;
  label: string;
  selector: string;
  signature: string;
  similar?: number;
  frame?: string;
}

const client = new Client();
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const slug = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const meaningful = (label: string) => !!label && !label.startsWith('(') && label.length <= 40 && !/^\d+$/.test(label);
// Selectors like a:nth-of-type(2) repeat across screens; with the label they identify a shared control.
const shellKey = (i: { selector: string; label: string }) => `${i.selector}|${i.label}`;
const clicks = (path: Step[]) => path.filter((s) => s.click).length;

class Abort extends Error {}

async function assertSafePhase(): Promise<string> {
  const phase = await client.phase();
  if (BUSY_PHASES.includes(phase)) throw new Abort(`phase changed to ${phase}; stopping`);
  return phase;
}

async function closeOverlays(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open = (await client.page<Array<{ tag: string; selector: string }>>('overlays')).filter((o) => !/tooltip/i.test(o.tag + o.selector));
    if (!open.length) return;
    await client.key('Escape');
    await sleep(400);
    if (i >= 1) {
      // Escape did not close it: try the overlay's own close/cancel button.
      for (const o of open) {
        for (const t of [{ selector: 'lol-uikit-close-button', within: o.selector }, { text: 'cancel', within: o.selector }, { text: 'close', within: o.selector }] as Target[]) {
          if (await client.page<number>('count', t).catch(() => 0)) {
            await client.click(t).catch(() => {});
            await sleep(400);
            break;
          }
        }
      }
    }
  }
}

/** Side panels (honor, notifications) cover the screen without looking like a modal. */
const CLOSERS = ['lol-uikit-close-button', '[class*="close-button"]', '[class*="close-btn"]', 'button[class*="close"]', '[class*="dismiss"]'];

/** True when most of the top bar is covered: a panel or backdrop sits over the screen. */
async function blocked(): Promise<boolean> {
  const n = await client.page<number>('count', { selector: 'lol-uikit-navigation-item.main-navigation-menu-item' }).catch(() => 0);
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const p = await client.page<{ onTop: boolean }>('point', { selector: 'lol-uikit-navigation-item.main-navigation-menu-item', nth: i }).catch(() => null);
    if (p && !p.onTop) covered++;
  }
  // A badge or glow can sit on one icon; a backdrop covers most of them.
  return covered > n / 2;
}

async function unblock(): Promise<void> {
  for (let i = 0; i < 3 && (await blocked()); i++) {
    await client.key('Escape');
    await sleep(500);
    if (!(await blocked())) return;
    for (const selector of CLOSERS) {
      const n = await client.page<number>('count', { selector }).catch(() => 0);
      let done = false;
      for (let k = 0; k < n && !done; k++) {
        const p = await client.page<{ onTop: boolean }>('point', { selector, nth: k }).catch(() => null);
        if (p?.onTop) {
          await client.click({ selector, nth: k }).catch(() => {});
          await sleep(600);
          done = true;
        }
      }
      if (done) break;
    }
  }
}

async function moveAway(): Promise<void> {
  await client.mouse('mouseMoved', 2, 700);
}

/** Brings the client to `node` from wherever it is. */
async function reset(node: Node): Promise<boolean> {
  await moveAway();
  await closeOverlays();
  await unblock();
  for (const step of node.path) {
    if (step.nav) await client.page('navigate', step.nav);
    if (step.click) {
      if (!(await waitFor(client, step.click, 8000))) return false;
      await client.click(step.click).catch(() => {});
    }
    await client.settle(undefined, 500, 6000);
  }
  if (node.within && !(await waitFor(client, { selector: node.within }, 5000))) return false;
  return true;
}

async function keyOf(): Promise<string> {
  const k = await client.page<{ main: string | null; sub: string[] }>('screenKey');
  return `${k.main}|${k.sub.join('>')}`;
}

async function signatures(within?: string): Promise<Set<string>> {
  const s = await client.page<{ items: Item[] }>('snapshot', { within, collapse: 1, signatures: true, max: 300 });
  return new Set(s.items.map((i) => i.signature));
}

async function items_(within?: string): Promise<Map<string, Item>> {
  const s = await client.page<{ items: Item[] }>('snapshot', { within, collapse: 2, max: 300 }).catch(() => ({ items: [] as Item[] }));
  return new Map(s.items.map((i) => [`${i.selector}|${i.label}`, i]));
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
};

async function main() {
  await client.init();
  const startPhase = await client.phase();
  if (!CRAWL_PHASES.includes(startPhase)) throw new Error(`Crawl only starts in ${CRAWL_PHASES.join('/')}; phase is ${startPhase}.`);
  const ua = await client.cdp.evaluate<string>('navigator.userAgent');
  const patch = patchOf(ua);
  const outDir = join(MAP_DIR, patch);
  mkdirSync(join(outDir, 'shots'), { recursive: true });

  const layer = await client.page<{ present: boolean; shown?: boolean }>('layer');
  if (layer.shown) {
    await client.cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',ctrlKey:true,shiftKey:true})), true`);
    await sleep(800);
  }

  const map: CrawlMap = {
    patch,
    client: /LeagueOfLegendsClient\/([\d.]+)/.exec(ua)?.[1] ?? '',
    crawledAt: new Date().toISOString(),
    screens: [],
  };
  const save = () => writeFileSync(join(outDir, ONLY.length ? `map.partial.json` : 'map.json'), JSON.stringify(map, null, 1));

  await client.crawlGuard(true);
  try {
    const nav = (await client.page<Array<{ id: string; name: string; disabled: boolean }>>('nav')).filter(
      (n) => !n.disabled && (!ONLY.length || ONLY.includes(n.id)),
    );
    // Tab names come only as loc keys; the tooltip on the top-bar icon has the localized name.
    const names = new Map<string, string>();
    for (const n of nav) {
      const t: Target = { selector: `lol-uikit-navigation-item.main-navigation-menu-item.menu_item_${n.name}` };
      if (!(await client.page<number>('count', t).catch(() => 0))) continue;
      const h = await client.observe(async () => (await client.hover(t), await sleep(700)), { maxMs: 1500, quietMs: 300 });
      const tip = h.opened.map((o) => o.text).find(Boolean);
      if (tip) names.set(n.id, tip.split(/ {2,}|\n/)[0].slice(0, 40));
    }
    await moveAway();
    const roots: Node[] = nav.map((n) => ({ id: n.id.replace(/^rcp-fe-lol-/, ''), title: names.get(n.id) ?? n.name, path: [{ nav: n.id }] }));

    // Controls shared by the first two screens (top bar, social panel) are the shell: crawled once, under "shell".
    const allNav = await client.page<Array<{ id: string }>>('nav');
    const probe = async (id: string) => {
      await client.page('navigate', id);
      await client.settle(undefined, 500, 6000);
      return (await client.page<{ items: Item[] }>('snapshot', { collapse: 1, max: 400 })).items.map(shellKey);
    };
    const a = new Set(await probe(allNav[0].id));
    const b = await probe(allNav[1].id);
    const shell = new Set(b.filter((s) => a.has(s)));
    log(`shell: ${shell.size} shared controls`);

    const queue: Node[] = [];
    if (!ONLY.length || ONLY.includes('shell')) queue.push({ id: 'shell', title: 'Shell (top bar, social panel)', path: [{ nav: allNav[0].id }] });
    queue.push(...roots);
    const seenKeys = new Set<string>();
    /** Screen key -> id of the node that covers it (visited or queued), so a screen is queued once. */
    const keyOwner = new Map<string, string>();
    /** Tabs already clicked once, by selector|label. */
    const tabs = new Map<string, Control>();
    const seenIds = new Set<string>();

    while (queue.length && map.screens.length < MAX_SCREENS) {
      const node = queue.shift()!;
      if (seenIds.has(node.id)) continue;
      seenIds.add(node.id);
      await assertSafePhase();

      const mark = client.net.length ? client.net[client.net.length - 1].seq : 0;
      if (!(await reset(node))) {
        log(`!! could not reach ${node.id}`);
        map.screens.push({ id: node.id, title: node.title, path: node.path, enter: [], controls: [], shot: undefined });
        continue;
      }
      const key = node.within ? `ov:${node.id}` : await keyOf();
      if (node.id !== 'shell' && seenKeys.has(key)) {
        log(`== ${node.id} is the same screen as an earlier one (${key})`);
        continue;
      }
      seenKeys.add(key);
      if (!keyOwner.has(key)) keyOwner.set(key, node.id);

      const screen: Screen = {
        id: node.id,
        title: node.title,
        path: node.path,
        enter: client.net.filter((n) => n.seq > mark).map((n) => `${n.method} ${n.path.replace(/\?.*/, '')}${n.blocked ? ' (blocked)' : ''}`),
        controls: [],
        shot: `shots/${slug(node.id)}.jpg`,
      };
      await shot(join(outDir, screen.shot!));

      const snap = await client.page<{ items: Item[] }>('snapshot', { within: node.within, collapse: 1, signatures: true, max: 300 });
      const items = snap.items.filter((i) => (node.id === 'shell' ? shell.has(shellKey(i)) : !shell.has(shellKey(i))));
      const baseSigs = new Set(snap.items.map((i) => i.signature));
      log(`>> ${node.id} [${key}] ${items.length} controls, queue ${queue.length}`);

      for (const item of items.slice(0, MAX_CONTROLS)) {
        const c: Control = { label: item.label, tag: item.tag, selector: item.selector, effect: 'none' };
        if (item.similar) c.similar = item.similar;
        if (item.frame) {
          c.effect = 'skipped';
          c.note = `iframe ${item.frame} (not crawled)`;
          screen.controls.push(c);
          continue;
        }
        const t: Target = { selector: item.selector, within: node.within };
        const known = tabs.get(`${item.selector}|${item.label}`);
        if (known && !node.within) {
          // Same tab as on a sibling screen: its hover and destination are already recorded.
          Object.assign(c, { effect: known.effect, opens: known.opens, hover: known.hover, note: 'tab (see first occurrence)' });
          screen.controls.push(c);
          continue;
        }
        try {
          if (!(await client.page<number>('count', t))) {
            // The element moved or vanished since the snapshot (previous click re-rendered the screen).
            if (!(await reset(node)) || !(await client.page<number>('count', t))) {
              c.effect = 'skipped';
              c.note = 'not found after reset';
              screen.controls.push(c);
              continue;
            }
          }
          if (HOVER) {
            const h = await client.observe(async () => {
              await client.hover(t);
              await sleep(700);
            }, { maxMs: 1500, quietMs: 300 });
            const tips = h.opened.map((o) => o.text).filter(Boolean);
            if (tips.length) c.hover = tips.join(' | ').slice(0, 300);
            await moveAway();
          }

          const before = await items_(node.within);
          const pt = await client.page<{ onTop: boolean }>('point', t);
          if (!pt.onTop) {
            // Something left open by the previous control (dropdown, flyout): close it and try again from a clean screen.
            if (!(await reset(node))) throw new Error('could not reset before click');
          }
          const o = await client.observe(() => client.click(t), { quietMs: 600, maxMs: 4000 });
          c.requests = o.requests.map((r) => r.slice(0, 400));
          if (!c.requests.length) delete c.requests;
          await assertSafePhase();

          const step: Step = {
            click: meaningful(item.label) ? { text: item.label, exact: true, within: node.within } : { selector: item.selector, within: node.within },
          };
          const childId = `${node.id}/${slug(meaningful(item.label) ? item.label : item.selector.split(/[ >.#:]+/).filter(Boolean).at(-1) ?? 'x')}`;
          const realOpened = o.opened
            .filter((x) => !/tooltip/i.test(x.tag + x.selector))
            .sort((a, b) => ((b as any).area ?? 0) - ((a as any).area ?? 0));
          let changed = false;

          if (realOpened.length) {
            c.effect = 'overlay';
            c.opens = `${realOpened[0].tag}: ${realOpened[0].text}`.slice(0, 300);
            if (clicks(node.path) < DEPTH) {
              queue.push({ id: childId, title: `${node.title} › ${item.label}`, path: [...node.path, step], within: realOpened[0].selector });
              c.opens = `${childId} — ${c.opens}`;
            }
            changed = true;
          } else {
            const nowKey = node.within ? key : await keyOf();
            const sigs = node.within ? baseSigs : await signatures();
            if (o.nav || nowKey !== key || jaccard(baseSigs, sigs) < 0.6) {
              c.effect = 'screen';
              const target = o.nav ? o.nav.to : nowKey;
              c.opens = target ?? undefined;
              const owner = keyOwner.get(nowKey);
              if (owner) c.opens = `${owner} (${target})`;
              else if (clicks(node.path) < DEPTH) {
                queue.push({ id: childId, title: `${node.title} › ${item.label}`, path: [...node.path, step] });
                keyOwner.set(nowKey, childId);
                c.opens = `${childId} (${target})`;
              }
              if (/^(a|lol-uikit-navigation-item)$/.test(item.tag)) tabs.set(`${item.selector}|${item.label}`, c);
              changed = true;
            } else if (o.closed.length && node.within) {
              c.effect = 'requests';
              c.note = 'closed the overlay';
              changed = true;
            } else {
              // Dropdowns and expanders add controls in place (often inside the control's own shadow root).
              const after = await items_(node.within);
              const added = [...after.values()].filter((i) => !before.has(`${i.selector}|${i.label}`) && i.label);
              if (added.length) {
                c.effect = 'reveals';
                c.opens = added.slice(0, 15).map((i) => i.label).join(' | ').slice(0, 400);
                changed = true;
              } else c.effect = c.requests ? 'requests' : 'none';
            }
          }
          if (changed && !(await reset(node))) {
            log(`!! lost ${node.id} after clicking "${item.label}"`);
            screen.controls.push(c);
            break;
          }
        } catch (e) {
          if (e instanceof Abort) throw e;
          c.effect = 'error';
          c.note = (e as Error).message.slice(0, 200);
          await reset(node).catch(() => {});
        }
        screen.controls.push(c);
        log(`   ${c.effect.padEnd(8)} ${c.label.slice(0, 40)}${c.hover ? ` ~ ${c.hover.slice(0, 40)}` : ''}${c.requests ? ` [${c.requests.length} req]` : ''}`);
      }
      map.screens.push(screen);
      save();
    }
  } finally {
    await client.crawlGuard(false).catch(() => {});
    await moveAway().catch(() => {});
    await closeOverlays().catch(() => {});
    // Blocked writes leave Riot's local view out of sync with the server; a reload re-reads everything.
    const phase = await client.phase().catch(() => 'unknown');
    if (phase === 'Lobby' && startPhase !== 'Lobby') await client.lcu('DELETE', '/lol-lobby/v2/lobby').catch(() => {});
    await client.reload().catch((e) => log(`reload skipped: ${e.message}`));
    if (layer.shown) {
      await sleep(3000);
      const l = await client.page<{ shown?: boolean }>('layer').catch(() => ({ shown: true }));
      if (!l.shown) await client.cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',ctrlKey:true,shiftKey:true})), true`);
    }
    save();
    log(`done: ${map.screens.length} screens → ${outDir}`);
    client.cdp.close();
  }
}

async function shot(file: string): Promise<void> {
  const zoom: number = (await client.cdp.send('Page.getLayoutMetrics')).cssVisualViewport.zoom ?? 1;
  const v = await client.cdp.evaluate<{ w: number; h: number }>('({w: innerWidth, h: innerHeight})');
  const r = await client.cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 60,
    clip: { x: 0, y: 0, width: v.w * zoom, height: v.h * zoom, scale: 1 / zoom },
  });
  writeFileSync(file, Buffer.from(r.data, 'base64'));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
