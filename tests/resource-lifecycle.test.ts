import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  type ResourceDefinition,
  validateResourceCatalog,
} from "@frasergrant/control-plane-sdk/core";
import {
  containerSchema,
  resourceSchema,
  type ContainerSpec,
} from "@frasergrant/control-plane-sdk/docker";
import {
  inspectResourceCatalog,
  ensurePersistentResources,
  removalAction,
  removeReviewedResource,
  resourceBlockers,
  reviewResourceRemoval,
  type ResourceOwnership,
} from "@frasergrant/control-plane-sdk/docker";
import {
  backupManifest,
  validateBackupManifest,
  listBackupInventory,
  readBackupSnapshot,
} from "@frasergrant/control-plane-sdk/persistence";
import {
  SyntheticDocker,
  syntheticPolicy,
  syntheticSpecifications,
} from "./generic-docker-fixture.js";

const syntheticResources: ResourceDefinition[] = [
  ...syntheticPolicy.roles.map((role): ResourceDefinition => ({
    kind: "container",
    role,
    ownerRole: role,
    persistence: "ephemeral",
    retention: "remove",
    purpose: "service",
  })),
  {
    kind: "container",
    role: "backup-ledger",
    ownerRole: "backup",
    persistence: "ephemeral",
    retention: "remove",
    purpose: "backup-helper",
  },
  {
    kind: "container",
    role: "restore-ledger",
    ownerRole: "restore",
    persistence: "ephemeral",
    retention: "remove",
    purpose: "restore-helper",
  },
  {
    kind: "network",
    role: "link",
    ownerRole: "link",
    persistence: "ephemeral",
    retention: "remove",
    purpose: "network",
  },
  {
    kind: "volume",
    role: "records",
    ownerRole: "records",
    persistence: "data",
    retention: "retain",
    purpose: "data",
  },
];
const syntheticVolumes = [
  {
    role: "ledger",
    volumeRole: "records",
    archive: "records.tar",
    mountTarget: "/records",
  },
];
const syntheticOwnership: ResourceOwnership = {
  name: (role) => syntheticPolicy.resourceName(role),
  labels: (role) => ({ "fixture.owner": role, "fixture.version": "7" }),
  isOwned: (labels, role) => syntheticPolicy.isOwned(labels, role),
  supportsSetup: (labels) => labels["fixture.version"] === "7",
};

type DockerResource = z.infer<typeof resourceSchema>;

class CatalogDocker extends SyntheticDocker {
  readonly resources = new Map<string, DockerResource>();
  override inspect(name: string) {
    const value = this.get(name);
    return Promise.resolve(value ? containerSchema.parse(value) : undefined);
  }
  override resource(_kind: "networks" | "volumes", name: string) {
    return Promise.resolve(structuredClone(this.resources.get(name)));
  }
  override json(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    if (
      method === "POST" &&
      ["/volumes/create", "/networks/create"].includes(endpoint)
    ) {
      const value = resourceSchema.parse(body);
      this.resources.set(value.Name, value);
      this.events.push(`resource:${value.Name}`);
      return Promise.resolve({});
    }
    if (method === "DELETE") {
      const encodedName = endpoint.slice(endpoint.lastIndexOf("/") + 1);
      this.resources.delete(decodeURIComponent(encodedName));
      return Promise.resolve({});
    }
    return super.json(method, endpoint, body);
  }
}

const scenarios = [
  {
    name: "three-service fixture",
    resources: syntheticResources,
    volumes: syntheticVolumes,
    ownership: syntheticOwnership,
  },
];
for (const scenario of scenarios) {
  test(`${scenario.name} uses the shared catalog for resource creation and reviewed retention`, async () => {
    validateResourceCatalog(scenario.resources, scenario.volumes);
    const docker = new CatalogDocker();
    await ensurePersistentResources(
      docker,
      scenario.resources,
      scenario.ownership,
    );
    const creations = [...docker.events];
    await ensurePersistentResources(
      docker,
      scenario.resources,
      scenario.ownership,
    );
    expect(docker.events).toEqual(creations);
    const template = Object.values(syntheticSpecifications())[0];
    if (!template) throw new Error("Missing fixture specification.");
    for (const entry of scenario.resources) {
      if (entry.kind !== "container") continue;
      const spec: ContainerSpec = {
        ...template,
        Labels: scenario.ownership.labels(entry.ownerRole),
      };
      await docker.create(scenario.ownership.name(entry.role), spec);
    }
    const foreign = "unrelated-volume";
    docker.resources.set(foreign, { Name: foreign, Labels: {} });
    const reviewed = await inspectResourceCatalog(
      docker,
      scenario.resources,
      scenario.ownership,
    );
    expect(resourceBlockers(reviewed, scenario.ownership)).toEqual([]);
    for (const entry of reviewed) {
      if (removalAction(entry.definition, false) === "remove")
        await removeReviewedResource(docker, entry, scenario.ownership);
    }
    expect(docker.containers.size).toBe(0);
    for (const volume of scenario.volumes)
      expect(
        docker.resources.has(scenario.ownership.name(volume.volumeRole)),
      ).toBe(true);
    const purge = await inspectResourceCatalog(
      docker,
      scenario.resources,
      scenario.ownership,
    );
    for (const entry of purge)
      if (removalAction(entry.definition, true) === "remove")
        await removeReviewedResource(docker, entry, scenario.ownership);
    expect(docker.resources.keys().toArray()).toEqual([foreign]);
  });
}

