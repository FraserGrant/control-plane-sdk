import process from "node:process";
import { request, type IncomingMessage } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { runtimeContainerSchema, type RuntimeContainer } from "./inspection.js";

const labelsSchema = z.record(z.string(), z.string());
const healthSchema = z.object({ Status: z.string() });
const bindingSchema = z.object({ HostIp: z.string(), HostPort: z.string() });
const portBindingsSchema = z
  .record(
    z.string(),
    z
      .array(bindingSchema)
      .nullable()
      .transform((value) => value ?? []),
  )
  .nullable();
export const containerSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  HostConfig: z.object({ PortBindings: portBindingsSchema }),
  Config: z.object({
    Labels: labelsSchema.nullish().transform((value) => value ?? {}),
    Image: z.string(),
  }),
  State: z.object({
    Running: z.boolean(),
    Health: healthSchema.optional(),
    ExitCode: z.number().optional(),
  }),
});
export type Container = z.infer<typeof containerSchema>;
export const resourceSchema = z.object({
  Name: z.string(),
  Id: z.string().optional(),
  CreatedAt: z.string().optional(),
  Labels: labelsSchema.nullish().transform((value) => value ?? {}),
});
const idSchema = z.object({ Id: z.string() });
export interface ContainerSpec {
  Image: string;
  Env?: string[];
  Cmd?: string[];
  Entrypoint?: string[];
  User?: string;
  Hostname?: string;
  Labels: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Healthcheck?: {
    Test: string[];
    Interval: number;
    Timeout: number;
    Retries: number;
    StartPeriod: number;
  };
  HostConfig: {
    Mounts?: {
      Type: string;
      Source: string;
      Target: string;
      ReadOnly?: boolean;
    }[];
    PortBindings?: Record<string, { HostIp: string; HostPort: string }[]>;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    ShmSize?: number;
    Memory?: number;
    NanoCpus?: number;
    NetworkMode?: string;
    ReadonlyRootfs?: boolean | undefined;
    ExtraHosts?: string[];
  };
  NetworkingConfig?: { EndpointsConfig: Record<string, { Aliases: string[] }> };
}
export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Docker {
  private api = "";
  constructor(
    readonly socket = process.env.DOCKER_HOST?.replace(/^unix:\/\//, "") ??
      "/var/run/docker.sock",
  ) {
    if (!socket.startsWith("/"))
      throw new Error(
        "Only local Docker Unix sockets are supported. Set DOCKER_HOST=unix:///path/to/docker.sock.",
      );
  }
  private async response(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const connection = request(
        {
          socketPath: this.socket,
          path: `${this.api}${path}`,
          method,
          headers:
            payload === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                },
        },
        resolve,
      );
      connection.setTimeout(600_000, () => {
        connection.destroy(new Error("Docker operation timed out."));
      });
      connection.on("error", reject);
      connection.end(payload);
    });
  }
  async raw(method: string, path: string, body?: unknown): Promise<Buffer> {
    const response = await this.response(method, path, body);
    const chunks: Buffer[] = [];
    for await (const chunk of response)
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(z.string().parse(chunk)),
      );
    const data = Buffer.concat(chunks);
    if ((response.statusCode ?? 500) >= 400)
      throw new DockerError(
        response.statusCode ?? 500,
        `Docker ${method} ${path.split("?", 1)[0] ?? path}: ${data.toString("utf8")}`,
      );
    return data;
  }
  async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const data = await this.raw(method, path, body);
    return data.length === 0 ? {} : JSON.parse(data.toString("utf8"));
  }
  async connect(): Promise<string> {
    const version = z
      .object({
        ApiVersion: z.string(),
        MinAPIVersion: z.string().optional(),
        Version: z.string(),
      })
      .parse(await this.json("GET", "/version"));
    if (
      Number(version.ApiVersion) < 1.44 ||
      Number(version.MinAPIVersion ?? "1.24") > 1.53
    )
      throw new Error("Docker Engine must support API 1.44–1.53.");
    this.api = `/v${Math.min(Number(version.ApiVersion), 1.53).toFixed(2)}`;
    return version.Version;
  }
  async inspect(name: string): Promise<Container | undefined> {
    try {
      return containerSchema.parse(
        await this.json("GET", `/containers/${encodeURIComponent(name)}/json`),
      );
    } catch (error) {
      if (error instanceof DockerError && error.status === 404)
        return undefined;
      throw error;
    }
  }
  async runtime(name: string): Promise<RuntimeContainer | undefined> {
    if (!(await this.inspect(name))) return undefined;
    try {
      return runtimeContainerSchema.parse(
        await this.json("GET", `/containers/${encodeURIComponent(name)}/json`),
      );
    } catch (error) {
      if (error instanceof DockerError && error.status === 404)
        return undefined;
      throw error;
    }
  }
  async resource(
    kind: "networks" | "volumes",
    name: string,
  ): Promise<z.infer<typeof resourceSchema> | undefined> {
    try {
      return resourceSchema.parse(
        await this.json("GET", `/${kind}/${encodeURIComponent(name)}`),
      );
    } catch (error) {
      if (error instanceof DockerError && error.status === 404)
        return undefined;
      throw error;
    }
  }
  async ensureImage(image: string): Promise<void> {
    try {
      await this.json("GET", `/images/${encodeURIComponent(image)}/json`);
      return;
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
    const data = await this.raw(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}`,
    );
    for (const line of data.toString("utf8").trim().split("\n")) {
      const item = z
        .object({ error: z.string().optional() })
        .parse(JSON.parse(line));
      if (item.error) throw new Error(`Image pull failed: ${item.error}`);
    }
  }
  async create(name: string, spec: ContainerSpec): Promise<string> {
    return idSchema.parse(
      await this.json(
        "POST",
        `/containers/create?name=${encodeURIComponent(name)}`,
        spec,
      ),
    ).Id;
  }
  async start(name: string): Promise<void> {
    await this.json("POST", `/containers/${encodeURIComponent(name)}/start`);
  }
  async stop(name: string): Promise<void> {
    const value = await this.inspect(name);
    if (value?.State.Running)
      await this.json(
        "POST",
        `/containers/${encodeURIComponent(name)}/stop?t=30`,
      );
  }
  async remove(name: string): Promise<void> {
    await this.json(
      "DELETE",
      `/containers/${encodeURIComponent(name)}?v=false`,
    );
  }
  async exec(name: string, command: string[]): Promise<string> {
    const execution = idSchema.parse(
      await this.json("POST", `/containers/${encodeURIComponent(name)}/exec`, {
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      }),
    );
    const data = await this.raw("POST", `/exec/${execution.Id}/start`, {
      Detach: false,
      Tty: false,
    });
    const output = decodeOutput(data);
    const state = z
      .object({ ExitCode: z.number().nullable(), Running: z.boolean() })
      .parse(await this.json("GET", `/exec/${execution.Id}/json`));
    if (state.Running || state.ExitCode !== 0)
      throw new Error(
        `Container command failed (${String(state.ExitCode ?? "running")}): ${output.slice(-2000)}`,
      );
    return output;
  }
  async importArchive(name: string, sourceFile: string): Promise<void> {
    let upload: Promise<void> = Promise.resolve();
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const connection = request(
        {
          socketPath: this.socket,
          path: `${this.api}/containers/${encodeURIComponent(name)}/archive?path=/target&noOverwriteDirNonDir=true`,
          method: "PUT",
          headers: { "Content-Type": "application/x-tar" },
        },
        resolve,
      );
      connection.setTimeout(600_000, () =>
        connection.destroy(new Error("Docker archive import timed out.")),
      );
      connection.on("error", reject);
      upload = pipeline(createReadStream(sourceFile), connection);
      void upload.catch(reject);
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      if (chunks.reduce((size, value) => size + value.length, 0) < 4096)
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(z.string().parse(chunk)),
        );
    }
    await upload;
    if ((response.statusCode ?? 500) >= 400)
      throw new DockerError(
        response.statusCode ?? 500,
        `Docker archive import failed: ${Buffer.concat(chunks).toString("utf8")}`,
      );
  }
  async archive(name: string, destination: string): Promise<void> {
    const response = await this.response(
      "GET",
      `/containers/${encodeURIComponent(name)}/archive?path=${encodeURIComponent("/source/.")}`,
    );
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error("Could not back up deployment volume.");
    }
    await pipeline(
      response,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  }
}
export function decodeOutput(data: Buffer): string {
  let offset = 0;
  const parts: Buffer[] = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset + 4);
    if (
      (data[offset] !== 1 && data[offset] !== 2) ||
      offset + 8 + length > data.length
    )
      throw new Error("Invalid Docker exec output frame.");
    parts.push(data.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  if (offset !== data.length) throw new Error("Incomplete Docker exec output.");
  return Buffer.concat(parts).toString("utf8");
}
