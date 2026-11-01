import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  applyState,
  type StateChoices,
} from "@frasergrant/control-plane-sdk/core";
import type { StateSnapshot } from "@frasergrant/control-plane-sdk/core";
import { dependencyOrder } from "@frasergrant/control-plane-sdk/docker";
import {
  readRuntimeInventory,
  runtimeReview,
  runtimeChoices,
} from "@frasergrant/control-plane-sdk/docker";
import { DockerStateUpdater } from "@frasergrant/control-plane-sdk/docker";
import {
  SyntheticDocker,
  syntheticPolicy,
  syntheticSpecifications,
} from "./generic-docker-fixture.js";

function fixture() {
  const docker = new SyntheticDocker();
  let baseline: StateSnapshot | undefined;
  const repository = {
    load: () => Promise.resolve(baseline),
    save: (value: StateSnapshot) => {
      baseline = value;
      return Promise.resolve();
    },
  };
  async function review(specs = syntheticSpecifications()) {
    return runtimeReview(
      await readRuntimeInventory(docker, syntheticPolicy),
      specs,
      "synthetic-hmac",
      baseline,
      syntheticPolicy,
    );
  }
  async function apply(
    specs = syntheticSpecifications(),
    choices: StateChoices = {},
  ) {
    const current = await review(specs);
    const updater = new DockerStateUpdater(
      docker,
      syntheticPolicy,
      specs,
      current,
      "synthetic-hmac",
      {
        prepare: () => Promise.resolve(),
        ready: () => Promise.resolve(),
        serviceReady: (role) => {
          docker.events.push(`ready:${role}`);
          return Promise.resolve();
        },
      },
    );
    return applyState(
      current.model,
      repository,
      updater,
      current.desired,
      current.state.revision,
      runtimeChoices(current, choices),
    );
  }
  return { docker, repository, review, apply };
}

test("different topology installs in dependency/readiness order and repeats without mutations", async () => {
  const f = fixture();
  await f.apply();
  expect(f.docker.events).toEqual([
    "create:synthetic-ledger",
    "start:synthetic-ledger",
    "ready:ledger",
    "create:synthetic-processor",
    "start:synthetic-processor",
    "ready:processor",
    "create:synthetic-portal",
    "start:synthetic-portal",
    "ready:portal",
  ]);
  const baseline = await f.repository.load();
  expect(baseline?.schemaVersion).toBe(3);
  expect(Object.keys(baseline?.values ?? {})).toHaveLength(24);
  f.docker.events.length = 0;
  await f.apply();
  expect(f.docker.events).toEqual([]);
  const ledger = f.docker.get("synthetic-ledger");
  expect(ledger?.Mounts.map((value) => value.Destination)).toEqual([
    "/records",
  ]);
});

test("different topology preserves manual drift during independent replacement and keeps its historical baseline", async () => {
  const f = fixture();
  await f.apply();
  const ledger = f.docker.get("synthetic-ledger");
  if (!ledger) throw new Error("Missing ledger");
  ledger.HostConfig.Memory = 1500;
  ledger.Config.Env.push("LOCAL_OPTION=retained");
  const specs = syntheticSpecifications();
  const portal = specs.portal;
  if (!portal) throw new Error("Missing portal spec");
  portal.Image = "synthetic:two";
  const before = f.docker.get("synthetic-portal")?.Id;
  const review = await f.review(specs);
  expect(
    review.state.changes.find((value) => value.field === "ledger.memoryBytes")
      ?.kind,
  ).toBe("drift");
  await f.apply(specs, { "ledger.memoryBytes": "keep" });
  expect(f.docker.get("synthetic-portal")?.Id).not.toBe(before);
  expect(ledger.HostConfig.Memory).toBe(1500);
  const saved = await f.repository.load();
  expect(saved?.values["ledger.memoryBytes"]).toEqual({
    present: true,
    value: 1000,
  });
  const pending = await f.review(specs);
  expect(
    pending.state.changes.find((value) => value.field === "ledger.memoryBytes")
      ?.kind,
  ).toBe("drift");
});

test("explicit nonheuristic secret names never expose their values in reviews", async () => {
  const f = fixture();
  await f.apply();
  const ledger = f.docker.get("synthetic-ledger");
  if (!ledger) throw new Error("Missing ledger");
  ledger.Config.Env = ledger.Config.Env.map((value) =>
    value.startsWith("ACCESS_PHRASE=")
      ? "ACCESS_PHRASE=manual-private-phrase"
      : value,
  );
  const review = await f.review();
  const serialized = JSON.stringify({
    observed: review.observed,
    desired: review.desired,
    state: review.state,
    baseline: review.baseline,
  });
  expect(serialized).not.toContain("private-fixture-phrase");
  expect(serialized).not.toContain("manual-private-phrase");
  expect(
    JSON.stringify(review.observed.values["ledger.environment"]),
  ).toContain("secret:");
});

