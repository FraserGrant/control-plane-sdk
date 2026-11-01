import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OperationCoordinator,
  observeSnapshots,
  redactValues,
} from "@frasergrant/control-plane-sdk/core";
import {
  FileStore,
  FileStateRepository,
  validateSharedFolder,
} from "@frasergrant/control-plane-sdk/persistence";
import { authorizeLocalRequest } from "@frasergrant/control-plane-sdk/host";

test("operation scopes reject overlap synchronously and release on success or failure", async () => {
  const notifications: string[] = [];
  const operations = new OperationCoordinator((id) => {
    notifications.push(id);
  });
  const pending = Promise.withResolvers<number>();
  const first = operations.run("first", () => pending.promise);
  expect(operations.isRunning("first")).toBe(true);
  expect(() => operations.run("first", () => Promise.resolve())).toThrow(
    "already running",
  );
  expect(await operations.run("second", () => Promise.resolve(2))).toBe(2);
  pending.resolve(1);
  expect(await first).toBe(1);
  await rejects(
    operations.run("first", () => {
      throw new Error("synthetic failure");
    }),
    /synthetic failure/,
  );
  expect(operations.isRunning("first")).toBe(false);
  expect(notifications).toEqual([
    "first",
    "second",
    "second",
    "first",
    "first",
    "first",
  ]);
});

test("snapshot notifications during a pending read are retained and abort releases the subscriber", async () => {
  const listeners = new Set<() => void>();
  const pending = Promise.withResolvers<number>();
  let reads = 0;
  const controller = new AbortController();
  const stream = observeSnapshots(
    {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      read: () => (++reads === 1 ? pending.promise : Promise.resolve(reads)),
    },
    controller.signal,
  );
  const first = stream.next();
  for (const listener of listeners) {
    listener();
    listener();
  }
  pending.resolve(1);
  const firstResult = await first;
  expect(firstResult.value).toBe(1);
  const nextResult = await stream.next();
  expect(nextResult.value).toBe(2);
  const waiting = stream.next();
  controller.abort();
  const lastResult = await waiting;
  expect(lastResult.done).toBe(true);
  expect(listeners.size).toBe(0);
});

test("snapshot read failures release subscribers", async () => {
  let isSubscribed = false;
  const stream = observeSnapshots({
    subscribe: () => {
      isSubscribed = true;
      return () => {
        isSubscribed = false;
      };
    },
    read: () => Promise.reject(new Error("read failed")),
  });
  await rejects(stream.next(), /read failed/);
  expect(isSubscribed).toBe(false);
});

test("file state repositories validate snapshots and isolate scopes and configurable files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fg-sdk-state-"));
  const store = new FileStore(root);
  const repository = new FileStateRepository(store, "ledger");
  const snapshot = {
    schemaVersion: 3,
    values: { enabled: { present: true, value: false } },
  };
  try {
    expect(await repository.load()).toBeUndefined();
    await repository.save(snapshot);
    expect(await repository.load()).toEqual(snapshot);
    expect(
      await new FileStateRepository(store, "processor").load(),
    ).toBeUndefined();
    expect(
      await new FileStateRepository(store, "ledger", "other.json").load(),
    ).toBeUndefined();
    await store.write("ledger", "infrastructure-state.json", {
      schemaVersion: "broken",
    });
    await rejects(repository.load());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared folders reject roots, unresolved symlinks and ancestors of protected paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fg-sdk-folder-"));
  try {
    const project = path.join(root, "project");
    await mkdir(project);
    await symlink(project, path.join(root, "alias"));
    await validateSharedFolder(project, [path.join(root, "project-secrets")]);
    await rejects(
      validateSharedFolder(root, [path.join(project, "secrets.json")]),
      /does not contain/,
    );
    await rejects(
      validateSharedFolder(path.join(root, "alias")),
      /resolved shared-folder path/,
    );
    await rejects(validateSharedFolder("/"), /filesystem root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const request = (
  headers: Record<string, string>,
  url = "http://127.0.0.1:7331/trpc",
) => new Request(url, { headers });

test("local authentication requires a loopback host, token and matching origin", () => {
  const headers = {
    host: "127.0.0.1:7331",
    authorization: "Bearer private-token",
  };
  authorizeLocalRequest(request(headers), "private-token");
  authorizeLocalRequest(
    request({ ...headers, origin: "http://127.0.0.1:7331" }),
    "private-token",
  );
  expect(() => {
    authorizeLocalRequest(
      request({ ...headers, host: "attacker.example" }),
      "private-token",
    );
  }).toThrow("Invalid host");
  expect(() => {
    authorizeLocalRequest(
      request(headers, "http://attacker.example/trpc"),
      "private-token",
    );
  }).toThrow("Invalid host");
  expect(() => {
    authorizeLocalRequest(
      request({ ...headers, authorization: "Bearer wrong" }),
      "private-token",
    );
  }).toThrow("launch URL");
  expect(() => {
    authorizeLocalRequest(
      request({ ...headers, origin: "http://localhost:7331" }),
      "private-token",
    );
  }).toThrow("Cross-origin");
  expect(() => {
    authorizeLocalRequest(
      request({ ...headers, authorization: "Bearer " }),
      "",
    );
  }).toThrow("launch URL");
});

test("redaction uses explicit sensitive values, ignores empties and bounds public text", () => {
  expect(
    redactValues("private-token repeated private-token", ["", "private-token"]),
  ).toBe("[redacted] repeated [redacted]");
  expect(redactValues("abcdef", [], 3)).toBe("abc");
});
