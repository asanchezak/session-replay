# UI/UX Design Specification — AI Browser Workflow Runtime

## 1. Overall Visual Direction & Product Design Concept

**Concept: "Mission Control for Workflows"**

The interface should feel like a calm, precise operations console — think air traffic control meets modern fintech. Dense information, but organized into clear zones. Every state is visible at a glance. Nothing is hidden. The user always knows: *what is running, what succeeded, what failed, what needs me.*

**Visual personality:**
- Calm, neutral base with one strong accent
- Soft surfaces, not harsh whites
- Rounded but not playful
- Information-dense but hierarchically clean
- Professional, quiet confidence — no neon, no gamification, no SaaS-template feel

**Core metaphor:** A workflow is a *flight path*. You can see where it started, where it is, where it got diverted, and where it landed. Every deviation is explained. Every checkpoint is recorded.

---

## 2. Information Architecture & Navigation

### Main App Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [Logo]  Search…                          [● Status] [User] │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│ WORKFLOWS│  ← Main content area                            │
│ Runs     │                                                  │
│ Audit    │                                                  │
│ Connectors│                                                 │
│ Settings │                                                 │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

**Left sidebar (persistent, collapsible):**

| Item | Purpose |
|---|---|
| **Dashboard** | Overview KPIs, alerts, recent activity |
| **Workflows** | List, create, manage workflow definitions |
| **Runs** | Execution history, filtered by workflow/status |
| **Audit** | Tamper-evident event log, trace viewer |
| **Connectors** | Odoo + future adapters, health, config |
| **Settings** | Policies, retention, team, API keys |

**Top bar:**
- Global search (workflows, runs, logs, records)
- Live status indicator (green = all healthy, amber = attention needed, red = failures)
- User menu

### Navigation Rules
- Sidebar items show count badges when relevant (e.g., `Runs (3 waiting)`)
- Clicking any workflow or run opens its detail in the main area
- Breadcrumbs appear on nested views: `Workflows › Candidate Search › Run #42`
- Right-side drawer for quick inspection without losing context

---

## 3. Screen-by-Screen Breakdown

### 3.1 Dashboard

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Good morning, [User]                                    │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ Active   │ Success  │ Waiting  │ Failed  │ Connectors  │
│ Workflows│ Rate     │ for You  │ Runs    │ Health      │
│   12     │  94.2%   │    3     │    1    │  ● ● ○     │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│ ⚠ Requires Attention (3)                                │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Run #87 — CAPTCHA detected on LinkedIn              │ │
│ │ Run #91 — Selector mismatch on page /jobs/42        │ │
│ │ Odoo connector — sync failed 2h ago                 │ │
│ └─────────────────────────────────────────────────────┘ │
├──────────────────────────┬──────────────────────────────┤
│ Recent Runs              │ Workflow Templates           │
│ ┌──────────────────────┐ │ ┌──────────────────────────┐ │
│ │ Candidate Search     │ │ │ Search & Extract         │ │
│ │ ● Running · Step 4/7 │ │ │ Fill & Submit            │ │
│ │ 2 min ago            │ │ │ Open & Inspect           │ │
│ └──────────────────────┘ │ └──────────────────────────┘ │
│ ┌──────────────────────┐ │                              │
│ │ Job Sync             │ │                              │
│ │ ✓ Completed          │ │                              │
│ │ 15 min ago           │ │                              │
│ └──────────────────────┘ │                              │
└──────────────────────────┴──────────────────────────────┘
```

**Design notes:**
- KPI cards are single-number focus with a subtle trend indicator (↑↓)
- "Requires Attention" is the most prominent section — this is where the user's eye goes first
- Recent runs show status with colored dot + text label (never color alone)
- Templates are quick-start cards, not buried in menus

---

### 3.2 Workflows List

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Workflows                    [+ New] [Filter] [Search]  │
├─────────────────────────────────────────────────────────┤
│ Name              │ Connector │ Status  │ Last Run │ Runs│
├─────────────────────────────────────────────────────────┤
│ Candidate Search  │ Odoo      │ Active  │ 2m ago   │ 47  │
│ Job Sync          │ Odoo      │ Active  │ 15m ago  │ 23  │
│ Profile Review    │ —         │ Draft   │ Never    │ 0   │
└─────────────────────────────────────────────────────────┘
```

