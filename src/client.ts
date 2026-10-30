import { Cdp } from './cdp.ts';
import { HELPER } from './inpage.ts';
import { BUSY_PHASES, crawlAllows, dangerous, pathOf } from './guard.ts';

export type Target = { ref?: string; selector?: string; text?: string; exact?: boolean; nth?: number; within?: string };

export interface NetEntry {
  seq: number;
  id: string;
  time: number;
  method: string;
  path: string;
  type: string;
  body?: string;
  status?: number;
  blocked?: string;
}

const KEYS: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, ' ': 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i])),
};
const MODS: Record<string, number> = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Shift: 8 };

/** Requests the Riot UI makes for assets; left out of the network log. */
const ASSET = /\.(png|jpe?g|webp|gif|svg|webm|mp4|ogg|wav|woff2?|ttf|css|js|map)$/i;
/** Riot's own telemetry and asset routes: never what a control "does". */
const NOISE = /^\/(fe|telemetry|tracing|lol-game-data\/assets)\//;

/**
 * High-level access to the client page: helper calls, real input, network log and the safety guard. One instance is
 * shared by the MCP server and the crawler.
 */
export class Client {
  readonly cdp = new Cdp();
  readonly net: NetEntry[] = [];
  readonly logs: string[] = [];
  private seq = 0;
  /** 'crawl' fails every write outside the crawl allowlist; 'input' fails dangerous writes until `inputUntil`. */
  private guardMode: 'off' | 'input' | 'crawl' = 'off';
  private inputUntil = 0;
  private fetchOn = false;
  private disarmTimer: NodeJS.Timeout | null = null;
  private scripts = new Map<string, { source: string; cdpId?: string }>();

