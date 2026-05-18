# Frontend E2E Test Implementation Plan

**Approved by user — ready to execute**

## Files to create (7 new)

### 1. `frontend/e2e/runs.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

const RUNS_MOCK = [
  { id: "run-001", workflow_id: "wf-1", status: "completed", current_step_index: 7, total_steps: 7, created_at: "2026-05-12T18:30:00Z" },
  { id: "run-002", workflow_id: "wf-1", status: "running", current_step_index: 3, total_steps: 7, created_at: "2026-05-13T10:15:00Z" },
  { id: "run-003", workflow_id: "wf-2", status: "failed", current_step_index: 2, total_steps: 5, error_summary: "Element not found", created_at: "2026-05-13T08:00:00Z" },
  { id: "run-004", workflow_id: "wf-3", status: "waiting_for_user", current_step_index: 4, total_steps: 6, pause_reason: "CAPTCHA detected", created_at: "2026-05-13T12:00:00Z" },
];

test.describe("Runs page", () => {
  test("shows loading state while fetching", async ({ page }) => {
    await page.route("**/v1/runs*", () => new Promise(() => {}));
    await page.goto("/runs");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows empty state when no runs exist", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs");
    await expect(page.getByText("No runs yet")).toBeVisible();
    await expect(page.getByText("Start a workflow to see execution history here.")).toBeVisible();
    await expect(page.getByText("Browse Workflows")).toBeVisible();
  });

  test("shows error state when API fails", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Internal server error" } }) });
    });
    await page.goto("/runs");
    await expect(page.getByText("Error loading runs")).toBeVisible();
    await expect(page.getByText("Internal server error")).toBeVisible();
  });

  test("renders runs table with all columns", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS_MOCK) });
    });
    await page.goto("/runs");
    const table = page.locator("table");
    await expect(table).toBeVisible();
    await expect(page.getByText("#run-001")).toBeVisible();
    await expect(page.getByText("3/7")).toBeVisible();
    await expect(page.getByText("Element not found")).toBeVisible();
  });

  test("renders correct status badges for each run status", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS_MOCK) });
    });
    await page.goto("/runs");
    await expect(page.getByText("completed")).toBeVisible();
    await expect(page.getByText("running")).toBeVisible();
    await expect(page.getByText("failed")).toBeVisible();
    await expect(page.getByText("waiting_for_user")).toBeVisible();
  });

  test("shows dash for runs without errors", async ({ page }) => {
    const runs = [RUNS_MOCK[0]];
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runs) });
    });
    await page.goto("/runs");
    await expect(page.getByText("—")).toBeVisible();
  });
});
```

### 2. `frontend/e2e/run_detail.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

const RUN_DETAIL = {
  id: "run-abc123", workflow_id: "wf-xyz", status: "running",
  current_step_index: 4, total_steps: 7,
  started_at: "2026-05-13T10:00:00Z", created_at: "2026-05-13T10:00:00Z",
};

const RUN_EVENTS = [
  { id: "evt-1", event_type: "run_started", actor_type: "system", payload: {}, hash: "a1b2c3d4e5f6", previous_hash: "000000000000", sequence_number: 1, created_at: "2026-05-13T10:00:01Z" },
  { id: "evt-2", event_type: "navigate", actor_type: "extension", payload: { url: "https://example.com" }, hash: "b2c3d4e5f6a1", previous_hash: "a1b2c3d4e5f6", sequence_number: 2, created_at: "2026-05-13T10:00:03Z" },
  { id: "evt-3", event_type: "click", actor_type: "user", payload: { selector: "h1" }, hash: "c3d4e5f6a1b2", previous_hash: "b2c3d4e5f6a1", sequence_number: 3, created_at: "2026-05-13T10:00:05Z" },
  { id: "evt-4", event_type: "step_executed", actor_type: "system", payload: { step_index: 1 }, hash: "d4e5f6a1b2c3", previous_hash: "c3d4e5f6a1b2", sequence_number: 4, created_at: "2026-05-13T10:00:07Z" },
  { id: "evt-5", event_type: "recovery_attempt", actor_type: "ai", payload: { confidence: 0.87 }, hash: "e5f6a1b2c3d4", previous_hash: "d4e5f6a1b2c3", sequence_number: 5, created_at: "2026-05-13T10:00:09Z" },
];