**Design notes:**
- Table view by default, grid toggle available
- Status column uses badge: `Active` (green), `Draft` (gray), `Paused` (amber), `Archived` (gray)
- Click row → detail page
- Empty state: "No workflows yet. Record your first workflow from the browser extension, or start from a template."

---

### 3.3 Workflow Detail Page

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ ← Back                                                  │
│                                                         │
│ Candidate Search                          [▶ Run] [...] │
│ Extract candidate profiles from LinkedIn and sync to    │
│ Odoo. Created 3 weeks ago by Ana.                       │
├─────────────────────────────────────────────────────────┤
│ Status: ● Active    │ Connector: Odoo    │ Version: 3   │
├─────────────────────┴────────────────────┴──────────────┤
│                                                         │
│ ┌────────────────────────┐ ┌───────────────────────────┐│
│ │ Steps (7)              │ │ Intent / Prompt           ││
│ │ 1. Navigate to /jobs   │ │ "Find senior React devs   ││
│ │ 2. Click "Candidates"  │ │  in Berlin with 5+ years" ││
│ │ 3. Extract table       │ │                           ││
│ │ 4. Filter by location  │ │                           ││
│ │ 5. Open profile        │ │                           ││
│ │ 6. Copy skills         │ │                           ││
│ │ 7. Submit to Odoo      │ │                           ││
│ └────────────────────────┘ └───────────────────────────┘│
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Execution History                                   │ │
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ #94  ● Running   Step 4/7   2 min ago   [View] │ │ │
│ │ │ #93  ✓ Completed  7/7       1 hour ago  [View] │ │ │
│ │ │ #92  ✗ Failed    Step 3/7   3 hours ago [View] │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [Recovery Rules]  [Audit Evidence]  [Artifacts]  [Notes]│
└─────────────────────────────────────────────────────────┘
```

**Design notes:**
- Steps are a numbered list with icons per action type (navigate, click, extract, etc.)
- Hovering a step shows tooltip with selector, intent, and last success time
- "Run" button is the primary action — prominent, top-right
- Tabs at bottom for deeper inspection without cluttering the main view

---

### 3.4 Recording View

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ ◉ Recording — "Candidate Search"              [Finish]  │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│  Browser Preview         │  Timeline                    │
│  (live or embedded)      │  ┌────────────────────────┐ │
│                          │  │ 1. Navigate to URL     │ │
│                          │  │    linkedin.com/jobs    │ │
│                          │  ├────────────────────────┤ │
│                          │  │ 2. Click element       │ │
│                          │  │    "Candidates" tab     │ │
│                          │  │    [edit] [checkpoint]  │ │
│                          │  ├────────────────────────┤ │
│                          │  │ 3. Scroll              │ │
│                          │  │    results area         │ │
│                          │  └────────────────────────┘ │
│                          │                              │
│                          │  [+ Add note/intent]         │
│                          │                              │
└──────────────────────────┴──────────────────────────────┘
```

**Design notes:**
- Recording indicator (red dot + pulsing ring) is always visible — impossible to miss
- Timeline auto-populates as actions are captured
- Each step is inline-editable: rename, add intent, mark as checkpoint
- "Finish" opens a summary modal: "Add a prompt describing this workflow"
- Browser preview can be a live view of the extension's captured session or a placeholder if recording from a different tab

---

