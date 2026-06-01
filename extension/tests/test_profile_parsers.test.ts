import { describe, it, expect } from "vitest";
import {
  parseExperienceItems,
  parseSkillItems,
  parseEducationItems,
  parseCertificationItems,
  parseProjectItems,
  parseSimpleListItems,
} from "../src/behavior/profile-parsers.mjs";

// Golden tests for the pure profile parsers extracted from driver-daemon.mjs.
// These lock current behavior so the de-dup extraction is provably
// behavior-preserving and future refactors can't silently drift.

describe("parseExperienceItems", () => {
  it("maps title/dates/employment_type/company in order (EN)", () => {
    expect(
      parseExperienceItems([
        { paras: ["Senior Engineer", "Jan 2020 - Present", "Full-time", "Acme Corp"], desc: "Built things." },
      ]),
    ).toEqual([
      {
        title: "Senior Engineer",
        company: "Acme Corp",
        employment_type: "Full-time",
        dates: "Jan 2020 - Present",
        duration: "",
        location: "",
        description: "Built things.",
      },
    ]);
  });

  it("recognizes Spanish date + employment labels", () => {
    const [exp] = parseExperienceItems([
      { paras: ["Ingeniero de Software", "ene. 2019 - dic. 2021", "Jornada completa", "Empresa SA"] },
    ]);
    expect(exp.title).toBe("Ingeniero de Software");
    expect(exp.dates).toBe("ene. 2019 - dic. 2021");
    expect(exp.employment_type).toBe("Jornada completa");
    expect(exp.company).toBe("Empresa SA");
    expect(exp.description).toBe("");
  });

  it("skips items with no paragraphs and caps at 12", () => {
    const items = [{ paras: [] }, ...Array.from({ length: 13 }, (_, i) => ({ paras: [`Role ${i}`] }))];
    const out = parseExperienceItems(items);
    expect(out).toHaveLength(12);
    expect(out[0].title).toBe("Role 0");
  });

  it("truncates description to 1500 chars", () => {
    const [exp] = parseExperienceItems([{ paras: ["T"], desc: "x".repeat(2000) }]);
    expect(exp.description).toHaveLength(1500);
  });
});

describe("parseSkillItems", () => {
  it("picks first non-ignored ≤80-char text, dedups, skips section headers", () => {
    expect(
      parseSkillItems([
        { texts: ["Python"] },
        { texts: ["Skills", "JavaScript"] }, // "Skills" is an ignored section header
        { texts: ["Python"] }, // duplicate
      ]),
    ).toEqual(["Python", "JavaScript"]);
  });

  it("skips texts longer than 80 chars", () => {
    expect(parseSkillItems([{ texts: ["x".repeat(90)] }])).toEqual([]);
  });

  it("caps at 50", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ texts: [`Skill${i}`] }));
    expect(parseSkillItems(items)).toHaveLength(50);
  });
});

describe("parseEducationItems", () => {
  it("school first, then degree/field, date detected anywhere", () => {
    expect(parseEducationItems([{ texts: ["MIT", "BSc Computer Science", "2015 - 2019"] }])).toEqual([
      { school: "MIT", degree: "BSc Computer Science", field: "", dates: "2015 - 2019" },
    ]);
    expect(
      parseEducationItems([{ texts: ["Stanford", "Master", "Computer Science", "sep. 2018 - jun. 2020"] }]),
    ).toEqual([{ school: "Stanford", degree: "Master", field: "Computer Science", dates: "sep. 2018 - jun. 2020" }]);
  });

  it("filters ignored section headers before assigning fields", () => {
    expect(parseEducationItems([{ texts: ["Education", "Harvard", "PhD"] }])).toEqual([
      { school: "Harvard", degree: "PhD", field: "", dates: "" },
    ]);
  });
});

describe("parseCertificationItems", () => {
  it("name/issuer/issued with date detection", () => {
    expect(
      parseCertificationItems([{ texts: ["AWS Certified Solutions Architect", "Amazon Web Services", "may. 2021"] }]),
    ).toEqual([{ name: "AWS Certified Solutions Architect", issuer: "Amazon Web Services", issued: "may. 2021" }]);
  });
});

describe("parseProjectItems", () => {
  it("name + date + joined description", () => {
    expect(parseProjectItems([{ texts: ["Project Apollo", "Jan 2022 - Mar 2022", "Built a rocket"] }])).toEqual([
      { name: "Project Apollo", dates: "Jan 2022 - Mar 2022", description: "Built a rocket" },
    ]);
  });

  it("a bare year is not a date range; goes to description", () => {
    expect(parseProjectItems([{ texts: ["P", "2020", "a", "b"] }])).toEqual([
      { name: "P", dates: "", description: "2020 a b" },
    ]);
  });
});

describe("parseSimpleListItems", () => {
  it("dedups, skips ignored headers, respects limit", () => {
    expect(
      parseSimpleListItems([{ texts: ["English"] }, { texts: ["Languages", "Spanish"] }, { texts: ["English"] }]),
    ).toEqual(["English", "Spanish"]);
    expect(parseSimpleListItems([{ texts: ["a"] }, { texts: ["b"] }, { texts: ["c"] }], 2)).toEqual(["a", "b"]);
  });

  it("treats 'open to work' / degree-connection noise as ignored", () => {
    expect(parseSimpleListItems([{ texts: ["open to work", "Jane Doe"] }])).toEqual(["Jane Doe"]);
  });
});