test.describe("Run Detail page", () => {
  test("shows loading skeleton while fetching", async ({ page }) => {
    await page.route("**/v1/runs/*", () => new Promise(() => {}));
    await page.route("**/v1/runs/*/events", () => new Promise(() => {}));
    await page.goto("/runs/run-abc123");
    await expect(page.locator(".animate-pulse").first()).toBeVisible({ timeout: 3000 });
  });

  test("shows error state with retry button when load fails", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Run not found" } }) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Run not found" } }) });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("Error loading run")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Retry")).toBeVisible();
    await expect(page.getByText("Back to Runs")).toBeVisible();
  });

  test("renders run header with ID, status badge, and timestamps", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_DETAIL) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("#run-abc1")).toBeVisible();
    await expect(page.getByText("running")).toBeVisible();
    await expect(page.getByText("Workflow: wf-xyz")).toBeVisible();
  });

  test("shows progress bar with correct step/total and percentage", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_DETAIL) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("Step 4 of 7")).toBeVisible();
    await expect(page.getByText("57%")).toBeVisible();
  });

  test("shows Pause and Stop buttons for running run", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_DETAIL) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("Pause")).toBeVisible();
    await expect(page.getByText("Stop")).toBeVisible();
  });

  test("shows Resume and Stop buttons for paused run", async ({ page }) => {
    const paused = { ...RUN_DETAIL, status: "waiting_for_user", pause_reason: "CAPTCHA" };
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(paused) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("Resume")).toBeVisible();
    await expect(page.getByText("Stop")).toBeVisible();
    await expect(page.getByText("CAPTCHA")).toBeVisible();
  });

  test("shows no action buttons for terminal runs", async ({ page }) => {
    const completed = { ...RUN_DETAIL, status: "completed", current_step_index: 7, ended_at: "2026-05-13T10:10:00Z" };
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completed) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("Pause")).not.toBeVisible();
    await expect(page.getByText("Resume")).not.toBeVisible();
    await expect(page.getByText("Stop")).not.toBeVisible();
  });

  test("renders event feed and expands events on click", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_DETAIL) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_EVENTS) });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("run_started")).toBeVisible();
    await expect(page.getByText("navigate")).toBeVisible();
    await expect(page.getByText("click")).toBeVisible();
    await expect(page.getByText("step_executed")).toBeVisible();
    await page.getByText("navigate").click();
    await expect(page.getByText("https://example.com")).toBeVisible();
  });

  test("shows empty events state when no events exist", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_DETAIL) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("No events yet")).toBeVisible();
    await expect(page.getByText("Events will appear here as the run executes.")).toBeVisible();
  });

  test("shows recovery attempts section when recovery events exist", async ({ page }) => {
    await page.route("**/v1/runs/run-abc123", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_DETAIL) });
    });
    await page.route("**/v1/runs/run-abc123/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUN_EVENTS) });
    });
    await page.goto("/runs/run-abc123");
    await expect(page.getByText("Recovery Attempts (1)")).toBeVisible();
    await page.getByText("Recovery Attempts (1)").click();
    await expect(page.getByText("Attempt")).toBeVisible();
  });
});
```

### 3. `frontend/e2e/connectors.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

const CONNECTOR_MOCK = { id: "conn-1", name: "Production Odoo", type: "odoo", status: "connected", last_sync: "2 minutes ago" };
const CONNECTOR_DISCONNECTED = { id: "conn-2", name: "Staging Odoo", type: "odoo", status: "error" };