### 3.5 Replay / Run View

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Run #94 — Candidate Search                [⏸] [⏹] [...] │
├─────────────────────────────────────────────────────────┤
│ ● Step 4 of 7: Filter by location                       │
│ ━━━━━━━━━━━━━━━━━━╸━━━━━━━━━━━━━━━━━━━━━━━━  57%       │
├──────────────────────────┬──────────────────────────────┤
│                          │  Live Event Feed             │
│  Browser Preview         │  ┌────────────────────────┐ │
│  (current page state)    │  │ 14:32:01  Navigated    │ │
│                          │  │ 14:32:03  Clicked tab   │ │
│                          │  │ 14:32:05  Extracted 24  │ │
│                          │  │ 14:32:08  Filtering...  │ │
│                          │  └────────────────────────┘ │
│                          │                              │
│  Checkpoint: Step 3 ✓    │  ┌────────────────────────┐ │
│                          │  │ Recovery Attempts       │ │
│                          │  │ (none — running clean)  │ │
│                          │  └────────────────────────┘ │
│                          │                              │
│                          │  [Pause] [Resume] [Retry]   │
│                          │  [Skip Step] [Stop]          │
└──────────────────────────┴──────────────────────────────┘
```

**Design notes:**
- Progress bar shows step count + percentage
- Current step is named and highlighted
- Browser preview shows live state (or last captured screenshot if running headless)
- Event feed is chronological, compact, with icons per event type
- Recovery attempts section appears only when triggered — progressive disclosure
- Controls are grouped: primary (pause/resume) vs. destructive (stop)

---

### 3.6 Audit / Trace View

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Audit Trail — Run #94                                   │
│ [Export] [Filter ▼] [Search in log]                     │
├─────────────────────────────────────────────────────────┤
│ Time       │ Step │ Event          │ Details     │ Hash │
├─────────────────────────────────────────────────────────┤
│ 14:32:01   │  —   │ run_started    │ workflow_id │ a3f… │
│ 14:32:01   │  —   │ checkpoint     │ step 0      │ b7e… │
│ 14:32:03   │  1   │ navigate       │ /jobs       │ c2d… │
│ 14:32:03   │  1   │ screenshot     │ [thumb]     │ d9a… │
│ 14:32:05   │  2   │ click          │ "Candidates"│ e1f… │
│ 14:32:05   │  2   │ dom_snapshot   │ [view]      │ f4b… │
│ 14:32:07   │  3   │ extract        │ 24 records  │ a8c… │
│ 14:32:08   │  4   │ recovery_try   │ confidence  │ b2d… │
│            │      │                │ 0.87 → OK   │      │
│ 14:32:09   │  4   │ click          │ [recovered] │ c5e… │
└─────────────────────────────────────────────────────────┘
```

**Design notes:**
- Table is the primary view — dense but scannable
- Each row has a hash for tamper verification (truncated, full on hover/click)
- Screenshots and DOM snapshots show as thumbnails that expand in a drawer
- AI recovery events show confidence score inline
- Filters: by step, event type, status, AI involvement, human intervention
- Export: JSON, CSV, or PDF report
- Row hover reveals "View details" → side drawer with full payload

---

