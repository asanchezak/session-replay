export class FakeChromeStorage {
  private data: Record<string, unknown> = {};
  private listeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void> = [];
  private accessLevel: string = "TRUSTED_AND_UNTRUSTED_CONTEXTS";

  async get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (keys === null) return { ...this.data };
    if (typeof keys === "string") {
      const val = this.data[keys];
      return val !== undefined ? { [keys]: val } : {};
    }
    if (Array.isArray(keys)) {
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in this.data) result[k] = this.data[k];
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [k, defaultVal] of Object.entries(keys)) {
      result[k] = k in this.data ? this.data[k] : defaultVal;
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [key, newValue] of Object.entries(items)) {
      const oldValue = this.data[key];
      this.data[key] = newValue;
      changes[key] = { oldValue, newValue };
    }
    this.notify(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
    const keyList = typeof keys === "string" ? [keys] : keys;
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const key of keyList) {
      if (key in this.data) {
        changes[key] = { oldValue: this.data[key], newValue: undefined };
        delete this.data[key];
      }
    }
    if (Object.keys(changes).length > 0) this.notify(changes);
  }

  async clear(): Promise<void> {
    this.data = {};
  }

  setAccessLevel(_level: string): void {
    this.accessLevel = _level;
  }

  reset(): void {
    this.data = {};
    this.listeners = [];
    this.accessLevel = "TRUSTED_AND_UNTRUSTED_CONTEXTS";
  }

  dump(): Record<string, unknown> {
    return { ...this.data };
  }

  onChanged = {
    addListener: (cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void) => {
      this.listeners.push(cb);
    },
    removeListener: (cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void) => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    },
  };

  private notify(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): void {
    for (const listener of this.listeners) {
      listener(changes);
    }
  }
}

export class FakeChromeRuntime {
  private listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void> = [];
  private tabListeners: Array<(tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void> = [];

  onMessage = {
    addListener: (cb: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) => {
      this.listeners.push(cb);
    },
    removeListener: (cb: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    },
  };

  onUpdated = {
    addListener: (cb: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) => {
      this.tabListeners.push(cb);
    },
    removeListener: (cb: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) => {
      this.tabListeners = this.tabListeners.filter((l) => l !== cb);
    },
  };

  async sendMessage(_message: unknown): Promise<unknown> {
    return {};
  }

  triggerMessage(message: unknown, sender: unknown): void {
    for (const listener of this.listeners) {
      listener(message, sender, () => {});
    }
  }

  triggerTabUpdate(tabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
    for (const listener of this.tabListeners) {
      listener(tabId, changeInfo);
    }
  }

  reset(): void {
    this.listeners = [];
    this.tabListeners = [];
  }
}

export function createMockTab(id: number, url: string = "https://example.com", status: string = "complete"): chrome.tabs.Tab {
  return {
    id,
    url,
    status,
    active: true,
    windowId: 1,
    index: 0,
    pinned: false,
    highlighted: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
  } as chrome.tabs.Tab;
}

export function createDom(html: string): () => void {
  document.body.innerHTML = html;
  return () => { document.body.innerHTML = ""; };
}

export function makeButton(text: string, attrs: Record<string, string> = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = text;
  for (const [k, v] of Object.entries(attrs)) btn.setAttribute(k, v);
  document.body.appendChild(btn);
  return btn;
}

export function makeInput(attrs: Record<string, string> = {}): HTMLInputElement {
  const input = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  input.value = attrs.value || "";
  document.body.appendChild(input);
  return input;
}

export function makeDiv(attrs: Record<string, string> = {}): HTMLDivElement {
  const div = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) div.setAttribute(k, v);
  document.body.appendChild(div);
  return div;
}

export function makeSelect(options: string[], attrs: Record<string, string> = {}): HTMLSelectElement {
  const select = document.createElement("select");
  for (const [k, v] of Object.entries(attrs)) select.setAttribute(k, v);
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = opt;
    select.appendChild(option);
  }
  document.body.appendChild(select);
  return select;
}

export function makeElement(tag: string, attrs: Record<string, string> = {}, children: HTMLElement[] = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const child of children) el.appendChild(child);
  document.body.appendChild(el);
  return el;
}

export function mockAnimationFrame(): { advanceFrames: (n: number) => void; restore: () => void } {
  let frame = 0;
  const originalRAF = window.requestAnimationFrame;
  const originalCAF = window.cancelAnimationFrame;

  const pending: Map<number, FrameRequestCallback> = new Map();

  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++frame;
    pending.set(id, cb);
    return id;
  }) as typeof window.requestAnimationFrame;

  window.cancelAnimationFrame = ((id: number) => {
    pending.delete(id);
  }) as typeof window.cancelAnimationFrame;

  return {
    advanceFrames: (n: number) => {
      for (let i = 0; i < n; i++) {
        const time = performance.now();
        const currentBatch = Array.from(pending.entries());
        pending.clear();
        for (const [, cb] of currentBatch) {
          try { cb(time); } catch { /* skip */ }
        }
      }
    },
    restore: () => {
      window.requestAnimationFrame = originalRAF;
      window.cancelAnimationFrame = originalCAF;
    },
  };
}

export function mockElementFromPoint(el: Element | null): () => void {
  document.elementFromPoint = ((_x: number, _y: number) => el) as typeof document.elementFromPoint;
  return () => {
    document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  };
}
