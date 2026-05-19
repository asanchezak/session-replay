# Page Context Enrichment: Design & Trade-offs

> **Goal:** Give the AI browser workflow agent richer perception of the page so it makes fewer mistakes, recovers faster, and handles scenarios that are currently invisible.

## Current State

The AI receives one `PageContext` struct per poll (every ~500ms–5s during a run):

| Field | Size Limit | Source |
|---|---|---|
| `url`, `title` | ~300 chars each | Content script |
| `dom_snippet` | 8 KB | `sanitizeNode(document.body)` + PII redaction |
| `accessibility_tree` | 4 KB | Interactive elements with ARIA role/name |
| `visible_text` | 2 KB | `document.body.innerText` |
| `visible_elements` | 30 items × ~5 fields | Interactive DOM elements with tag, id, class, text, role, rect |
| `page_diff` | 15 added + 15 removed | SW computes delta from previous capture |
| `is_blocking` / `blocking_type` | enum | Heuristic: CAPTCHA iframes, password fields, modals |

**What the AI cannot currently perceive:**
- How the page *looks* (layout, color, spacing, visual hierarchy)
- Complete DOM structure beyond 8 KB of serialized HTML
- Whether XHR/fetch calls are pending or failed
- Whether JS errors occurred on the page
- Whether elements are actually rendered vs. merely in DOM
- Whether CSS animations or transitions are in progress
- Network conditions, geolocation, time, or other DevTools state

---

## A. Vision / Screenshots

### Why It Matters

Screenshots unlock scenarios that text-only context fundamentally cannot represent:

1. **Visual layout understanding** — a CAPTCHA image cannot be described in text; a screenshot lets the AI recognize "this is a reCAPTCHA widget" by visual pattern
2. **CSS-driven state** — a button that turns green on success, a loading spinner that fades, a disabled element that looks gray — text won't show `opacity: 0.5` as meaningfully as a screenshot
3. **Overlay / z-index conflicts** — an invisible modal blocking clicks is detectable via computed style but a screenshot makes it obvious
4. **Canvas / WebGL / SVG content** — data rendered to canvas elements is invisible to DOM serialization
5. **Image-based CAPTCHAs** — text-based detection misses visual CAPTCHAs (select all traffic lights, etc.)
6. **Page structure at a glance** — the AI sees "there's a sidebar, a main content area, and a footer" rather than a flat list of elements

### Technical Implementation Sketch

```
┌──────────────────────────────────────────────────────────┐
│ Extension Content Script (capture.ts)                     │
│                                                           │
│ capturePageContext() {                                    │
│   // existing context                                     │
│   screenshot ← html2canvas(document.body) OR              │
│                chrome.tabs.captureVisibleTab()            │
│                                                           │
│   return { ..., screenshot: base64_jpeg }                 │
│ }                                                         │
│                                                           │
│ Size: JPEG quality 0.5 → ~30-80 KB per screenshot         │
│ Format: base64 JPEG (smaller than PNG, fast decode)       │
└──────────────────────────────────────────────────────────┘
```

**Two capture paths:**

| Method | Pros | Cons | When to use |
|---|---|---|---|
| `chrome.tabs.captureVisibleTab()` | Offscreen, no DOM injection, captures browser chrome | Viewport only (no full page), requires `activeTab` permission | Every poll — it's simple |
| `html2canvas` / `dom-to-image` | Can capture full scrollable page, runs in-page | Slower, may miss some CSS, larger payload | On step failures or recovery |

**Integration at the backend:**

```python
# agent_service.py
async def _consult_ai_for_step(self, ..., ctx: PageContext):
    prompt = build_agent_decision_prompt(...)
    
    if ctx.screenshot:
        # Use vision-capable model
        response = await provider.generate_vision(
            prompt=prompt,
            images=[ctx.screenshot],  # base64 JPEG
            system=AGENT_EXECUTOR_SYSTEM,
        )
    else:
        response = await provider.generate(prompt, ...)
```

The `AIProvider` base class needs a new `generate_vision()` method that accepts images. The OpenAI provider sends `image_url` parts; the Anthropic provider sends `base64` blocks.

### What Screenshots Can and Cannot Replace

| Can replace | Cannot replace |
|---|---|
| Text descriptions of layout ("there's a sidebar") | Actual text content (screenshots have OCR errors) |
| Color/visible state ("the button is gray") | Accessibility tree (ARIA roles, names) |
| Visual CAPTCHA detection | DOM structure for selector construction |
| Canvas/WebGL content | Hidden/offscreen element text |

**Verdict: screenshots SUPPLEMENT DOM context, they don't replace it.** The AI needs both: text for precision (selectors, values, accessibility) and vision for gestalt understanding (layout, state, blocked interactions).

### Compression & Optimization