test("partial installation does not advance baseline and can be reviewed and retried", async () => {
  const f = fixture();
  f.docker.failCreate = "synthetic-processor";
  await rejects(f.apply(), /creation interrupted/);
  expect(await f.repository.load()).toBeUndefined();
  expect(f.docker.get("synthetic-ledger")).toBeDefined();
  f.docker.failCreate = undefined;
  await f.apply();
  expect(f.docker.containers.size).toBe(3);
  expect(await f.repository.load()).toBeDefined();
});

test("stale review rejects changed Docker configuration before writes", async () => {
  const f = fixture();
  await f.apply();
  const current = await f.review();
  const ledger = f.docker.get("synthetic-ledger");
  if (!ledger) throw new Error("Missing ledger");
  ledger.HostConfig.Memory = 1500;
  const updater = new DockerStateUpdater(
    f.docker,
    syntheticPolicy,
    syntheticSpecifications(),
    current,
    "synthetic-hmac",
    { prepare: () => Promise.resolve(), ready: () => Promise.resolve() },
  );
  f.docker.events.length = 0;
  await rejects(
    applyState(
      current.model,
      f.repository,
      updater,
      current.desired,
      current.state.revision,
    ),
    /changed after review/,
  );
  expect(f.docker.events).toEqual([]);
});

test("dependency graph rejects cycles, unknown dependencies and duplicate IDs", () => {
  expect(dependencyOrder(syntheticPolicy)).toEqual([
    "ledger",
    "processor",
    "portal",
  ]);
  expect(() =>
    dependencyOrder({ ...syntheticPolicy, roles: ["portal", "portal"] }),
  ).toThrow("Duplicate");
  expect(() =>
    dependencyOrder({
      ...syntheticPolicy,
      dependencies: { portal: ["missing"] },
    }),
  ).toThrow("Unknown");
  expect(() =>
    dependencyOrder({
      ...syntheticPolicy,
      dependencies: { portal: ["processor"], processor: ["portal"] },
    }),
  ).toThrow("cycle");
});

test("all declared bindings share the same fixed loopback uniqueness checks", async () => {
  const f = fixture();
  const specs = syntheticSpecifications();
  const ledger = specs.ledger;
  if (!ledger) throw new Error("Missing ledger");
  ledger.HostConfig.PortBindings = {
    "9090/tcp": [{ HostIp: "127.0.0.1", HostPort: "48761" }],
  };
  await rejects(f.apply(specs), /different host port/);
  expect(f.docker.events).toEqual([]);
});

test("readiness failure stops the dependency chain and preserves the baseline", async () => {
  const f = fixture();
  const review = await f.review();
  const updater = new DockerStateUpdater(
    f.docker,
    syntheticPolicy,
    syntheticSpecifications(),
    review,
    "synthetic-hmac",
    {
      prepare: () => Promise.resolve(),
      ready: () => Promise.resolve(),
      serviceReady: () => Promise.reject(new Error("dependency is unhealthy")),
    },
  );
  await rejects(
    applyState(
      review.model,
      f.repository,
      updater,
      review.desired,
      review.state.revision,
      runtimeChoices(review, {}),
    ),
    /dependency is unhealthy/,
  );
  expect(f.docker.get("synthetic-ledger")).toBeDefined();
  expect(f.docker.get("synthetic-processor")).toBeUndefined();
  expect(f.docker.get("synthetic-portal")).toBeUndefined();
  expect(await f.repository.load()).toBeUndefined();
});

test("an interrupted replacement preserves the committed baseline until a reviewed retry verifies all services", async () => {
  const f = fixture();
  await f.apply();
  const baseline = await f.repository.load();
  const specs = syntheticSpecifications();
  for (const role of ["ledger", "processor"]) {
    const spec = specs[role];
    if (!spec) throw new Error("Missing service specification.");
    spec.Image = "synthetic:two";
  }
  f.docker.failCreate = "synthetic-processor";
  await rejects(f.apply(specs), /creation interrupted/);
  expect(await f.repository.load()).toEqual(baseline);
  expect(f.docker.get("synthetic-ledger")?.Config.Image).toBe("synthetic:two");
  expect(f.docker.get("synthetic-processor")).toBeUndefined();
  f.docker.failCreate = undefined;
  await f.apply(specs);
  expect(f.docker.get("synthetic-processor")?.Config.Image).toBe(
    "synthetic:two",
  );
  expect(await f.repository.load()).not.toEqual(baseline);
});

