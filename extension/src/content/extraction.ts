export function extractStructuredData(
  outputSchema: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  if (!outputSchema) {
    const text = extractTextContent(document.body);
    if (text.length > 0) {
      results.push({ text });
    }
    return results;
  }

  const schemaItems = outputSchema?.items as Record<string, unknown> | undefined;
  const properties = (schemaItems?.properties || {}) as Record<string, { type?: string }>;

  if (Object.keys(properties).length === 0) {
    results.push({ page_text: extractTextContent(document.body) });
    return results;
  }

  const propertyKeys = Object.keys(properties);
  const candidates = findDataCandidates(document.body, propertyKeys);
  results.push(...candidates);

  if (results.length === 0) {
    results.push({ page_title: document.title, url: window.location.href });
  }

  return results;
}

function extractTextContent(element: Element, maxLength: number = 5000): string {
  return (element.textContent || "").trim().slice(0, maxLength);
}

function findDataCandidates(root: Element, keys: string[]): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  const containers = root.querySelectorAll<HTMLElement>(
    "article, .job-card, .listing, .result-item, .card, li[data-id], tr[data-id], .row, .item"
  );

  if (containers.length === 0) {
    const tables = root.querySelectorAll("table");
    for (const table of tables) {
      const rows = table.querySelectorAll("tr");
      if (rows.length > 1) {
        const headers = Array.from(rows[0].querySelectorAll("th, td")).map((h) =>
          (h.textContent || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "_")
        );
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          const row: Record<string, unknown> = {};
          cells.forEach((cell, ci) => {
            if (ci < headers.length) {
              row[headers[ci]] = (cell.textContent || "").trim();
            }
          });
          if (Object.keys(row).length > 0) {
            results.push(row);
          }
        }
        break;
      }
    }
    return results;
  }

  for (const container of containers) {
    const item: Record<string, unknown> = {};
    for (const key of keys) {
      const match = findValueForKey(container, key);
      if (match) {
        item[key] = match;
      }
    }
    if (Object.keys(item).length > 0) {
      results.push(item);
    }
  }

  return results;
}

function findValueForKey(container: Element, key: string): string | null {
  const lowerKey = key.toLowerCase();
  const variations = [lowerKey, lowerKey.replace(/_/g, " "), lowerKey.replace(/_/g, "-")];

  for (const variant of variations) {
    const elements = container.querySelectorAll<HTMLElement>("[data-field], [aria-label], [name], [class]");
    for (const el of elements) {
      const attrs = [el.getAttribute("data-field"), el.getAttribute("aria-label"), el.getAttribute("name")];
      for (const attr of attrs) {
        if (attr && attr.toLowerCase().includes(variant)) {
          return (el.textContent || "").trim();
        }
      }
    }
  }

  const allText = container.querySelectorAll<HTMLElement>("span, p, div, h1, h2, h3, h4, h5, h6, li, td, th");
  for (const el of allText) {
    const text = (el.textContent || "").trim().toLowerCase();
    for (const variant of variations) {
      if (text.includes(variant)) {
        const nextEl = el.nextElementSibling;
        if (nextEl) {
          return (nextEl.textContent || "").trim();
        }
        return (el.textContent || "").trim();
      }
    }
  }

  return null;
}
