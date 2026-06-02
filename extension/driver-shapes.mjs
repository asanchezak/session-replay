export function normalizeShape(rawShape) {
  if (!rawShape || typeof rawShape !== "object") return null;
  const key = String(rawShape.key || "").trim();
  const label = String(rawShape.label || key).trim();
  if (!key || !label) return null;
  const kind = String(rawShape.kind || "scalar");
  return {
    key,
    label,
    kind,
    item_keys: Array.isArray(rawShape.item_keys)
      ? rawShape.item_keys.map((itemKey) => String(itemKey).trim()).filter(Boolean)
      : null,
    extract_hints: rawShape.extract_hints ? String(rawShape.extract_hints).trim() : null,
  };
}

export function readExtractShapes(step) {
  const methods = Array.isArray(step?.methods) ? step.methods : [];
  const entry = methods.find((method) => method && typeof method === "object" && method.kind === "extract_shapes");
  const shapes = Array.isArray(entry?.shapes) ? entry.shapes : [];
  return shapes.map(normalizeShape).filter(Boolean);
}

// Which extract STRATEGY a step asks for: "linkedin_profile" (the default —
// scrapeProfileFull, visiting /details/ subpages with the LinkedIn parsers) or
// "generic_schema" (extract the requested shapes from the CURRENT page's text,
// no subpage navigation, no site-specific structure). Read from a dedicated
// `{kind:"extract_strategy", strategy:"..."}` method, or a `strategy` field on
// the `extract_shapes` method. Unknown/missing → "linkedin_profile" (safe default
// = today's behavior).
export function readExtractStrategy(step) {
  const methods = Array.isArray(step?.methods) ? step.methods : [];
  const stratEntry = methods.find((m) => m && typeof m === "object" && m.kind === "extract_strategy");
  if (stratEntry && typeof stratEntry.strategy === "string" && stratEntry.strategy.trim()) {
    return stratEntry.strategy.trim();
  }
  const shapesEntry = methods.find((m) => m && typeof m === "object" && m.kind === "extract_shapes");
  if (shapesEntry && typeof shapesEntry.strategy === "string" && shapesEntry.strategy.trim()) {
    return shapesEntry.strategy.trim();
  }
  return "linkedin_profile";
}

export function defaultEmptyValue(shape) {
  if (shape.kind === "string_list" || shape.kind === "record_list") return [];
  return "";
}

export function shapeToSchema(shape) {
  if (shape.kind === "string_list") {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        [shape.key]: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: [shape.key],
    };
  }

  if (shape.kind === "record_list") {
    const itemKeys = shape.item_keys?.length ? shape.item_keys : ["value"];
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        [shape.key]: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(itemKeys.map((itemKey) => [itemKey, { type: "string" }])),
            required: itemKeys,
          },
        },
      },
      required: [shape.key],
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      [shape.key]: { type: "string" },
    },
    required: [shape.key],
  };
}

export function shapeToPrompt(shape) {
  const base = {
    scalar: `Extract the ${shape.label} value from this LinkedIn profile section.`,
    string_list: `Extract the ${shape.label} values as a list of strings from this LinkedIn profile section.`,
    record_list: `Extract the ${shape.label} entries as a list of records from this LinkedIn profile section.`,
  }[shape.kind] || `Extract the ${shape.label} value from this LinkedIn profile section.`;

  const detail = shape.kind === "record_list"
    ? ` Include exactly these record keys in every item: ${(shape.item_keys?.length ? shape.item_keys : ["value"]).join(", ")}. Use empty strings when a field is missing.`
    : "";
  const hints = shape.extract_hints ? ` ${shape.extract_hints}` : "";
  return `${base}${detail}${hints} Copy values verbatim. Return strict JSON only.`;
}
