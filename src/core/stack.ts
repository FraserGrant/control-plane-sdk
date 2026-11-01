import type { z } from "zod";
import type { DataVolumeDefinition, ResourceDefinition } from "./resources.js";

export interface VerificationCheck {
  name: string;
  status: "passed" | "failed" | "pending";
  detail: string;
}

/**
Runtime and blueprint types belong to the selected target.
*/
export interface StackDefinition<
  Settings,
  Secrets,
  Blueprint,
  Runtime,
  VerificationOptions,
> {
  id: string;
  target: string;
  setupVersion: number;
  settingsSchema: z.ZodType<Settings>;
  secretsSchema: z.ZodType<Secrets>;
  requiredSecrets: readonly (keyof Secrets)[];
  defaults: Settings;
  roles: readonly string[];
  resources: readonly ResourceDefinition[];
  dataVolumes: readonly DataVolumeDefinition[];
  migrations: readonly { from: number; to: number; description: string }[];
  capabilities: Readonly<Record<string, boolean>>;
  specifications(settings: Settings, secrets: Secrets): Blueprint;
  bootstrap(runtime: Runtime, settings: Settings): Promise<void>;
  verify(
    runtime: Runtime,
    settings: Settings,
    secrets: Secrets,
    options: VerificationOptions,
  ): Promise<VerificationCheck[]>;
}
