import {
  validateResourceCatalog,
  type ResourceDefinition,
  type DataVolumeDefinition,
} from "../../core/resources.js";
import type { StackDefinition } from "../../core/stack.js";
import type { Docker, ContainerSpec } from "./transport.js";

export interface DockerStackDefinition<
  Settings,
  Secrets,
  VerificationOptions,
> extends StackDefinition<
  Settings,
  Secrets,
  Record<string, ContainerSpec>,
  Docker,
  VerificationOptions
> {
  images: Readonly<Record<string, string>>;
  helperImage: string;
}

export function defineDockerStack<
  Definition extends {
    resources: readonly ResourceDefinition[];
    dataVolumes: readonly DataVolumeDefinition[];
  },
>(definition: Definition): Definition {
  validateResourceCatalog(definition.resources, definition.dataVolumes);
  return definition;
}
