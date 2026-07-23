#!/usr/bin/env node
/**
 * build-extension.mjs — produce a PROTECTED distribution build of the Chrome
 * extension for public users, from the readable source in `extension/`.
 *
 * WHY
 * ---
 * The readable `extension/` source is the ADMIN's open copy — it stays in the
 * repo and is NEVER published. Everyone else downloads the protected build this
 * script emits, so the extension can be handed out at scale without shipping the
 * heavily-commented "how it works" source that would let someone (or an AI) clone
 * it cheaply.
 *
 * HONEST SCOPE: client-side code always runs on the user's machine, so this can
 * never make the code *uncopyable* — the browser must read it. What it does is
 * remove every explanatory comment (today's biggest copy aid), minify, and
 * mangle internal (function-local) names. That is strong deterrence, not a vault.
 *
 * SAFETY (why this can't break integrations)
 * -----------------------------------------
 * The transform is deliberately the *provably behaviour-preserving* subset:
 *   - compress:false          → no dead-code elimination, no reordering. Zero
 *                               semantic risk.
 *   - mangle.toplevel:false   → top-level names are PRESERVED. The 8 content
 *                               scripts injected into one isolated world share a
 *                               top-level scope at runtime; preserving those
 *                               names keeps every cross-file reference intact.
 *   - mangle.properties:false → property names are never touched, so chrome.*,
 *                               DOM APIs, message-type strings, selectors and
 *                               every object shape stay identical.
 *   - only comments/whitespace removed + LOCAL variables alpha-renamed.
 * On top of that, every output file is (a) syntax-checked with `node --check`
 * and (b) parsed with acorn to assert its set of TOP-LEVEL binding names is
 * byte-identical to the source's. If any file fails either check the build
 * aborts and emits nothing — so a broken protected build can never ship.
 *
 * OUTPUT
 * ------
 *   extension-dist/   mirror of extension/, JS protected, everything else verbatim
 *   (caller then zips extension-dist/ into public/extensions/…zip)
 *
 * USAGE
 * -----
 *   node scripts/build-extension.mjs      # build + verify → extension-dist/
 *   npm run build:extension                # same, via package.json script
 */
import { promises as fs, existsSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import * as acorn from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "extension-dist");

// The behaviour-preserving terser config. Do NOT enable compress, toplevel
// mangling, or property mangling — see the SAFETY note above.
const TERSER_OPTS = {
  compress: false,
  mangle: { toplevel: false, properties: false },
  format: { comments: false, beautify: false, ecma: 2020 },
  keep_classnames: true,
  sourceMap: false,
};

// Names bound in the PROGRAM (top-level) scope only. These cross file
// boundaries at runtime, so they must survive the transform unchanged.
function topLevelNames(code) {
  const ast = acorn.parse(code, {
    ecmaVersion: 2022,
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
  const names = new Set();
  const addPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case "Identifier": names.add(node.name); break;
      case "ObjectPattern": node.properties.forEach((p) => addPattern(p.value || p.argument)); break;
      case "ArrayPattern": node.elements.forEach((e) => e && addPattern(e)); break;
      case "AssignmentPattern": addPattern(node.left); break;
      case "RestElement": addPattern(node.argument); break;
      default: break;
    }
  };
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id) names.add(node.id.name);
    else if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
    else if (node.type === "VariableDeclaration") node.declarations.forEach((d) => addPattern(d.id));
  }
  return names;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// `node --check` the protected output; throws if the syntax is invalid.
function nodeCheck(code, tag) {
  const tmp = path.join(os.tmpdir(), `lc-check-${tag.replace(/[^a-z0-9]+/gi, "_")}.js`);
  writeFileSync(tmp, code);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } finally {
    try { unlinkSync(tmp); } catch (_) {}
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  if (!existsSync(SRC)) { console.error("No extension/ source dir found."); process.exit(1); }
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const files = await walk(SRC);
  let protectedCount = 0, copiedCount = 0;
  const failures = [];

  for (const srcFile of files) {
    const rel = path.relative(SRC, srcFile);
    const dstFile = path.join(OUT, rel);
    await fs.mkdir(path.dirname(dstFile), { recursive: true });

    if (srcFile.endsWith(".js")) {
      const source = await fs.readFile(srcFile, "utf8");
      let result;
      try {
        result = await minify(source, TERSER_OPTS);
      } catch (e) {
        failures.push(`${rel}: terser error — ${e.message}`);
        continue;
      }
      const code = result.code || "";
      if (!code) { failures.push(`${rel}: empty output`); continue; }

      // (a) syntax must still be valid
      try { nodeCheck(code, rel); }
      catch (e) { failures.push(`${rel}: node --check failed on protected output`); continue; }

      // (b) top-level binding surface must be IDENTICAL (cross-file API intact)
      let srcTop, outTop;
      try { srcTop = topLevelNames(source); outTop = topLevelNames(code); }
      catch (e) { failures.push(`${rel}: parse error during verification — ${e.message}`); continue; }
      if (!setsEqual(srcTop, outTop)) {
        const missing = [...srcTop].filter((n) => !outTop.has(n));
        const extra = [...outTop].filter((n) => !srcTop.has(n));
        failures.push(`${rel}: top-level names changed (missing: ${missing.join(",") || "—"}; extra: ${extra.join(",") || "—"})`);
        continue;
      }

      await fs.writeFile(dstFile, code);
      protectedCount++;
    } else {
      // manifest.json, *.html, *.css, *.png, *.json, *.txt … copied verbatim.
      await fs.copyFile(srcFile, dstFile);
      copiedCount++;
    }
  }

  if (failures.length) {
    console.error("PROTECTED BUILD ABORTED — verification failed:");
    for (const f of failures) console.error("  ✗ " + f);
    await fs.rm(OUT, { recursive: true, force: true });
    process.exit(1);
  }

  console.log(`Protected build OK → ${path.relative(ROOT, OUT)}`);
  console.log(`  ${protectedCount} JS files protected (comments stripped, minified, locals mangled)`);
  console.log(`  ${copiedCount} other files copied verbatim (manifest/html/css/png)`);
  console.log(`  every output passed node --check + top-level-name identity check`);
}

main().catch((e) => { console.error(e); process.exit(1); });
