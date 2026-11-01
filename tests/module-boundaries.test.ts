import { expect, test } from "bun:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

type ImportGraph = ReadonlyMap<string, readonly string[]>;
const reusableRoots = [
  "core/",
  "persistence/",
  "targets/docker/",
  "host/",
  "browser/",
];
const allowedPackages = new Set(["zod", "microdiff"]);

function moduleImports(source: string): string[] {
  const imports: string[] = [];
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      imports.push(
        argument && ts.isStringLiteral(argument)
          ? argument.text
          : "unsupported-dynamic-import",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports;
}

function resolveModule(
  graph: ImportGraph,
  importer: string,
  specifier: string,
): string | undefined {
  const base = path.posix.normalize(
    path.posix.join(
      path.posix.dirname(importer),
      specifier.replace(/\.js$/, ""),
    ),
  );
  return [base, `${base}.ts`, `${base}/index.ts`].find((candidate) =>
    graph.has(candidate),
  );
}

function boundaryViolations(graph: ImportGraph): string[] {
  const violations = new Set<string>();
  const visit = (file: string, chain: readonly string[]): void => {
    const imports = graph.get(file) ?? [];
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) {
        const isBrowserBuiltin =
          (chain[0] ?? file).startsWith("browser/") &&
          specifier.startsWith("node:");
        if (
          isBrowserBuiltin ||
          (!specifier.startsWith("node:") && !allowedPackages.has(specifier))
        )
          violations.add(`${chain.join(" -> ")} -> ${specifier}`);
        continue;
      }
      const dependency = resolveModule(graph, file, specifier);
      if (!dependency) {
        violations.add(`${file}: unresolved ${specifier}`);
        continue;
      }
      const origin = chain[0] ?? file;
      const canUseDocker = origin.startsWith("targets/docker/");
      const canUsePersistence =
        canUseDocker || origin.startsWith("persistence/");
      const canUseHost = origin.startsWith("host/");
      const canUseBrowser = origin.startsWith("browser/");
      const isAllowed =
        dependency.startsWith("core/") ||
        (canUsePersistence && dependency.startsWith("persistence/")) ||
        (canUseDocker && dependency.startsWith("targets/docker/")) ||
        (canUseHost && dependency.startsWith("host/")) ||
        (canUseBrowser && dependency.startsWith("browser/"));
      if (!isAllowed) violations.add(`${chain.join(" -> ")} -> ${dependency}`);
      if (!chain.includes(dependency))
        visit(dependency, [...chain, dependency]);
    }
  };
  for (const file of graph.keys()) {
    if (reusableRoots.some((root) => file.startsWith(root)))
      visit(file, [file]);
  }
  return [...violations].toSorted((left, right) => left.localeCompare(right));
}

test("reusable modules have no application, stack, profile, UI or transport-framework dependencies", async () => {
  const source = path.resolve(import.meta.dir, "../src");
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.ts").scan({ cwd: source }),
  );
  const entries = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(source, file), "utf8");
      return [file, moduleImports(content)] satisfies [string, string[]];
    }),
  );
  expect(boundaryViolations(new Map(entries))).toEqual([]);
});

test("boundary guard follows re-export shims and dynamic imports through neutral helpers", () => {
  const graph: ImportGraph = new Map([
    ["core/index.ts", moduleImports('export * from "../model";')],
    [
      "core/forbidden.ts",
      moduleImports('import "../targets/docker/transport";'),
    ],
    ["model.ts", moduleImports('export * from "./stacks/example/settings";')],
    ["stacks/example/settings.ts", []],
    [
      "targets/docker/transport.ts",
      moduleImports('import { probe } from "./ports";'),
    ],
    [
      "targets/docker/ports.ts",
      moduleImports('export const load = () => import("../../service");'),
    ],
    ["service.ts", moduleImports('import { TRPCError } from "@trpc/server";')],
  ]);
  const violations = boundaryViolations(graph);
  expect(violations).toContain("core/index.ts -> model.ts");
  expect(violations).toContain(
    "core/forbidden.ts -> targets/docker/transport.ts",
  );
  expect(violations).toContain(
    "core/index.ts -> model.ts -> stacks/example/settings.ts",
  );
  expect(violations).toContain(
    "targets/docker/transport.ts -> targets/docker/ports.ts -> service.ts",
  );
  expect(violations).toContain(
    "targets/docker/transport.ts -> targets/docker/ports.ts -> service.ts -> @trpc/server",
  );
});

test("host and browser adapters cannot depend on persistence or Docker", () => {
  const graph: ImportGraph = new Map([
    [
      "host/index.ts",
      moduleImports('export * from "../persistence/file-store.js";'),
    ],
    ["persistence/file-store.ts", []],
    [
      "browser/index.ts",
      moduleImports('export * from "../targets/docker/transport.js";'),
    ],
    ["targets/docker/transport.ts", []],
    ["browser/unsafe.ts", moduleImports('import "node:fs";')],
    ["core/unsafe.ts", moduleImports('import "../host/index.js";')],
  ]);
  const violations = boundaryViolations(graph);
  expect(violations).toContain("host/index.ts -> persistence/file-store.ts");
  expect(violations).toContain(
    "browser/index.ts -> targets/docker/transport.ts",
  );
  expect(violations).toContain("browser/unsafe.ts -> node:fs");
  expect(violations).toContain("core/unsafe.ts -> host/index.ts");
});
