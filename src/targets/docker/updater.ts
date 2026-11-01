import { z } from "zod";
import type { Docker, ContainerSpec } from "./transport.js";
import { canBind } from "./ports.js";
import { dependencyOrder, type DockerRuntimePolicy } from "./policy.js";
import { dockerContainerStateSchema } from "./reader.js";
import {
  environment,
  preservedConfigSchema,
  preservedHostSchema,
  type RuntimeContainer,
} from "./inspection.js";
import {
  runtimeReview,
  inventoryRevision,
  readRuntimeInventory,
  optionsSchema,
  stateValue,
  type RuntimeReview,
} from "./runtime.js";
import type { StateSnapshot } from "../../core/state/model.js";
import type {
  StateAdapter,
  StateMutation,
} from "../../core/state/reconciliation.js";
import { requiredSpec } from "./reader.js";

export interface UpdateHooks {
  prepare(replacements: readonly string[]): Promise<void>;
  ready(): Promise<void>;
  serviceReady?(role: string): Promise<void>;
}
const replaceFields = new Set([
  "image",
  "ports",
  "command",
  "environment",
  "options",
]);
export function requiresReplacement(field: string): boolean {
  return replaceFields.has(field.split(".", 2)[1] ?? "");
}
function hasValue(value: unknown): boolean {
  if (value === null) return false;
  const emptyValues: readonly unknown[] = [undefined, null, false, "", 0];
  if (emptyValues.includes(value)) return false;
  return Array.isArray(value)
    ? value.some((entry) => hasValue(entry))
    : typeof value !== "object" ||
        Object.values(value).some((entry) => hasValue(entry));
}
function replacementBlockers(container: RuntimeContainer): string[] {
  const hostKnown = new Set([
    ...Object.keys(preservedHostSchema.shape),
    "Memory",
    "NanoCpus",
    "ShmSize",
    "RestartPolicy",
    "PortBindings",
    "ExtraHosts",
    "NetworkMode",
    "Mounts",
    "Binds",
  ]);
  const configKnown = new Set([
    ...Object.keys(preservedConfigSchema.shape),
    "Image",
    "Cmd",
    "Env",
    "Labels",
    "ExposedPorts",
    "Healthcheck",
    "Hostname",
    "Volumes",
  ]);
  const hostUnknown = Object.entries(container.HostConfig)
    .filter(([key, value]) => !hostKnown.has(key) && hasValue(value))
    .map(([key]) => key);
  const configUnknown = Object.entries(container.Config)
    .filter(([key, value]) => !configKnown.has(key) && hasValue(value))
    .map(([key]) => key);
  const configuredMounts = z
    .array(z.record(z.string(), z.json()))
    .parse(container.HostConfig.Mounts ?? []);
  const mountKeys = new Set(["Type", "Source", "Target", "ReadOnly"]);
  const hasCustomMountOptions = configuredMounts.some((mount) =>
    Object.entries(mount).some(
      ([key, value]) => !mountKeys.has(key) && hasValue(value),
    ),
  );
  const isUnsupportedMounts = container.Mounts.some(
    (mount) =>
      mount.Type === "tmpfs" ||
      (!["", "rw", "ro"].includes(mount.Mode) &&
        !(mount.Type === "volume" && mount.Mode === "z")) ||
      !["", "rprivate"].includes(mount.Propagation),
  );
  const isStaticNetworks = Object.values(
    container.NetworkSettings.Networks,
  ).some(
    (endpoint) =>
      endpoint.IPAMConfig !== null && endpoint.IPAMConfig !== undefined,
  );
  const networkMode = container.HostConfig.NetworkMode;
  const attachedNetworks = Object.keys(container.NetworkSettings.Networks);
  const hasOnlyNamedNetworks =
    attachedNetworks.length > 0 &&
    attachedNetworks.every(
      (name) => !["bridge", "host", "none"].includes(name),
    );
  const isSupportedPrimary =
    ["default", "bridge"].includes(networkMode) ||
    attachedNetworks.includes(networkMode);
  const isUnsupportedNetworkMode =
    !hasOnlyNamedNetworks ||
    !isSupportedPrimary ||
    ["host", "none"].includes(networkMode) ||
    networkMode.startsWith("container:");
  return [
    ...hostUnknown,
    ...configUnknown,
    ...(isUnsupportedNetworkMode ? ["network mode"] : []),
    ...(isUnsupportedMounts || hasCustomMountOptions ? ["mount options"] : []),
    ...(isStaticNetworks ? ["static network addresses"] : []),
  ];
}

export class DockerStateUpdater implements StateAdapter {
  private target: StateSnapshot | undefined;
  private replacements: string[] = [];
  private mutations: readonly StateMutation[] = [];
  constructor(
    readonly docker: Docker,
    readonly policy: DockerRuntimePolicy,
    readonly specs: Record<string, ContainerSpec>,
    readonly review: RuntimeReview,
    readonly secretKey: string,
    readonly hooks: UpdateHooks,
  ) {}