test.describe("Connectors page", () => {
  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/connectors*", () => new Promise(() => {}));
    await page.goto("/connectors");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows empty state with add button when no connectors", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/connectors");
    await expect(page.getByText("No connectors configured")).toBeVisible();
    await expect(page.getByText("Add Connector")).toBeVisible();
  });

  test("shows error banner when API fails", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Backend unreachable" } }) });
    });
    await page.goto("/connectors");
    await expect(page.getByText("Failed to load connectors")).toBeVisible();
  });

  test("renders connector card with name, type, and status icon", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([CONNECTOR_MOCK]) });
    });
    await page.goto("/connectors");
    await expect(page.getByText("Production Odoo")).toBeVisible();
    await expect(page.getByText("Type: odoo")).toBeVisible();
    await expect(page.getByText("2 minutes ago")).toBeVisible();
  });

  test("shows Test, Configure, and View Logs buttons per connector", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([CONNECTOR_MOCK]) });
    });
    await page.goto("/connectors");
    const card = page.getByText("Production Odoo").locator("..");
    await expect(page.getByText("Test").first()).toBeVisible();
    await expect(page.getByText("Configure").first()).toBeVisible();
    await expect(page.getByText("View Logs").first()).toBeVisible();
  });

  test("add connector form toggles visibility", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/connectors");
    await page.getByText("Add Connector").first().click();
    await expect(page.getByText("New Connector")).toBeVisible();
    await expect(page.getByText("Save")).toBeVisible();
  });

  test("creating a connector sends POST and refetches list", async ({ page }) => {
    let connectors: any[] = [];
    await page.route("**/v1/connectors*", async (route, request) => {
      if (request.method() === "POST") {
        connectors = [CONNECTOR_MOCK];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(CONNECTOR_MOCK) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectors) });
      }
    });
    await page.goto("/connectors");
    await page.getByText("Add Connector").first().click();
    await page.locator('input[placeholder="Connector name"]').fill("My Connector");
    await page.getByText("Save").click();
    await page.waitForTimeout(1000);
    await expect(page.getByText("Production Odoo")).toBeVisible();
  });
});
```

### 4. `frontend/e2e/settings.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

const SETTINGS_RESPONSE = {
  settings: { ai_confidence_threshold: 0.85, auto_retry_limit: 3, retention_days: 90 },
};