test("fresh Docker creation respects declared execution and host settings", async () => {
  const f = fixture();
  const specs = syntheticSpecifications();
  const portal = specs.portal;
  if (!portal) throw new Error("Missing portal specification.");
  portal.User = "1001";
  portal.Entrypoint = ["/custom-entry"];
  portal.Hostname = "synthetic-front";
  portal.HostConfig.ReadonlyRootfs = true;
  await f.apply(specs);
  const installed = f.docker.get("synthetic-portal");
  expect(installed?.Config.User).toBe("1001");
  expect(installed?.Config.Entrypoint).toEqual(["/custom-entry"]);
  expect(installed?.Config.Hostname).toBe("synthetic-front");
  expect(installed?.HostConfig.ReadonlyRootfs).toBe(true);
});

test("untracked explicit network modes are rejected before any service mutation", async () => {
  for (const mode of [
    "none",
    "host",
    "container:another-service",
    "bridge",
    "synthetic-link",
  ]) {
    const f = fixture();
    const specs = syntheticSpecifications();
    const portal = specs.portal;
    if (!portal) throw new Error("Missing portal specification.");
    portal.HostConfig.NetworkMode = mode;
    if (mode === "none") delete portal.NetworkingConfig;
    await rejects(f.apply(specs), /unsupported explicit NetworkMode/);
    expect(f.docker.events).toEqual([]);
    expect(await f.repository.load()).toBeUndefined();
  }
});

test("implicit and built-in networks are rejected before creating dependencies", async () => {
  for (const network of [undefined, "bridge", "none", "host"]) {
    const f = fixture();
    const specs = syntheticSpecifications();
    const portal = specs.portal;
    if (!portal) throw new Error("Missing portal specification.");
    if (network === undefined) delete portal.NetworkingConfig;
    else
      portal.NetworkingConfig = {
        EndpointsConfig: { [network]: { Aliases: [] } },
      };
    await rejects(f.apply(specs), /must declare named network endpoints/);
    expect(f.docker.events).toEqual([]);
  }
});

test("manual network namespaces block replacement while allowing independent in-place updates", async () => {
  for (const mode of ["none", "host", "container:external", "bridge"]) {
    const f = fixture();
    await f.apply();
    const portal = f.docker.get("synthetic-portal");
    if (!portal) throw new Error("Missing portal.");
    portal.HostConfig.NetworkMode = mode;
    portal.NetworkSettings.Networks = {};
    portal.HostConfig.Memory = 1500;
    const specs = syntheticSpecifications();
    const desired = specs.portal;
    if (!desired) throw new Error("Missing portal specification.");
    desired.Image = "synthetic:two";
    f.docker.events.length = 0;
    await rejects(
      f.apply(specs),
      /Cannot preserve portal options.*network mode/,
    );
    expect(f.docker.events).toEqual([]);
    desired.Image = "synthetic:one";
    await f.apply(specs, {
      "portal.options": "keep",
      "portal.memoryBytes": "apply",
    });
    expect(
      f.docker.events.filter((event) => !event.startsWith("ready:")),
    ).toEqual(["update:synthetic-portal"]);
    expect(portal.HostConfig.NetworkMode).toBe(mode);
    expect(portal.HostConfig.Memory).toBe(1000);
  }
});

test("omitted healthchecks explicitly disable inherited checks without changing null state", async () => {
  const f = fixture();
  await f.apply();
  expect(f.docker.get("synthetic-ledger")?.Config.Healthcheck?.Test).toEqual([
    "NONE",
  ]);
  const review = await f.review();
  expect(JSON.stringify(review.observed.values["ledger.options"])).toContain(
    '"healthcheck":null',
  );
  expect(
    review.state.changes.every((change) => change.kind === "unchanged"),
  ).toBe(true);
});

test("Docker default and bridge aliases preserve actual named endpoints during replacement", async () => {
  for (const mode of ["default", "bridge"]) {
    const f = fixture();
    await f.apply();
    const portal = f.docker.get("synthetic-portal");
    if (!portal) throw new Error("Missing portal.");
    const before = portal.Id;
    portal.HostConfig.NetworkMode = mode;
    const specs = syntheticSpecifications();
    const desired = specs.portal;
    if (!desired) throw new Error("Missing portal specification.");
    desired.Image = "synthetic:two";
    await f.apply(specs);
    const replaced = f.docker.get("synthetic-portal");
    expect(replaced?.Id).not.toBe(before);
    expect(replaced?.HostConfig.NetworkMode).toBe("synthetic-link");
    expect(replaced?.NetworkSettings.Networks).toEqual(
      portal.NetworkSettings.Networks,
    );
  }
});