### 3.7 Human Intervention Modal

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│              ⚠ Workflow Paused — Action Required        │
│                                                         │
│  Run: Candidate Search (#94)                            │
│  Blocked at: Step 4 — Filter by location                │
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │                                                   │ │
│  │   A CAPTCHA challenge appeared on the page.       │ │
│  │   The system cannot complete this step            │ │
│  │   automatically.                                  │ │
│  │                                                   │ │
│  │   What you need to do:                            │ │
│  │   1. Complete the CAPTCHA in your browser         │ │
│  │   2. Click "Continue" to resume from Step 4       │ │
│  │                                                   │ │
│  │   Browser window has been brought to front.       │ │
│  │   State is preserved — no data will be lost.      │ │
│  │                                                   │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│              [  Continue Workflow  ]                    │
│                                                         │
│        [Review Details]              [Cancel Run]       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Design notes:**
- Modal is centered, dark overlay — impossible to miss
- Clear explanation in plain language, no jargon
- "Continue" is the primary button — large, accent color
- "Review Details" opens a drawer with technical context (DOM, screenshot, recovery attempts)
- "Cancel Run" is secondary, requires confirmation
- Modal also appears as a notification in the extension popup for users not on the dashboard

---

### 3.8 Connector Configuration View

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Connectors                                    [+ Add]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Odoo                        ● Connected             │ │
│ │ URL: https://mycompany.odoo.com                     │ │
│ │ Last sync: 12 minutes ago                           │ │
│ │ Health: ● Healthy                                   │ │
│ │                                                     │ │
│ │ Capabilities: list_open_jobs, get_job_details,      │ │
│ │               upsert_candidate, update_status       │ │
│ │                                                     │ │
│ │ [Configure]  [Test Connection]  [View Logs]         │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ + Add Connector                                     │ │
│ │                                                     │ │
│ │ Available: Salesforce · HubSpot · Greenhouse ·      │ │
│ │            Custom API                               │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Setup flow (stepper):**
1. Choose connector type
2. Enter credentials / authorize OAuth
3. Test connection → green check or red error with guidance
4. Map fields (drag-and-drop or auto-suggest)
5. Run sample sync → preview results
6. Activate

---

### 3.9 Settings Page

**Sections:**
- **Policies:** AI confidence thresholds, auto-retry limits, pause triggers
- **Retention:** Log retention period, artifact cleanup rules
- **Team:** User roles, permissions
- **API Keys:** Generate/revoke keys for extension auth
- **Notifications:** Email, Slack, webhook alerts for failures/interventions

---

## 4. Browser Extension UI

### 4.1 Extension Popup (compact, always visible)

```
┌──────────────────────────┐
│  ● Connected            │
│  mycompany.workflow.io   │
├──────────────────────────┤
│                          │
│  [ ◉ Record ]            │
│  [ ▶ Run Workflow ▼ ]   │
│                          │
├──────────────────────────┤
│  Active: Candidate Search│
│  Step 4/7 · Running      │
│  ━━━━━━━━━━╸━━━━━━━━━━  │
│                          │
│  [Pause]  [View Details] │
│                          │
├──────────────────────────┤
│  ⚠ Needs attention (1)   │
│  Run #91 — selector      │
│  mismatch                │
│  [Review →]              │
│                          │
└──────────────────────────┘
```

**States:**
- **Idle:** Shows "Record" and "Run Workflow" buttons, connection status
- **Recording:** Red indicator, timeline preview, "Stop Recording" button
- **Running:** Progress bar, current step, pause/resume controls
- **Waiting for user:** Amber banner with action required, big "I've handled it" button
- **Error:** Red banner with error summary and "Retry" / "View Details"

### 4.2 Extension Side Panel (expanded view)

Opens from popup or keyboard shortcut. Shows:
- Full timeline of current recording or run
- Step details on click (selector, intent, screenshot thumbnail)
- Quick actions: add checkpoint, annotate, skip step
- Audit log for current session

---

## 5. Component Library Recommendations

| Component | Usage |
|---|---|
| **StatusBadge** | `idle` `recording` `running` `waiting` `recovering` `failed` `completed` `canceled` — each with color + icon + label |
| **ProgressBar** | Step-level and workflow-level progress |
| **Timeline** | Vertical step list with icons, timestamps, expandable details |
| **EventRow** | Single audit log entry with hash, timestamp, type, payload preview |
| **Stepper** | Connector setup, multi-step wizards |
| **Drawer** | Side inspection panel — step details, event payload, screenshot viewer |
| **Modal** | Human intervention, confirmations, recording summary |
| **Card** | KPI summaries, templates, connector cards |
| **DataTable** | Workflow list, run list, audit log |
| **Toast** | Non-critical notifications (run completed, sync finished) |
| **Banner** | Critical inline alerts (failure, waiting for user) |
| **Tooltip** | Brief context on hover — only where label is truncated |
| **EmptyState** | Illustration + text + primary action |

---

## 6. State Model for Workflows and Runs

### Workflow States
| State | Badge Color | Meaning |
|---|---|---|
| `draft` | Gray | Created, not yet validated |
| `active` | Green | Ready to run |
| `archived` | Gray | No longer used, preserved for audit |

### Run States
| State | Badge Color | Icon | Meaning |
|---|---|---|---|
| `idle` | Gray | ○ | Not started |
| `recording` | Red | ◉ | Actively capturing |
| `queued` | Blue | ⏳ | Waiting for worker |
| `running` | Blue | ▶ | Executing steps |
| `waiting_for_user` | Amber | ⚠ | Paused, needs human action |
| `recovering` | Amber | ↻ | AI/heuristic recovery in progress |
| `completed` | Green | ✓ | All steps done |
| `failed` | Red | ✗ | Unrecoverable error |
| `canceled` | Gray | ⊘ | Stopped by user |

**State visibility rules:**
- `waiting_for_user` and `recovering` always surface to the top of lists
- `failed` runs show error summary inline, not hidden behind a click
- State transitions are logged in the audit trail automatically

---

## 7. Empty / Error / Loading States

### Empty States

| Screen | Message | Action |
|---|---|---|
| **Workflows (none)** | "No workflows yet. Record your first workflow from the browser extension, or start from a template." | [Install Extension] [Use Template] |
| **Runs (none)** | "No runs yet. Start a workflow to see execution history here." | [Browse Workflows] |
| **Audit (none)** | "No audit events. Run a workflow to generate an audit trail." | [View Workflows] |
| **Connectors (none)** | "No connectors configured. Connect a system to enable sync." | [Add Connector] |

### Error States

| Scenario | Message | Action |
|---|---|---|
| **Run failed** | "Run failed at Step 3: element not found. The page structure may have changed." | [View Recovery Attempts] [Retry] [Edit Workflow] |
| **Connector disconnected** | "Odoo connection lost. Check credentials and network." | [Reconnect] [View Logs] |
| **Extension offline** | "Extension is not connected to the backend." | [Check Connection] [Troubleshoot] |

### Loading States

- **Initial load:** Skeleton cards matching the layout shape
- **Run in progress:** Subtle pulse on the active step, event feed auto-scrolls
- **AI recovery:** "Analyzing page changes…" with a spinner — never more than 5 seconds without a status update
- **Sync in progress:** Progress bar with "Syncing 24 of 156 records…"

---

## 8. Interaction Patterns

### Recording
1. User clicks "Record" in extension → popup shows recording indicator
2. Each browser action auto-appends to timeline
3. User can click any step in timeline to add intent note
4. User can mark any step as a checkpoint (saves full state)
5. "Finish Recording" → modal: "Describe this workflow in a sentence" → saves as prompt
6. Workflow is saved as `draft` — user can validate and activate from dashboard

### Replay
1. User clicks "Run" on a workflow → run starts in `queued` → `running`
2. Each step executes with visual progress
3. If step fails → system attempts deterministic recovery → if that fails → AI recovery
4. AI recovery shows confidence score and explanation in the event feed
5. If confidence < threshold → pauses for human review
6. User can pause, resume, retry, skip, or stop at any time

### Audit Inspection
1. User opens audit view for a run
2. Table shows all events chronologically
3. Click any row → side drawer opens with full payload
4. Screenshot thumbnails expand to full view in drawer
5. DOM snapshots show as formatted tree with highlighted target element
6. AI events show: input context, output, confidence, decision
7. User can filter by event type, step, or status
8. Export generates a complete run report

### Human Intervention
1. System detects blocking condition → pauses run → sets state to `waiting_for_user`
2. Modal appears on dashboard + notification in extension
3. Browser window is brought to foreground (via extension)
4. Modal explains: what blocked, what user should do, state is preserved
5. User completes action in browser → clicks "Continue"
6. System verifies page state → resumes from checkpoint
7. Intervention is logged in audit trail with timestamp, reason, and user action

---

## 9. Design System Direction

### Colors

| Token | Value | Usage |
|---|---|---|
| `--bg-primary` | `#0F1117` | App background |
| `--bg-surface` | `#1A1D27` | Cards, panels |
| `--bg-elevated` | `#242836` | Modals, drawers |
| `--bg-input` | `#2A2E3D` | Inputs, textareas |
| `--text-primary` | `#E8EAED` | Body text |
| `--text-secondary` | `#9AA0B0` | Labels, hints |
| `--text-muted` | `#6B7280` | Timestamps, hashes |
| `--accent` | `#6C5CE7` | Primary actions, links |
| `--accent-hover` | `#7C6EF7` | Hover state |
| `--success` | `#00B894` | Completed, healthy |
| `--warning` | `#FDCB6E` | Waiting, recovering |
| `--error` | `#E17055` | Failed, blocked |
| `--info` | `#74B9FF` | Running, queued |
| `--border` | `#2D3148` | Dividers, card borders |

**Rationale:** Dark base reduces eye strain for operators who may have the dashboard open for hours. The accent is a calm purple — distinctive but not aggressive. Status colors are muted enough to not create visual noise but clear enough to scan.

### Typography

| Token | Value | Usage |
|---|---|---|
| `--font-sans` | `Inter, system-ui, sans-serif` | UI text |
| `--font-mono` | `JetBrains Mono, SF Mono, monospace` | Hashes, IDs, code, traces |
| `--text-xs` | `11px / 400` | Labels, badges |
| `--text-sm` | `13px / 400` | Body, table cells |
| `--text-base` | `15px / 400` | Paragraphs, descriptions |
| `--text-lg` | `17px / 500` | Section headers |
| `--text-xl` | `20px / 600` | Page titles |
| `--text-2xl` | `24px / 600` | Dashboard greeting, KPI numbers |

### Spacing

| Token | Value |
|---|---|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `20px` |
| `--space-6` | `24px` |
| `--space-8` | `32px` |
| `--space-10` | `40px` |
| `--space-12` | `48px` |

### Border Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `6px` | Buttons, badges, inputs |
| `--radius-md` | `10px` | Cards, panels |
| `--radius-lg` | `14px` | Modals, drawers |
| `--radius-full` | `9999px` | Avatars, status dots |

### Shadows

| Token | Value | Usage |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.3)` | Cards |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.4)` | Dropdowns, popups |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.5)` | Modals, drawers |

### Iconography

- Use a consistent icon set (recommend **Lucide** or **Phosphor Icons**)
- Every icon must have a text label or tooltip — never icon-only for critical actions
- Status icons: circle (idle), dot-in-circle (recording), triangle (running), exclamation (waiting), refresh (recovering), check (completed), X (failed), minus (canceled)

---

## 10. Wireframe Structure Summary

```
Main App:
┌─ Top Bar (search, status, user) ────────────────────┐
│                                                      │
│ ┌─ Sidebar ────┐ ┌─ Main Content ─────────────────┐ │
│ │ Dashboard    │ │                                 │ │
│ │ Workflows    │ │  Page-specific content          │ │
│ │ Runs         │ │  (tables, cards, detail views)  │ │
│ │ Audit        │ │                                 │ │
│ │ Connectors   │ │                          [Drawer]│ │
│ │ Settings     │ │                                 │ │
│ └──────────────┘ └─────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘

Extension Popup:
┌──────────────────────────┐
│ Connection status        │
│ Primary action           │
│ Active run status        │
│ Alerts                   │
└──────────────────────────┘

Modal (Human Intervention):
┌──────────────────────────────────────┐
│ Title: what happened                 │
│ Explanation: plain language          │
│ What to do: numbered steps           │
│ State preserved: reassurance         │
│ [Primary action]                     │
│ [Secondary]              [Destructive]│
└──────────────────────────────────────┘
```

---

## 11. Rationale

This design fits the product because:

1. **Trust through visibility.** Every state, every step, every recovery attempt is visible. The user never wonders "what is it doing?" The audit trail is a first-class citizen, not a debug afterthought.

2. **Calm under complexity.** The dark, muted palette and generous spacing prevent the interface from feeling overwhelming even when showing dense execution data. Information is structured hierarchically — summary first, detail on demand.

3. **Human intervention is designed as a conversation, not an error.** The modal explains what happened, what to do, and reassures that state is preserved. It feels like a colleague asking for help, not a system crashing.

4. **Progressive disclosure keeps it simple but powerful.** The default view is clean. Technical details (DOM snapshots, AI confidence scores, hash chains) are available but not forced on the user.

5. **Reusable by design.** The connector system is abstracted — adding a new adapter is just another card in the connector list. Workflow templates are generic. Nothing is hardcoded to Odoo in the UI.

6. **Desktop-first, responsive.** The layout works on laptops and wide screens. The extension popup is compact by necessity but expands to a side panel when more context is needed.

7. **Accessible by default.** Status is never communicated by color alone. Keyboard navigation is supported. Contrast ratios meet WCAG AA. Mono font for technical data ensures readability.