  private async guard(role: string): Promise<RuntimeContainer | undefined> {
    const current = await this.docker.runtime(this.policy.resourceName(role));
    const before = this.review.inventory[role];
    const left = { ...this.review.inventory, [role]: current };
    if (inventoryRevision(left) !== inventoryRevision(this.review.inventory))
      throw new Error(
        `The ${role} container changed after review; review the plan again.`,
      );
    if (current && !this.policy.isOwned(current.Config.Labels, role))
      throw new Error(`Refusing to modify unmanaged container ${role}.`);
    if (current?.Id !== before?.Id)
      throw new Error("The reviewed container identity changed.");
    return current;
  }

  private spec(role: string, target: StateSnapshot): ContainerSpec {
    const template = requiredSpec(this.specs, role);
    const current = this.review.inventory[role];
    function value(name: string): unknown {
      const slot = stateValue(target, `${role}.${name}`);
      if (!slot.present)
        throw new Error(`Cannot remove required ${role}.${name}.`);
      return slot.value;
    }
    const image = z.string().parse(value("image"));
    const ports = dockerContainerStateSchema.shape.ports.parse(value("ports"));
    const restart = dockerContainerStateSchema.shape.restartPolicy.parse(
      value("restartPolicy"),
    );
    const options = optionsSchema.parse(value("options"));
    const didSelectEnvironment = this.mutations.some(
      (mutation) => mutation.field === `${role}.environment`,
    );
    const variables = new Map(
      Object.entries(environment(current?.Config.Env ?? [])),
    );
    if (didSelectEnvironment || !current) {
      const scope = this.review.scopes[role] ?? [];
      for (const key of scope) variables.delete(key);
      const templateEntries = Object.entries(environment(template.Env ?? []));
      for (const [key, entry] of templateEntries) variables.set(key, entry);
    }
    const command = stateValue(target, `${role}.command`);
    const preserved = preservedConfigSchema.parse(
      current ? current.Config : template,
    );
    const { Entrypoint: entrypoint, User: user, ...config } = preserved;
    const host = preservedHostSchema.parse(
      current ? current.HostConfig : template.HostConfig,
    );
    const networks = options.networks;
    const primary = current?.HostConfig.NetworkMode;
    const networkMode =
      primary && Object.hasOwn(networks, primary)
        ? primary
        : Object.keys(networks)[0];
    const commandOptions: Pick<ContainerSpec, "Cmd"> = {};
    if (command.present)
      commandOptions.Cmd = z.array(z.string()).parse(command.value);
    else if (current?.Config.Cmd) commandOptions.Cmd = current.Config.Cmd;
    return {
      ...config,
      ...(current &&
        current.Config.Hostname !== current.Id.slice(0, 12) && {
          Hostname: current.Config.Hostname,
        }),
      ...(!current &&
        template.Hostname !== undefined && { Hostname: template.Hostname }),
      ...(user !== undefined && { User: user }),
      ...(entrypoint && { Entrypoint: entrypoint }),
      Image: image,
      ...commandOptions,
      Env: [...variables].map(([key, entry]) => `${key}=${entry}`),
      Labels: { ...current?.Config.Labels, ...template.Labels },
      ExposedPorts: {
        ...current?.Config.ExposedPorts,
        ...template.ExposedPorts,
      },
      Healthcheck: options.healthcheck ?? {
        Test: ["NONE"],
        Interval: 0,
        Timeout: 0,
        Retries: 0,
        StartPeriod: 0,
      },
      HostConfig: {
        ...host,
        Memory: z.number().nonnegative().parse(value("memoryBytes")),
        NanoCpus: z.number().nonnegative().parse(value("nanoCpus")),
        RestartPolicy: {
          Name: restart.name,
          MaximumRetryCount: restart.maximumRetryCount,
        },
        PortBindings: Object.fromEntries(
          Object.entries(ports).map(([key, entries]) => [
            key,
            entries.map((binding) => ({
              HostIp: binding.hostIp,
              HostPort: String(binding.hostPort),
            })),
          ]),
        ),
        ShmSize: options.sharedMemory,
        Mounts: options.mounts,
        ExtraHosts: options.extraHosts,
        ...(networkMode && { NetworkMode: networkMode }),
      },
      NetworkingConfig: { EndpointsConfig: networks },
    };
  }

