import { z } from "zod";
import { type Docker, DockerError, type ContainerSpec } from "./transport.js";
import type { DockerRuntimePolicy } from "./policy.js";

import {
  StateModel,
  type StateField,
  type StateSnapshot,
} from "../../core/state/model.js";
import type { StateReader } from "../../core/state/reconciliation.js";

const portSchema = z.strictObject({
  hostIp: z.string(),
  hostPort: z.number().int().min(0).max(65_535),
});
const restartSchema = z.strictObject({
  name: z.string(),
  maximumRetryCount: z.number().int().nonnegative(),
});
export const dockerContainerV1Schema = z.strictObject({
  image: z.string(),
  ports: z.record(z.string(), z.array(portSchema)),
  restartPolicy: restartSchema,
  nanoCpus: z.number().int().nonnegative(),
});
export const dockerContainerStateSchema = dockerContainerV1Schema.extend({
  memoryBytes: z.number().int().nonnegative(),
});
export type DockerContainerState = z.infer<typeof dockerContainerStateSchema>;
export interface DockerInfrastructure {
  containers: Record<string, DockerContainerState | null>;
}

function containerFields(roles: readonly string[]): Record<string, StateField> {
  const fields = new Map<string, StateField>();
  const shape = Object.entries(dockerContainerStateSchema.shape);
  for (const role of roles) {
    for (const [name, value] of shape)
      fields.set(`${role}.${name}`, {
        path: ["containers", role, name],
        value,
      });
  }
  return Object.fromEntries(fields);
}
// Schema 1 tracked image, bindings, restart policy and CPU. Schema 2 adds RAM.
// Advancing the version leaves RAM absent in old history instead of filling 0.
export function createDockerStateModel(roles: readonly string[]): StateModel {
  return new StateModel(2, containerFields(roles), [{ from: 1, to: 2 }]);
}

const labelsSchema = z.record(z.string(), z.string()).nullish();
const bindingSchema = z.object({ HostIp: z.string(), HostPort: z.string() });
const bindingsSchema = z
  .record(z.string(), z.array(bindingSchema).nullable())
  .nullable();
const inspectRestartSchema = z.object({
  Name: z.string(),
  MaximumRetryCount: z.number().int().nonnegative(),
});
const hostConfigSchema = z.object({
  Memory: z.number().int().nonnegative(),
  NanoCpus: z.number().int().nonnegative(),
  RestartPolicy: inspectRestartSchema,
  PortBindings: bindingsSchema,
});
const inspectionSchema = z.object({
  Config: z.object({ Image: z.string(), Labels: labelsSchema }),
  HostConfig: hostConfigSchema,
});

export function normalizePorts(
  bindings: Record<
    string,
    { HostIp: string; HostPort: string }[] | null
  > | null,
): DockerContainerState["ports"] {
  const normalized = new Map<string, DockerContainerState["ports"][string]>();
  const entriesByPort = Object.entries(bindings ?? {});
  const hostPort = z.coerce.number().int().min(0).max(65_535);
  for (const [name, entries] of entriesByPort) {
    const values = (entries ?? []).map((entry) => ({
      hostIp: entry.HostIp || "0.0.0.0",
      hostPort: hostPort.parse(entry.HostPort),
    }));
    values.sort(
      (left, right) =>
        left.hostIp.localeCompare(right.hostIp) ||
        left.hostPort - right.hostPort,
    );
    normalized.set(name, values);
  }
  return Object.fromEntries(normalized);
}

export function desiredDockerState(
  specs: Record<string, ContainerSpec>,
  roles: readonly string[],
): StateSnapshot {
  function state(spec: ContainerSpec): DockerContainerState {
    return dockerContainerStateSchema.parse({
      image: spec.Image,
      ports: normalizePorts(spec.HostConfig.PortBindings ?? null),
      restartPolicy: {
        name: spec.HostConfig.RestartPolicy?.Name ?? "no",
        maximumRetryCount: 0,
      },
      nanoCpus: spec.HostConfig.NanoCpus ?? 0,
      memoryBytes: spec.HostConfig.Memory ?? 0,
    });
  }
  return createDockerStateModel(roles).capture({
    containers: Object.fromEntries(
      roles.map((role) => [role, state(requiredSpec(specs, role))]),
    ),
  });
}

/**
Reads only infrastructure configuration, never environment variables or secrets.
*/
export class DockerStateReader implements StateReader {
  constructor(
    readonly docker: Docker,
    readonly policy: DockerRuntimePolicy,
  ) {}

  private async container(role: string): Promise<DockerContainerState | null> {
    let raw: unknown;
    try {
      raw = await this.docker.json(
        "GET",
        `/containers/${encodeURIComponent(this.policy.resourceName(role))}/json`,
      );
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
    const container = inspectionSchema.parse(raw);
    if (!this.policy.isOwned(container.Config.Labels ?? {}, role))
      throw new Error(
        `Cannot read managed state from an unowned ${role} container.`,
      );
    return dockerContainerStateSchema.parse({
      image: container.Config.Image,
      ports: normalizePorts(container.HostConfig.PortBindings),
      restartPolicy: {
        name: container.HostConfig.RestartPolicy.Name,
        maximumRetryCount: container.HostConfig.RestartPolicy.MaximumRetryCount,
      },
      nanoCpus: container.HostConfig.NanoCpus,
      memoryBytes: container.HostConfig.Memory,
    });
  }

  async read(): Promise<StateSnapshot> {
    const entries = await Promise.all(
      this.policy.roles.map(
        async (role): Promise<[string, DockerContainerState | null]> => [
          role,
          await this.container(role),
        ],
      ),
    );
    return createDockerStateModel(this.policy.roles).capture({
      containers: Object.fromEntries(entries),
    });
  }
}
export function requiredSpec(
  specs: Record<string, ContainerSpec>,
  role: string,
): ContainerSpec {
  const spec = specs[role];
  if (!spec) throw new Error(`Missing specification for ${role}.`);
  return spec;
}