| Strategy | Size | Quality Trade-off |
|---|---|---|
| JPEG quality 0.4–0.6 | 20–50 KB | Acceptable for understanding layout + state |
| JPEG quality 0.2–0.3 | 8–15 KB | Blurry but can detect large visual changes |
| WebP (Chrome only) | 15–30 KB | Better quality/ratio, but only in `captureVisibleTab` |
| PNG 256-colors quantized | 10–25 KB | Sharp but limited colors |
| Diff-only: send screenshot only if page changed | 0 KB on unchanged polls | Requires delta encoding (complex) |
| Thumbnail: 640×400 max | Proportional | Cuts bandwidth by 4× vs. full HD |

**Recommended default:** JPEG Q=0.5, max 1280×800, send ONLY when `page_unchanged === false` or every 3rd poll minimum. This gives ~30 KB per screenshot sent on ~1 in 3 polls = ~10 KB average per poll.

### Latency & Cost

| Dimension | Impact |
|---|---|
| Capture time | `chrome.tabs.captureVisibleTab()` → 50–150ms (async, non-blocking) |
| Encode time | browser-native JPEG encode → ~5ms |
| Transfer (base64) | 30 KB → ~15ms over local network |
| Model inference | Vision models are 2–5× slower than text-only (GPT-4o: ~2s vs ~0.5s) |
| Token cost | Vision tokens charged at higher rate (GPT-4o: ~$0.0025/image vs ~$0.00003/1K text tokens) |

**Cost example:**
- Text-only poll: ~1K input tokens → $0.000015
- Vision poll: text + 30 KB image → ~$0.0025 per poll
- At 1 poll/s for a 60-run: text = $0.0009, vision = $0.15
- For 10,000 runs/month: text = $0.15, vision = $25

**Mitigation:** Only send screenshots on recovery cycles (not on happy path polls), or send a low-res thumbnail on every poll and full-res only on failures.

### Privacy

Screenshots are the biggest privacy concern in this design:

| Risk | Mitigation |
|---|---|
| Sensitive data visible (PII, financial, credentials) | Apply Canny edge detection over input fields *before reading pixels*, or blackout `<input>` regions |
| Internal tooling exposed | Allow URL-based allowlist/blocklist in connector config |
| Screenshots stored in DB/event log | Auto-delete after retention period; hash-link in audit trail instead of storing raw image |
| Cloud API sees screenshot | User must consent; document in privacy policy; offer on-premise model option |

**Implementation: Blackout sensitive fields at capture time:**

```typescript
// capture.ts
function redactScreenshot(canvas: HTMLCanvasElement): void {
  const inputs = document.querySelectorAll('input[type="password"], input[type="email"], [autocomplete="cc-number"]');
  const ctx = canvas.getContext('2d');
  for (const input of inputs) {
    const rect = input.getBoundingClientRect();
    ctx.fillStyle = '#000';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
}
```

---

## B. Full DOM Tree (Compressed Format)

### Why It Matters

The current 8 KB DOM snippet is a single `sanitizeNode(body)` string — it's flat HTML with stripped attributes. The AI misses:

1. **DOM hierarchy** — which elements contain other elements, crucial for understanding page structure
2. **Iframe content** — many embedded widgets (CAPTCHAs, payment iframes, social widgets) live in iframes
3. **Shadow DOM** — modern web components (including the replay panel itself!) are invisible
4. **Attributes beyond id/class** — `data-*` attributes, `aria-*` attributes beyond what we explicitly extract, `href`, `src`, `alt`, `title`
5. **Hidden but meaningful state** — `aria-expanded`, `aria-selected`, `aria-busy`, `hidden`, `disabled`

### Compressed DOM Tree Format

Instead of serialized HTML, emit a structured tree stripping non-essential data:

```typescript
interface CompressedDOMNode {
  tag: string;
  id?: string;
  classes?: string[];
  role?: string;
  attrs: Record<string, string>;  // only meaningful attrs: aria-*, data-testid, href, src, alt, type, name, placeholder, value, disabled, hidden, required, readonly
  text?: string;                  // max 100 chars, only for leaf-ish nodes
  children: CompressedDOMNode[];
  rect?: { x: number; y: number; width: number; height: number }; // only for visible elements
  shadow?: boolean;               // true if node is a shadow host
  iframe?: string;                // iframe src URL (not content — that's captured separately)
  is_visible: boolean;            // computed: offsetWidth > 0 && offsetHeight > 0 && style.display !== 'none'
}
```

**Key compression strategies:**

