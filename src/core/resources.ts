export interface ResourceDefinition {
  kind: "container" | "network" | "volume";
  role: string;
  ownerRole: string;
  persistence: "ephemeral" | "data";
  retention: "remove" | "retain";
  purpose: "service" | "backup-helper" | "restore-helper" | "network" | "data";
}

export interface DataVolumeDefinition {
  role: string;
  volumeRole: string;
  archive: string;
  mountTarget: string;
}

export function validateResourceCatalog(
  resources: readonly ResourceDefinition[],
  volumes: readonly DataVolumeDefinition[] = [],
): void {
  const roles = new Set<string>();
  for (const resource of resources) {
    if (!/^[a-z][a-z0-9-]*$/.test(resource.role) || roles.has(resource.role))
      throw new Error("Resource roles must be unique stable identifiers.");
    roles.add(resource.role);
    if (resource.persistence === "data" && resource.retention !== "retain")
      throw new Error("Persistent data must require explicit deletion.");
  }
  const archives = new Set<string>();
  const backedUpRoles = new Set<string>();
  const backedUpVolumes = new Set<string>();
  for (const volume of volumes) {
    const resource = resources.find(
      (entry) => entry.role === volume.volumeRole,
    );
    if (resource?.kind !== "volume" || resource.persistence !== "data")
      throw new Error(
        "Backup volumes must refer to declared persistent volumes.",
      );
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(volume.archive) ||
      archives.has(volume.archive) ||
      backedUpRoles.has(volume.role) ||
      backedUpVolumes.has(volume.volumeRole)
    )
      throw new Error(
        "Backup roles, volumes and archive filenames must be unique.",
      );
    archives.add(volume.archive);
    backedUpRoles.add(volume.role);
    backedUpVolumes.add(volume.volumeRole);
  }
}