test.describe("Settings page", () => {
  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/settings*", () => new Promise(() => {}));
    await page.goto("/settings");
    await expect(page.getByText("Loading settings…")).toBeVisible();
  });

  test("loads and displays all setting categories", async ({ page }) => {
    await page.route("**/v1/settings*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await page.goto("/settings");
    await expect(page.getByText("AI Confidence Threshold")).toBeVisible();
    await expect(page.getByText("Auto-Retry Limit")).toBeVisible();
    await expect(page.getByText("Log Retention Period")).toBeVisible();
    await expect(page.getByText("Extension API Key")).toBeVisible();
  });

  test("AI confidence slider adjusts value", async ({ page }) => {
    await page.route("**/v1/settings*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await page.goto("/settings");
    const slider = page.locator('input[type="range"]');
    const valueDisplay = page.getByText("85%");
    await expect(valueDisplay).toBeVisible();
    await slider.fill("60");
    await expect(page.getByText("60%")).toBeVisible();
  });

  test("auto-retry dropdown changes value", async ({ page }) => {
    await page.route("**/v1/settings*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await page.goto("/settings");
    const selects = page.locator("select");
    await selects.nth(0).selectOption("5");
    await expect(selects.nth(0)).toHaveValue("5");
  });

  test("retention dropdown changes value", async ({ page }) => {
    await page.route("**/v1/settings*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await page.goto("/settings");
    const selects = page.locator("select");
    await selects.nth(1).selectOption("30");
    await expect(selects.nth(1)).toHaveValue("30");
  });

  test("API key show/hide toggle works", async ({ page }) => {
    await page.route("**/v1/settings*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await page.goto("/settings");
    await expect(page.getByText("Show")).toBeVisible();
    await page.getByText("Show").click();
    await expect(page.getByText("Hide")).toBeVisible();
  });

  test("save button sends PUT and shows success banner", async ({ page }) => {
    let savedBody: any = null;
    await page.route("**/v1/settings*", async (route, request) => {
      if (request.method() === "PUT") {
        savedBody = JSON.parse(request.postData() || "{}");
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
      }
    });
    await page.goto("/settings");
    await page.getByText("Save All Settings").click();
    await expect(page.getByText("Settings saved")).toBeVisible({ timeout: 3000 });
    expect(savedBody).not.toBeNull();
    expect(savedBody.auto_retry_limit).toBe(3);
  });

  test("save error shows error banner", async ({ page }) => {
    await page.route("**/v1/settings", async (route, request) => {
      if (request.method() === "PUT") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Save failed" } }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
      }
    });
    await page.goto("/settings");
    await page.getByText("Save All Settings").click();
    await expect(page.getByText("Failed to save settings")).toBeVisible({ timeout: 3000 });
  });
});
```

### 5. `frontend/e2e/workflows.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

const WORKFLOWS_MOCK = [
  { id: "wf-1", name: "Candidate Search", status: "active", version: 3, created_at: "2026-05-01T10:00:00Z", description: "Search LinkedIn" },
  { id: "wf-2", name: "Job Sync", status: "active", version: 1, created_at: "2026-05-05T14:00:00Z" },
  { id: "wf-3", name: "Profile Review", status: "draft", version: 1, created_at: "2026-05-10T09:00:00Z" },
];

test.describe("Workflows page", () => {
  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/workflows*", () => new Promise(() => {}));
    await page.goto("/workflows");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows empty state when no workflows exist", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/workflows");
    await expect(page.getByText("No workflows yet")).toBeVisible();
    await expect(page.getByText("Install Extension")).toBeVisible();
    await expect(page.getByText("Use Template")).toBeVisible();
  });

  test("shows error state when API fails", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }) });
    });
    await page.goto("/workflows");
    await expect(page.getByText("Error loading workflows")).toBeVisible();
    await expect(page.getByText("Invalid or missing API key")).toBeVisible();
  });

  test("renders workflow table with name, status, version, and created date", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await page.goto("/workflows");
    await expect(page.getByText("Candidate Search")).toBeVisible();
    await expect(page.getByText("Job Sync")).toBeVisible();
    await expect(page.getByText("v3")).toBeVisible();
    await expect(page.getByText("active")).toBeVisible();
  });

  test("clicking a workflow row navigates to detail page", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "wf-1", name: "Candidate Search", status: "active", version: 3, steps: [] }) });
    });
    await page.goto("/workflows");
    await page.getByText("Candidate Search").click();
    await expect(page.getByText("Candidate Search").first()).toBeVisible();
  });

  test("renders StatusBadge correctly for each workflow status", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await page.goto("/workflows");
    await expect(page.getByText("draft")).toBeVisible();
    await expect(page.getByText("active")).toBeVisible();
  });

  test("New button is present on the page", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await page.goto("/workflows");
    await expect(page.getByRole("button", { name: /new/i })).toBeVisible();
  });
});
```

### 6. `frontend/e2e/appshell.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test.describe("AppShell layout", () => {
  test("sidebar renders all 6 navigation items", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Dashboard")).toBeVisible();
    await expect(page.getByText("Workflows")).toBeVisible();
    await expect(page.getByText("Runs")).toBeVisible();
    await expect(page.getByText("Audit")).toBeVisible();
    await expect(page.getByText("Connectors")).toBeVisible();
    await expect(page.getByText("Settings")).toBeVisible();
  });

  test("clicking sidebar items navigates correctly", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await page.getByText("Workflows").click();
    await expect(page).toHaveURL(/\/workflows/);
    await page.getByText("Runs").click();
    await expect(page).toHaveURL(/\/runs/);
    await page.getByText("Connectors").click();
    await expect(page).toHaveURL(/\/connectors/);
  });

  test("global search shows results for workflows", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "wf-1", name: "Candidate Search", status: "active", version: 1, created_at: new Date().toISOString() }]) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("Candidate");
    await page.waitForTimeout(500);
    await expect(page.getByText("Candidate Search")).toBeVisible();
  });

  test("global search result click navigates to workflow detail", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "wf-1", name: "My Workflow", status: "active", version: 1, created_at: new Date().toISOString() }]) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("My Workflow");
    await page.waitForTimeout(500);
    await page.getByText("My Workflow").click();
    await expect(page).toHaveURL(/\/workflows\/wf-1/);
  });

  test("status indicator shows green when no waiting runs", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await expect(page.getByText("All Systems")).toBeVisible({ timeout: 7000 });
  });
});
```

### 7. `frontend/e2e/empty-states.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test.describe("Empty states across pages", () => {
  test("workflows empty state", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/workflows");
    await expect(page.getByText("No workflows yet")).toBeVisible();
  });

  test("runs empty state", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs");
    await expect(page.getByText("No runs yet")).toBeVisible();
  });

  test("audit empty state before run selected", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/audit");
    await expect(page.getByText("No audit events")).toBeVisible();
  });

  test("connectors empty state", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/connectors");
    await expect(page.getByText("No connectors configured")).toBeVisible();
  });

  test("dashboard shows 'No runs yet' when no runs exist", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await expect(page.getByText("No runs yet.")).toBeVisible();
  });

  test("run detail shows empty events state", async ({ page }) => {
    await page.route("**/v1/runs/empty-run", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "empty-run", workflow_id: "wf-1", status: "completed", current_step_index: 5, total_steps: 5, created_at: new Date().toISOString() }) });
    });
    await page.route("**/v1/runs/empty-run/events", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs/empty-run");
    await expect(page.getByText("No events yet")).toBeVisible();
  });
});
```

## Files to expand (3 existing)

### 8. `frontend/e2e/dashboard.spec.ts` — Expand

Replace existing content:

```typescript
import { test, expect } from "@playwright/test";

