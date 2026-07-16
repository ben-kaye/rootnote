#!/usr/bin/env node
import * as core from "./core.mjs";
const [command, ...args] = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++)
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    opts[k] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  } else positional.push(args[i]);
if (positional.length) {
  if (["get", "neighbors"].includes(command)) opts.id ??= positional[0];
  if (["search", "traverse"].includes(command)) opts.query ??= positional[0];
}
const repoRoot = opts.repoRoot || process.cwd();
delete opts.repoRoot;
const json = opts.json === true || opts.json === "true";
delete opts.json;
for (const k of ["depth", "limit", "maxChars", "maxNodes", "maxHops"])
  if (opts[k] !== undefined && opts[k] !== "full") opts[k] = Number(opts[k]);
for (const k of ["reciprocal", "apply", "overwrite"])
  if (opts[k] !== undefined) opts[k] = opts[k] === true || opts[k] === "true";
if (opts.starts) opts.starts = String(opts.starts).split(",");
const map = {
  init: core.init,
  index: core.index,
  get: core.get,
  search: core.search,
  traverse: core.traverse,
  neighbors: core.neighbors,
  validate: core.validate,
  doctor: core.doctor,
};
const envelope = (data, diagnostics = [], refreshed = false) => ({
  ok: true,
  data,
  warnings: data.warnings || [],
  diagnostics,
  provenance: { vault: ".vault" },
  indexState: { refreshed },
});
const render = (result) =>
  json
    ? JSON.stringify(result, null, 2)
    : result.ok
      ? `${command}: ok\n${JSON.stringify(result.data, null, 2)}`
      : `${command}: failed\n${result.diagnostics.map((x) => x.message).join("\n")}`;
try {
  if (!map[command]) throw new Error(`Unknown command: ${command}`);
  const data = await map[command](repoRoot, opts);
  console.log(render(envelope(data, data.errors || data.diagnostics || [], command === "index")));
} catch (e) {
  console.error(render({
      ok: false,
      data: {},
      warnings: [],
      diagnostics: [{ code: e.code || "ERROR", message: e.message }],
      provenance: { vault: ".vault" },
      indexState: { refreshed: false },
    }));
  process.exitCode = 1;
}
