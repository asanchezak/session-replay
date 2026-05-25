export async function waitForTabLoad(tabId: number, timeoutMs: number = 15000): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
  } catch {
    // Tab may be gone.
  }

  return new Promise((resolve, reject) => {
    function cleanup(): void {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Page load timed out"));
    }, timeoutMs);
    const listener = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (_tabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export async function waitForTabLoadBestEffort(
  tabId: number,
  contextLabel: string,
  timeoutMs: number = 15000,
): Promise<void> {
  try {
    await waitForTabLoad(tabId, timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const tab = await chrome.tabs.get(tabId);
      console.log(
        `[service-worker] ${contextLabel}: load wait timed out; continuing ` +
        `(status=${tab.status}, url=${tab.url || ""})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return;
    } catch {
      throw new Error(`Page load timed out (${contextLabel}): ${message}`);
    }
  }
}