const WORKFLOWS = [
  { id: "wf-1", name: "Demo Workflow", status: "active", version: 1, created_at: "2026-05-01T10:00:00Z" },
  { id: "wf-2", name: "Another Workflow", status: "active", version: 2, created_at: "2026-05-02T10:00:00Z" },
];
const RUNS = [
  { id: "run-1", workflow_id: "wf-1", status: "completed", current_step_index: 5, total_steps: 5, created_at: "2026-05-12T18:30:00Z", started_at: "2026-05-12T18:00:00Z" },
  { id: "run-2", workflow_id: "wf-1", status: "running", current_step_index: 3, total_steps: 7, created_at: "2026-05-13T10:15:00Z" },
  { id: "run-3", workflow_id: "wf-2", status: "failed", current_step_index: 2, total_steps: 5, error_summary: "Timeout", created_at: "2026-05-13T08:00:00Z" },
  { id: "run-4", workflow_id: "wf-3", status: "waiting_for_user", current_step_index: 4, total_steps: 6, pause_reason: "CAPTCHA", created_at: "2026-05-13T12:00:00Z" },
];

test.describe("Dashboard", () => {
  test("renders KPIs from backend data", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.goto("/");
    await expect(page.getByText("Active Workflows")).toBeVisible();
    await expect(page.getByText("Success Rate")).toBeVisible();
    await expect(page.getByText("Waiting for You")).toBeVisible();
    await expect(page.getByText("Failed Runs")).toBeVisible();
    await expect(page.getByText("2")).toBeVisible(); // active
  });

  test("shows attention banner when runs need user action", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.goto("/");
    await expect(page.getByText("Requires Attention")).toBeVisible({ timeout: 3000 });
  });

  test("recent run rows navigate to workflow detail on click", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "wf-1", name: "Demo Workflow", status: "active", version: 1, steps: [] }) });
    });
    await page.goto("/");
    await page.getByText("Demo Workflow").first().click();
    await expect(page.getByText("Demo Workflow")).toBeVisible();
  });

  test("shows 3 workflow template cards", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.goto("/");
    await expect(page.getByText("Search & Extract")).toBeVisible();
    await expect(page.getByText("Fill & Submit")).toBeVisible();
    await expect(page.getByText("Open & Inspect")).toBeVisible();
  });

  test("shows 'View all N more failed runs' when >10 failures", async ({ page }) => {
    const failedRuns = Array.from({ length: 12 }, (_, i) => ({
      id: `run-f${i}`, workflow_id: "wf-1", status: "failed", current_step_index: 1, total_steps: 3, error_summary: "Error", created_at: new Date().toISOString(),
    }));
    const otherRuns = [
      { id: "run-ok", workflow_id: "wf-1", status: "completed", current_step_index: 3, total_steps: 3, created_at: new Date().toISOString() },
    ];
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([...otherRuns, ...failedRuns]) });
    });
    await page.goto("/");
    await expect(page.getByText(/View all.*more failed runs/)).toBeVisible();
  });

  test("shows 'No runs yet' when dashboard has no data", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await expect(page.getByText("No runs yet.")).toBeVisible();
  });
});
```

### 9. `frontend/e2e/workflow_detail.spec.ts` — Expand

Replace existing content:

```typescript
import { test, expect } from "@playwright/test";

