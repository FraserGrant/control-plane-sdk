import { createHash } from "node:crypto";
import type { z } from "zod";
import type { ResourceDefinition } from "../../core/resources.js";
import { validateResourceCatalog } from "../../core/resources.js";
import type { Docker, Container, resourceSchema } from "./transport.js";

export interface ResourceOwnership {
  name(role: string): string;
  labels(role: string): Record<string, string>;
  isOwned(labels: Record<string, string>, role: string): boolean;
  supportsSetup(labels: Record<string, string>): boolean;
}

export interface ObservedResource {
  definition: ResourceDefinition;
  name: string;
  value: Container | z.infer<typeof resourceSchema> | undefined;
}

export function resourceRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function inspectResourceCatalog(
  docker: Docker,
  resources: readonly ResourceDefinition[],
  ownership: ResourceOwnership,
): Promise<ObservedResource[]> {
  validateResourceCatalog(resources);
  return Promise.all(
    resources.map(async (definition) => {
      const name = ownership.name(definition.role);
      const value =
        definition.kind === "container"
          ? await docker.inspect(name)
          : await docker.resource(
              definition.kind === "network" ? "networks" : "volumes",
              name,
            );
      return { definition, name, value };
    }),
  );
}

export function resourceBlockers(
  entries: readonly ObservedResource[],
  ownership: ResourceOwnership,
): string[] {
  return entries.flatMap(({ definition, name, value }) => {
    if (!value) return [];
    const labels = "Config" in value ? value.Config.Labels : value.Labels;
    return [
      ...(ownership.isOwned(labels, definition.ownerRole)
        ? []
        : [`Refusing unmanaged resource ${name}.`]),
      ...(ownership.supportsSetup(labels)
        ? []
        : [`Unsupported setup version for ${name}.`]),
    ];
  });
}

export async function ensurePersistentResources(
  docker: Docker,
  resources: readonly ResourceDefinition[],
  ownership: ResourceOwnership,
): Promise<void> {
  const entries = await inspectResourceCatalog(
    docker,
    resources.filter((resource) => resource.kind !== "container"),
    ownership,
  );
  const blockers = resourceBlockers(entries, ownership);
  if (blockers.length > 0) throw new Error(blockers.join(" "));
  for (const { definition, name, value } of entries) {
    if (value) continue;
    await docker.json(
      "POST",
      definition.kind === "network" ? "/networks/create" : "/volumes/create",
      {
        Name: name,
        ...(definition.kind === "network" && { Driver: "bridge" }),
        Labels: ownership.labels(definition.ownerRole),
      },
    );
  }
}

export function removalAction(
  resource: ResourceDefinition,
  shouldDeleteData: boolean,
): "remove" | "keep" {
  if (shouldDeleteData) return "remove";
  return resource.retention === "retain" ? "keep" : "remove";
}

export interface RemovalResource {
  kind: ResourceDefinition["kind"];
  name: string;
  action: "remove" | "keep";
}
export interface ResourceRemovalPlan {
  revision: string;
  resources: RemovalResource[];
  blockers: string[];
  deleteData: boolean;
}

/**
The caller supplies configuration that must invalidate an earlier review.
*/
export async function reviewResourceRemoval(
  docker: Docker,
  resources: readonly ResourceDefinition[],
  ownership: ResourceOwnership,
  shouldDeleteData: boolean,
  context: unknown,
): Promise<{
  plan: ResourceRemovalPlan;
  targets: { resource: RemovalResource; observed: ObservedResource }[];
}> {
  const entries = await inspectResourceCatalog(docker, resources, ownership);
  const targets = entries.flatMap((entry) => {
    if (!entry.value) return [];
    const resource: RemovalResource = {
      kind: entry.definition.kind,
      name: entry.name,
      action: removalAction(entry.definition, shouldDeleteData),
    };
    return { resource, observed: entry };
  });
  return {
    plan: {
      revision: resourceRevision({
        context,
        shouldDeleteData,
        observed: entries.map(({ definition, name, value }) => ({
          kind: definition.kind,
          name,
          value,
        })),
      }),
      resources: targets.map(({ resource }) => resource),
      blockers: resourceBlockers(entries, ownership),
      deleteData: shouldDeleteData,
    },
    targets,
  };
}

export async function removeReviewedResource(
  docker: Docker,
  entry: ObservedResource,
  ownership: ResourceOwnership,
): Promise<void> {
  const [current] = await inspectResourceCatalog(
    docker,
    [entry.definition],
    ownership,
  );
  if (!current?.value) return;
  if (
    resourceBlockers([current], ownership).length > 0 ||
    resourceRevision(current.value) !== resourceRevision(entry.value)
  )
    throw new Error(
      "Managed resource changed during teardown. Review a fresh plan.",
    );
  const identity =
    "Id" in current.value ? (current.value.Id ?? entry.name) : entry.name;
  if (entry.definition.kind === "container") {
    await docker.stop(identity);
    const stopped = await docker.inspect(identity);
    if (
      stopped?.Id !== identity ||
      !ownership.isOwned(stopped.Config.Labels, entry.definition.ownerRole) ||
      !ownership.supportsSetup(stopped.Config.Labels)
    )
      throw new Error(
        "Managed container changed during teardown. Review a fresh plan.",
      );
    await docker.remove(identity);
    return;
  }
  await docker.json(
    "DELETE",
    `/${entry.definition.kind === "network" ? "networks" : "volumes"}/${encodeURIComponent(identity)}`,
  );
}