1. **Max depth:** Limit to depth 12 (most pages don't need deeper)
2. **Max children per level:** 30 — anything beyond is truncated with `...[+N more]`
3. **Total node budget:** 200 nodes max (keeps JSON under ~15 KB)
4. **Skip non-visible nodes** that have no interactive children (but keep `hidden` trackers)
5. **Strip inline styles** entirely (except `display:none` detection)
6. **Strip event handlers**, `data-react*`, `data-v-*` framework artifacts
7. **Deduplicate repeated text** in sibling structures (tables, lists)

### Implementation

```typescript
// content/capture.ts — new function
function captureCompressedDOM(root: Element, depth: number = 0, budget: number = 200): CompressedDOMNode | null {
  if (depth > 12 || budget <= 0) return null;
  
  const tag = root.tagName.toLowerCase();
  const rect = root.getBoundingClientRect();
  const style = window.getComputedStyle(root);
  const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && root.offsetWidth > 0;
  
  const node: CompressedDOMNode = {
    tag,
    attrs: extractMeaningfulAttrs(root),
    is_visible: isVisible,
    children: [],
  };
  
  if (root.id) node.id = root.id;
  if (root.classList.length > 0) node.classes = Array.from(root.classList);
  const role = root.getAttribute('role');
  if (role) node.role = role;
  
  // Shadow DOM host
  if (root.shadowRoot) {
    node.shadow = true;
    const shadowChild = captureCompressedDOM(root.shadowRoot as unknown as Element, depth + 1, budget - 1);
    if (shadowChild) node.children.push(shadowChild);
  }
  
  // Iframe (capture src URL only, not content)
  if (root instanceof HTMLIFrameElement) {
    node.iframe = root.src;
  }
  
  // Only include rect for visible interactive elements (saves KB)
  if (isVisible && (tag === 'a' || tag === 'button' || tag === 'input' || role)) {
    node.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }
  
  // Text content: only for leaf-ish nodes (no children or only text children)
  if (root.childElementCount === 0) {
    const text = (root.textContent || '').trim().slice(0, 100);
    if (text) node.text = text;
  }
  
  // Recurse into children
  budget--;
  for (const child of root.children) {
    const childNode = captureCompressedDOM(child, depth + 1, budget);
    if (childNode) {
      node.children.push(childNode);
      budget -= countNodes(childNode);
    }
    if (budget <= 0) break;
  }
  
  return node;
}
```

### Iframe & Shadow DOM Strategy

| Technique | What it captures | Cost |
|---|---|---|
| **Cross-origin iframe** | Nothing (security) | — |
| **Same-origin iframe** | Full compressed DOM subtree | Included in budget |
| **Open shadow DOM** | `el.shadowRoot` accessible | Recursively traverse |
| **Closed shadow DOM** | Not accessible from content script | Cannot capture |
| **`<slot>` content** | Already in light DOM | No extra work |

**For iframes:** the content script runs separately in each same-origin iframe (by manifest `"all_frames": true`). Each frame independently captures its context. The parent frame's context includes a reference (`iframe: src`), and the per-frame context is associated via `window.top !== window.self`.

### Size Budget

| Component | Typical Size | Budget |
|---|---|---|
| Compressed DOM tree (200 nodes) | 8–15 KB JSON | 15 KB |
| Accesssibility tree (current) | 1–4 KB | 4 KB |
| Visible text (current) | 1–2 KB | 2 KB |
| Visible elements (current) | 3–5 KB | — (redundant with compressed DOM, remove) |
| Screenshot (conditionally) | 0–50 KB | 0 KB on happy path |
| Page diff | 1–3 KB | 3 KB |
| Other (url, title, flags) | < 1 KB | 1 KB |
| **Total (happy path, no screenshot)** | **~25 KB** | **25 KB** |
| **Total (recovery, with screenshot)** | **~75 KB** | **Limit: 100 KB** |

---

## C. Network Activity Context

### Why It Matters

The AI currently has no visibility into what the browser's network layer is doing. This causes:

1. **"The page hasn't loaded yet" confusion** — AI polls, sees no content, thinks something is wrong. In reality, an XHR is still resolving. If the AI knew a fetch was pending, it would WAIT.
2. **"I clicked but nothing happened"** — The click may have triggered an API call that failed (500, timeout). The AI retries the click, which makes things worse.
3. **"The data should be there but it's not"** — The API response succeeded but the UI hasn't re-rendered yet. The AI tries to extract empty data.
4. **WebSocket-driven UIs** — Live-updating pages (trading platforms, chat apps, monitoring dashboards) never "finish loading." The AI needs to know that new WebSocket data just arrived.
5. **Pagination / infinite scroll** — The AI cannot tell if "Load more" triggered a successful network request or if the network is slow.

### What Network Data Matters

| Data Point | How the AI uses it | Priority |
|---|---|---|
| **Pending XHRs/fetches** | "There's an active request → WAIT until it resolves" | Critical |
| **Failed XHRs (status 4xx/5xx)** | "The API failed → don't retry the UI action, try a different approach" | Critical |
| **Completed XHRs (2xx)** | "The data loaded → now extract it" | High |
| **WebSocket messages** | "New real-time data arrived → re-scan the page" | Medium |
| **API response body (first 1KB)** | "The response says 'invalid session' → PAUSE, user needs to re-authenticate" | Medium |
| **Request timing** | "API call took 8s → page might be slow, increase timeouts" | Low |

### Technical Implementation Sketch

**Approach A: `chrome.webRequest` (MV3, simpler)**

```typescript
// service-worker.ts
const pendingRequests = new Map<string, { url: string, startedAt: number }>();
const completedRequests: Array<{ url: string, status: number, duration: number }> = [];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    pendingRequests.set(details.requestId, { url: details.url, startedAt: Date.now() });
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const req = pendingRequests.get(details.requestId);
    pendingRequests.delete(details.requestId);
    if (req) {
      completedRequests.push({
        url: req.url,
        status: details.statusCode,
        duration: Date.now() - req.startedAt,
      });
      // Keep last 20 completed requests
      if (completedRequests.length > 20) completedRequests.shift();
    }
  },
  { urls: ['<all_urls>'] },
);

// In captureContext():
function getNetworkSummary(): NetworkSummary {
  return {
    pending: Array.from(pendingRequests.values()).slice(0, 10),
    completed: completedRequests.slice(-10),
    total_pending: pendingRequests.size,
  };
}
```

**Approach B: Content-script interception (more detailed)**

```typescript
// content/capture.ts — intercept fetch/XHR in-page
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  networkObserver.dispatchEvent(new CustomEvent('fetch-start', { detail: { url, time: Date.now() } }));
  try {
    const response = await originalFetch.apply(this, args);
    networkObserver.dispatchEvent(new CustomEvent('fetch-end', { detail: { url, status: response.status, time: Date.now() } }));
    return response;
  } catch (err) {
    networkObserver.dispatchEvent(new CustomEvent('fetch-error', { detail: { url, error: err.message, time: Date.now() } }));
    throw err;
  }
};
```

**Recommendation:** Use `chrome.webRequest` in the service worker for basic tracking (no monkey-patching, works across all contexts, MV3-compatible). Supplement with content-script XHR interception only for response bodies if absolutely needed.

### Privacy

| Concern | Mitigation |
|---|---|
| API response bodies contain PII | Strip bodies by default; only capture on explicit opt-in per connector |
| Request URLs leak query params hash | Hash-sensitive segments; allow URL pattern allowlist |
| Internal API endpoints exposed | Filter by domain (only capture requests to the connector's domain) |

---

## D. Console Logs & Errors

### Why It Matters

JavaScript errors on the page are often the *first indicator* that something went wrong — often before any visible UI change:

1. **React rendering errors** — A component crashed but the page shows a partial render. The AI tries to click a broken element.
2. **Network timeout errors** — `fetch` fails silently and the page shows "no data." The AI doesn't know why.
3. **Third-party script failures** — Analytics, ads, or widgets fail to load. The AI should distinguish "page is broken" from "non-essential script failed."
4. **Deprecated API warnings** — "The API at /v1/old is deprecated" — the AI should adapt its strategy.

### Design: Structured Error Feed

```typescript
interface ConsoleCapture {
  entries: Array<{
    level: 'error' | 'warn' | 'info' | 'debug';
    message: string;          // First 200 chars
    source: string;           // URL or 'inline'
    line: number;
    column: number;
    timestamp: number;
    repeats: number;          // How many times this identical message fired
  }>;
  error_count: number;        // Total errors since last poll
  new_since_last_poll: number; // Errors that are new since the previous capture
}
```

### Implementation

```typescript
// content/capture.ts — install once in the poll handler lifecycle
const consoleCapture = {
  entries: [] as Array<{...}>,
  lastCaptureCount: 0,

  install(): void {
    const origError = console.error;
    console.error = (...args: any[]) => {
      this.push('error', args.map(String).join(' '));
      origError.apply(console, args);
    };
    // Also intercept window.onerror and unhandledrejection
    window.addEventListener('error', (e) => this.push('error', `${e.message} at ${e.filename}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => this.push('error', `Unhandled promise: ${e.reason}`));
  },

  push(level: string, message: string): void {
    // Deduplication: if last entry is identical and within 100ms, increment repeats
    const last = this.entries[this.entries.length - 1];
    if (last && last.level === level && last.message === message && Date.now() - last.timestamp < 100) {
      last.repeats++;
      return;
    }
    this.entries.push({ level, message: message.slice(0, 200), source: '', line: 0, column: 0, timestamp: Date.now(), repeats: 1 });
    if (this.entries.length > 100) this.entries.splice(0, this.entries.length - 100);
  },

  snapshot(): ConsoleCapture {
    const count = this.entries.length;
    const newCount = count - this.lastCaptureCount;
    this.lastCaptureCount = count;
    return {
      entries: this.entries.slice(-20),  // last 20 entries
      error_count: this.entries.filter(e => e.level === 'error').length,
      new_since_last_poll: Math.min(newCount, 20),
    };
  },
};
```

### How the AI Uses Console Data

In the prompt, console errors get their own section:

```
## Console Errors (3 new since last poll)
  [error] TypeError: Cannot read properties of null (reading 'value') at https://app.example.com/main.js:142
  [warn] API /v2/search returned 429 — rate limited
  [error] Unhandled promise: NetworkError when fetching https://api.example.com/data