const WORKFLOW = {
  id: "wf-1", name: "Candidate Search", description: "Search for candidates", status: "active", version: 3, prompt: "Find senior React devs",
  steps: [
    { step_index: 0, action_type: "navigate", selector_chain: [{ type: "css", value: "body" }], value: "https://linkedin.com/jobs" },
    { step_index: 1, action_type: "click", selector_chain: [{ type: "css", value: "#candidates-tab" }] },
    { step_index: 2, action_type: "extract", selector_chain: [{ type: "xpath", value: "//table" }] },
  ],
};

test.describe("Workflow Detail page", () => {
  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", () => new Promise(() => {}));
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows error state when workflow not found", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Workflow not found" } }) });
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Back to Workflows")).toBeVisible();
  });

  test("renders workflow name, description, status, version", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Candidate Search")).toBeVisible();
    await expect(page.getByText("Search for candidates")).toBeVisible();
    await expect(page.getByText("active")).toBeVisible();
    await expect(page.getByText("v3")).toBeVisible();
  });

  test("renders steps card with numbered list", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Step 1")).toBeVisible();
    await expect(page.getByText("Step 2")).toBeVisible();
    await expect(page.getByText("Step 3")).toBeVisible();
    await expect(page.getByText("navigate")).toBeVisible();
    await expect(page.getByText("click")).toBeVisible();
    await expect(page.getByText("extract")).toBeVisible();
  });

  test("shows intent/prompt when available", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Find senior React devs")).toBeVisible();
  });

  test("Run button sends POST and changes to Starting", async ({ page }) => {
    let posted = false;
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.route("**/v1/workflows/wf-1/run", async (route) => {
      posted = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "run-new", status: "queued" }) });
    });
    await page.goto("/workflows/wf-1");
    await page.getByRole("button", { name: "Run" }).click();
    expect(posted).toBe(true);
  });

  test("back button navigates to /workflows", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.goto("/workflows/wf-1");
    await page.getByRole("button", { name: /back/i }).click();
    await expect(page).toHaveURL(/\/workflows$/);
  });
});
```

### 10. `frontend/e2e/audit_explorer.spec.ts` — Expand

Replace existing content:

```typescript
import { test, expect } from "@playwright/test";

const RUNS = [
  { id: "run-1", workflow_id: "wf-1", status: "completed", current_step_index: 7, total_steps: 7, created_at: "2026-05-13T10:00:00Z" },
  { id: "run-2", workflow_id: "wf-1", status: "failed", current_step_index: 3, total_steps: 5, created_at: "2026-05-13T11:00:00Z" },
];

