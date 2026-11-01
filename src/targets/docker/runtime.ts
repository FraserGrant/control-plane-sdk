import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { Docker, ContainerSpec } from "./transport.js";
import { dependencyOrder, type DockerRuntimePolicy } from "./policy.js";
import {
  StateModel,
  type StateField,
  type StateSnapshot,
  type StateSlot,
} from "../../core/state/model.js";
import {
  createDockerStateModel,
  normalizePorts,
  requiredSpec,
} from "./reader.js";
import {
  compareState,
  type StatePlan,
  type StateChoices,
  selectedMutations,
} from "../../core/state/reconciliation.js";
import {
  environment,
  healthcheckSchema,
  normalizedHealthcheck,
  type RuntimeContainer,
} from "./inspection.js";

const mountSchema = z.object({
  Type: z.enum(["volume", "bind"]),
  Source: z.string(),
  Target: z.string(),
  ReadOnly: z.boolean(),
});
const aliasesSchema = z.object({ Aliases: z.array(z.string()) });
const networkSchema = z.record(z.string(), aliasesSchema);
export const optionsSchema = z.object({
  healthcheck: healthcheckSchema.nullable(),
  mounts: z.array(mountSchema),
  sharedMemory: z.number().nonnegative(),
  extraHosts: z.array(z.string()),
  networks: networkSchema,
});
export function createRuntimeStateModel(roles: readonly string[]): StateModel {
  const fieldDefinitions: Record<string, StateField> = {
    ...createDockerStateModel(roles).fields,
  };
  for (const role of roles) {
    fieldDefinitions[`${role}.command`] = {
      path: ["containers", role, "command"],
      value: z.array(z.string()),
    };
    fieldDefinitions[`${role}.environment`] = {
      path: ["containers", role, "environment"],
      value: z.record(z.string(), z.string()),
    };
    fieldDefinitions[`${role}.options`] = {
      path: ["containers", role, "options"],
      value: optionsSchema,
    };
  }
  return new StateModel(3, fieldDefinitions, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ]);
}
export type RuntimeInventory = Record<string, RuntimeContainer | undefined>;
export interface RuntimeReview {
  policy: DockerRuntimePolicy;
  model: StateModel;
  inventory: RuntimeInventory;
  baseline: StateSnapshot | undefined;
  observed: StateSnapshot;
  desired: StateSnapshot;
  state: StatePlan;
  scopes: Record<string, string[]>;
}

export function inventoryRevision(inventory: RuntimeInventory): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(inventory)
          .toSorted((left, right) => left.localeCompare(right))
          .map((role) => {
            const value = inventory[role];
            return value
              ? {
                  id: value.Id,
                  config: value.Config,
                  host: value.HostConfig,
                  mounts: value.Mounts.toSorted((left, right) =>
                    left.Destination.localeCompare(right.Destination),
                  ),
                  networks: value.NetworkSettings,
                }
              : null;
          }),
      ),
    )
    .digest("hex");
}

function actualOptions(
  container: RuntimeContainer,
): z.infer<typeof optionsSchema> {
  const mounts = container.Mounts.filter((mount) => mount.Type !== "tmpfs").map(
    (mount) => ({
      Type: mount.Type,
      Source: mount.Type === "volume" ? mount.Name : mount.Source,
      Target: mount.Destination,
      ReadOnly: !mount.RW,
    }),
  );
  const networks = new Map<string, { Aliases: string[] }>();
  const entries = Object.entries(container.NetworkSettings.Networks);
  for (const [name, endpoint] of entries) {
    const aliases = (endpoint.Aliases ?? []).filter(
      (alias) =>
        ![
          container.Name.replace(/^\//, ""),
          container.Id,
          container.Id.slice(0, 12),
        ].includes(alias),
    );
    networks.set(name, {
      Aliases: aliases.toSorted((left, right) => left.localeCompare(right)),
    });
  }
  return optionsSchema.parse({
    healthcheck: normalizedHealthcheck(container.Config.Healthcheck),
    mounts: mounts.toSorted((left, right) =>
      left.Target.localeCompare(right.Target),
    ),
    sharedMemory: container.HostConfig.ShmSize,
    extraHosts: (container.HostConfig.ExtraHosts ?? []).toSorted(
      (left, right) => left.localeCompare(right),
    ),
    networks: Object.fromEntries(networks),
  });
}

function desiredOptions(
  spec: ContainerSpec,
  container: RuntimeContainer | undefined,
  policy: DockerRuntimePolicy,
): z.infer<typeof optionsSchema> {
  const actual = container ? actualOptions(container) : undefined;
  const expectedMounts = spec.HostConfig.Mounts ?? [];
  const destinations = new Set([
    ...(policy.reservedMountTargets ?? []),
    ...expectedMounts.map((mount) => mount.Target),
  ]);
  const mounts = [
    ...(actual?.mounts.filter((mount) => !destinations.has(mount.Target)) ??
      []),
    ...expectedMounts,
  ];
  const networks = {
    ...actual?.networks,
    ...spec.NetworkingConfig?.EndpointsConfig,
  };
  const extraHosts = [
    ...new Set([
      ...(actual?.extraHosts ?? []),
      ...(spec.HostConfig.ExtraHosts ?? []),
    ]),
  ];
  return optionsSchema.parse({
    healthcheck: normalizedHealthcheck(spec.Healthcheck),
    mounts: mounts
      .map((mount) => ({ ...mount, ReadOnly: mount.ReadOnly ?? false }))
      .toSorted((left, right) => left.Target.localeCompare(right.Target)),
    sharedMemory: spec.HostConfig.ShmSize ?? actual?.sharedMemory ?? 67_108_864,
    extraHosts: extraHosts.toSorted((left, right) => left.localeCompare(right)),
    networks,
  });
}

function protectedEnvironment(
  values: Record<string, string>,
  scope: readonly string[],
  key: string,
  sensitive: readonly string[],
): Record<string, string> {
  const entries = Object.entries(values).filter(([name]) =>
    scope.includes(name),
  );
  return Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      sensitive.includes(name) ||
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)
        ? `secret:${createHmac("sha256", key).update(value).digest("hex")}`
        : `value:${value}`,
    ]),
  );
}

