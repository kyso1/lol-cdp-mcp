import { createHash } from 'node:crypto';

/**
 * Helper installed into the client page as `window.__lolmcp`. Serialized with `Function.prototype.toString`, so it
 * must not reference anything outside its own body. Node's type stripping leaves plain JS behind.
 *
 * Riot's UI nests ~100 shadow roots, so every search here walks into them. Selectors produced by `selectorFor` join
 * one segment per shadow root with ` >>> `.
 */
export function inpage() {
  const refs = new Map<string, WeakRef<Element>>();
  let refSeq = 0;

  const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION']);
  const UIKIT =
    /^(lol-uikit-(flat-button|flat-button-secondary|flat-button-group|navigation-item|radio-input-option|flat-checkbox|checkbox|dropdown|framed-dropdown|dropdown-option|flat-input|slider|close-button|toggle|framed-icon-button|icon-button|plus-button|switch|search-input|flat-text-area|tab)|lc-button|lol-social-roster-member|lol-social-panel-button)$/i;
  const ROLES = /^(button|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|link|option|switch|slider|combobox|textbox|treeitem|spinbutton)$/;
  const OVERLAY = /modal|flyout|tooltip|dialog|popup|popover|toast|context-menu|contextmenu|dropdown-options|menu-options|lol-uikit-menu/i;
  const UNSTABLE_CLASS = /^(ember|active|hover|hovered|selected|focus|focused|disabled|enabled|visible|hidden|show|open|is-|has-|ng-|animat|transition)/i;

  const parentDeep = (e: Element): Element | null =>
    e.parentElement ?? ((e.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;

  function* walk(root: Document | ShadowRoot | Element): Generator<Element> {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = tw.nextNode() as Element | null; n; n = tw.nextNode() as Element | null) {
      yield n;
      if (n.shadowRoot) yield* walk(n.shadowRoot);
    }
  }

  function containsDeep(outer: Element, inner: Element | null): boolean {
    for (let e = inner; e; e = parentDeep(e)) if (e === outer) return true;
    return false;
  }

  function visible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const s = getComputedStyle(el);
    if (s.visibility !== 'visible') return false;
    for (let e: Element | null = el; e; e = parentDeep(e)) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || Number(cs.opacity) === 0) return false;
    }
    return true;
  }

  function deepPoint(x: number, y: number): Element | null {
    let e = document.elementFromPoint(x, y);
    while (e?.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  }

  function interactive(el: Element): boolean {
    if (INTERACTIVE_TAGS.has(el.tagName) || UIKIT.test(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && ROLES.test(role)) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    if ((el as HTMLElement).onclick) return true;
    // Ember {{action}} and Riot's Datadog action names mark click handlers that leave no other trace.
    for (const a of el.getAttributeNames()) if (a.startsWith('data-ember-action') || a === 'data-dd-action-name') return true;
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    // Only the outermost element of a pointer region counts, so a button's icon and label are not listed separately.
    const p = parentDeep(el);
    return !p || getComputedStyle(p).cursor !== 'pointer';
  }

  const squash = (s: string | null | undefined, max = 80) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };

  function label(el: Element): string {
    const a = ['aria-label', 'title', 'alt', 'placeholder', 'data-tooltip', 'tooltip-text', 'data-dd-action-name', 'action']
      .map((k) => el.getAttribute(k))
      .find((v) => v && v.trim());
    const text = squash((el as HTMLElement).innerText ?? el.textContent);
    if (text) return a && !text.includes(a) ? `${text} [${squash(a, 40)}]` : text;
    if (a) return squash(a);
    const img = el.querySelector?.('img[alt]') ?? el.shadowRoot?.querySelector('img[alt]');
    if (img?.getAttribute('alt')) return squash(img.getAttribute('alt'));
    const input = el as HTMLInputElement;
    if (typeof input.value === 'string' && input.value) return squash(input.value);
    // Icon-only controls: their class usually says what they are ("honor-button", "chat-button").
    const cls = [...el.classList].filter((c) => !UNSTABLE_CLASS.test(c) && /[a-z]{3}/i.test(c)).slice(0, 2);
    return cls.length ? `(${cls.join(' ')})` : '';
  }

  function segment(el: Element, root: Document | ShadowRoot): string {
    const parts: string[] = [];
    let e: Element | null = el;
    while (e && e !== (root as unknown)) {
      let s = e.tagName.toLowerCase();
      if (e.id && !/^ember\d+$/.test(e.id) && /^[A-Za-z][\w-]*$/.test(e.id)) s += `#${e.id}`;
      else {
        s += [...e.classList]
          .filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !UNSTABLE_CLASS.test(c))
          .slice(0, 3)
          .map((c) => `.${c}`)
          .join('');
        const parent = e.parentElement;
        if (parent) {
          const same = [...parent.children].filter((x) => x.tagName === e!.tagName);
          if (same.length > 1 && parent.querySelectorAll(`:scope > ${s}`).length > 1) {
            s += `:nth-of-type(${same.indexOf(e) + 1})`;
          }
        }
      }
      parts.unshift(s);
      try {
        if (root.querySelectorAll(parts.join(' > ')).length === 1) break;
      } catch {}
      e = e.parentElement;
    }
    return parts.join(' > ');
  }

  function selectorFor(el: Element): string {
    const segs: string[] = [];
    let e: Element = el;
    for (;;) {
      const root = e.getRootNode() as Document | ShadowRoot;
      segs.unshift(segment(e, root));
      if (root instanceof ShadowRoot) e = root.host;
      else break;
    }
    return segs.join(' >>> ');
  }

  function queryAllDeep(selector: string, scope: Element | Document = document): Element[] {
    if (selector.includes('>>>')) {
      let ctx: Array<Document | ShadowRoot | Element> = [scope];
      const parts = selector.split('>>>').map((p) => p.trim());
      let found: Element[] = [];
      parts.forEach((part, i) => {
        found = ctx.flatMap((c) => [...c.querySelectorAll(part)]);
        if (i < parts.length - 1) ctx = found.map((f) => f.shadowRoot).filter((r): r is ShadowRoot => !!r);
      });
      return found;
    }
    const out: Element[] = [];
    for (const e of walk(scope)) if (e.matches(selector)) out.push(e);
    return out;
  }

  type Target = { ref?: string; selector?: string; text?: string; exact?: boolean; nth?: number; within?: string };

  function scopeOf(t: Target): Element | Document {
    if (!t.within) return document;
    const s = queryAllDeep(t.within).find(visible);
    if (!s) throw new Error(`within: nothing visible matches ${t.within}`);
    return s;
  }

  function candidates(t: Target): Element[] {
    if (t.ref) {
      const el = refs.get(t.ref)?.deref();
      if (!el || !el.isConnected) throw new Error(`ref ${t.ref} is stale; take a new snapshot`);
      return [el];
    }
    const scope = scopeOf(t);
    if (t.selector) {
      const all = queryAllDeep(t.selector, scope);
      const vis = all.filter(visible);
      return vis.length ? vis : all;
    }
    if (t.text !== undefined) {
      const want = t.text.toLowerCase();
      const match = (s: string) => (t.exact ? s.toLowerCase() === want : s.toLowerCase().includes(want));
      const inter: Element[] = [];
      const plain: Element[] = [];
      for (const e of walk(scope)) {
        if (!visible(e)) continue;
        if (interactive(e) && match(label(e))) inter.push(e);
        else if (!inter.length) {
          const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
          if (match(squash(own, 500))) plain.push(e);
        }
      }
      // Shortest label first: "Play" should beat "Play again later".
      const byLen = (a: Element, b: Element) => label(a).length - label(b).length;
      return inter.length ? inter.sort(byLen) : plain;
    }
    throw new Error('target needs ref, selector or text');
  }

  function find(t: Target): Element {
    const list = candidates(t);
    const el = list[t.nth ?? 0];
    if (!el) throw new Error(`no element for ${JSON.stringify(t)} (${list.length} candidates)`);
    return el;
  }

  function stateOf(el: Element) {
    const h = el as HTMLInputElement;
    const flags: string[] = [];
    if (h.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') flags.push('disabled');
    if (h.checked || el.hasAttribute('selected') || el.getAttribute('aria-checked') === 'true') flags.push('checked');
    if (el.hasAttribute('active') || el.classList.contains('active') || el.getAttribute('aria-selected') === 'true')
      flags.push('active');
    return flags;
  }

  function describe(el: Element) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      label: label(el),
      selector: selectorFor(el),
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      state: stateOf(el),
      value: typeof (el as HTMLInputElement).value === 'string' ? (el as HTMLInputElement).value : undefined,
    };
  }

  function signature(el: Element): string {
    const one = (e: Element) =>
      e.tagName + [...e.classList].filter((c) => !UNSTABLE_CLASS.test(c)).sort().join('.');
    const p = parentDeep(el);
    return `${p ? one(p) : ''}>${one(el)}`;
  }

  /** Visible interactive elements, with refs the other tools accept. Repeated items (same signature) collapse. */
  function snapshot(opts: { within?: string; max?: number; collapse?: number; signatures?: boolean } = {}) {
    refs.clear();
    const scope = opts.within ? scopeOf({ within: opts.within }) : document;
    const groups = new Map<string, number>();
    const items: Array<ReturnType<typeof describe> & { ref: string; similar?: number; frame?: string }> = [];
    const collapse = opts.collapse ?? 3;
    let hidden = 0;
    const kept = new Set<Element>();
    // A link wrapping a nav item wrapping a label is one control: skip parts that fill most of a kept ancestor.
    const nested = (el: Element) => {
      const r = el.getBoundingClientRect();
      let p = parentDeep(el);
      for (let i = 0; p && i < 6; i++, p = parentDeep(p)) {
        if (!kept.has(p)) continue;
        const q = p.getBoundingClientRect();
        // Inside a kept control: skip when it fills most of it or has no name of its own (icon, label span).
        return (r.width * r.height) / Math.max(1, q.width * q.height) > 0.5 || label(el).startsWith('(') || !label(el);
      }
      return false;
    };
    for (const el of walk(scope)) {
      if (el.tagName === 'IFRAME' && visible(el)) {
        const ref = `e${++refSeq}`;
        refs.set(ref, new WeakRef(el));
        items.push({ ...describe(el), ref, frame: (el as HTMLIFrameElement).src.slice(0, 120) });
        continue;
      }
      if (!interactive(el) || !visible(el)) continue;
      if (nested(el)) continue;
      kept.add(el);
      // Tabs are siblings with the same shape but each leads somewhere else: never collapse them.
      const tab = /navigation-item|radio-input-option|^tab$/i.test(el.tagName) || el.getAttribute('role') === 'tab' ||
        !!el.querySelector?.('lol-uikit-navigation-item') || !!el.closest('nav,[role=tablist],[role=navigation],[role=menubar]');
      const sig = tab ? `${signature(el)}#${label(el)}` : signature(el);
      const n = (groups.get(sig) ?? 0) + 1;
      groups.set(sig, n);
      if (collapse > 0 && n > collapse) {
        hidden++;
        continue;
      }
      if (items.length >= (opts.max ?? 400)) {
        hidden++;
        continue;
      }
      const ref = `e${++refSeq}`;
      refs.set(ref, new WeakRef(el));
      items.push({ ...describe(el), ref, signature: sig } as any);
    }
    for (const it of items as any[]) {
      const n = groups.get(it.signature) ?? 1;
      if (n > collapse && collapse > 0) it.similar = n - collapse;
      if (!opts.signatures) delete it.signature;
    }
    return { items, hidden };
  }

  /** Point to send real input to: scrolled into view, center of the box, and whether the element is on top there. */
  function point(t: Target) {
    const el = find(t);
    const before = el.getBoundingClientRect();
    if (before.top < 0 || before.bottom > innerHeight) (el as HTMLElement).scrollIntoView?.({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const hit = deepPoint(x, y);
    return {
      x,
      y,
      onTop: containsDeep(el, hit),
      covering: hit && !containsDeep(el, hit) ? describe(hit) : undefined,
      element: describe(el),
    };
  }

  /** Visible modals, flyouts, tooltips, menus: whatever floats above the screen. */
  function overlays() {
    const out: Array<{ tag: string; selector: string; text: string; area: number }> = [];
    const seen = new Set<Element>();
    for (const e of walk(document)) {
      const tag = e.tagName.toLowerCase();
      const cls = typeof e.className === 'string' ? e.className : '';
      if (!(OVERLAY.test(tag) || OVERLAY.test(cls) || e.getAttribute('role') === 'dialog')) continue;
      if (tag.startsWith('uikit-') || tag === 'lol-uikit-navigation-bar') continue;
      // Skip nested overlay parts once the outer one is listed.
      let inner = false;
      for (let p = parentDeep(e); p; p = parentDeep(p)) if (seen.has(p)) inner = true;
      if (inner || !visible(e)) continue;
      const text = squash((e as HTMLElement).innerText ?? e.textContent, 400);
      if (!text && !/modal|dialog/i.test(tag + cls)) continue;
      seen.add(e);
      const r = e.getBoundingClientRect();
      out.push({ tag, selector: selectorFor(e), text, area: Math.round(r.width * r.height) });
    }
    return out;
  }

  function nav() {
    try {
      const api = (window as any).rcp.get('rcp-fe-lol-navigation');
      const items = api._services.navigation.emberMenuItems;
      return (items.toArray ? items.toArray() : items).map((i: any) => ({
        id: i.get('id'),
        name: i.get('displayName') ?? i.get('displayNameLocKey'),
        active: !!i.get('active'),
        disabled: !!i.get('disabled'),
      }));
    } catch {
      return [];
    }
  }

  function navigate(id: string) {
    const api = (window as any).rcp.get('rcp-fe-lol-navigation');
    if (id === 'home') return api.showHome?.() ?? true;
    const item = api._services.navigation.getEmberMenuItemById(id);
    if (!item) throw new Error(`unknown nav id ${id}; known: ${nav().map((n: any) => n.id).join(', ')}`);
    api.setActive(item, true);
    return true;
  }

  /** Identity of what is on screen: active main tab plus the active sub-tabs (Collection > Skins). */
  function screenKey() {
    const main = nav().find((n: any) => n.active)?.id ?? null;
    const sub: string[] = [];
    for (const e of walk(document)) {
      if (e.tagName !== 'LOL-UIKIT-NAVIGATION-ITEM' || e.classList.contains('main-navigation-menu-item')) continue;
      if (!(e.hasAttribute('active') || e.getAttribute('aria-selected') === 'true') || !visible(e)) continue;
      const l = label(e);
      if (l && !l.startsWith('(')) sub.push(l);
    }
    return { main, sub };
  }

  function text(t: Target) {
    const el = find(t);
    return squash((el as HTMLElement).innerText ?? el.textContent, 4000);
  }

  function html(t: Target, max = 6000) {
    const el = find(t);
    const shadow = el.shadowRoot ? `\n<!-- shadow -->\n${el.shadowRoot.innerHTML}` : '';
    const s = (el.outerHTML + shadow).replace(/<path [^>]*>/g, '<path/>').replace(/(src|href)="data:[^"]{60,}"/g, '$1="data:…"');
    return s.length > max ? s.slice(0, max) + `… (${s.length} chars)` : s;
  }

  function count(t: Target): number {
    try {
      return candidates(t).filter(visible).length;
    } catch {
      return 0;
    }
  }

  function focus(t: Target) {
    const el = find(t) as HTMLElement;
    const input = el.matches('input,textarea,[contenteditable]')
      ? el
      : ((el.shadowRoot?.querySelector('input,textarea') ?? el.querySelector('input,textarea')) as HTMLElement | null) ?? el;
    input.focus();
    return describe(input);
  }

  function clear(t: Target) {
    const el = find(t);
    const input = (el.matches('input,textarea')
      ? el
      : el.shadowRoot?.querySelector('input,textarea') ?? el.querySelector('input,textarea')) as HTMLInputElement | null;
    if (!input) throw new Error('no input inside the target');
    input.focus();
    input.select();
    return true;
  }

  async function lcu(method: string, path: string, body?: unknown) {
    const r = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await r.text();
    let data: unknown = raw;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {}
    return { status: r.status, data };
  }

  function layer() {
    const root = document.querySelector('#rlc-root');
    if (!root) return { present: false };
    return { present: true, shown: getComputedStyle(root).display !== 'none' && visible(root) };
  }

  return { snapshot, point, overlays, nav, navigate, screenKey, text, html, count, focus, clear, lcu, layer, describe, find, selectorFor, queryAllDeep, visible };
}

const SOURCE = inpage.toString();
// Keyed by a hash of the source, so a page that still holds an older helper (server restarted) gets the new one.
const KEY = `__lolmcp_${createHash('sha1').update(SOURCE).digest('hex').slice(0, 8)}`;

/** Expression that installs the helper once per page load and evaluates to it. */
export const HELPER = `(window.${KEY} ??= (${SOURCE})())`;
