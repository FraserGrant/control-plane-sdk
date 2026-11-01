import { rejects } from "node:assert/strict";
import {
  waitForHealthy,
  restartOwnedService,
  withTemporaryContainer,
} from "@frasergrant/control-plane-sdk/docker";
import { expect, test } from "bun:test";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  Docker,
  type ContainerSpec,
} from "@frasergrant/control-plane-sdk/docker";
import { createOwnership } from "@frasergrant/control-plane-sdk/docker";
import type { DockerRuntimePolicy } from "@frasergrant/control-plane-sdk/docker";
import {
  runtimeChoices,
  runtimeReview,
  readRuntimeInventory,
} from "@frasergrant/control-plane-sdk/docker";
import { DockerStateUpdater } from "@frasergrant/control-plane-sdk/docker";
import { applyState } from "@frasergrant/control-plane-sdk/core";
import type { StateSnapshot } from "@frasergrant/control-plane-sdk/core";

test.skipIf(process.env.RUN_DOCKER_TESTS !== "1")(
  "real Docker target installs and selectively replaces a three-service dependency chain",
  async () => {
    const docker = new Docker();
    await docker.connect();
    const id = `generic-${randomUUID()}`;
    const owner = createOwnership({
      namespace: "com.frasergrant.synthetic",
      namePrefix: "fg-test",
      deploymentId: id,
      setupVersion: 1,
      appVersion: "test",
    });
    const roles = ["front", "worker", "database"];
    const policy: DockerRuntimePolicy = {
      roles,
      resourceName: owner.resourceName,
      isOwned: (labels, role) => owner.isOwned(labels, role),
      setupVersion: 1,
      setupVersionLabel: "com.frasergrant.synthetic.setup-version",
      dependencies: { front: ["worker"], worker: ["database"] },
      sensitiveEnvironment: ["ACCESS_PHRASE"],
    };
    const network = owner.resourceName("link");
    const volume = owner.resourceName("records");
    const imageSource = owner.resourceName("image-source");
    let inheritedImage: string | undefined;
    const specs: Record<string, ContainerSpec> = Object.fromEntries(
      roles.map((role) => [
        role,
        {
          Image: "alpine:3.22",
          Cmd: [
            "sh",
            "-c",
            "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done",
          ],
          Env: ["ACCESS_PHRASE=isolated-synthetic-value", "REGION=east"],
          Labels: owner.labels(role),
          HostConfig: {
            Memory: 67_108_864,
            NanoCpus: 100_000_000,
            RestartPolicy: { Name: "no" },
            Mounts:
              role === "database"
                ? [{ Type: "volume", Source: volume, Target: "/records" }]
                : [],
          },
          NetworkingConfig: {
            EndpointsConfig: { [network]: { Aliases: [role] } },
          },
        },
      ]),
    );
    let baseline: StateSnapshot | undefined;
    const repository = {
      load: () => Promise.resolve(baseline),
      save: (value: StateSnapshot) => {
        baseline = value;
        return Promise.resolve();
      },
    };
    const ready: string[] = [];
    async function apply() {
      const review = runtimeReview(
        await readRuntimeInventory(docker, policy),
        specs,
        "isolated-hmac",
        baseline,
        policy,
      );
      const updater = new DockerStateUpdater(
        docker,
        policy,
        specs,
        review,
        "isolated-hmac",
        {
          prepare: () => Promise.resolve(),
          ready: () => Promise.resolve(),
          serviceReady: async (role) => {
            const container = await docker.runtime(owner.resourceName(role));
            if (!container?.State.Running)
              throw new Error(`Service ${role} did not start.`);
            ready.push(role);
          },
        },
      );
      return applyState(
        review.model,
        repository,
        updater,
        review.desired,
        review.state.revision,
        runtimeChoices(review, {}),
      );
    }
    try {
      await docker.ensureImage("alpine:3.22");
      await docker.create(imageSource, {
        Image: "alpine:3.22",
        Labels: owner.labels("image-source"),
        HostConfig: { NetworkMode: "none" },
      });
      const committed = z.object({ Id: z.string() }).parse(
        await docker.json(
          "POST",
          `/commit?container=${encodeURIComponent(imageSource)}`,
          {
            Labels: owner.labels("inherited-image"),
            Healthcheck: {
              Test: ["CMD", "false"],
              Interval: 1_000_000_000,
              Timeout: 1_000_000_000,
              Retries: 1,
            },
          },
        ),
      );
      inheritedImage = committed.Id;
      const imageResponse = await docker.json(
        "GET",
        `/images/${encodeURIComponent(inheritedImage)}/json`,
      );
      const inheritedHealthcheckSchema = z.object({
        Test: z.array(z.string()),
      });
      const imageSchema = z.object({
        Config: z.object({
          Healthcheck: inheritedHealthcheckSchema,
        }),
      });
      const image = imageSchema.parse(imageResponse);
      expect(image.Config.Healthcheck.Test).toEqual(["CMD", "false"]);
      for (const spec of Object.values(specs)) spec.Image = inheritedImage;

      await docker.json("POST", "/networks/create", {
        Name: network,
        Labels: owner.labels("link"),
      });
      await docker.json("POST", "/volumes/create", {
        Name: volume,
        Labels: owner.labels("records"),
      });
      await apply();
      expect(ready).toEqual(["database", "worker", "front"]);
      const original = await readRuntimeInventory(docker, policy);
      for (const role of roles)
        expect(original[role]?.Config.Healthcheck?.Test).toEqual(["NONE"]);
      await apply();
      const repeated = await readRuntimeInventory(docker, policy);
      expect(repeated.front?.Id).toBe(original.front?.Id);
      await docker.json(
        "POST",
        `/containers/${owner.resourceName("database")}/update`,
        { Memory: 100_663_296 },
      );
      const front = specs.front;
      if (!front) throw new Error("Missing front specification.");
      front.Env = ["ACCESS_PHRASE=isolated-synthetic-value", "REGION=west"];
      const pending = await apply();
      expect(
        pending.changes.find(
          (change) => change.field === "database.memoryBytes",
        )?.kind,
      ).toBe("drift");
      const updated = await readRuntimeInventory(docker, policy);
      expect(updated.front?.Id).not.toBe(original.front?.Id);
      expect(updated.database?.HostConfig.Memory).toBe(100_663_296);
    } finally {
      for (const role of roles) {
        const name = owner.resourceName(role);
        const container = await docker.runtime(name);
        if (!(container && owner.isOwned(container.Config.Labels, role))) {
          continue;
        }

        await docker.stop(name);
        await docker.remove(name);
      }
      const source = await docker.runtime(imageSource);
      if (source && owner.isOwned(source.Config.Labels, "image-source"))
        await docker.remove(imageSource);
      if (inheritedImage)
        await docker.json(
          "DELETE",
          `/images/${encodeURIComponent(inheritedImage)}`,
        );
      const existingVolume = await docker.resource("volumes", volume);
      if (existingVolume && owner.isOwned(existingVolume.Labels, "records"))
        await docker.json("DELETE", `/volumes/${volume}`);
      const existingNetwork = await docker.resource("networks", network);
      if (existingNetwork && owner.isOwned(existingNetwork.Labels, "link"))
        await docker.json("DELETE", `/networks/${network}`);
    }
  },
  60_000,
);

