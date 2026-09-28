import { ACCEPTED_SCHEMAS, CONFIDENCES, EDGE_KINDS, GATE_TYPES, NODE_ID_PATTERN, NODE_KINDS, ORIGINS, SCHEMA_VERSION } from "./schema.js";

/**
 * JSON Schema (draft 2020-12) for editors and external agents.
 * Structural only — endpoint-kind rules live in validate.ts (EDGE_RULES).
 * schema/graph.schema.json is generated from this; a test guards drift.
 */
export function buildJsonSchema(): Record<string, unknown> {
  const source = {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:discovery-graph:schema:2",
    title: SCHEMA_VERSION,
    type: "object",
    required: ["schema", "meta", "nodes", "edges"],
    properties: {
      schema: { enum: [...ACCEPTED_SCHEMAS] },
      meta: {
        type: "object",
        required: ["name", "root", "generatedAt", "generator", "scannedFiles"],
        properties: {
          name: { type: "string" },
          root: { type: "string" },
          generatedAt: { type: "string" },
          generator: { type: "string" },
          scannedFiles: { type: "array", items: { type: "string" } },
        },
      },
      nodes: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "kind", "label", "origin", "confidence"],
          properties: {
            id: { type: "string", pattern: NODE_ID_PATTERN },
            kind: { enum: [...NODE_KINDS] },
            label: { type: "string", minLength: 1 },
            description: { type: "string" },
            source,
            origin: { enum: [...ORIGINS] },
            confidence: { enum: [...CONFIDENCES] },
            initial: { type: "boolean" },
            terminal: { type: "boolean" },
            parent: { type: "string" },
            criteria: { type: "array", items: { type: "string" } },
            gateType: { enum: [...GATE_TYPES] },
            props: { type: "object" },
          },
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          required: ["from", "to", "kind", "origin", "confidence"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            kind: { enum: [...EDGE_KINDS] },
            label: { type: "string" },
            source,
            origin: { enum: [...ORIGINS] },
            confidence: { enum: [...CONFIDENCES] },
          },
        },
      },
    },
  };
}
