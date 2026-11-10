import assert from "node:assert/strict";
import { buildSchema } from "../dist/index.js";

// Explicit native OMP extension; importing the builder performs no OAuth or HTTP.
export default function () {
  const parameters = buildSchema({
    type: "object",
    required: ["fileKey"],
    properties: {
      fileKey: { type: "string", description: "Required file key" },
      label: { type: "string", description: "Optional label" },
      mode: { type: "string", enum: ["brief", "full"], description: "Output mode" },
      enabled: { type: "boolean", description: "Optional flag" },
      scale: { type: "number", description: "Output scale" },
      items: { type: "array", description: "Selected items" },
    },
  });

  assert.equal(parameters.allows({ fileKey: "abc" }), true);
  assert.equal(parameters.allows({ fileKey: "abc", label: "home", mode: "full", enabled: false, scale: 1.5, items: [] }), true);
  assert.equal(parameters.allows({ label: "home" }), false);
  assert.equal(parameters.allows({ fileKey: 123 }), false);
  assert.equal(parameters.allows({ fileKey: "abc", label: null }), false);
  assert.equal(parameters.allows({ fileKey: "abc", label: 123 }), false);
  assert.equal(parameters.allows({ fileKey: "abc", mode: "invalid" }), false);
  assert.equal(parameters.allows({ fileKey: "abc", enabled: "false" }), false);
  assert.equal(parameters.allows({ fileKey: "abc", scale: "1.5" }), false);
  assert.equal(parameters.allows({ fileKey: "abc", items: "not-an-array" }), false);

  const wire = parameters.toJsonSchema();
  assert.deepEqual(wire.required, ["fileKey"]);
}
