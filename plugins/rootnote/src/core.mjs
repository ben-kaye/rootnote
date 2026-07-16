import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parseDocument, isAlias, isMap, isScalar, isSeq } from "yaml";
import MarkdownIt from "markdown-it";

export class VaultError extends Error {
  constructor(message, code = "VAULT_ERROR") {
    super(message);
    this.code = code;
  }
}
const sortBy = (a, b) =>
  (Number.isFinite(a.meta.order) ? a.meta.order : Infinity) -
    (Number.isFinite(b.meta.order) ? b.meta.order : Infinity) ||
  a.id.localeCompare(b.id);
const words = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [],
  );
const score = (q, text) => {
  const a = words(q),
    b = words(text);
  return !a.size ? 0 : [...a].filter((x) => b.has(x)).length / a.size;
};
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const strip = (id) => id.replace(/^\/+|\/+$/g, "").normalize("NFC");
const markdown = new MarkdownIt({ html: true, linkify: false });
const FRONTMATTER_FIELDS = new Set([
  "title",
  "summary",
  "order",
  "created",
  "updated",
  "aliases",
  "tags",
  "sources",
]);

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text, error: null };
  const doc = parseDocument(m[1], { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents))
    return {
      meta: {},
      body: text.slice(m[0].length),
      error: doc.errors[0]?.message || "Frontmatter must be a YAML mapping",
    };
  const meta = {}, warnings = [];
  for (const pair of doc.contents.items) {
    if (
      !isScalar(pair.key) ||
      typeof pair.key.value !== "string" ||
      !FRONTMATTER_FIELDS.has(pair.key.value)
    )
      {
        warnings.push({
          type: "unknown-frontmatter-field",
          field: String(pair.key?.value),
          message: `Unknown frontmatter field is preserved: ${String(pair.key?.value)}`,
        });
        continue;
      }
    const key = pair.key.value,
      value = pair.value;
    if (isAlias(value) || value?.anchor)
      return {
        meta,
        body: text.slice(m[0].length),
        error: "YAML aliases and anchors are not supported",
      };
    if (["aliases", "tags", "sources"].includes(key)) {
      if (
        !isSeq(value) ||
        value.items.some(
          (item) => !isScalar(item) || typeof item.value !== "string",
        )
      )
        return {
          meta,
          body: text.slice(m[0].length),
          error: `${key} must be a YAML list of strings`,
        };
      meta[key] = value.items.map((item) => item.value);
    } else {
      if (
        !isScalar(value) ||
        ["object", "undefined"].includes(typeof value.value)
      )
        return {
          meta,
          body: text.slice(m[0].length),
          error: `${key} must be a scalar value`,
        };
      if (
        key === "order" &&
        (typeof value.value !== "number" || !Number.isFinite(value.value))
      )
        return {
          meta,
          body: text.slice(m[0].length),
          error: "order must be a number",
        };
      if (
        key !== "order" &&
        (typeof value.value !== "string" || value.value.includes("\n"))
      )
        return {
          meta,
          body: text.slice(m[0].length),
          error: `${key} must be a string`,
        };
      if (
        ["created", "updated"].includes(key) &&
        !/^\d{4}-\d{2}-\d{2}$/.test(value.value)
      )
        return {
          meta,
          body: text.slice(m[0].length),
          error: `${key} must use YYYY-MM-DD`,
        };
      meta[key] = value.value;
    }
  }
  return { meta, body: text.slice(m[0].length), error: null, warnings };
}
// Wiki links in examples are documentation, not graph relationships.  Keep a
// mask rather than deleting code so link offsets remain usable for safe edits.
function codeMask(text) {
  const masked = new Uint8Array(text.length);
  let fenced = false,
    fence = null;
  for (let start = 0; start < text.length;) {
    const end = text.indexOf("\n", start);
    const lineEnd = end < 0 ? text.length : end + 1;
    const line = text.slice(start, lineEnd);
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m && (!fenced || m[1][0] === fence)) {
      masked.fill(1, start, lineEnd);
      fenced = !fenced;
      fence = fenced ? m[1][0] : null;
      start = lineEnd;
      continue;
    }
    if (fenced) {
      masked.fill(1, start, lineEnd);
      start = lineEnd;
      continue;
    }
    // Inline code may use one or more backticks.  An unmatched delimiter is
    // intentionally treated as literal Markdown.
    for (let i = start; i < lineEnd;) {
      if (text[i] !== "`") {
        i++;
        continue;
      }
      let j = i;
      while (text[j] === "`") j++;
      const ticks = text.slice(i, j);
      const close = text.indexOf(ticks, j);
      if (close < 0 || close >= lineEnd) {
        i = j;
        continue;
      }
      masked.fill(1, i, close + ticks.length);
      i = close + ticks.length;
    }
    start = lineEnd;
  }
  return masked;
}
function contentMask(text) {
  const masked = codeMask(text);
  for (const m of text.matchAll(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g))
    masked.fill(1, m.index, m.index + m[0].length);
  const offsets = [0];
  for (const m of text.matchAll(/\n/g)) offsets.push(m.index + 1);
  for (const token of markdown.parse(text, {}))
    if (token.type === "html_block" && token.map)
      masked.fill(
        1,
        offsets[token.map[0]],
        offsets[token.map[1]] ?? text.length,
      );
  return masked;
}
function slug(text) {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}
function links(body) {
  const masked = contentMask(body),
    out = [];
  for (const m of body.matchAll(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
  )) {
    const start = m.index,
      end = start + m[0].length;
    let eligible = true;
    for (let i = start; i < end; i++)
      if (masked[i]) {
        eligible = false;
        break;
      }
    if (eligible)
      out.push({
        target: strip(m[1]),
        heading: m[2] || null,
        label: m[3] || null,
        raw: m[0],
        start,
        end,
      });
  }
  return out;
}
function headings(body) {
  const masked = contentMask(body),
    counts = new Map();
  return [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)]
    .filter((m) => !masked[m.index])
    .map((m) => {
      const text = m[2].replace(/\s+#+\s*$/, "").trim(),
        base = slug(text),
        count = (counts.get(base) || 0) + 1;
      counts.set(base, count);
      return {
        level: m[1].length,
        text,
        slug: count === 1 ? base : `${base}-${count}`,
        offset: m.index,
      };
    });
}
export function validateId(id) {
  if (
    typeof id !== "string" ||
    !id ||
    id.includes("..") ||
    id.includes("\\") ||
    id.startsWith("/") ||
    !/^[\p{L}\p{N}][\p{L}\p{N}_./-]*$/u.test(id)
  )
    throw new VaultError("Invalid vault-relative node ID", "INVALID_PATH");
  return strip(id);
}