test("catalog operations refuse changed ownership before deleting and preflight before creating", async () => {
  const docker = new CatalogDocker();
  await ensurePersistentResources(
    docker,
    syntheticResources,
    syntheticOwnership,
  );
  const reviewed = await inspectResourceCatalog(
    docker,
    syntheticResources,
    syntheticOwnership,
  );
  const volume = reviewed.find((entry) => entry.definition.role === "records");
  if (!volume) throw new Error("Missing fixture volume.");
  docker.resources.set(volume.name, { Name: volume.name, Labels: {} });
  await rejects(
    removeReviewedResource(docker, volume, syntheticOwnership),
    /changed during teardown/,
  );
  docker.resources.delete(syntheticOwnership.name("link"));
  const events = [...docker.events];
  await rejects(
    ensurePersistentResources(docker, syntheticResources, syntheticOwnership),
    /unmanaged/,
  );
  expect(docker.events).toEqual(events);
  expect(docker.resources.has(volume.name)).toBe(true);
});

test("backup artifacts follow the selected stack and reject incompatible or aliased archives", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fg-artifacts-"));
  try {
    const backup = path.join(directory, "backups", "snapshot");
    await mkdir(backup, { recursive: true });
    const expected = backupManifest("synthetic", 7, syntheticVolumes);
    await writeFile(
      path.join(backup, "configuration.json"),
      JSON.stringify({
        backupManifest: expected,
        credential: "synthetic-secret",
      }),
    );
    const partial = await listBackupInventory(directory, [
      "configuration.json",
      "records.tar",
    ]);
    expect(partial[0]?.missingFiles).toEqual(["records.tar"]);
    await writeFile(path.join(backup, "records.tar"), "synthetic archive");
    const schema = z.object({
      backupManifest: z.unknown(),
      credential: z.string(),
    });
    const parse = (input: unknown) => {
      const config = schema.parse(input);
      validateBackupManifest(config.backupManifest, expected);
      return config;
    };
    const first = await readBackupSnapshot(
      directory,
      "snapshot",
      syntheticVolumes,
      parse,
    );
    expect(first.archives.ledger).toBe(path.join(backup, "records.tar"));
    const inventory = await listBackupInventory(directory, [
      "configuration.json",
      "records.tar",
    ]);
    expect(inventory[0]?.complete).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain("synthetic-secret");
    await writeFile(path.join(backup, "records.tar"), "changed archive");
    const changed = await readBackupSnapshot(
      directory,
      "snapshot",
      syntheticVolumes,
      parse,
    );
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(() => {
      validateBackupManifest(
        { ...expected, stackId: "another-stack" },
        expected,
      );
    }).toThrow("incompatible");
    const duplicate = {
      ...syntheticVolumes[0],
      role: "processor",
      volumeRole: "records",
      archive: "records.tar",
      mountTarget: "/records",
    };
    await rejects(
      readBackupSnapshot(
        directory,
        "snapshot",
        [...syntheticVolumes, duplicate],
        parse,
      ),
      /unique roles/,
    );
    expect(() => {
      validateResourceCatalog(syntheticResources, [
        ...syntheticVolumes,
        duplicate,
      ]);
    }).toThrow("unique");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removal reviews include retention, configuration freshness and foreign ownership without mutating resources", async () => {
  const docker = new CatalogDocker();
  await ensurePersistentResources(
    docker,
    syntheticResources,
    syntheticOwnership,
  );
  const before = [...docker.events];
  const review = () =>
    reviewResourceRemoval(
      docker,
      syntheticResources,
      syntheticOwnership,
      false,
      { generation: 1 },
    );
  const current = await review();
  expect(
    current.plan.resources.find((resource) => resource.kind === "volume")
      ?.action,
  ).toBe("keep");
  expect(current.plan.blockers).toEqual([]);
  const repeated = await review();
  expect(repeated.plan.revision).toBe(current.plan.revision);
  const changed = await reviewResourceRemoval(
    docker,
    syntheticResources,
    syntheticOwnership,
    false,
    { generation: 2 },
  );
  expect(changed.plan.revision).not.toBe(current.plan.revision);
  const purge = await reviewResourceRemoval(
    docker,
    syntheticResources,
    syntheticOwnership,
    true,
    { generation: 1 },
  );
  expect(purge.plan.revision).not.toBe(current.plan.revision);
  expect(
    purge.plan.resources.every((resource) => resource.action === "remove"),
  ).toBe(true);
  const name = syntheticOwnership.name("records");
  docker.resources.set(name, { Name: name, Labels: {} });
  const foreign = await review();
  expect(foreign.plan.blockers).toContain(
    `Refusing unmanaged resource ${name}.`,
  );
  expect(foreign.plan.revision).not.toBe(current.plan.revision);
  expect(docker.events).toEqual(before);
});