  async init(): Promise<void> {
    this.cdp.on('Network.requestWillBeSent', (p) => {
      const url: string = p.request.url;
      const path = pathOf(url);
      if (!/^https:\/\/127\.0\.0\.1/.test(url) || ASSET.test(path) || NOISE.test(path)) return;
      this.push({
        seq: ++this.seq,
        id: p.requestId,
        time: Date.now(),
        method: p.request.method,
        path: url.replace(/^https:\/\/[^/]+/, ''),
        type: p.type,
        body: p.request.postData?.slice(0, 2000),
      });
    });
    this.cdp.on('Network.responseReceived', (p) => {
      const e = this.net.findLast((n) => n.id === p.requestId);
      if (e) e.status = p.response.status;
    });
    this.cdp.on('Fetch.requestPaused', (p) => void this.decide(p));
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = p.args.map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      this.log(`[${p.type}] ${text}`);
    });
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.log(`[exception] ${d.exception?.description ?? d.text}`);
    });
    this.cdp.on('Inspector.detached', () => this.cdp.close());
    await this.cdp.onConnect(async () => {
      this.fetchOn = false;
      await this.cdp.send('Network.enable', { maxPostDataSize: 4096 });
      await this.cdp.send('Runtime.enable');
      await this.cdp.send('Page.enable');
      for (const s of this.scripts.values()) {
        s.cdpId = (await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: s.source })).identifier;
      }
      if (this.guardMode !== 'off') await this.setFetch(true);
    });
  }

  private push(e: NetEntry) {
    this.net.push(e);
    if (this.net.length > 1000) this.net.splice(0, this.net.length - 1000);
  }

  private log(line: string) {
    this.logs.push(`${new Date().toISOString().slice(11, 23)} ${line.slice(0, 2000)}`);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  // ---- guard ---------------------------------------------------------------------------------------------------

  private async decide(p: any): Promise<void> {
    const { method, url, postData } = p.request;
    let why: string | null = null;
    if (this.guardMode === 'crawl') why = crawlAllows(method, url) ? null : (dangerous(method, url) ?? 'crawl: write');
    else if (this.guardMode === 'input' && Date.now() < this.inputUntil) why = dangerous(method, url);
    try {
      if (!why) return void (await this.cdp.send('Fetch.continueRequest', { requestId: p.requestId }));
      this.push({
        seq: ++this.seq,
        id: p.networkId ?? p.requestId,
        time: Date.now(),
        method,
        path: url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, ''),
        type: p.resourceType,
        body: postData?.slice(0, 2000),
        blocked: why,
      });
      await this.cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    } catch {
      // The request may already be gone (page navigated); nothing to do.
    }
  }

  private async setFetch(on: boolean): Promise<void> {
    if (on === this.fetchOn) return;
    this.fetchOn = on;
    if (on) await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    else await this.cdp.send('Fetch.disable').catch(() => {});
  }

  /** Arms the dangerous-write filter for `ms` after an input action. Interception stops again when idle. */
  async armInput(ms = 6000): Promise<void> {
    if (this.guardMode === 'crawl') return;
    this.guardMode = 'input';
    this.inputUntil = Date.now() + ms;
    await this.setFetch(true);
    if (this.disarmTimer) clearTimeout(this.disarmTimer);
    this.disarmTimer = setTimeout(() => {
      if (this.guardMode !== 'input') return;
      this.guardMode = 'off';
      void this.setFetch(false);
    }, ms + 200);
  }

  async crawlGuard(on: boolean): Promise<void> {
    this.guardMode = on ? 'crawl' : 'off';
    await this.setFetch(on);
  }

  // ---- page helper -------------------------------------------------------------------------------------------------

  page<T = any>(fn: string, ...args: unknown[]): Promise<T> {
    const a = args.map((x) => (x === undefined ? 'undefined' : JSON.stringify(x))).join(',');
    return this.cdp.evaluate<T>(`${HELPER}.${fn}(${a})`);
  }

  async lcu<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const why = dangerous(method, path);
    if (why) throw new Error(`Refused ${method} ${path}: ${why} (account safety rule).`);
    return this.page('lcu', method, path, body);
  }

  async phase(): Promise<string> {
    return (await this.page<{ data: string }>('lcu', 'GET', '/lol-gameflow/v1/gameflow-phase')).data;
  }

  // ---- input -----------------------------------------------------------------------------------------------------

  async pointOf(t: Target | { x: number; y: number }) {
    if ('x' in t) return { x: t.x, y: t.y, onTop: true, element: undefined as any, covering: undefined as any };
    return this.page<{ x: number; y: number; onTop: boolean; element: any; covering?: any }>('point', t);
  }

  async mouse(type: string, x: number, y: number, extra: object = {}): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  async click(t: Target | { x: number; y: number }, opts: { button?: string; count?: number; force?: boolean } = {}) {
    const p = await this.pointOf(t);
    if (!p.onTop && !opts.force) {
      throw new Error(
        `Target is covered at its center by ${JSON.stringify(p.covering)}; close that first or pass force.`,
      );
    }
    await this.armInput();
    const button = opts.button ?? 'left';
    await this.mouse('mouseMoved', p.x, p.y);
    for (let i = 1; i <= (opts.count ?? 1); i++) {
      await this.mouse('mousePressed', p.x, p.y, { button, clickCount: i });
      await this.mouse('mouseReleased', p.x, p.y, { button, clickCount: i });
    }
    return p;
  }

  async hover(t: Target | { x: number; y: number }) {
    const p = await this.pointOf(t);
    await this.mouse('mouseMoved', p.x, p.y);
    return p;
  }

  async scroll(t: Target | { x: number; y: number }, deltaY: number, deltaX = 0) {
    const p = await this.pointOf(t);
    await this.mouse('mouseMoved', p.x, p.y);
    await this.mouse('mouseWheel', p.x, p.y, { deltaX, deltaY });
    return p;
  }

  /** Presses a combo like "Escape", "Enter", "Ctrl+A", "Ctrl+Shift+F12". */
  async key(combo: string): Promise<void> {
    await this.armInput();
    const parts = combo.split('+').map((s) => s.trim());
    const key = parts.pop()!;
    const modifiers = parts.reduce((m, k) => m | (MODS[k] ?? 0), 0);
    const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
    const text = !(key in KEYS) && key.length === 1 && !(modifiers & ~8) ? key : undefined;
    const base = {
      key: key === 'Space' ? ' ' : key,
      code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      modifiers,
    };
    await this.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(text: string): Promise<void> {
    await this.armInput();
    await this.cdp.send('Input.insertText', { text });
  }

  /**
   * Runs `action` and reports what it caused: LCU requests (including blocked ones), overlays that appeared or went
   * away, and the active nav tab. Waits until the network has been quiet for `quietMs` (max `maxMs`).
   */
  async observe(action: () => Promise<unknown>, opts: { quietMs?: number; maxMs?: number } = {}) {
    const before = await this.page<Array<{ selector: string; text: string; tag: string }>>('overlays').catch(() => []);
    const navBefore = await this.activeNav();
    const mark = this.seq;
    const result = await action();
    await this.settle(mark, opts.quietMs ?? 500, opts.maxMs ?? 4000);
    const after = await this.page<Array<{ selector: string; text: string; tag: string }>>('overlays').catch(() => []);
    const key = (o: { selector: string; text: string }) => o.selector + '|' + o.text;
    const was = new Set(before.map(key));
    const now = new Set(after.map(key));
    const navAfter = await this.activeNav();
    return {
      result,
      requests: this.net.filter((n) => n.seq > mark).map(fmtNet),
      opened: after.filter((o) => !was.has(key(o))),
      closed: before.filter((o) => !now.has(key(o))).map((o) => o.selector),
      nav: navBefore !== navAfter ? { from: navBefore, to: navAfter } : undefined,
    };
  }

  /** Resolves once no new request arrived for `quietMs`, or after `maxMs`. */
  async settle(mark = this.seq, quietMs = 500, maxMs = 4000): Promise<void> {
    const start = Date.now();
    let last = Date.now();
    let seen = mark;
    while (Date.now() - start < maxMs) {
      await sleep(100);
      if (this.seq !== seen) {
        seen = this.seq;
        last = Date.now();
      } else if (Date.now() - last >= quietMs && Date.now() - start >= 250) return;
    }
  }

  async activeNav(): Promise<string | null> {
    const items = await this.page<Array<{ id: string; active: boolean }>>('nav').catch(() => []);
    return items.find((i) => i.active)?.id ?? null;
  }

  async reload(): Promise<string> {
    const phase = await this.phase();
    if (BUSY_PHASES.includes(phase)) throw new Error(`Refusing to reload during ${phase}.`);
    await this.cdp.send('Page.reload', {});
    await sleep(1500);
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      try {
        if (await this.cdp.evaluate(`!!(window.rcp?.get?.('rcp-fe-lol-navigation')?._services) && document.readyState === 'complete'`))
          return phase;
      } catch {}
      await sleep(500);
    }
    throw new Error('Client did not come back within 90 s after reload.');
  }

  async addScript(id: string, source: string, runNow = true): Promise<void> {
    await this.removeScript(id);
    const cdpId = (await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
    this.scripts.set(id, { source, cdpId });
    if (runNow) await this.cdp.evaluate(source);
  }

  async removeScript(id: string): Promise<boolean> {
    const s = this.scripts.get(id);
    if (!s) return false;
    this.scripts.delete(id);
    if (s.cdpId) await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.cdpId }).catch(() => {});
    return true;
  }

  scriptIds(): string[] {
    return [...this.scripts.keys()];
  }
}

export function fmtNet(n: NetEntry): string {
  const status = n.blocked ? `BLOCKED (${n.blocked})` : (n.status ?? '…');
  return `${n.method} ${n.path} → ${status}${n.body ? ` ${n.body.slice(0, 300)}` : ''}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
