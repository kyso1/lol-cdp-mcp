import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, Target } from './client.ts';
import { sleep } from './client.ts';

export const MAP_DIR = join(import.meta.dirname, '..', 'map');

/** One way to get somewhere: open a nav tab, click a control, press a key. */
export interface Step {
  nav?: string;
  click?: Target;
  key?: string;
}

export interface Control {
  label: string;
  tag: string;
  selector: string;
  /** What clicking did: went to another screen, opened an overlay, only fired requests, nothing, or was not clicked. */
  effect: 'screen' | 'overlay' | 'requests' | 'none' | 'skipped' | 'error';
  hover?: string;
  /** Screen id reached, or overlay text. */
  opens?: string;
  requests?: string[];
  similar?: number;
  note?: string;
}

export interface Screen {
  id: string;
  title: string;
  path: Step[];
  /** LCU requests fired while the screen loaded. */
  enter: string[];
  controls: Control[];
  shot?: string;
}

export interface CrawlMap {
  patch: string;
  client: string;
  crawledAt: string;
  screens: Screen[];
}

export function patchOf(userAgent: string): string {
  return /LeagueOfLegendsClient\/(\d+\.\d+)/.exec(userAgent)?.[1] ?? 'unknown';
}

export function loadMap(patch: string): CrawlMap | null {
  const file = join(MAP_DIR, patch, 'map.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  // Fall back to the newest map from another patch; most screens survive a patch.
  const dirs = existsSync(MAP_DIR) ? readdirSync(MAP_DIR).filter((d) => existsSync(join(MAP_DIR, d, 'map.json'))) : [];
  const last = dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  return last ? JSON.parse(readFileSync(join(MAP_DIR, last, 'map.json'), 'utf8')) : null;
}

/** Screens whose id, title, control labels, hovers or requests contain every word of `query`. */
export function searchMap(map: CrawlMap, query: string): Array<{ screen: Screen; hits: string[] }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Array<{ screen: Screen; hits: string[] }> = [];
  for (const s of map.screens) {
    const hay = (t: string) => words.every((w) => t.toLowerCase().includes(w));
    const hits: string[] = [];
    if (hay(`${s.id} ${s.title}`)) hits.push('(screen)');
    for (const c of s.controls) {
      const text = `${c.label} ${c.hover ?? ''} ${c.opens ?? ''} ${(c.requests ?? []).join(' ')}`;
      if (hay(text)) hits.push(c.label || c.selector);
    }
    for (const r of s.enter) if (hay(r)) hits.push(`enter: ${r}`);
    if (hits.length) out.push({ screen: s, hits });
  }
  return out;
}

/** Replays a screen's path from a known state: nav tab first, then the clicks. */
export async function goTo(client: Client, screen: Screen): Promise<void> {
  for (const step of screen.path) {
    if (step.nav) await client.page('navigate', step.nav);
    if (step.click) {
      await waitFor(client, step.click, 8000);
      await client.click(step.click);
    }
    if (step.key) await client.key(step.key);
    await client.settle(undefined, 400, 5000);
  }
}

export async function waitFor(client: Client, t: Target, timeoutMs: number, gone = false): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await client.page<number>('count', t).catch(() => 0);
    if (gone ? n === 0 : n > 0) return true;
    await sleep(150);
  }
  return false;
}
