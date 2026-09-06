/**
 * The demo's control panel: a rounded glass card pinned to the left edge that
 * lists every command the demo answers to, grouped by subsystem.
 *
 * It is driven by the same registry the keyboard is. Each control names its
 * key and how to run it, and the panel is a view over that list — a click and
 * a key press take the same path, and the row's on/off state or value is read
 * back from the demo every frame through `refresh()`, so the panel never
 * carries state of its own.
 *
 * The whole panel collapses to a pill, and each section folds on its own;
 * both are remembered in localStorage so the view survives a reload.
 */

/** A row that is on or off. Click or key flips it. */
export interface ToggleControl {
  type: 'toggle';
  label: string;
  key?: string;
  get: () => boolean;
  set: (on: boolean) => void;
}

/** A row that does something once; the optional value shows what it's set to now. */
export interface ActionControl {
  type: 'action';
  label: string;
  key?: string;
  run: () => void;
  value?: () => string;
}

/** A value stepped down or up with two keys. */
export interface ScrubControl {
  type: 'scrub';
  label: string;
  keys: [string, string];
  value: () => string;
  dec: () => void;
  inc: () => void;
}

/**
 * A keyboard-only command — one that needs the cursor on the map, which it
 * can't be while it's on this panel. Listed so the key is discoverable.
 */
export interface HintControl {
  type: 'hint';
  label: string;
  key?: string;
  run?: () => void;
  /** Drop auto-repeat: held keys fire every ~30 ms, and some commands can't take that. */
  noRepeat?: boolean;
}

/** A line of status text under the controls above it. */
export interface NoteControl {
  type: 'note';
  text: () => string;
}

export type PanelControl = ToggleControl | ActionControl | ScrubControl | HintControl | NoteControl;

export interface PanelSection {
  title: string;
  controls: PanelControl[];
}

export interface ControlPanelOptions {
  title: string;
  sections: PanelSection[];
  /** localStorage key the collapse state is kept under. Omit to not remember it. */
  storageKey?: string;
}

const STYLE_ID = 'hexworld-control-panel-style';

const CSS = `
.cp {
  position: fixed; top: 12px; left: 12px;
  width: 268px; max-height: calc(100vh - 24px);
  display: flex; flex-direction: column;
  color: #e8ecf4;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: rgba(16, 18, 26, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  user-select: none;
  z-index: 10;
}
.cp.cp-collapsed { width: auto; }
.cp.cp-collapsed .cp-body { display: none; }
.cp-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 10px 14px;
  font-weight: 600; letter-spacing: 0.02em;
  cursor: pointer;
}
.cp-head .cp-title { flex: 1; }
.cp-head .cp-chev { opacity: 0.7; transition: transform 0.15s; font-size: 11px; }
.cp.cp-collapsed .cp-head .cp-chev { transform: rotate(-90deg); }
.cp-body { overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 8px; scrollbar-width: thin; }
.cp-section { margin-top: 2px; }
.cp-section-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 6px 5px;
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  color: rgba(232, 236, 244, 0.6);
  cursor: pointer; border: 0; background: none; width: 100%; text-align: left;
}
.cp-section-head .cp-chev { font-size: 9px; transition: transform 0.15s; }
.cp-section.cp-folded .cp-section-head .cp-chev { transform: rotate(-90deg); }
.cp-section.cp-folded .cp-section-body { display: none; }
.cp-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; min-height: 30px; padding: 4px 8px;
  border: 0; border-radius: 8px; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.cp-row:hover { background: rgba(255, 255, 255, 0.07); }
.cp-row:active { background: rgba(255, 255, 255, 0.12); }
.cp-row .cp-label { flex: 1; }
.cp-row .cp-value {
  color: rgba(232, 236, 244, 0.6); font-size: 12px; font-variant-numeric: tabular-nums;
  text-align: right; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cp kbd {
  display: inline-block; min-width: 20px; padding: 1px 5px;
  font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; text-align: center;
  color: rgba(232, 236, 244, 0.85);
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14); border-bottom-width: 2px;
  border-radius: 4px;
}
.cp-switch {
  position: relative; width: 30px; height: 17px; flex: none;
  background: rgba(255, 255, 255, 0.16); border-radius: 9px;
  transition: background 0.15s;
}
.cp-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 13px; height: 13px; border-radius: 50%;
  background: #fff; transition: transform 0.15s;
}
.cp-toggle[aria-checked="true"] .cp-switch { background: #4f8cff; }
.cp-toggle[aria-checked="true"] .cp-switch::after { transform: translateX(13px); }
.cp-scrub { flex-wrap: wrap; cursor: default; }
.cp-scrub:hover { background: none; }
.cp-scrub .cp-scrub-bar {
  display: flex; align-items: center; gap: 4px; width: 100%;
  margin-top: 2px;
}
.cp-scrub .cp-scrub-bar .cp-value {
  flex: 1; text-align: center; max-width: none; color: #e8ecf4;
}
.cp-step {
  width: 28px; height: 24px; flex: none;
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px;
  background: rgba(255, 255, 255, 0.06); color: inherit; font: inherit; cursor: pointer;
}
.cp-step:hover { background: rgba(255, 255, 255, 0.14); }
.cp-step:active { background: rgba(255, 255, 255, 0.2); }
.cp-hint { cursor: default; min-height: 26px; color: rgba(232, 236, 244, 0.7); font-size: 12px; }
.cp-hint:hover { background: none; }
.cp-note {
  padding: 2px 8px 6px; font-size: 12px; color: rgba(232, 236, 244, 0.55);
  white-space: pre-wrap; word-break: break-word;
}
`;

const KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  ' ': 'Space',
};

/** `e.key` folded so a shifted letter finds the same control as the plain one. */
export function keyId(e: KeyboardEvent): string {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function kbd(key: string): HTMLElement {
  return el('kbd', undefined, keyLabel(key));
}

interface KeyBinding { run: () => void; noRepeat: boolean }

/** A per-frame updater for one row; returns nothing, writes only on change. */
type Refresher = () => void;

export class ControlPanel {
  readonly element: HTMLDivElement;
  private readonly bindings = new Map<string, KeyBinding>();
  private readonly refreshers: Refresher[] = [];
  private readonly storageKey?: string;
  private readonly folded: Record<string, boolean> = {};
  private collapsed = false;

  constructor(opts: ControlPanelOptions) {
    this.storageKey = opts.storageKey;
    this.restore();

    if (!document.getElementById(STYLE_ID)) {
      const style = el('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.element = el('div', 'cp');
    const head = el('div', 'cp-head');
    head.append(el('span', 'cp-title', opts.title), el('span', 'cp-chev', '▼'));
    head.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.element.appendChild(head);

    const body = el('div', 'cp-body');
    for (const section of opts.sections) body.appendChild(this.buildSection(section));
    this.element.appendChild(body);

    this.element.classList.toggle('cp-collapsed', this.collapsed);
    document.body.appendChild(this.element);
  }

  /** Collapse to the title pill, or open back out. */
  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.element.classList.toggle('cp-collapsed', collapsed);
    this.persist();
  }

  /**
   * Route a key press to the control that owns it. Returns true if one did,
   * so a caller can `preventDefault` only for keys the demo actually uses.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const binding = this.bindings.get(keyId(e));
    if (!binding) return false;
    if (binding.noRepeat && e.repeat) return true;
    binding.run();
    return true;
  }

  /** Pull every switch position and value from the demo. Call once per frame. */
  refresh(): void {
    for (const r of this.refreshers) r();
  }

  private bind(key: string | undefined, run: () => void, noRepeat = false): void {
    if (!key) return;
    if (this.bindings.has(key)) throw new Error(`ControlPanel: key "${key}" bound twice`);
    this.bindings.set(key, { run, noRepeat });
  }

  private buildSection(section: PanelSection): HTMLElement {
    const root = el('div', 'cp-section');
    const head = el('button', 'cp-section-head');
    head.type = 'button';
    head.append(el('span', 'cp-chev', '▼'), el('span', undefined, section.title));
    head.addEventListener('click', () => {
      this.folded[section.title] = !this.folded[section.title];
      root.classList.toggle('cp-folded', this.folded[section.title]);
      head.blur();
      this.persist();
    });
    root.appendChild(head);
    root.classList.toggle('cp-folded', !!this.folded[section.title]);

    const body = el('div', 'cp-section-body');
    for (const control of section.controls) body.appendChild(this.buildControl(control));
    root.appendChild(body);
    return root;
  }

  private buildControl(control: PanelControl): HTMLElement {
    switch (control.type) {
      case 'toggle': return this.buildToggle(control);
      case 'action': return this.buildAction(control);
      case 'scrub':  return this.buildScrub(control);
      case 'hint':   return this.buildHint(control);
      case 'note':   return this.buildNote(control);
    }
  }

  private buildToggle(c: ToggleControl): HTMLElement {
    const row = el('button', 'cp-row cp-toggle');
    row.type = 'button';
    row.setAttribute('role', 'switch');
    row.append(el('span', 'cp-label', c.label));
    if (c.key) row.appendChild(kbd(c.key));
    row.appendChild(el('span', 'cp-switch'));

    const flip = (): void => c.set(!c.get());
    row.addEventListener('click', () => { flip(); row.blur(); });
    this.bind(c.key, flip);

    let last: boolean | null = null;
    this.refreshers.push(() => {
      const on = c.get();
      if (on !== last) { last = on; row.setAttribute('aria-checked', String(on)); }
    });
    return row;
  }

  private buildAction(c: ActionControl): HTMLElement {
    const row = el('button', 'cp-row cp-action');
    row.type = 'button';
    row.append(el('span', 'cp-label', c.label));
    if (c.value) {
      const value = el('span', 'cp-value');
      row.appendChild(value);
      let last = '';
      this.refreshers.push(() => {
        const v = c.value!();
        if (v !== last) { last = v; value.textContent = v; value.title = v; }
      });
    }
    if (c.key) row.appendChild(kbd(c.key));

    row.addEventListener('click', () => { c.run(); row.blur(); });
    this.bind(c.key, c.run);
    return row;
  }

  private buildScrub(c: ScrubControl): HTMLElement {
    const row = el('div', 'cp-row cp-scrub');
    row.append(el('span', 'cp-label', c.label), kbd(c.keys[0]), kbd(c.keys[1]));

    const bar   = el('div', 'cp-scrub-bar');
    const dec   = el('button', 'cp-step', '‹');
    const value = el('span', 'cp-value');
    const inc   = el('button', 'cp-step', '›');
    dec.type = inc.type = 'button';
    dec.addEventListener('click', () => { c.dec(); dec.blur(); });
    inc.addEventListener('click', () => { c.inc(); inc.blur(); });
    bar.append(dec, value, inc);
    row.appendChild(bar);

    this.bind(c.keys[0], c.dec);
    this.bind(c.keys[1], c.inc);

    let last = '';
    this.refreshers.push(() => {
      const v = c.value();
      if (v !== last) { last = v; value.textContent = v; }
    });
    return row;
  }

  private buildHint(c: HintControl): HTMLElement {
    const row = el('div', 'cp-row cp-hint');
    if (c.key) row.appendChild(kbd(c.key));
    row.appendChild(el('span', 'cp-label', c.label));
    if (c.run) this.bind(c.key, c.run, c.noRepeat);
    return row;
  }

  private buildNote(c: NoteControl): HTMLElement {
    const note = el('div', 'cp-note');
    let last = '';
    this.refreshers.push(() => {
      const v = c.text();
      if (v !== last) { last = v; note.textContent = v; }
    });
    return note;
  }

  private restore(): void {
    if (!this.storageKey) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { collapsed?: boolean; folded?: Record<string, boolean> };
      this.collapsed = !!saved.collapsed;
      Object.assign(this.folded, saved.folded ?? {});
    } catch { /* a stale or unreadable entry just means default state */ }
  }

  private persist(): void {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ collapsed: this.collapsed, folded: this.folded }));
    } catch { /* storage full or blocked — the panel still works, it just won't remember */ }
  }
}
