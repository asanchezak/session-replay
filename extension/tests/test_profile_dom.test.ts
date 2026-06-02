import { describe, it, expect, beforeEach } from "vitest";
import {
  experienceParasCore,
  sectionListItemsCore,
  subpageTextCore,
} from "../src/behavior/profile-dom.mjs";

// Golden tests for the pure DOM-text extraction cores (the inner bodies of the
// daemon's page.evaluate closures). Run under jsdom — same DOM API the cores see
// inside a real page — so the wrapper/core split is provably behavior-preserving.

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("experienceParasCore", () => {
  it("returns per-<li> paragraphs + a long span as description", () => {
    const longDesc = "d".repeat(50);
    document.body.innerHTML = `<main><ul><li><p>Senior Engineer</p><p>Acme Corp</p><span>${longDesc}</span></li></ul></main>`;
    expect(experienceParasCore()).toEqual([
      { paras: ["Senior Engineer", "Acme Corp"], desc: longDesc },
    ]);
  });

  it("picks the <ul> with the most list text", () => {
    document.body.innerHTML =
      `<main><ul><li><p>x</p></li></ul>` +
      `<ul><li><p>Longer content here</p><p>Second line</p></li></ul></main>`;
    expect(experienceParasCore()).toEqual([
      { paras: ["Longer content here", "Second line"], desc: "" },
    ]);
  });

  it("returns [] when there is no list", () => {
    document.body.innerHTML = `<main><p>nothing</p></main>`;
    expect(experienceParasCore()).toEqual([]);
  });
});

describe("sectionListItemsCore", () => {
  it("collects leaf texts per <li> (no nested <li>)", () => {
    document.body.innerHTML = `<main><ul><li><span>Python</span><span>JavaScript</span></li></ul></main>`;
    expect(sectionListItemsCore()).toEqual([{ texts: ["Python", "JavaScript"] }]);
  });

  it("falls back to section/article blocks when there are no <li>", () => {
    document.body.innerHTML = `<main><section><span>A</span><span>B</span></section></main>`;
    expect(sectionListItemsCore()).toEqual([{ texts: ["A", "B"] }]);
  });
});

describe("subpageTextCore", () => {
  it("strips the section header prefix", () => {
    document.body.innerHTML = `<main>Education Harvard PhD 2015 - 2019</main>`;
    expect(subpageTextCore("education")).toBe("Harvard PhD 2015 - 2019");
  });

  it("returns '' on the empty-state placeholder", () => {
    document.body.innerHTML = `<main>Nothing to see for now</main>`;
    expect(subpageTextCore("skills")).toBe("");
  });

  it("truncates at 'Ad Options' and strips the skills header", () => {
    document.body.innerHTML = `<main>Skills Python Java Ad Options promoted stuff</main>`;
    expect(subpageTextCore("skills")).toBe("Python Java");
  });
});