test.skipIf(process.env.RUN_DOCKER_TESTS !== "1")(
  "real temporary helper waits for owned health and cleans up after an archive failure",
  async () => {
    const docker = new Docker();
    await docker.connect();
    const owner = createOwnership({
      namespace: "com.frasergrant.synthetic",
      namePrefix: "fg-test-",
      deploymentId: `helper-${randomUUID()}`,
      setupVersion: 1,
      appVersion: "test",
    });
    const ownership = {
      name: owner.resourceName,
      labels: owner.labels,
      isOwned: owner.isOwned,
      supportsSetup: () => true,
    };
    const name = owner.resourceName("archive");
    await docker.ensureImage("alpine:3.22");
    try {
      await rejects(
        withTemporaryContainer(
          docker,
          name,
          {
            Image: "alpine:3.22",
            Labels: owner.labels("archive"),
            Cmd: ["sh", "-c", "trap 'exit 0' TERM; sleep 120 & wait"],
            Healthcheck: {
              Test: ["CMD", "true"],
              Interval: 1_000_000_000,
              Timeout: 1_000_000_000,
              Retries: 3,
              StartPeriod: 0,
            },
            HostConfig: { NetworkMode: "none" },
          },
          async (identity) => {
            await waitForHealthy(docker, ownership, "archive", {
              attempts: 30,
              intervalMs: 200,
            });
            await restartOwnedService(docker, ownership, "archive", identity);
            const restarted = await docker.inspect(identity);
            expect(restarted?.State.Running).toBe(true);
            throw new Error("synthetic archive failure");
          },
        ),
        /synthetic archive failure/,
      );
      expect(await docker.inspect(name)).toBeUndefined();
    } finally {
      const container = await docker.inspect(name);
      if (container && owner.isOwned(container.Config.Labels, "archive")) {
        await docker.stop(container.Id);
        await docker.remove(container.Id);
      }
    }
  },
  60_000,
);
