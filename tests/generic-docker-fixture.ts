import { z } from "zod";
import {
  Docker,
  type ContainerSpec,
} from "@frasergrant/control-plane-sdk/docker";
import {
  runtimeContainerSchema,
  type RuntimeContainer,
} from "@frasergrant/control-plane-sdk/docker";
import type { DockerRuntimePolicy } from "@frasergrant/control-plane-sdk/docker";
export function runtimeContainer(
  name: string,
  spec: ContainerSpec,
): RuntimeContainer {
  const config = {
    Image: spec.Image,
    Labels: spec.Labels,
    Healthcheck: spec.Healthcheck,
    ExposedPorts: spec.ExposedPorts,
    User: spec.User,
  };
  const mounts = (spec.HostConfig.Mounts ?? []).map((mount) => ({
    Type: mount.Type,
    Name: mount.Type === "volume" ? mount.Source : undefined,
    Source: mount.Source,
    Destination: mount.Target,
    RW: !mount.ReadOnly,
    Mode: "",
    Propagation: "",
  }));
  return runtimeContainerSchema.parse({
    Id: `${name}-id`,
    Name: name,
    Image: spec.Image,
    Config: {
      ...config,
      Cmd: spec.Cmd ?? ["run"],
      Env: spec.Env ?? [],
      Hostname: spec.Hostname ?? `${name}-id`,
      Entrypoint: spec.Entrypoint ?? null,
    },
    HostConfig: {
      ...spec.HostConfig,
      Memory: spec.HostConfig.Memory ?? 0,
      NanoCpus: spec.HostConfig.NanoCpus ?? 0,
      MemorySwap: spec.HostConfig.Memory ? spec.HostConfig.Memory * 2 : 0,
      ShmSize: spec.HostConfig.ShmSize ?? 67_108_864,
      ExtraHosts: spec.HostConfig.ExtraHosts ?? [],
      RestartPolicy: {
        Name: spec.HostConfig.RestartPolicy?.Name ?? "no",
        MaximumRetryCount:
          spec.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0,
      },
      PortBindings: spec.HostConfig.PortBindings ?? {},
      NetworkMode:
        spec.HostConfig.NetworkMode ??
        Object.keys(spec.NetworkingConfig?.EndpointsConfig ?? {})[0] ??
        "bridge",
    },
    Mounts: mounts,
    NetworkSettings: { Networks: spec.NetworkingConfig?.EndpointsConfig ?? {} },
    State: { Running: true },
  });
}

export const syntheticPolicy: DockerRuntimePolicy = {
  roles: ["portal", "ledger", "processor"],
  resourceName: (role) => `synthetic-${role}`,
  isOwned: (labels, role) => labels["fixture.owner"] === role,
  setupVersion: 7,
  setupVersionLabel: "fixture.version",
  dependencies: { portal: ["processor"], processor: ["ledger"] },
  sensitiveEnvironment: ["ACCESS_PHRASE"],
};
export function syntheticSpecifications(): Record<string, ContainerSpec> {
  return Object.fromEntries(
    syntheticPolicy.roles.map((role, index) => [
      role,
      {
        Image: "synthetic:one",
        Cmd: ["run", role],
        Env: ["ACCESS_PHRASE=private-fixture-phrase", "REGION=east"],
        Labels: { "fixture.owner": role, "fixture.version": "7" },
        HostConfig: {
          Memory: 1000,
          NanoCpus: 1000,
          RestartPolicy: { Name: "no" },
          PortBindings:
            index === 0
              ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "48761" }] }
              : {},
          Mounts:
            role === "ledger"
              ? [
                  {
                    Type: "volume",
                    Source: "synthetic-records",
                    Target: "/records",
                  },
                ]
              : [],
        },
        NetworkingConfig: {
          EndpointsConfig: { "synthetic-link": { Aliases: [role] } },
        },
      },
    ]),
  );
}
export class SyntheticDocker extends Docker {
  private sequence = 0;
  readonly containers = new Map<string, RuntimeContainer>();
  readonly events: string[] = [];
  failCreate: string | undefined;
  get(name: string): RuntimeContainer | undefined {
    return (
      this.containers.get(name) ??
      this.containers.values().find((value) => value.Id === name)
    );
  }
  override runtime(name: string): Promise<RuntimeContainer | undefined> {
    return Promise.resolve(structuredClone(this.get(name)));
  }
  override ensureImage(): Promise<void> {
    return Promise.resolve();
  }
  override create(name: string, spec: ContainerSpec): Promise<string> {
    if (this.failCreate === name)
      return Promise.reject(new Error("synthetic creation interrupted"));
    const value = runtimeContainer(name, spec);
    value.Id = `${name}-${String(++this.sequence)}`;
    value.State.Running = false;
    this.containers.set(name, value);
    this.events.push(`create:${name}`);
    return Promise.resolve(value.Id);
  }
  override start(name: string): Promise<void> {
    const value = this.get(name);
    if (value) value.State.Running = true;
    this.events.push(`start:${value?.Name ?? name}`);
    return Promise.resolve();
  }
  override stop(name: string): Promise<void> {
    const value = this.get(name);
    if (value) value.State.Running = false;
    this.events.push(`stop:${value?.Name ?? name}`);
    return Promise.resolve();
  }
  override remove(name: string): Promise<void> {
    const value = this.get(name);
    if (value) this.containers.delete(value.Name);
    this.events.push(`remove:${value?.Name ?? name}`);
    return Promise.resolve();
  }
  override json(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    if (method !== "POST" || !endpoint.endsWith("/update"))
      return Promise.reject(new Error("Unexpected synthetic request"));
    const input = z
      .object({
        Memory: z.number(),
        NanoCpus: z.number(),
        RestartPolicy: z.object({
          Name: z.string(),
          MaximumRetryCount: z.number(),
        }),
      })
      .parse(body);
    const name = decodeURIComponent(endpoint.split("/", 3)[2] ?? "");
    const value = this.get(name);
    if (!value) return Promise.reject(new Error("Missing synthetic container"));
    Object.assign(value.HostConfig, input);
    this.events.push(`update:${value.Name}`);
    return Promise.resolve({});
  }
}