```

The system prompt should instruct:
- "If console shows API errors (4xx/5xx), prefer WAIT or ADAPT over retrying the same action"
- "If console shows JS errors that match the blocked step, consider ADAPT with a different approach"
- "If console is clean but the page isn't responding, the issue is likely selector-related"

### Avoiding Overload

| Strategy | Implementation |
|---|---|
| **Cap per poll** | Last 20 entries, max 200 chars each → ~4 KB |
| **Deduplicate** | Repeated identical errors merge with `repeats: 5` |
| **Ignore noise** | Skip known noise patterns: `ResizeObserver loop`, `favicon.ico 404`, extension-injected errors |
| **Show new only** | `new_since_last_poll` flag lets AI focus on what changed |
| **Rate-limit** | If >10 errors/second, sample 1 in N and add "errors suppressed due to rate" |

---

## E. Mutation Observers

### Why It Matters

The current polling loop runs every ~500ms–2s and re-captures the full PageContext each time. This is wasteful:

- **CPU:** Re-serializing the DOM and accessibility tree every 500ms on every poll
- **Latency:** The AI can't react faster than the poll interval
- **Redundancy:** Most polls see the same page state

With mutation observers, the AI says "tell me when X happens" instead of "tell me everything every N ms."

### Design: AI-Specified Wait Conditions

The AI can emit a `success_condition` in its command response, and the content script sets up a targeted observer:

```typescript
interface SuccessCondition {
  type: 'element_visible' | 'element_gone' | 'text_appears' | 'text_disappears' | 'url_changes' | 'dom_unchanged_for_ms' | 'network_idle';
  selector?: string;
  text?: string;
  timeout_ms: number;  // max 30s
}
```

**How it flows:**

1. AI decides EXECUTE with a click command AND attaches a success condition:
```json
{
  "decision": "EXECUTE",
  "command": {
    "action": "click",
    "selector_chain": [{"type": "css", "value": "button.submit"}],
    "success_condition": {
      "type": "element_gone",
      "selector": ".spinner",
      "timeout_ms": 15000
    }
  }
}
```

2. Extension executes the click, then sets up a MutationObserver watching for `.spinner` to disappear
3. Observer fires → step marked successful immediately (no re-poll needed)
4. If observer times out → step marked failed, extension re-polls for a new decision

### Implementation

```typescript
// content/replay.ts — in the command execution handler
async function waitForCondition(condition: SuccessCondition): Promise<'satisfied' | 'timeout' | 'error'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), condition.timeout_ms);
    
    switch (condition.type) {
      case 'element_gone': {
        const el = document.querySelector(condition.selector);
        if (!el || (el as HTMLElement).offsetWidth === 0) {
          clearTimeout(timeout);
          return resolve('satisfied');
        }
        const observer = new MutationObserver(() => {
          if (!document.querySelector(condition.selector) || 
              (document.querySelector(condition.selector) as HTMLElement).offsetWidth === 0) {
            clearTimeout(timeout);
            observer.disconnect();
            resolve('satisfied');
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        break;
      }
      case 'element_visible': {
        // Similar: wait for querySelector match + visible
        break;
      }
      case 'text_appears': {
        // Similar: wait for document.body.textContent.includes(condition.text)
        break;
      }
      case 'network_idle': {
        // Wait for webRequest to have no pending requests for 500ms
        break;
      }
      case 'dom_unchanged_for_ms': {
        // Wait for no mutations for `condition.timeout_ms` ms
        // After one mutation, reset the counter
        break;
      }
    }
  });
}
```

### AI-Level: "Wait for Spinner" Pattern

The most common and powerful pattern is "click something, then wait for the loading state to end." This can be abstracted into the system prompt:

```
When you execute a click or submit action, look for evidence of 
a pending/loading state on the page (spinners, progress bars, 
disabled buttons, "loading" text). If detected, attach a 
success_condition of type "element_gone" targeting the loading 
indicator. This lets the system wait efficiently instead of polling.
```

### Observer Overhead

| Aspect | Impact |
|---|---|
| Observer scope | `document.body` with `subtree: true` — covers most changes |
| Filtering | Check `mutation.type` — skip non-relevant attribute changes |
| Cleanup | Auto-disconnect on timeout or satisfaction |
| Memory | ~2 KB per active observer. Max 3 simultaneous observers per run |

**Mutation observers don't replace polling entirely.** They replace the *fast-path* polling between steps. After a step executes and the observer condition is met, the system does one final `captureContext()` and sends the result to the AI. If the observer times out, it falls back to polling.

---

## F. Computed Styles & Layout

### Why It Matters

The current context only knows about DOM structure, not visual rendering:

| Scenario | Today | With computed styles |
|---|---|---|
| Button that looks clickable but is `pointer-events: none` | AI tries to click, fails silently | AI sees `pointer-events: none`, skips or finds alternative |
| Element rendered but offscreen (`transform: translate(-9999px)`) | AI sees the element in DOM, tries to interact | AI sees the element is off-screen, scrolls first or re-evaluates |
| CSS animation in progress (opacity fading, element sliding in) | AI polls, sees partial state, gets confused | AI sees `animation-name` or `transition-property` active, WAITs |
| Z-index stacking that makes element non-interactable | AI clicks element, click hits a covering overlay | AI checks `z-index` and stacking context, detects overlap |
| `visibility: hidden` vs `display: none` vs `opacity: 0` | AI sees none of these explicitly | AI checks all three and knows exact visibility state |

### Technical Implementation

Add a compact computed-styles layer to `captureVisibleElements`:

```typescript
// content/capture.ts — extend visible elements capture
function captureElementVisualState(el: HTMLElement): VisualState {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  
  const isOffscreen = rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth;
  const isClickable = style.pointerEvents !== 'none';
  const isOpaque = parseFloat(style.opacity) > 0.01;
  const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && isOpaque;
  
  // Detect active animations
  const animation = style.animationName && style.animationName !== 'none' 
    ? { name: style.animationName, duration: style.animationDuration } 
    : undefined;
  const transition = style.transitionProperty && style.transitionProperty !== 'none'
    ? { property: style.transitionProperty, duration: style.transitionDuration }
    : undefined;
  
  return {
    visible: isVisible && !isOffscreen && rect.width > 0 && rect.height > 0,
    clickable: isClickable,
    offscreen: isOffscreen,
    opacity: parseFloat(style.opacity),
    z_index: parseInt(style.zIndex) || 'auto',
    position: style.position,
    animation: animation ? `${animation.name} ${animation.duration}` : undefined,
    transition: transition ? `${transition.property} ${transition.duration}` : undefined,
    overflow: style.overflow !== 'visible' ? style.overflow : undefined,
  };
}
```

This adds ~200 bytes per element. At 25 elements, that's ~5 KB extra. To stay lean, only include `visual_state` for the element directly targeted by the current step + surrounding interactive elements.

### Stacking Context Detection

For z-index conflicts (a common automation failure cause):

```typescript
function findTopmostElement(x: number, y: number): Element | null {
  // Uses document.elementsFromPoint to find what's visually on top
  // If it's not our target, there's a covering element
  const elements = document.elementsFromPoint(x, y);
  return elements.length > 0 ? elements[0] : null;
}
```

This is called when a click fails — the system checks "was something covering the target?" and includes it in the error context.

---

## G. Chrome DevTools Protocol (CDP) Access

### Why It Matters

CDP transforms the system from "automation that works with what it gets" to "automation that controls the environment":

| Capability | Scenario Unlocked |
|---|---|
| **Network throttling** | Test how the workflow behaves on slow connections; the AI can slow down when it detects rate limiting |
| **Geolocation mock** | Automate location-conditional flows (pricing by country, region-restricted features) |
| **Time override** | Test time-based features (end-of-day processing, calendar events, timed forms) |
| **Cookie/session management** | Clear specific cookies mid-run to test re-authentication flows |
| **Console access** | Read page console output directly (alternative to monkey-patching) |
| **Performance metrics** | Detect page jank, long tasks, layout shifts that may interfere with automation |
| **Request blocking** | Block specific script/resources to test graceful degradation |
| **Emulation** | Set user agent, device metrics, color scheme for consistent execution |

### Technical Approach

MV3 extensions can access CDP through `chrome.debugger` API:

```typescript
// service-worker.ts
async function attachDebugger(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, '1.3');
  
  // Enable needed domains
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Console.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Performance.enable');
  
  // Listen for events
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === tabId) {
      switch (method) {
        case 'Console.messageAdded':
          consoleCapture.push(params.message.level, params.message.text);
          break;
        case 'Network.responseReceived':
          trackResponse(params);
          break;
        case 'Performance.metrics':
          trackMetrics(params);
          break;
      }
    }
  });
}
```

**Cost of using `chrome.debugger`:**

| Aspect | Impact |
|---|---|
| **Permissions** | `"debugger"` in manifest — triggers Chrome warning bar on first attach |
| **Concurrency** | One debugger session per tab; other debugger tools (DevTools) disconnect |
| **Performance** | Slight overhead from Network.enable (every request is emitted as event) |
| **Security** | Full page access — sensitive data in network bodies, console |
| **Installation** | Must be opt-in per connector/run, not default |

### Architecture Decision

**Don't enable CDP by default.** Use it in two specific modes:

1. **Recovery mode (auto-attach on failure):** When a step fails, attach the debugger to get network/console context that explains *why*
2. **Environment mode (opt-in per workflow):** Users can tag a workflow with `env: { geolocation: 'DE', throttling: '3G' }` and the debugger is attached for that entire run

```typescript
// In executeAgentRun():
if (workflow.env_overrides) {
  await attachDebugger(targetTabId);
  if (workflow.env_overrides.geolocation) {
    await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Emulation.setGeolocationOverride', {
      latitude: ..., longitude: ..., accuracy: 100,
    });
  }
}
```

---

## Priority Ranking: If You Could Only Add 3

### #1: Mutation Observers + Success Conditions

**Why:** This has the highest impact on reliability for the lowest cost. Currently, every poll is a full-page context capture + AI consultation. Observers let the AI say "I clicked the button, wait for this specific thing to happen" and then skip ~10–30 unnecessary polling rounds. This directly reduces API costs (fewer AI calls), reduces latency (milliseconds instead of seconds), and improves robustness (the AI specifies exactly what signal it's waiting for).

**Cost:** ~2 days of development. Zero ongoing cost (entirely client-side). No new permissions. No privacy risk.

### #2: Network Activity Summary

**Why:** The number one failure mode in production automation is "I clicked but nothing happened" when really the API call failed or is still pending. Network context gives the AI the single most useful signal for distinguishing "wait longer" from "try something else." It's also cheap to implement with `chrome.webRequest` — no monkey-patching, no new permissions beyond `webRequest`, works in MV3.

**Cost:** ~1.5 days. Zero ongoing cost (runs in the extension's service worker).

### #3: Screenshots (Vision)

**Why:** Screenshots unlock fundamentally different scenarios — visual CAPTCHAs, canvas-based apps, layout understanding. The cost and latency are real, but the capability gap they fill is the largest. Without vision, there are entire classes of automation problems that are simply unsolvable (any workflow involving image classification, visual verification, or CSS-driven state that isn't reflected in DOM attributes).

**Cost:** ~3–4 days. Adds variable AI cost (~$0.0025/vision poll vs ~$0.000015/text poll). Adds latency (~2s vs ~0.5s per AI call). BUT these can be mitigated: only use vision in recovery mode or on failing polls.

### Why Not the Others (for now)

| Candidate | Rationale for deferring |
|---|---|
| **Full DOM tree** | The compressed tree adds ~10 KB per poll. The benefit overlaps significantly with the existing accessibility tree + visible elements. Defer until the AI consistently fails because of missing DOM structure (not just missing state). |
| **Console logs** | Valuable but noisy. The AI needs to learn to ignore 90% of console output. Implement after network context, when "silent failures" (no error in UI but JS error in console) become a known pain point. |
| **Computed styles** | Overlaps with screenshot context. If we have vision + accessibility tree, the AI can already infer visibility. Computed styles add precision but at marginal benefit for the complexity. |
| **CDP access** | Transformative but heavy. The `debugger` permission is a UX concern (Chrome warning bar). Best introduced as an opt-in "advanced" feature for power users, not the default path. |

---

## Implementation Roadmap

### Phase 1: Fast Path Optimization (1 week)
- [ ] Mutation observers: `success_condition` type on AgentCommand
- [ ] Content script observer engine (`waitForCondition` in replay.ts)
- [ ] SW handles observer result (skip polling loop when condition satisfied)
- [ ] Update prompts to teach AI about `success_condition`

### Phase 2: Network & Console Awareness (1 week)
- [ ] `chrome.webRequest` capture in SW → `network_summary` field on PageContext
- [ ] Console error capture in content script → `console_errors` field on PageContext
- [ ] Backend prompt builder: add network/console sections
- [ ] Privacy controls: URL allowlist, console silence patterns

### Phase 3: Screenshots (2 weeks)
- [ ] `chrome.tabs.captureVisibleTab()` in content script
- [ ] PII redaction layer (blackout sensitive input regions)
- [ ] JPEG compression + size limiting in the SW
- [ ] Backend `AIProvider.generate_vision()` method
- [ ] Prompt changes: teach AI when and how to use screenshots
- [ ] Conditional capture: only on recovery cycles, or every Nth poll
- [ ] Client-configurable: enable/disable per connector or per run

### Phase 4: Full DOM + Styles (2 weeks, optional)
- [ ] Compressed DOM tree capture
- [ ] Replace `visible_elements` with compressed tree (they're redundant)
- [ ] Computed styles for target element
- [ ] Size budgeting: truncate tree when prompt exceeds limit

### Phase 5: CDP Integration (variable, optional)
- [ ] `chrome.debugger` attach/detach lifecycle
- [ ] Environment overrides (geolocation, throttling, UA)
- [ ] CDP-based network capture (replaces `chrome.webRequest`)
- [ ] CDP-based console capture (replaces monkey-patching)
- [ ] Permission warning UX
- [ ] Opt-in per workflow setting in the connector config

---

## Size & Concurrency Budget

### Per-Poll Budget (what gets sent to the backend)

| Component | Happy Path | Recovery | Max |
|---|---|---|---|
| Compressed DOM | 0 KB (skip) | 15 KB | 15 KB |
| Accessibility tree | 4 KB | 4 KB | 4 KB |
| Visible text | 2 KB | 2 KB | 2 KB |
| Page diff | 2 KB | 2 KB | 3 KB |
| Network summary | 1 KB | 1 KB | 2 KB |
| Console errors | 0 KB (empty) | 3 KB | 4 KB |
| Screenshot | 0 KB (skip) | 30 KB | 50 KB |
| Other (url, title, flags) | 1 KB | 1 KB | 1 KB |
| **Total** | **~10 KB** | **~58 KB** | **~81 KB** |

### Concurrency Limits

| Resource | Limit | Rationale |
|---|---|---|
| Active MutationObservers | 3 per tab | One per step, one for page-load, one spare |
| Pending network requests tracked | 50 | Covers all concurrent API calls on a modern SPA |
| Console entries kept in memory | 100 | Rolling buffer, older entries evicted |
| Screenshot encode ops in-flight | 1 | Serialize captures to avoid memory pressure |
| CDP debugger sessions | 1 (or 0) | One per active run tab; detach on run end |

---

## Prompt Integration

Each new context source needs corresponding prompt instructions so the AI knows how to use it:

### System Prompt Additions

```python
AGENT_EXECUTOR_SYSTEM += """

NETWORK CONTEXT:
- Pending network requests → the page is still loading data; PREFER WAIT
- Failed requests (4xx/5xx) → the action triggered an API failure; consider ADAPT
  or SKIP; DO NOT retry the same action blindly
- Completed requests with data → the page likely has fresh data; proceed with extraction

CONSOLE ERRORS:
- JS errors on the page indicate something is broken; consider alternative approaches
- Repeated same errors → the page state is likely degraded; PAUSE if no path forward
- Rate-limited API responses (429) → WAIT with backoff, then retry

SCREENSHOTS (when available):
- Use the screenshot to understand visual layout and element state
- Look for: loading spinners, disabled buttons, error toasts, modals
- Cross-reference with visible elements text for confirmation

SUCCESS CONDITIONS:
- After any action, specify a success_condition to wait efficiently
- Example: after clicking "submit", wait for `.error-message` or `.success-banner`
- Example: after navigating, wait for a known element to appear
- This eliminates unnecessary polling rounds

MUTATION OBSERVERS:
- You can wait for: element_visible, element_gone, text_appears, text_disappears
- Use these to react to page state changes instead of polling
- If the condition times out, the system falls back to polling
"""
```

### Backend Prompt Builder: New Sections

```python
if network_summary:
    parts.append("## Network Activity")
    if network_summary.get("pending"):
        parts.append(f"Pending requests ({len(network_summary['pending'])}):")
        for req in network_summary["pending"][:5]:
            parts.append(f"  ⏳ {req.get('url', '')[:80]}")
    if network_summary.get("failed"):
        parts.append("Failed requests:")
        for req in network_summary["failed"][:5]:
            parts.append(f"  ✗ {req.get('url', '')[:60]} → {req.get('status')}")

if console_errors:
    parts.append("## Console Errors")
    for entry in console_errors.get("entries", [])[:10]:
        level_icon = {"error": "✗", "warn": "⚠", "info": "ℹ"}.get(entry.get("level", ""), "·")
        msg = entry.get("message", "")[:150]
        repeats = f" (×{entry['repeats']})" if entry.get("repeats", 1) > 1 else ""
        parts.append(f"  {level_icon} [{entry.get('level')}]{repeats} {msg}")
```

---

## Summary Decision Matrix

| Area | Impact | Implementation Cost | Ongoing Cost | Privacy Risk | Priority |
|---|---|---|---|---|---|
| Mutation Observers | High | Low (2 days) | None | None | **1** |
| Network Activity | High | Low (1.5 days) | None | Low | **2** |
| Screenshots (Vision) | Transformative | Medium (3-4 days) | Medium ($0.0025/call) | High | **3** |
| Console Logs | Medium | Low (1 day) | None | Medium | 4 |
| Full DOM Tree | Medium | Medium (3 days) | None | Low | 5 |
| Computed Styles | Low | Low (1 day) | None | None | 6 |
| CDP Access | High | High (5+ days) | None | High (warnings) | 7 |
