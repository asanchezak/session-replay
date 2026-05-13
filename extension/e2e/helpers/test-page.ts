import type { Page } from "@playwright/test";

const V1_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Page V1</title></head>
<body>
  <div id="app">
    <button id="submit-btn-v1" class="btn btn-primary" data-testid="submit-button">Submit Application</button>
    <a data-testid="candidate-link" class="old-class" href="#section2">View Candidate</a>
    <div class="results-table-v1"><span>24 results found</span></div>
    <div class="profile-card"><h2 class="name-header">John Doe</h2><p class="role-tag">Senior Developer</p></div>
    <p>Some text here</p>
  </div>
</body></html>`;

const V2_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Page V2</title></head>
<body>
  <div id="app">
    <button id="submit-btn-v2" class="btn-new btn-secondary" data-testid="submit-button">Submit Application</button>
    <a data-testid="candidate-link" class="new-class" href="#section2">View Candidate</a>
    <div class="results-grid"><span>24 results found</span></div>
    <div class="profile-card"><h2 class="name-header">John Doe</h2><p class="role-tag">Senior Developer</p></div>
    <p>Some text here</p>
  </div>
</body></html>`;

export const TEST_PAGE_URL = "http://sr-test.local/test-page";
export const TEST_PAGE_URL_V2 = "http://sr-test.local/test-page?version=v2";

export async function serveTestPage(page: Page): Promise<void> {
  await page.route("**/sr-test.local/**", async (route) => {
    const url = new URL(route.request().url());
    const isV2 = url.searchParams.get("version") === "v2";
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: isV2 ? V2_HTML : V1_HTML,
    });
  });
}
