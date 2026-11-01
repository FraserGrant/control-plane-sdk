import type { ContainerSpec } from "./transport.js";
import type { StateSnapshot } from "../../core/state/model.js";

export interface DockerRuntimePolicy {
  roles: readonly string[];
  resourceName(role: string): string;
  isOwned(labels: Record<string, string>, role: string): boolean;
  setupVersion: number;
  setupVersionLabel: string;
  reservedMountTargets?: readonly string[];
  sensitiveEnvironment?: readonly string[];
  /** Explicit consumer opt-in; omitted policies remain loopback-only. */
  allowedHostAddresses?: readonly string[];
  dependencies?: Readonly<Record<string, readonly string[]>>;
  validateSelection?(
    specs: Record<string, ContainerSpec>,
    target: StateSnapshot,
  ): Promise<void> | void;
}

export function dependencyOrder(policy: DockerRuntimePolicy): string[] {
  const declared = new Set(policy.roles);
  if (declared.size !== policy.roles.length)
    throw new Error("Duplicate Docker service IDs.");
  for (const role of policy.roles) {
    if (!role || role.includes("."))
      throw new Error(
        "Docker service IDs must be nonempty and cannot contain periods.",
      );
  }
  const dependencyServices = Object.keys(policy.dependencies ?? {});
  for (const role of dependencyServices) {
    if (!declared.has(role))
      throw new Error(`Unknown dependency service ${role}.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];
  function visit(role: string): void {
    if (!declared.has(role))
      throw new Error(`Unknown dependency service ${role}.`);
    if (visiting.has(role)) throw new Error(`Dependency cycle at ${role}.`);
    if (visited.has(role)) return;
    visiting.add(role);
    const dependencies = policy.dependencies?.[role] ?? [];
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(role);
    visited.add(role);
    ordered.push(role);
  }
  for (const role of policy.roles) visit(role);
  return ordered;
}