  private async validateBindings(target: StateSnapshot): Promise<void> {
    const selectedPorts = new Set<number>();
    for (const role of dependencyOrder(this.policy)) {
      const slot = stateValue(target, `${role}.ports`);
      if (!slot.present) throw new Error("Service port bindings are required.");
      const bindings = dockerContainerStateSchema.shape.ports.parse(slot.value);
      const container = this.review.inventory[role];
      const owned = Object.values(
        container?.HostConfig.PortBindings ?? {},
      ).flatMap((values) => values ?? []);
      const values = Object.values(bindings).flat();
      for (const binding of values) {
        if (selectedPorts.has(binding.hostPort))
          throw new Error("Each service needs a different host port.");
        selectedPorts.add(binding.hostPort);
        if (binding.hostIp !== "127.0.0.1" || binding.hostPort < 1024)
          throw new Error(
            "Managed services must use fixed loopback ports above 1023.",
          );
        if (
          container?.State.Running &&
          owned.some(
            (entry) =>
              entry.HostPort === String(binding.hostPort) &&
              entry.HostIp === binding.hostIp,
          )
        )
          continue;
        if (!(await canBind(binding.hostPort)))
          throw new Error(
            `Port ${String(binding.hostPort)} is already in use. Keep the current bindings or choose a free port.`,
          );
      }
    }
  }

  private validateDeclaredNetworks(): void {
    for (const role of dependencyOrder(this.policy)) {
      const spec = requiredSpec(this.specs, role);
      if (spec.HostConfig.NetworkMode !== undefined)
        throw new Error(
          `The ${role} specification uses unsupported explicit NetworkMode. Declare named network endpoints instead.`,
        );
      const networks = Object.keys(
        spec.NetworkingConfig?.EndpointsConfig ?? {},
      );
      if (
        networks.length === 0 ||
        networks.some((name) => ["bridge", "host", "none"].includes(name))
      )
        throw new Error(
          `The ${role} specification must declare named network endpoints; implicit and built-in network modes are unsupported.`,
        );
    }
  }

  async read(): Promise<StateSnapshot> {
    const inventory = await readRuntimeInventory(this.docker, this.policy);
    return runtimeReview(
      inventory,
      this.specs,
      this.secretKey,
      this.review.baseline,
      this.policy,
    ).observed;
  }

  async validate(mutations: readonly StateMutation[]): Promise<void> {
    this.validateDeclaredNetworks();
    this.mutations = mutations;
    const values = { ...this.review.observed.values };
    for (const mutation of mutations) values[mutation.field] = mutation.after;
    this.target = { schemaVersion: this.review.desired.schemaVersion, values };
    await this.validateBindings(this.target);
    const replacements: string[] = [];
    for (const role of dependencyOrder(this.policy)) {
      const container = await this.guard(role);
      const changes = mutations.filter((mutation) =>
        mutation.field.startsWith(`${role}.`),
      );
      const shouldReplace =
        container?.Config.Labels[this.policy.setupVersionLabel] !==
          String(this.policy.setupVersion) ||
        changes.some((mutation) => requiresReplacement(mutation.field));
      const spec = this.spec(role, this.target);
      if (container && shouldReplace) {
        const unsupported = replacementBlockers(container);
        if (unsupported.length > 0)
          throw new Error(
            `Cannot preserve ${role} options during replacement: ${unsupported.join(", ")}. Keep changes requiring replacement and review these options manually.`,
          );
      }
      if (
        container &&
        (spec.HostConfig.Memory ?? 0) >
          (container.HostConfig.MemorySwap ?? -1) &&
        (container.HostConfig.MemorySwap ?? -1) > 0
      )
        throw new Error(
          `The ${role} memory limit exceeds its existing swap limit. Adjust that limit and review again.`,
        );
      if (shouldReplace) replacements.push(role);
    }
    const valuesTarget = this.target;
    const effectiveSpecs = Object.fromEntries(
      dependencyOrder(this.policy).map((role) => [
        role,
        this.spec(role, valuesTarget),
      ]),
    );
    await this.policy.validateSelection?.(effectiveSpecs, this.target);
    this.replacements = replacements;
  }

  async apply(): Promise<void> {
    if (!this.target)
      throw new Error("Validate selected Docker changes before applying.");
    await this.hooks.prepare(this.replacements);
    for (const role of dependencyOrder(this.policy)) {
      const current = await this.guard(role);
      const spec = this.spec(role, this.target);
      const name = this.policy.resourceName(role);
      if (this.replacements.includes(role)) {
        await this.docker.ensureImage(spec.Image);
        if (current) {
          await this.docker.stop(current.Id);
          await this.guard(role);
          await this.docker.remove(current.Id);
        }
        const id = await this.docker.create(name, spec);
        await this.docker.start(id);
      } else if (current) {
        const changes = this.mutations.filter((mutation) =>
          mutation.field.startsWith(`${role}.`),
        );
        if (changes.length > 0)
          await this.docker.json(
            "POST",
            `/containers/${encodeURIComponent(current.Id)}/update`,
            {
              Memory: spec.HostConfig.Memory,
              NanoCpus: spec.HostConfig.NanoCpus,
              RestartPolicy: spec.HostConfig.RestartPolicy,
            },
          );
        if (!current.State.Running) await this.docker.start(current.Id);
      }
      await this.hooks.serviceReady?.(role);
    }
    await this.hooks.ready();
  }
}
