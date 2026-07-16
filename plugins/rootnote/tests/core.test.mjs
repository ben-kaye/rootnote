import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as g from "../src/core.mjs";
const run = promisify(execFile);
function runWithInput(file, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)),
    );
    child.stdin.end(input);
  });
}
async function repo() {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "gk-"));
  await g.init(p);
  return p;
}
test("creates, indexes, searches and follows links", async () => {
  const p = await repo();
  await g.create(p, { id: "product", kind: "composite", title: "Product" });
  await g.create(p, {
    id: "product/vision",
    title: "Vision",
    body: "A focused strategy.",
  });
  await g.addLink(p, { from: "product", to: "product/vision" });
  assert.equal((await g.index(p)).nodes, 3);
  assert.equal(
    (await g.search(p, { query: "strategy" }))[0].id,
    "product/vision",
  );
  assert.deepEqual((await g.neighbors(p, { id: "product" })).outgoing, [
    "product/vision",
  ]);
});
test("requires canonical links and preserves related idempotently", async () => {
  const p = await repo();
  await g.create(p, { id: "a/x" });
  await g.create(p, { id: "b/x" });
  await g.create(p, { id: "origin", body: "[[x]]" });
  assert.equal(
    (await g.validate(p)).errors.some((e) => e.type === "broken-link"),
    true,
  );
  await g.addLink(p, { from: "origin", to: "a/x" });
  await g.addLink(p, { from: "origin", to: "a/x" });
  const raw = await fs.readFile(path.join(p, ".vault", "origin.md"), "utf8");
  assert.equal((raw.match(/\[\[a\/x\]\]/g) || []).length, 1);
});
test("validates YAML frontmatter, sources, fragments, and non-content links", async () => {
  const p = await repo();
  await g.create(p, {
    id: "target",
    body: "## Repeated Heading\n\n## Repeated Heading",
  });
  await g.create(p, {
    id: "source",
    body: "<!-- [[missing]] -->\n<div>[[also-missing]]</div>",
  });
  const source = path.join(p, ".vault", "source.md");
  await fs.writeFile(
    source,
    "---\ntitle: Source\nsources:\n  - missing.ts\n---\n[[target#absent]]",
  );
  const result = await g.validate(p);
  assert.ok(result.errors.some((e) => e.type === "broken-heading"));
  assert.ok(result.errors.some((e) => e.type === "missing-source"));
  await fs.writeFile(source, "---\nunknown: nope\n---\n# Source\n");
  const graph = await g.build(p);
  assert.equal(graph.errors.length, 0);
  assert.ok(
    graph.warnings.some((warning) => warning.type === "unknown-frontmatter-field"),
  );
});
test("initialization preserves an existing configuration and retrieval paths are vault-relative", async () => {
  const p = await repo();
  const config = path.join(p, ".rootnote", "config.json");
  await fs.writeFile(config, '{"schemaVersion":1,"custom":"kept"}\n');
  await g.init(p);
  assert.equal(await fs.readFile(config, "utf8"), '{"schemaVersion":1,"custom":"kept"}\n');
  await g.create(p, { id: "note", body: "retrievable" });
  const result = await g.search(p, { query: "retrievable" });
  assert.equal(result[0].path, "note.md");
});
test("deleting the cache cannot change retrieval results", async () => {
  const p = await repo();
  await g.create(p, { id: "note", body: "durable retrieval" });
  await g.index(p);
  const cached = await g.search(p, { query: "durable" });
  await fs.rm(path.join(p, ".rootnote", "cache"), { recursive: true });
  assert.deepEqual(await g.search(p, { query: "durable" }), cached);
});
test("doctor reports non-authoritative cache and quality signals", async () => {
  const p = await repo();
  await g.create(p, { id: "isolated", body: "x" });
  const result = await g.doctor(p);
  assert.equal(result.cache.authoritative, false);
  assert.ok(result.missingSummaries.includes("isolated"));
});
test("rename is dry-run then rewrites wiki links only", async () => {
  const p = await repo();
  await g.create(p, { id: "old", body: "[[old#Heading|label]] and old" });
  await g.create(p, { id: "source", body: "[[old]] plain old" });
  const dry = await g.renameNode(p, { from: "old", to: "new" });
  assert.equal(dry.apply, false);
  await g.renameNode(p, { from: "old", to: "new", apply: true });
  const raw = await fs.readFile(path.join(p, ".vault", "source.md"), "utf8");
  assert.match(raw, /\[\[new\]\] plain old/);
});
test("composite moves keep descendant links continuous", async () => {
  const p = await repo();
  await g.create(p, { id: "old", kind: "composite" });
  await g.create(p, { id: "old/child", body: "child" });
  await g.create(p, { id: "source", body: "[[old/child]]" });
  await g.renameNode(p, { from: "old", to: "new", apply: true });
  assert.equal(
    (await g.neighbors(p, { id: "source" })).outgoing[0],
    "new/child",
  );
  await assert.rejects(fs.access(path.join(p, ".vault", "old", "child.md")));
});
test("traversal is bounded and provenance rich", async () => {
  const p = await repo();
  await g.create(p, { id: "a", body: "strategy [[b]]" });
  await g.create(p, { id: "b", body: "strategy details" });
  const x = await g.traverse(p, { query: "strategy", maxNodes: 1 });
  assert.equal(x.excerpts.length, 1);
  assert.ok(x.stopReason);
  assert.ok(Array.isArray(x.visitedEdges));
});
test("code examples are neither links nor rename targets", async () => {
  const p = await repo();
  await g.create(p, { id: "old" });
  await g.create(p, {
    id: "source",
    body: "[[old]]\n\n`[[old]]`\n\n```md\n[[old]]\n```",
  });
  assert.deepEqual((await g.neighbors(p, { id: "source" })).outgoing, ["old"]);
  await g.renameNode(p, { from: "old", to: "new", apply: true });
  const raw = await fs.readFile(path.join(p, ".vault", "source.md"), "utf8");
  assert.match(raw, /\[\[new\]\]/);
  assert.match(raw, /`\[\[old\]\]`/);
  assert.match(raw, /```md\n\[\[old\]\]\n```/);
});
test("nested creation supplies composite ancestors and validation detects malformed layouts", async () => {
  const p = await repo();
  await g.create(p, { id: "a/b" });
  assert.equal((await g.get(p, { id: "a" })).kind, "composite");
  await fs.mkdir(path.join(p, ".vault", "orphan"));
  await fs.writeFile(path.join(p, ".vault", "orphan", "child.md"), "# child\n");
  const result = await g.validate(p);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.type === "missing-composite-parent" && e.id === "orphan/child",
    ),
  );
});
test("traversal never exceeds its character budget", async () => {
  const p = await repo();
  await g.create(p, { id: "long", body: "x".repeat(3000) });
  const x = await g.traverse(p, {
    query: "long",
    starts: ["long"],
    maxChars: 100,
  });
  assert.ok(x.excerpts[0].excerpt.length <= 100);
  assert.equal(x.stopReason, "character-limit");
  await assert.rejects(g.traverse(p, { query: "x", maxChars: -1 }), {
    code: "INVALID_LIMIT",
  });
});
test("rename rejects composite self-descendant destinations without creating them", async () => {
  const p = await repo();
  await g.create(p, { id: "old", kind: "composite" });
  await assert.rejects(g.renameNode(p, { from: "old", to: "old/new" }), {
    code: "INVALID_MOVE",
  });
  await assert.rejects(fs.access(path.join(p, ".vault", "old", "new")));
});
test("state and gitignore symlinks cannot escape the repository", async (t) => {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "gk-safe-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gk-outside-"));
  try {
    await fs.symlink(outside, path.join(p, ".rootnote"));
  } catch (e) {
    t.skip(`symlinks unavailable: ${e.code}`);
    return;
  }
  await assert.rejects(g.init(p), { code: "SYMLINK_ESCAPE" });
  await fs.unlink(path.join(p, ".rootnote"));
  await fs.writeFile(path.join(p, ".gitignore"), "");
  await fs.unlink(path.join(p, ".gitignore"));
  await fs.symlink(path.join(outside, "ignored"), path.join(p, ".gitignore"));
  await assert.rejects(g.init(p), { code: "SYMLINK_ESCAPE" });
});
test("CLI accepts positional arguments and keeps JSON opt-in", async () => {
  const p = await repo();
  await g.create(p, { id: "note", body: "retrievable" });
  const cli = path.resolve("src/cli.mjs");
  const json = await run(process.execPath, [cli, "get", "note", "--repoRoot", p, "--json"]);
  assert.equal(JSON.parse(json.stdout).data.id, "note");
  const human = await run(process.execPath, [cli, "get", "note", "--repoRoot", p]);
  assert.match(human.stdout, /^get: ok/m);
});
test("MCP exposes only the planned read-only and setup tools", async () => {
  const server = path.resolve("mcp/server.mjs");
  const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
  const result = await runWithInput(server, input);
  const names = JSON.parse(result.stdout).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "init",
    "index",
    "get",
    "search",
    "traverse",
    "neighbors",
    "validate",
    "doctor",
  ]);
});
test("MCP tool errors use the shared result envelope", async () => {
  const server = path.resolve("mcp/server.mjs");
  const input =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get","arguments":{"repoRoot":"relative","id":"note"}}}\n';
  const result = await runWithInput(server, input);
  const response = JSON.parse(result.stdout).result.structuredContent;
  assert.equal(response.ok, false);
  assert.equal(response.diagnostics[0].code, "INVALID_REPO_ROOT");
});
