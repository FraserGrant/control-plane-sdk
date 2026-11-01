import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export async function validateSharedFolder(
  folder: string,
  protectedPaths: readonly string[] = [],
): Promise<void> {
  let resolved;
  try {
    resolved = await realpath(folder);
    const metadata = await stat(resolved);
    if (!metadata.isDirectory()) throw new Error("Not a folder.");
    await access(resolved, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(
      "The shared folder must exist and be readable by the control plane.",
    );
  }
  if (resolved !== path.normalize(folder))
    throw new Error(`Use the resolved shared-folder path: ${resolved}`);
  if (resolved === path.parse(resolved).root)
    throw new Error("Choose a project folder instead of the filesystem root.");
  for (const protectedPath of protectedPaths) {
    let protectedResolved;
    try {
      protectedResolved = await realpath(protectedPath);
    } catch {
      protectedResolved = path.resolve(protectedPath);
    }
    const relative = path.relative(resolved, protectedResolved);
    const isInsideFolder =
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    if (isInsideFolder)
      throw new Error(
        "Choose a shared folder that does not contain the control-plane state directory or Docker socket.",
      );
  }
}
