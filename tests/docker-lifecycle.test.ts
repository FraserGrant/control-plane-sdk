import { test, expect } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  containerSchema,
  restartOwnedService,
  waitForHealthy,
  withTemporaryContainer,
  type Container,
  type ResourceOwnership,
} from "@frasergrant/control-plane-sdk/docker";
import {
  SyntheticDocker,
  syntheticSpecifications,
} from "./generic-docker-fixture.js";

class InspectionDocker extends SyntheticDocker {
  health: string | undefined;
  override async inspect(name: string): Promise<Container | undefined> {
    const value = await this.runtime(name);
    return value
      ? containerSchema.parse({
          ...value,
          State: {
            ...value.State,
            ...(this.health && { Health: { Status: this.health } }),
          },
        })
      : undefined;
  }
}
const ownership: ResourceOwnership = {
  name: (role) => `synthetic-${role}`,
  labels: (role) => ({ "fixture.owner": role }),
  isOwned: (labels, role) => labels["fixture.owner"] === role,
  supportsSetup: () => true,
};

test("temporary helpers clean up their original identity after success and archive failure", async () => {
  const docker = new InspectionDocker();
  const spec = syntheticSpecifications().ledger;
  if (!spec) throw new Error("Missing fixture");
  expect(
    await withTemporaryContainer(docker, "archive-ledger", spec, (identity) => {
      expect(docker.get(identity)?.State.Running).toBe(true);
      return Promise.resolve("archive-written");
    }),
  ).toBe("archive-written");
  expect(docker.containers.size).toBe(0);
  await rejects(
    withTemporaryContainer(docker, "archive-ledger", spec, () =>
      Promise.reject(new Error("archive failed")),
    ),
    /archive failed/,
  );
  expect(docker.containers.size).toBe(0);
  expect(
    docker.events.filter((event) => event === "remove:archive-ledger"),
  ).toHaveLength(2);
});

test("readiness requires running owned healthy containers and has a bounded timeout", async () => {
  const docker = new InspectionDocker();
  const spec = syntheticSpecifications().ledger;
  if (!spec) throw new Error("Missing fixture");
  await docker.create("synthetic-ledger", spec);
  await rejects(
    waitForHealthy(docker, ownership, "ledger", { attempts: 1, intervalMs: 0 }),
    /did not become healthy/,
  );
  await docker.start("synthetic-ledger");
  await rejects(
    waitForHealthy(docker, ownership, "ledger", { attempts: 1, intervalMs: 0 }),
    /readiness timed out/,
  );
  const container = docker.get("synthetic-ledger");
  if (!container) throw new Error("Missing fixture container");
  docker.health = "healthy";
  await waitForHealthy(docker, ownership, "ledger");
  container.Config.Labels["fixture.owner"] = "another-owner";
  await rejects(waitForHealthy(docker, ownership, "ledger"), /unmanaged/);
});

test("restart checks ownership, supported setup and the reviewed identity before stopping a service", async () => {
  const docker = new InspectionDocker();
  const spec = syntheticSpecifications().ledger;
  if (!spec) throw new Error("Missing fixture");
  const identity = await docker.create("synthetic-ledger", spec);
  await docker.start(identity);
  const before = [...docker.events];
  await rejects(
    restartOwnedService(docker, ownership, "ledger", "stale-id"),
    /Service changed/,
  );
  await rejects(
    restartOwnedService(
      docker,
      { ...ownership, supportsSetup: () => false },
      "ledger",
      identity,
    ),
    /unsupported/,
  );
  const container = docker.get(identity);
  if (!container) throw new Error("Missing fixture");
  container.Config.Labels["fixture.owner"] = "other";
  await rejects(
    restartOwnedService(docker, ownership, "ledger", identity),
    /unmanaged/,
  );
  expect(docker.events).toEqual(before);
  container.Config.Labels["fixture.owner"] = "ledger";
  await restartOwnedService(docker, ownership, "ledger", identity);
  expect(docker.events.slice(-2)).toEqual([
    "stop:synthetic-ledger",
    "start:synthetic-ledger",
  ]);
  expect(docker.get(identity)?.State.Running).toBe(true);
});
