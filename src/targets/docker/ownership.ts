export interface OwnershipIdentity {
  namespace: string;
  namePrefix: string;
  deploymentId: string;
  setupVersion: number;
  appVersion: string;
}

export interface Ownership {
  resourceName: (role: string) => string;
  labels: (role: string, specHash?: string) => Record<string, string>;
  isOwned: (labels: Record<string, string>, role: string) => boolean;
}

export function createOwnership(identity: OwnershipIdentity): Ownership {
  const { namespace, namePrefix, deploymentId, setupVersion, appVersion } =
    identity;
  return {
    resourceName: (role: string): string =>
      `${namePrefix}${deploymentId}-${role}`,
    labels(role: string, specHash = ""): Record<string, string> {
      return {
        [`${namespace}.managed`]: "true",
        [`${namespace}.deployment`]: deploymentId,
        [`${namespace}.role`]: role,
        [`${namespace}.setup-version`]: String(setupVersion),
        [`${namespace}.app-version`]: appVersion,
        [`${namespace}.spec`]: specHash,
      };
    },
    isOwned(labels: Record<string, string>, role: string): boolean {
      return (
        labels[`${namespace}.managed`] === "true" &&
        labels[`${namespace}.deployment`] === deploymentId &&
        labels[`${namespace}.role`] === role
      );
    },
  };
}
