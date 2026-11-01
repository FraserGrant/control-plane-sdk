import { z } from "zod";

const strings = z.array(z.string());
const stringMap = z.record(z.string(), z.string());
const binding = z.object({ HostIp: z.string(), HostPort: z.string() });
const bindings = z.record(z.string(), z.array(binding).nullable()).nullable();
export const healthcheckSchema = z.object({
  Test: strings,
  Interval: z.number().default(0),
  Timeout: z.number().default(0),
  Retries: z.number().default(0),
  StartPeriod: z.number().default(0),
  StartInterval: z.number().default(0),
});
const mountSchema = z.object({
  Type: z.enum(["volume", "bind", "tmpfs"]),
  Name: z.string().optional(),
  Source: z.string().default(""),
  Destination: z.string(),
  RW: z.boolean(),
  Mode: z.string().default(""),
  Propagation: z.string().default(""),
});
const endpointSchema = z.object({
  Aliases: strings.nullable(),
  IPAMConfig: z.json().nullable().optional(),
});
const restartSchema = z.object({
  Name: z.string(),
  MaximumRetryCount: z.number().default(0),
});
const logSchema = z.object({ Type: z.string(), Config: stringMap });
const limitSchema = z.object({
  Name: z.string(),
  Soft: z.number(),
  Hard: z.number(),
});
// Only these validated create options are carried across replacement.
export const preservedHostSchema = z.object({
  ConsoleSize: z.array(z.number()).optional(),
  MemorySwap: z.number().optional(),
  MemoryReservation: z.number().optional(),
  CpuShares: z.number().optional(),
  CpuPeriod: z.number().optional(),
  CpuQuota: z.number().optional(),
  CpusetCpus: z.string().optional(),
  CpusetMems: z.string().optional(),
  PidsLimit: z.number().nullable().optional(),
  Privileged: z.boolean().optional(),
  ReadonlyRootfs: z.boolean().optional(),
  CapAdd: strings.nullable().optional(),
  CapDrop: strings.nullable().optional(),
  SecurityOpt: strings.nullable().optional(),
  GroupAdd: strings.nullable().optional(),
  Dns: strings.nullable().optional(),
  DnsOptions: strings.nullable().optional(),
  DnsSearch: strings.nullable().optional(),
  Init: z.boolean().nullable().optional(),
  Runtime: z.string().optional(),
  LogConfig: logSchema.optional(),
  Ulimits: z.array(limitSchema).nullable().optional(),
  IpcMode: z.string().optional(),
  PidMode: z.string().optional(),
  UTSMode: z.string().optional(),
  UsernsMode: z.string().optional(),
  CgroupnsMode: z.string().optional(),
  CgroupParent: z.string().optional(),
  Sysctls: stringMap.nullable().optional(),
  StorageOpt: stringMap.nullable().optional(),
  MaskedPaths: strings.nullable().optional(),
  ReadonlyPaths: strings.nullable().optional(),
});
const hostSchema = preservedHostSchema
  .extend({
    Memory: z.number(),
    NanoCpus: z.number(),
    ShmSize: z.number(),
    RestartPolicy: restartSchema,
    PortBindings: bindings,
    ExtraHosts: strings.nullable(),
    NetworkMode: z.string(),
  })
  .catchall(z.json());
export const preservedConfigSchema = z.object({
  User: z.string().optional(),
  WorkingDir: z.string().optional(),
  Entrypoint: strings.nullable().optional(),
  StopSignal: z.string().optional(),
  StopTimeout: z.number().optional(),
  Tty: z.boolean().optional(),
  OpenStdin: z.boolean().optional(),
  StdinOnce: z.boolean().optional(),
  AttachStdin: z.boolean().optional(),
  AttachStdout: z.boolean().optional(),
  AttachStderr: z.boolean().optional(),
  Domainname: z.string().optional(),
});
const configSchema = preservedConfigSchema
  .extend({
    Image: z.string(),
    Cmd: strings.nullable(),
    Env: strings,
    Labels: stringMap.nullish().transform((value) => value ?? {}),
    ExposedPorts: z.record(z.string(), z.object({})).optional(),
    Healthcheck: healthcheckSchema.optional(),
    Hostname: z.string(),
  })
  .catchall(z.json());
const networkSettingsSchema = z.object({
  Networks: z.record(z.string(), endpointSchema),
});
export const runtimeContainerSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Image: z.string(),
  Config: configSchema,
  HostConfig: hostSchema,
  Mounts: z.array(mountSchema),
  NetworkSettings: networkSettingsSchema,
  State: z.object({ Running: z.boolean() }),
});
export type RuntimeContainer = z.infer<typeof runtimeContainerSchema>;

export function environment(
  entries: readonly string[],
): Record<string, string> {
  const values = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1)
      throw new Error("Container environment entries need a name and value.");
    const key = entry.slice(0, separator);
    if (values.has(key)) throw new Error(`Duplicate environment entry ${key}.`);
    values.set(key, entry.slice(separator + 1));
  }
  return Object.fromEntries(values);
}

export function normalizedHealthcheck(
  value: z.input<typeof healthcheckSchema> | undefined,
): z.output<typeof healthcheckSchema> | null {
  const isDisabled =
    !value || (value.Test.length === 1 && value.Test[0] === "NONE");
  return isDisabled ? null : healthcheckSchema.parse(value);
}
