import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Listener = (params: any) => void;

const penguConfig = () => join(process.env.PENGU_DIR ?? 'C:\\Program Files\\Pengu Loader', 'config');

/** Port from LOL_CDP_PORT, else `RemoteDebuggingPort=` in Pengu Loader's config file, else 9222. */
export function cdpPort(): number {
  if (process.env.LOL_CDP_PORT) return Number(process.env.LOL_CDP_PORT);
  try {
    const m = /RemoteDebuggingPort\s*=\s*(\d+)/i.exec(readFileSync(penguConfig(), 'utf8'));
    if (m && m[1] !== '0') return Number(m[1]);
  } catch {}
  return 9222;
}

/** `--setup`: sets RemoteDebuggingPort in Pengu Loader's config (other keys kept). Takes effect on the next client start. */
export function setupPengu(port = Number(process.env.LOL_CDP_PORT ?? 9222)): string {
  const file = penguConfig();
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*RemoteDebuggingPort\s*=/i.test(l));
  lines.push(`RemoteDebuggingPort=${port}`);
  writeFileSync(file, lines.join('\n'));
  return `Wrote RemoteDebuggingPort=${port} to ${file}. Restart the League client to open the port.`;
}

export class CdpError extends Error {}

/**
 * One connection to the client's page target. Reconnects lazily: after a UX restart the target id changes, so the next
 * `send` finds the new page and re-runs every `onConnect` hook (domain enables, interception).
 */
export class Cdp {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<Listener>>();
  private hooks: Array<() => Promise<void>> = [];
  readonly port: number;

  constructor(port = cdpPort()) {
    this.port = port;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Runs now (if connected) and after every reconnect. */
  async onConnect(hook: () => Promise<void>): Promise<void> {
    this.hooks.push(hook);
    if (this.connected) await hook();
  }

  on(method: string, fn: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(): Promise<void> {
    let targets: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
    try {
      targets = await (await fetch(`http://127.0.0.1:${this.port}/json`, { signal: AbortSignal.timeout(3000) })).json();
    } catch {
      throw new CdpError(
        `No CDP endpoint on 127.0.0.1:${this.port}. Is the League client running with Pengu Loader, and does ` +
          `"${penguConfig()}" contain RemoteDebuggingPort=${this.port}? Run "npx -y -p github:kyso1/lol-cdp-mcp ` +
          `lol-cdp-mcp --setup" to add it, then restart the client.`,
      );
    }
    const page = targets.find((t) => t.type === 'page' && /\/index\.html/.test(t.url) && t.webSocketDebuggerUrl);
    if (!page) throw new CdpError('CDP is up but the client page target is not there yet (client still loading?).');
    const ws = new WebSocket(page.webSocketDebuggerUrl!);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new CdpError('Could not open the CDP WebSocket.'));
    });
    ws.onmessage = (e) => this.dispatch(JSON.parse(String(e.data)));
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CdpError('CDP connection closed (client restarted or closed).'));
      }
      this.pending.clear();
    };
    this.ws = ws;
    for (const hook of this.hooks) await hook();
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners.get(msg.method) ?? []) {
      try {
        fn(msg.params);
      } catch (e) {
        console.error(`[cdp] listener for ${msg.method} threw`, e);
      }
    }
  }

  async send<T = any>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    await this.connect();
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates `expression` (awaiting promises) and returns its JSON value; page exceptions become CdpError. */
  async evaluate<T = any>(expression: string, timeoutMs = 30_000): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new CdpError(d.exception?.description ?? d.exception?.value ?? d.text ?? 'evaluation failed');
    }
    return r.result.value as T;
  }

  close(): void {
    this.ws?.close();
  }
}
