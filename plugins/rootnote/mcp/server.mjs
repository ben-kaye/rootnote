#!/usr/bin/env node
import readline from "node:readline";
import * as core from "../src/core.mjs";
const tools = {
  init: core.init,
  index: core.index,
  get: core.get,
  search: core.search,
  traverse: core.traverse,
  neighbors: core.neighbors,
  validate: core.validate,
  doctor: core.doctor,
};
const descriptions = {
  init: "Initialize a vault.",
  index: "Refresh derived index.",
  get: "Get a known node.",
  search: "Lexically search notes.",
  traverse: "Build a bounded context pack.",
  neighbors: "Get explicit graph neighbors.",
  validate: "Validate vault structure and links.",
  doctor: "Report graph health and maintenance suggestions.",
};
const repoRoot = {
  type: "string",
  description: "Absolute path to the repository containing .vault.",
};
const nodeId = {
  type: "string",
  description: "Vault-relative canonical node ID.",
};
const schema = (properties = {}, required = []) => ({
  type: "object",
  properties: { repoRoot, ...properties },
  required: ["repoRoot", ...required],
  additionalProperties: false,
});
const schemas = {
  init: schema(),
  index: schema(),
  get: schema(
    {
      id: {
        ...nodeId,
        description: "Node ID; use an empty string for vault root.",
      },
      depth: {
        anyOf: [{ type: "integer", minimum: 0 }, { const: "full" }],
        default: 0,
      },
    },
    ["id"],
  ),
  search: schema(
    {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    },
    ["query"],
  ),
  traverse: schema(
    {
      query: { type: "string", minLength: 1 },
      starts: { type: "array", items: nodeId, uniqueItems: true },
      mode: {
        type: "string",
        enum: ["answer", "overview", "explore"],
        default: "answer",
      },
      maxChars: { type: "integer", minimum: 0, default: 20000 },
      maxNodes: { type: "integer", minimum: 0, default: 16 },
      maxHops: { type: "integer", minimum: 0, default: 4 },
    },
    ["query"],
  ),
  neighbors: schema({ id: nodeId }, ["id"]),
  validate: schema(),
  doctor: schema(),
};
const envelope = (data, diagnostics = [], refreshed = false) => ({
  ok: true,
  data,
  warnings: data.warnings || [],
  diagnostics,
  provenance: { vault: ".vault" },
  indexState: { refreshed },
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, error) {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error.message,
        data: { code: error.code || "ERROR" },
      },
    }) + "\n",
  );
}
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try {
    const r = (request = JSON.parse(line));
    if (r.method === "initialize")
      return reply(r.id, {
        protocolVersion: r.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rootnote", version: "0.1.0" },
      });
    if (r.method === "notifications/initialized") return;
    if (r.method === "tools/list")
      return reply(r.id, {
        tools: Object.keys(tools).map((name) => ({
          name,
          description: descriptions[name],
          inputSchema: schemas[name],
        })),
      });
    if (r.method === "tools/call") {
      const fn = tools[r.params?.name];
      if (!fn) throw new core.VaultError("Unknown tool", "METHOD_NOT_FOUND");
      const a = r.params.arguments || {};
      if (!a.repoRoot || !process.platform || !a.repoRoot.startsWith("/"))
        throw new core.VaultError(
          "repoRoot must be an absolute path",
          "INVALID_REPO_ROOT",
        );
      const data = await fn(a.repoRoot, a);
      const result = envelope(
        data,
        data.errors || data.diagnostics || [],
        r.params.name === "index",
      );
      return reply(r.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    }
    throw new core.VaultError("Method not found", "METHOD_NOT_FOUND");
  } catch (e) {
    if (request?.method === "tools/call") {
      const result = {
        ok: false,
        data: {},
        warnings: [],
        diagnostics: [{ code: e.code || "ERROR", message: e.message }],
        provenance: { vault: ".vault" },
        indexState: { refreshed: false },
      };
      return reply(request.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: true,
      });
    }
    if (request) fail(request.id, e);
  }
});