export async function vaultPaths(repoRoot) {
  if (!path.isAbsolute(repoRoot))
    throw new VaultError("repoRoot must be absolute", "INVALID_REPO_ROOT");
  const root = await fs.realpath(repoRoot);
  const vault = path.join(root, ".vault");
  try {
    const real = await fs.realpath(vault);
    if (real !== vault)
      throw new VaultError(
        "Vault symlink escapes repository",
        "SYMLINK_ESCAPE",
      );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { root, vault, state: path.join(root, ".rootnote") };
}
async function lstatSafe(p) {
  try {
    const s = await fs.lstat(p);
    if (s.isSymbolicLink())
      throw new VaultError(`Symlinks are not allowed: ${p}`, "SYMLINK_ESCAPE");
    return s;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function ensureDirectory(root, dir) {
  const relative = path.relative(root, dir);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new VaultError("Path escape", "INVALID_PATH");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const s = await lstatSafe(current);
    if (!s) await fs.mkdir(current);
    else if (!s.isDirectory())
      throw new VaultError(`Expected directory: ${current}`, "INVALID_PATH");
  }
}
async function safeWritableFile(root, file) {
  const relative = path.relative(root, file);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new VaultError("Path escape", "INVALID_PATH");
  await ensureDirectory(root, path.dirname(file));
  const s = await lstatSafe(file);
  if (s && !s.isFile())
    throw new VaultError(`Expected regular file: ${file}`, "INVALID_PATH");
}
async function atomicWrite(root, file, content) {
  await safeWritableFile(root, file);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, file);
}
async function assertSafePath(root, file) {
  const relative = path.relative(root, file);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new VaultError("Path escape", "INVALID_PATH");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!(await lstatSafe(current))) break;
  }
}
async function loadCache(p) {
  const file = path.join(p.state, "cache", "index.json");
  try {
    await assertSafePath(p.root, file);
    const s = await lstatSafe(file);
    if (!s) return null;
    if (!s.isFile())
      throw new VaultError(`Expected regular file: ${file}`, "INVALID_PATH");
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return data?.version === 1 && Array.isArray(data.nodes)
      ? new Map(data.nodes.map((n) => [n.file, n]))
      : null;
  } catch (e) {
    if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
    throw e;
  }
}
async function files(dir) {
  const out = [];
  async function walk(p) {
    for (const e of await fs.readdir(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isSymbolicLink())
        throw new VaultError(
          `Symlinks are not allowed: ${f}`,
          "SYMLINK_ESCAPE",
        );
      if (e.isDirectory()) await walk(f);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(f);
    }
  }
  await walk(dir);
  return out;
}
export async function init(repoRoot) {
  const p = await vaultPaths(repoRoot);
  await ensureDirectory(p.root, p.vault);
  const rootIndex = path.join(p.vault, "_index.md");
  await safeWritableFile(p.root, rootIndex);
  try {
    await fs.access(rootIndex);
  } catch {
    await fs.writeFile(rootIndex, "# Knowledge Vault\n\n");
  }
  await ensureDirectory(p.root, path.join(p.state, "cache"));
  const config = path.join(p.state, "config.json");
  await safeWritableFile(p.root, config);
  try {
    await fs.access(config);
  } catch {
    await fs.writeFile(
      config,
      JSON.stringify(
        { schemaVersion: 1, vaultPath: ".vault", cachePath: ".rootnote/cache" },
        null,
        2,
      ) + "\n",
    );
  }
  const gitignore = path.join(p.root, ".gitignore");
  await safeWritableFile(p.root, gitignore);
  let gi = "";
  try {
    gi = await fs.readFile(gitignore, "utf8");
  } catch {}
  if (!gi.split(/\r?\n/).includes(".rootnote/cache/"))
    await fs.appendFile(
      gitignore,
      `${gi && !gi.endsWith("\n") ? "\n" : ""}.rootnote/cache/\n`,
    );
  return { initialized: true, vault: ".vault" };
}
export async function build(repoRoot, { requireVault = true } = {}) {
  const p = await vaultPaths(repoRoot);
  try {
    await fs.access(path.join(p.vault, "_index.md"));
  } catch {
    if (requireVault)
      throw new VaultError(
        "Unrecognized vault: .vault/_index.md is required",
        "NO_VAULT",
      );
    return { p, nodes: new Map(), errors: [] };
  }
  const nodes = new Map(),
    errors = [],
    warnings = [],
    cached = await loadCache(p);
  for (const file of await files(p.vault)) {
    const rel = path.relative(p.vault, file).replaceAll(path.sep, "/");
    let id;
    if (rel === "_index.md") id = "";
    else if (rel.endsWith("/_index.md")) id = rel.slice(0, -10);
    else id = rel.slice(0, -3);
    try {
      validateId(id || "root");
    } catch (e) {
      errors.push({ type: "invalid-path", file, message: e.message });
      continue;
    }
    const kind =
      rel === "_index.md" || rel.endsWith("/_index.md") ? "composite" : "leaf";
    const stat = await fs.stat(file),
      cachedNode = cached?.get(file);
    const raw =
        cachedNode?.signature?.size === stat.size &&
        cachedNode?.signature?.mtimeMs === stat.mtimeMs &&
        typeof cachedNode.raw === "string"
          ? cachedNode.raw
          : await fs.readFile(file, "utf8"),
      parsed = frontmatter(raw);
    if (parsed.error)
      errors.push({ type: "malformed-frontmatter", id, message: parsed.error });
    warnings.push(...(parsed.warnings || []).map((warning) => ({ ...warning, id })));
    if (nodes.has(id))
      errors.push({
        type: "collision",
        id,
        message: "Leaf and composite share a canonical path",
      });
    nodes.set(id, {
      id,
      kind,
      file,
      path: rel,
      raw,
      body: parsed.body,
      meta: parsed.meta,
      headings: headings(parsed.body),
      links: links(parsed.body),
      children: [],
      backlinks: [],
      parent: null,
      hash: hash(raw),
    });
  }
  for (const n of nodes.values()) {
    if (n.id) {
      const parent = n.id.includes("/")
        ? n.id.slice(0, n.id.lastIndexOf("/"))
        : "";
      if (!nodes.has(parent) || nodes.get(parent).kind !== "composite") {
        errors.push({
          type: "missing-composite-parent",
          id: n.id,
          parent,
          message: `Missing composite parent: ${parent || "root"}`,
        });
        n.parent = null;
      } else {
        n.parent = parent;
        nodes.get(parent).children.push(n.id);
      }
    }
  }
  for (const n of nodes.values()) {
    for (const l of n.links) {
      const target = resolve(nodes, l.target);
      if (target.error)
        errors.push({ type: target.error, source: n.id, target: l.target });
      else if (
        l.heading &&
        !nodes.get(target.id).headings.some((h) => h.slug === slug(l.heading))
      )
        errors.push({
          type: "broken-heading",
          source: n.id,
          target: l.target,
          heading: l.heading,
        });
      else {
        l.resolved = target.id;
        nodes.get(target.id).backlinks.push(n.id);
      }
    }
    for (const source of n.meta.sources || []) {
      const candidate = path.resolve(p.root, source);
      if (
        path.relative(p.root, candidate).startsWith("..") ||
        path.isAbsolute(source)
      )
        errors.push({ type: "source-path-escape", id: n.id, source });
      else {
        const s = await lstatSafe(candidate);
        if (!s || !s.isFile())
          errors.push({ type: "missing-source", id: n.id, source });
      }
    }
  }
  for (const n of nodes.values()) {
    n.children.sort((a, b) => sortBy(nodes.get(a), nodes.get(b)));
    n.backlinks.sort();
  }
  return { p, nodes, errors, warnings };
}
function resolve(nodes, target) {
  return nodes.has(target) ? { id: target } : { error: "broken-link" };
}
function publicNode(n, detail = false) {
  return {
    id: n.id,
    kind: n.kind,
    path: n.path,
    title: n.meta.title || n.id.split("/").at(-1) || "Knowledge Vault",
    aliases: n.meta.aliases || [],
    tags: n.meta.tags || [],
    summary: n.meta.summary || "",
    headings: n.headings.map((h) => ({ text: h.text, slug: h.slug })),
    ...(detail ? { body: n.body } : {}),
  };
}
export async function index(repoRoot) {
  const g = await build(repoRoot);
  await ensureDirectory(g.p.root, path.join(g.p.state, "cache"));
  const file = path.join(g.p.state, "cache", "index.json");
  await safeWritableFile(g.p.root, file);
  const data = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodes: await Promise.all(
      [...g.nodes.values()].map(async (n) => {
        const s = await fs.stat(n.file);
        return {
          id: n.id,
          kind: n.kind,
          file: n.file,
          hash: n.hash,
          signature: { size: s.size, mtimeMs: s.mtimeMs },
          raw: n.raw,
          meta: n.meta,
          headings: n.headings,
          links: n.links.map(({ target, heading, label, resolved }) => ({
            target,
            heading,
            label,
            resolved,
          })),
        };
      }),
    ),
  };
  await atomicWrite(g.p.root, file, JSON.stringify(data, null, 2));
  return { nodes: data.nodes.length, errors: g.errors };
}
export async function create(
  repoRoot,
  { id, kind = "leaf", title = "", body = "" } = {},
) {
  id = validateId(id);
  if (!["leaf", "composite"].includes(kind))
    throw new VaultError("kind must be leaf or composite");
  const g = await build(repoRoot);
  if (g.nodes.has(id)) throw new VaultError("Node already exists", "COLLISION");
  const parts = id.split("/");
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join("/");
    if (g.nodes.has(ancestor)) {
      if (g.nodes.get(ancestor).kind !== "composite")
        throw new VaultError(
          `Ancestor is not composite: ${ancestor}`,
          "INVALID_HIERARCHY",
        );
      continue;
    }
    const ancestorFile = path.join(g.p.vault, ancestor, "_index.md");
    await safeWritableFile(g.p.root, ancestorFile);
    await fs.writeFile(ancestorFile, `# ${parts[i - 1]}\n\n`);
    g.nodes.set(ancestor, { kind: "composite" });
  }
  const file = path.join(
    g.p.vault,
    kind === "leaf" ? `${id}.md` : id,
    kind === "leaf" ? "" : "_index.md",
  );
  await safeWritableFile(g.p.root, file);
  try {
    await fs.access(file);
    throw new VaultError(
      "Destination already exists; overwrites are refused",
      "COLLISION",
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fs.writeFile(
    file,
    `${title ? `---\ntitle: ${title}\n---\n` : ""}# ${title || id.split("/").at(-1)}\n\n${body}`,
  );
  return { created: id, kind, file };
}
export async function get(repoRoot, { id, depth = 0 } = {}) {
  const g = await build(repoRoot);
  id = id === "" ? "" : validateId(id);
  const n = g.nodes.get(id);
  if (!n) throw new VaultError("Node not found", "NOT_FOUND");
  const max = depth === "full" ? Infinity : Number(depth);
  if (!Number.isInteger(max) || max < 0)
    throw new VaultError("depth must be a non-negative integer or full");
  const visit = (x, d) => ({
    ...publicNode(x, true),
    children:
      d < max
        ? x.children.map((c) => visit(g.nodes.get(c), d + 1))
        : x.children,
  });
  return visit(n, 0);
}
export async function search(repoRoot, { query, limit = 10 } = {}) {
  if (!query) throw new VaultError("query is required");
  const g = await build(repoRoot);
  return [...g.nodes.values()]
    .map((n) => ({
      node: n,
      score: score(
        query,
        `${n.id} ${n.meta.title || ""} ${n.meta.summary || ""} ${n.body}`,
      ),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, limit)
    .map((x) => ({
      ...publicNode(x.node),
      score: x.score,
      snippet: x.node.body.replace(/\s+/g, " ").slice(0, 240),
      ancestors: x.node.id ? x.node.id.split("/").slice(0, -1) : [],
    }));
}
export async function neighbors(repoRoot, { id } = {}) {
  const g = await build(repoRoot);
  const n = g.nodes.get(id === "" ? "" : validateId(id));
  if (!n) throw new VaultError("Node not found", "NOT_FOUND");
  return {
    id: n.id,
    outgoing: n.links.filter((l) => l.resolved).map((l) => l.resolved),
    backlinks: n.backlinks,
    parent: n.parent,
    children: n.children,
  };
}
function excerpt(n, query) {
  if (n.kind === "composite") return n.body.slice(0, 2500);
  if (n.body.length <= 3000) return n.body;
  const hs = n.headings.find((h) => score(query, h.text) > 0);
  return hs ? n.body.slice(hs.offset, hs.offset + 3000) : n.body.slice(0, 3000);
}
export async function traverse(
  repoRoot,
  {
    query,
    starts,
    mode = "answer",
    maxChars = 20000,
    maxNodes = 16,
    maxHops = 4,
  } = {},
) {
  if (!query || !["answer", "overview", "explore"].includes(mode))
    throw new VaultError("query and valid mode are required");
  for (const [name, value] of Object.entries({ maxChars, maxNodes, maxHops }))
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 0)
      throw new VaultError(
        `${name} must be a non-negative integer`,
        "INVALID_LIMIT",
      );
  maxChars = Number(maxChars);
  maxNodes = Number(maxNodes);
  maxHops = Number(maxHops);
  const g = await build(repoRoot);
  let seeds = (starts || [])
    .map((id) => g.nodes.get(validateId(id)))
    .filter(Boolean);
  if (!seeds.length)
    seeds = (await search(repoRoot, { query, limit: 3 })).map((x) =>
      g.nodes.get(x.id),
    );
  // The rank is a documented lexicographic tuple, not tuned percentage
  // weights. Its components are relevance [0,1], relationship priority
  // [1,4], hop distance [0,+∞), duplicate penalty [0,+∞), and canonical ID.
  // Evaluation fixtures can later revise relationship priorities without
  // changing the ordering contract.
  const relationshipPriority = {
      answer: { seed: 4, outgoing: 4, backlink: 3, child: 2, parent: 1 },
      overview: { seed: 4, child: 4, parent: 3, outgoing: 2, backlink: 1 },
      explore: { seed: 4, outgoing: 4, backlink: 3, child: 2, parent: 1 },
    }[mode],
    seen = new Set(),
    frontier = seeds.map((n) => ({
      n,
      hop: 0,
      reason: "seed",
      authority: 4,
      relevance: score(query, `${n.id} ${n.meta.title || ""} ${n.body}`),
      relationshipPriority: relationshipPriority.seed,
      duplicatePenalty: 0,
    })),
    excerpts = [],
    trace = [];
  let used = 0,
    stopReason = null,
    hitHopLimit = false;
  while (frontier.length && excerpts.length < maxNodes) {
    frontier.sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.relationshipPriority - a.relationshipPriority ||
        a.hop - b.hop ||
        a.duplicatePenalty - b.duplicatePenalty ||
        a.n.id.localeCompare(b.n.id),
    );
    const item = frontier.shift();
    if (seen.has(item.n.id)) continue;
    const text = excerpt(item.n, query);
    const remaining = maxChars - used;
    if (remaining <= 0) {
      frontier.unshift(item);
      stopReason = "character-limit";
      break;
    }
    const selected = text.slice(0, remaining);
    seen.add(item.n.id);
    used += selected.length;
    excerpts.push({
      ...publicNode(item.n),
      excerpt: selected,
      reason: item.reason,
      score: item.relevance,
    });
    if (selected.length < text.length) {
      stopReason = "character-limit";
      break;
    }
    if (item.hop >= maxHops) {
      hitHopLimit = true;
      continue;
    }
    const related = [
      ...item.n.links
        .filter((l) => l.resolved)
        .map((l) => [l.resolved, "outgoing", 4]),
      ...item.n.children.map((x) => [x, "child", 3]),
      ...(item.n.parent !== null ? [[item.n.parent, "parent", 2]] : []),
      ...item.n.backlinks.map((x) => [x, "backlink", 1]),
    ];
    for (const [id, reason, authority] of related)
      if (!seen.has(id)) {
        const n = g.nodes.get(id);
        frontier.push({
          n,
          hop: item.hop + 1,
          reason,
          authority,
          relevance: score(query, `${n.id} ${n.meta.title || ""} ${n.body}`),
          relationshipPriority: relationshipPriority[reason],
          duplicatePenalty: frontier.filter((x) => x.n.id === id).length,
        });
        trace.push({ from: item.n.id, to: id, reason });
      }
  }
  if (!stopReason)
    stopReason =
      excerpts.length >= maxNodes && frontier.length
        ? "node-limit"
        : frontier.length
          ? "node-limit"
          : hitHopLimit
            ? "hop-limit"
            : "frontier-empty";
  return {
    mode,
    query,
    excerpts,
    visitedEdges: trace.filter((e) => seen.has(e.to)),
    omittedFrontier: [
      ...new Set(frontier.filter((x) => !seen.has(x.n.id)).map((x) => x.n.id)),
    ].sort(),
    stopReason,
    errors: g.errors,
  };
}
export async function suggestLinks(repoRoot, { id, limit = 5 } = {}) {
  const g = await build(repoRoot);
  const n = g.nodes.get(validateId(id));
  if (!n) throw new VaultError("Node not found", "NOT_FOUND");
  const linked = new Set(
    n.links.filter((l) => l.resolved).map((l) => l.resolved),
  );
  return [...g.nodes.values()]
    .filter((x) => x.id !== n.id && !linked.has(x.id))
    .map((x) => ({
      id: x.id,
      score: score(
        `${n.id} ${n.meta.title || ""} ${n.body}`,
        `${x.id} ${x.meta.title || ""} ${x.meta.summary || ""}`,
      ),
      reason: "lexical similarity only; not an implicit graph edge",
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
async function related(g, from, to) {
  const n = g.nodes.get(from);
  if (n.links.some((l) => l.resolved === to || l.target === to)) return false;
  const marker = /^## Related\s*$/im,
    link = `[[${to}]]`;
  let out = n.raw;
  const m = marker.exec(out);
  out = m
    ? out.slice(0, m.index + m[0].length) +
      `\n\n- ${link}` +
      out.slice(m.index + m[0].length)
    : `${out.replace(/\s*$/, "")}\n\n## Related\n\n- ${link}\n`;
  await fs.writeFile(n.file, out);
  return true;
}
export async function addLink(repoRoot, { from, to, reciprocal = false } = {}) {
  const g = await build(repoRoot);
  from = validateId(from);
  to = validateId(to);
  if (!g.nodes.has(from) || !g.nodes.has(to))
    throw new VaultError("Both nodes must exist", "NOT_FOUND");
  const changed = [];
  if (await related(g, from, to)) changed.push(from);
  if (reciprocal && (await related(g, to, from))) changed.push(to);
  await index(repoRoot);
  return { from, to, reciprocal, changed };
}
export async function renameNode(repoRoot, { from, to, apply = false } = {}) {
  const g = await build(repoRoot);
  from = validateId(from);
  to = validateId(to);
  const n = g.nodes.get(from);
  if (!n) throw new VaultError("Node not found", "NOT_FOUND");
  if (n.kind === "composite" && (to === from || to.startsWith(`${from}/`)))
    throw new VaultError(
      "A composite cannot be moved into itself or a descendant",
      "INVALID_MOVE",
    );
  if (g.nodes.has(to))
    throw new VaultError(
      "Destination collides with existing node",
      "COLLISION",
    );
  const source = n.file,
    dest = path.join(
      g.p.vault,
      n.kind === "leaf" ? `${to}.md` : to,
      n.kind === "leaf" ? "" : "_index.md",
    );
  await assertSafePath(g.p.root, dest);
  const remap = new Map(
    [...g.nodes.keys()]
      .filter(
        (id) =>
          id === from || (n.kind === "composite" && id.startsWith(`${from}/`)),
      )
      .map((id) => [id, to + id.slice(from.length)]),
  );
  const affected = [...g.nodes.values()]
    .filter((x) => x.links.some((l) => l.resolved && remap.has(l.resolved)))
    .map((x) => x.id);
  const plan = {
    from,
    to,
    source,
    destination: dest,
    affectedNotes: affected,
    linkRewrites: affected.length,
    manualFollowUps: [
      "Plain-text references, raw URLs, and code blocks are intentionally untouched.",
    ],
    apply,
  };
  if (!apply) return plan;
  try {
    await fs.access(n.kind === "leaf" ? dest : path.dirname(dest));
    throw new VaultError("Destination already exists", "COLLISION");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await ensureDirectory(g.p.root, path.dirname(dest));
  const oldDir = n.kind === "composite" ? path.dirname(source) : null,
    newDir = n.kind === "composite" ? path.dirname(dest) : null;
  await fs.rename(
    n.kind === "leaf" ? source : oldDir,
    n.kind === "leaf" ? dest : newDir,
  );
  for (const id of affected) {
    const node = g.nodes.get(id),
      old = node.raw;
    let rewritten = old;
    for (const link of [...node.links].reverse()) {
      const next = link.resolved && remap.get(link.resolved);
      if (next)
        rewritten =
          rewritten.slice(0, link.start) +
          `[[${next}${link.heading ? `#${link.heading}` : ""}${link.label ? `|${link.label}` : ""}]]` +
          rewritten.slice(link.end);
    }
    const file =
      oldDir && node.file.startsWith(oldDir + path.sep)
        ? newDir + node.file.slice(oldDir.length)
        : node.file;
    await fs.writeFile(file, rewritten);
  }
  await index(repoRoot);
  return plan;
}
export async function validate(repoRoot) {
  const g = await build(repoRoot);
  return { valid: !g.errors.length, errors: g.errors, nodes: g.nodes.size };
}
export async function doctor(repoRoot) {
  const g = await build(repoRoot);
  const orphans = [...g.nodes.values()]
    .filter(
      (n) =>
        n.id &&
        !n.backlinks.length &&
        !(
          n.parent !== null &&
          g.nodes.get(n.parent).links.some((link) => link.resolved === n.id)
        ),
    )
    .map((n) => n.id);
  const missingSummaries = [...g.nodes.values()]
    .filter((n) => n.id && !n.meta.summary)
    .map((n) => n.id);
  const oversized = [...g.nodes.values()]
    .filter((n) => n.body.length > 20_000)
    .map((n) => n.id);
  const cache = await loadCache(g.p);
  return {
    nodes: g.nodes.size,
    edges: [...g.nodes.values()].reduce(
      (total, n) => total + n.links.filter((l) => l.resolved).length,
      0,
    ),
    diagnostics: g.errors,
    orphans,
    missingSummaries,
    oversized,
    cache: { present: Boolean(cache), authoritative: false },
    suggestedActions: [
      ...(g.errors.length
        ? ["Run validate and repair reported diagnostics."]
        : []),
      ...(orphans.length
        ? [
            "Review orphaned notes; containment alone does not make them an error.",
          ]
        : []),
      ...(missingSummaries.length
        ? ["Add concise summaries to improve retrieval."]
        : []),
    ],
  };
}