function scopeFor(
  role: string,
  spec: ContainerSpec,
  baseline: StateSnapshot | undefined,
): string[] {
  const previous = baseline?.values[`${role}.environment`];
  const oldValues = previous?.present
    ? z.record(z.string(), z.string()).parse(previous.value)
    : {};
  return [
    ...new Set([
      ...Object.keys(environment(spec.Env ?? [])),
      ...Object.keys(oldValues),
    ]),
  ];
}

export async function readRuntimeInventory(
  docker: Docker,
  policy: DockerRuntimePolicy,
): Promise<RuntimeInventory> {
  const roles = dependencyOrder(policy);
  const entries = await Promise.all(
    roles.map(async (role): Promise<[string, RuntimeContainer | undefined]> => [
      role,
      await docker.runtime(policy.resourceName(role)),
    ]),
  );
  const inventory: RuntimeInventory = Object.fromEntries(entries);
  for (const role of roles) {
    const container = inventory[role];
    if (container && !policy.isOwned(container.Config.Labels, role))
      throw new Error(
        `The ${role} container name is already in use by another deployment.`,
      );
  }
  return inventory;
}

export function runtimeReview(
  inventory: RuntimeInventory,
  specs: Record<string, ContainerSpec>,
  secretKey: string,
  baselineInput: StateSnapshot | undefined,
  policy: DockerRuntimePolicy,
): RuntimeReview {
  const roles = dependencyOrder(policy);
  const runtimeStateModel = createRuntimeStateModel(roles);
  const baseline =
    baselineInput === undefined
      ? undefined
      : runtimeStateModel.upgrade(baselineInput);
  const scopes = Object.fromEntries(
    roles.map((role) => [
      role,
      scopeFor(role, requiredSpec(specs, role), baseline),
    ]),
  );
  function desired(role: string): object {
    const spec = requiredSpec(specs, role);
    return {
      image: spec.Image,
      ports: normalizePorts(spec.HostConfig.PortBindings ?? null),
      memoryBytes: spec.HostConfig.Memory ?? 0,
      nanoCpus: spec.HostConfig.NanoCpus ?? 0,
      restartPolicy: {
        name: spec.HostConfig.RestartPolicy?.Name ?? "no",
        maximumRetryCount:
          spec.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0,
      },
      ...(spec.Cmd !== undefined && { command: spec.Cmd }),
      environment: protectedEnvironment(
        environment(spec.Env ?? []),
        scopes[role] ?? [],
        secretKey,
        policy.sensitiveEnvironment ?? [],
      ),
      options: desiredOptions(spec, inventory[role], policy),
    };
  }
  function observed(role: string): object | null {
    const container = inventory[role];
    if (!container) return null;
    return {
      image: container.Config.Image,
      ports: normalizePorts(container.HostConfig.PortBindings),
      memoryBytes: container.HostConfig.Memory,
      nanoCpus: container.HostConfig.NanoCpus,
      restartPolicy: {
        name: container.HostConfig.RestartPolicy.Name,
        maximumRetryCount: container.HostConfig.RestartPolicy.MaximumRetryCount,
      },
      ...(requiredSpec(specs, role).Cmd !== undefined && {
        command: container.Config.Cmd ?? [],
      }),
      environment: protectedEnvironment(
        environment(container.Config.Env),
        scopes[role] ?? [],
        secretKey,
        policy.sensitiveEnvironment ?? [],
      ),
      options: actualOptions(container),
    };
  }
  const desiredState = runtimeStateModel.capture({
    containers: Object.fromEntries(roles.map((role) => [role, desired(role)])),
  });
  const observedState = runtimeStateModel.capture({
    containers: Object.fromEntries(roles.map((role) => [role, observed(role)])),
  });
  return {
    policy,
    model: runtimeStateModel,
    inventory,
    baseline,
    scopes,
    observed: observedState,
    desired: desiredState,
    state: compareState(
      runtimeStateModel,
      baseline,
      observedState,
      desiredState,
    ),
  };
}

export function runtimeChoices(
  review: RuntimeReview,
  input: StateChoices,
): StateChoices {
  const choices = { ...input };
  for (const change of review.state.changes) {
    const role = review.policy.roles.find((value) =>
      change.field.startsWith(`${value}.`),
    );
    if (
      !role ||
      review.inventory[role] !== undefined ||
      change.kind === "unchanged" ||
      change.kind === "released"
    )
      continue;
    if (choices[change.field] === "keep")
      throw new Error(
        `Cannot keep missing ${change.field}; create the service first.`,
      );
    choices[change.field] = "apply";
  }
  return choices;
}

export function effectiveState(
  review: RuntimeReview,
  choices: StateChoices,
): StateSnapshot {
  const values = { ...review.observed.values };
  const mutations = selectedMutations(
    review.state,
    runtimeChoices(review, choices),
  );
  for (const mutation of mutations) values[mutation.field] = mutation.after;
  return { schemaVersion: review.model.version, values };
}

export function stateValue(state: StateSnapshot, field: string): StateSlot {
  const slot = state.values[field];
  if (!slot) throw new Error(`Missing state for ${field}.`);
  return slot;
}
