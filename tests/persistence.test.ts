import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStore } from "@frasergrant/control-plane-sdk/persistence";

test("generic protected files isolate scopes and notify after atomic replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fg-file-store-"));
  const store = new FileStore(root);
  let notifications = 0;
  const unsubscribe = store.subscribe("example", () => {
    notifications++;
  });
  try {
    await store.write("example", "state.json", { generation: 1 });
    await store.write("example", "state.json", { generation: 2 });
    expect(await store.read("example", "state.json")).toEqual({
      generation: 2,
    });
    expect(await store.read("another", "state.json")).toBeUndefined();
    expect(await store.scopes()).toEqual(["example"]);
    const directoryStats = await stat(store.directory("example"));
    const fileStats = await stat(
      path.join(store.directory("example"), "state.json"),
    );
    expect(directoryStats.mode & 0o777).toBe(0o700);
    expect(fileStats.mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory("example"))).toEqual(["state.json"]);
    expect(notifications).toBe(2);
    unsubscribe();
    await store.write("example", "state.json", {});
    expect(notifications).toBe(2);
    await rejects(
      store.write("example", "../escaped.json", {}),
      /within their scope/,
    );
    await rejects(
      store.read("example", path.join(root, "outside.json")),
      /within their scope/,
    );
    expect(() => store.directory("../invalid")).toThrow();
  } finally {
    unsubscribe();
    await rm(root, { recursive: true, force: true });
  }
});