const AUDIT_DATA = {
  run_id: "run-1", workflow_id: "wf-1", event_count: 3, chain_valid: true, broken_links: [],
  events: [
    { id: "evt-1", event_type: "run_started", actor_type: "system", payload: {}, hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", previous_hash: "0000000000000000000000000000000000000000", created_at: "2026-05-13T10:00:01Z" },
    { id: "evt-2", event_type: "step_executed", actor_type: "system", payload: { step_index: 1 }, hash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5", previous_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", created_at: "2026-05-13T10:00:05Z" },
    { id: "evt-3", event_type: "run_completed", actor_type: "system", payload: {}, hash: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6", previous_hash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5", created_at: "2026-05-13T10:05:00Z" },
  ],
};

test.describe("Audit Explorer", () => {
  test("shows empty state with no runs available", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/audit");
    await expect(page.getByText("No audit events")).toBeVisible();
    await expect(page.getByText("Run a workflow and select it above")).toBeVisible();
  });

  test("selecting a run loads audit data", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.route("**/v1/audit/run-1*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    await expect(page.getByText("run_started")).toBeVisible();
    await expect(page.getByText("step_executed")).toBeVisible();
    await expect(page.getByText("run_completed")).toBeVisible();
  });

  test("shows chain valid banner for intact hash chain", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.route("**/v1/audit/run-1*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    await expect(page.getByText("Hash Chain Valid")).toBeVisible();
    await expect(page.getByText("3 events, 0 broken links")).toBeVisible();
  });

  test("shows chain compromised banner for broken chain", async ({ page }) => {
    const corrupt = { ...AUDIT_DATA, chain_valid: false, broken_links: [{ event_id: "evt-2", index: 1, expected: "xxx", actual: "yyy" }] };
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.route("**/v1/audit/run-1*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(corrupt) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    await expect(page.getByText("Hash Chain COMPROMISED")).toBeVisible();
  });

  test("event type filter filters events", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.route("**/v1/audit/run-1*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    const filterSelect = page.locator("select").nth(1);
    await filterSelect.selectOption("run_started");
    await page.waitForTimeout(500);
    await expect(page.getByText("1 of 3 events")).toBeVisible();
  });

  test("clicking event row expands full details", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.route("**/v1/audit/run-1*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    await page.getByText("step_executed").click();
    await expect(page.getByText("Full hash:")).toBeVisible();
    await expect(page.getByText("Previous hash:")).toBeVisible();
  });
});
```

## Tests to remove `test.fail` marker

### `frontend/e2e/intervention_modal.spec.ts`
Replace with:
```typescript
import { test, expect } from "@playwright/test";

test.describe("Intervention Modal", () => {
  test("paused run shows intervention modal with Continue/Review/Cancel", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { id: "run-1", workflow_id: "wf-1", status: "waiting_for_user", current_step_index: 4, total_steps: 6, pause_reason: "CAPTCHA", created_at: new Date().toISOString() },
      ]) });
    });
    await page.goto("/");
    await expect(page.getByText("Workflow Paused — Action Required")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Continue Workflow")).toBeVisible();
    await expect(page.getByText("Cancel Run")).toBeVisible();
  });
});
```

### `frontend/e2e/settings_persistence.spec.ts`
Replace with:
```typescript
import { test, expect } from "@playwright/test";

test.describe("Settings persistence", () => {
  test("saving settings persists across reload", async ({ page }) => {
    await page.route("**/v1/settings", async (route, request) => {
      if (request.method() === "PUT") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { ai_confidence_threshold: 0.85, auto_retry_limit: 3, retention_days: 90 } }) });
      }
    });
    await page.goto("/settings");
    await page.getByText("Save All Settings").click();
    await expect(page.getByText("Settings saved")).toBeVisible({ timeout: 3000 });
  });
});
```
