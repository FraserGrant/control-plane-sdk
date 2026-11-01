import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const consumer = await mkdtemp(path.join(tmpdir(), "fg-sdk-consumer-"));

async function run(commandArguments: string[], cwd: string): Promise<void> {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", ...commandArguments], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await process.exited) !== 0)
    throw new Error(
      `Package verification failed: ${commandArguments.join(" ")}`,
    );
}

try {
  const archive = path.join(consumer, "sdk.tgz");
  await run(["pm", "pack", "--filename", archive, "--quiet"], root);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@frasergrant/control-plane-sdk": `file:${archive}`,
        zod: "^4.3.0",
      },
      devDependencies: { "@types/bun": "^1.4.4" },
    }),
  );
  await run(["install", "--ignore-scripts"], consumer);
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["bun"],
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["consumer.ts"],
    }),
  );
  await writeFile(
    path.join(consumer, "consumer.ts"),
    `import { strict as assert } from "node:assert";
import { z } from "zod";
import { StateModel as RootModel } from "@frasergrant/control-plane-sdk";
import { StateModel as CompiledModel } from "./node_modules/@frasergrant/control-plane-sdk/dist/core/index.js";
import { StateModel, applyState, planState, type StateSnapshot } from "@frasergrant/control-plane-sdk/core";
import { FileStore, FileStateRepository } from "@frasergrant/control-plane-sdk/persistence";
import { authorizeLocalRequest } from "@frasergrant/control-plane-sdk/host";
import { LaunchAuthentication } from "@frasergrant/control-plane-sdk/browser";
import { Docker, createOwnership, defineDockerStack } from "@frasergrant/control-plane-sdk/docker";

assert.equal(RootModel, StateModel);
assert.equal(typeof LaunchAuthentication, "function");
authorizeLocalRequest(new Request("http://127.0.0.1:8080/trpc", { headers: { host: "127.0.0.1:8080", authorization: "Bearer packed-token" }}), "packed-token");
const fields = { image: { path: ["image"], value: z.string() } };
const model = new StateModel(1, fields);
assert.deepEqual(new CompiledModel(1, fields).capture({ image: "old" }), model.capture({ image: "old" }));
const store = new FileStore("./state");
let current = model.capture({ image: "old" });
const repository = {
  load: async () => {
    const value = await store.read("consumer", "baseline.json");
    return value === undefined ? undefined : model.upgrade(value);
  },
  save: (snapshot: StateSnapshot) => store.write("consumer", "baseline.json", snapshot),
};
const adapter = {
  read: () => Promise.resolve(current),
  validate: () => Promise.resolve(),
  apply: () => { current = model.capture({ image: "new" }); return Promise.resolve(); },
};
const persistentRepository = new FileStateRepository(store, "consumer");
await persistentRepository.save(current);
assert.deepEqual(await persistentRepository.load(), current);
await repository.save(current);
const desired = model.capture({ image: "new" });
const review = await planState(model, repository, adapter, desired);
await applyState(model, repository, adapter, desired, review.revision);
assert.deepEqual(await repository.load(), desired);
assert.ok(new Docker("/tmp/unused-sdk-test.sock"));
assert.equal(createOwnership({ namespace: "test", namePrefix: "test-", deploymentId: "consumer", setupVersion: 1, appVersion: "test" }).resourceName("worker"), "test-consumer-worker");
assert.equal(defineDockerStack({ resources: [], dataVolumes: [] }).resources.length, 0);
console.log("Packed SDK consumer: Bun source, compiled JavaScript, types and protected persistence passed.");
`,
  );
  await run(
    [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    consumer,
  );
  await run(["consumer.ts"], consumer);
  const files = await Array.fromAsync(
    new Bun.Glob("**/*").scan({
      cwd: path.join(consumer, "node_modules/@frasergrant/control-plane-sdk"),
    }),
  );
  if (files.some((file) => /^(tests|scripts|\.git)\//.test(file)))
    throw new Error("The package included private development files.");
  for (const file of [
    "src/core/index.ts",
    "dist/core/index.js",
    "dist/core/index.d.ts",
    "src/host/index.ts",
    "src/browser/index.ts",
    "dist/host/index.js",
    "dist/browser/index.js",
    "dist/host/index.d.ts",
    "dist/browser/index.d.ts",
  ])
    if (!files.includes(file))
      throw new Error(`Missing package artifact: ${file}`);
  const entry = await readFile(
    path.join(
      consumer,
      "node_modules/@frasergrant/control-plane-sdk/dist/core/index.js",
    ),
    "utf8",
  );
  if (entry.includes("agent-control-plane"))
    throw new Error("The package contains an application import.");
  // Git dependencies contain source only; do not let compiled files hide a fallback.
  await rm(
    path.join(consumer, "node_modules/@frasergrant/control-plane-sdk/dist"),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(consumer, "source-only.ts"),
    `import { StateModel } from "@frasergrant/control-plane-sdk/core";
import { FileStore, FileStateRepository } from "@frasergrant/control-plane-sdk/persistence";
import { authorizeLocalRequest } from "@frasergrant/control-plane-sdk/host";
import { LaunchAuthentication } from "@frasergrant/control-plane-sdk/browser";
import { Docker } from "@frasergrant/control-plane-sdk/docker";
if ([StateModel, FileStore, FileStateRepository, Docker, authorizeLocalRequest, LaunchAuthentication].some((value) => typeof value !== "function"))
  throw new Error("Source-only SDK exports did not resolve.");
`,
  );
  await run(["source-only.ts"], consumer);
  await writeFile(
    path.join(consumer, "browser.ts"),
    `import { scopeId } from "@frasergrant/control-plane-sdk/persistence";
import { LaunchAuthentication } from "@frasergrant/control-plane-sdk/browser";
console.log(scopeId.parse("browser-consumer"), LaunchAuthentication);
`,
  );
  await run(
    ["build", "browser.ts", "--target", "browser", "--outdir", "browser-dist"],
    consumer,
  );
  console.log(
    "Source-only SDK imports and browser validation bundle passed without dist/.",
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
