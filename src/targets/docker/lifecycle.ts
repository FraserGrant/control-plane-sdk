import type { Docker, ContainerSpec } from "./transport.js";
import type { ResourceOwnership } from "./resources.js";

export async function restartOwnedService(
  docker: Docker,
  ownership: ResourceOwnership,
  role: string,
  expectedIdentity: string,
): Promise<void> {
  const container = await docker.inspect(ownership.name(role));
  if (container?.Id !== expectedIdentity)
    throw new Error("Service changed. Refresh its status before restarting.");
  if (
    !ownership.isOwned(container.Config.Labels, role) ||
    !ownership.supportsSetup(container.Config.Labels)
  )
    throw new Error(
      `Refusing to restart an unmanaged or unsupported ${role} service.`,
    );
  await docker.stop(container.Id);
  // Address the original identity so a same-name replacement cannot be restarted.
  await docker.start(container.Id);
  const restarted = await docker.inspect(container.Id);
  if (!restarted?.State.Running)
    throw new Error(`${role} did not restart. Inspect its Docker logs.`);
}

/**
Tracks the newly created identity rather than adopting a later same-name helper.
*/
export async function withTemporaryContainer<T>(
  docker: Docker,
  name: string,
  spec: ContainerSpec,
  action: (identity: string) => Promise<T>,
): Promise<T> {
  const identity = await docker.create(name, spec);
  try {
    await docker.start(identity);
    return await action(identity);
  } finally {
    await docker.stop(identity);
    await docker.remove(identity);
  }
}

export async function waitForHealthy(
  docker: Docker,
  ownership: ResourceOwnership,
  role: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 150;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const container = await docker.inspect(ownership.name(role));
    if (container && !ownership.isOwned(container.Config.Labels, role))
      throw new Error(`Refusing to check an unmanaged ${role} container.`);
    if (container?.State.Health?.Status === "healthy") return;
    if (
      !container?.State.Running ||
      container.State.Health?.Status === "unhealthy"
    )
      throw new Error(
        `${role} did not become healthy. Inspect its Docker logs and retry setup.`,
      );
    await Bun.sleep(options.intervalMs ?? 2000);
  }
  throw new Error(
    `${role} readiness timed out. Retry after checking Docker logs.`,
  );
}
