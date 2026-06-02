import { describe, expect, it } from "vitest";
import { defaultEmptyValue, normalizeShape, readExtractShapes, readExtractStrategy, shapeToPrompt, shapeToSchema } from "../driver-shapes.mjs";

describe("driver-shapes", () => {
  it("builds a strict schema for string lists", () => {
    const shape = normalizeShape({ key: "languages", label: "Languages", kind: "string_list", extract_hints: "Extract names only." });
    const schema = shapeToSchema(shape!);

    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        languages: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["languages"],
    });
  });

  it("builds a strict schema for record lists with required keys", () => {
    const shape = normalizeShape({
      key: "projects",
      label: "Projects",
      kind: "record_list",
      item_keys: ["name", "dates", "description"],
    });
    const schema = shapeToSchema(shape!);

    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        projects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              dates: { type: "string" },
              description: { type: "string" },
            },
            required: ["name", "dates", "description"],
          },
        },
      },
      required: ["projects"],
    });
  });

  it("includes extract hints in prompts", () => {
    const shape = normalizeShape({
      key: "skills",
      label: "Skills",
      kind: "string_list",
      extract_hints: "Skip filter tabs.",
    });

    expect(shapeToPrompt(shape!)).toContain("Skip filter tabs.");
  });

  it("reads extract shapes from workflow step methods", () => {
    const shapes = readExtractShapes({
      methods: [{
        kind: "extract_shapes",
        shapes: [
          { key: "about", label: "About", kind: "scalar", item_keys: null, extract_hints: "Summary only." },
        ],
      }],
    });

    expect(shapes).toEqual([{
      key: "about",
      label: "About",
      kind: "scalar",
      item_keys: null,
      extract_hints: "Summary only.",
    }]);
    expect(defaultEmptyValue(shapes[0]!)).toBe("");
  });
});

describe("readExtractStrategy", () => {
  it("defaults to linkedin_profile when no strategy is declared", () => {
    expect(readExtractStrategy({})).toBe("linkedin_profile");
    expect(readExtractStrategy({ methods: [] })).toBe("linkedin_profile");
    expect(readExtractStrategy({ methods: [{ kind: "extract_shapes", shapes: [] }] })).toBe("linkedin_profile");
  });

  it("reads a dedicated extract_strategy method", () => {
    const step = { methods: [{ kind: "extract_strategy", strategy: "generic_schema" }] };
    expect(readExtractStrategy(step)).toBe("generic_schema");
  });

  it("reads a strategy field on the extract_shapes method", () => {
    const step = { methods: [{ kind: "extract_shapes", strategy: "generic_schema", shapes: [] }] };
    expect(readExtractStrategy(step)).toBe("generic_schema");
  });

  it("prefers the dedicated extract_strategy method over the extract_shapes field", () => {
    const step = {
      methods: [
        { kind: "extract_shapes", strategy: "generic_schema", shapes: [] },
        { kind: "extract_strategy", strategy: "linkedin_profile" },
      ],
    };
    expect(readExtractStrategy(step)).toBe("linkedin_profile");
  });

  it("ignores a blank strategy and falls back to the default", () => {
    expect(readExtractStrategy({ methods: [{ kind: "extract_strategy", strategy: "   " }] })).toBe("linkedin_profile");
  });
});
