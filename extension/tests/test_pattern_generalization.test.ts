import { describe, it, expect, beforeEach } from "vitest";

describe("Pattern detection", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("detects repeated list item pattern", async () => {
    const { detectPattern } = await import("../src/content/selectors");
    const ul = document.createElement("ul");
    ul.id = "items";
    for (let i = 0; i < 5; i++) {
      const li = document.createElement("li");
      li.textContent = `Item ${i}`;
      ul.appendChild(li);
    }
    document.body.appendChild(ul);
    const target = ul.children[2] as HTMLElement;

    const pattern = detectPattern(target);
    expect(pattern).not.toBeNull();
    expect(pattern!.siblingCount).toBe(5);
    expect(pattern!.childIndex).toBe(2);
    expect(pattern!.siblingTag).toBe("li");
  });

  it("detects table row pattern", async () => {
    const { detectPattern } = await import("../src/content/selectors");
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (let i = 0; i < 10; i++) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = `Row ${i}`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    document.body.appendChild(table);
    const target = tbody.children[4] as HTMLElement;

    const pattern = detectPattern(target);
    expect(pattern).not.toBeNull();
    expect(pattern!.siblingCount).toBe(10);
    expect(pattern!.childIndex).toBe(4);
  });

  it("returns null for unique element (less than 3 siblings)", async () => {
    const { detectPattern } = await import("../src/content/selectors");
    const div = document.createElement("div");
    div.id = "unique";
    document.body.appendChild(div);

    const pattern = detectPattern(div);
    expect(pattern).toBeNull();
  });

  it("returns null for element with no parent", async () => {
    const { detectPattern } = await import("../src/content/selectors");
    const orphan = document.createElement("button");
    const pattern = detectPattern(orphan);
    expect(pattern).toBeNull();
  });

  it("returns null for non-HTMLElement", async () => {
    const { detectPattern } = await import("../src/content/selectors");
    const textNode = document.createTextNode("hello") as unknown as HTMLElement;
    const pattern = detectPattern(textNode);
    expect(pattern).toBeNull();
  });

  it("generates consistent structure hash for same structure", async () => {
    const { detectPattern } = await import("../src/content/selectors");
    const ul1 = document.createElement("ul");
    ul1.id = "a";
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      ul1.appendChild(li);
    }
    document.body.appendChild(ul1);
    const target1 = ul1.children[0] as HTMLElement;
    const p1 = detectPattern(target1);

    const ul2 = document.createElement("ul");
    ul2.id = "b";
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      ul2.appendChild(li);
    }
    document.body.appendChild(ul2);
    const target2 = ul2.children[0] as HTMLElement;
    const p2 = detectPattern(target2);

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    // Same structure → same hash prefix (li-3-)
    expect(p1!.structureHash).toBe(p2!.structureHash);
  });
});
