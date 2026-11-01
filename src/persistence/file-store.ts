import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const scopeId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/,
    "Use 3–40 lowercase letters, numbers or hyphens.",
  );

export class FileStore {
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(readonly root: string) {}
  private filePath(id: string, file: string): string {
    const directory = this.directory(id);
    const destination = path.resolve(directory, file);
    const relative = path.relative(directory, destination);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Store files must stay within their scope directory.");
    return destination;
  }
  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }
  notify(id: string): void {
    const listeners = this.listeners.get(id);
    if (listeners) for (const listener of listeners) listener();
  }
  directory(id: string): string {
    return path.join(this.root, scopeId.parse(id));
  }
  async write(id: string, file: string, value: unknown): Promise<void> {
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const destination = this.filePath(id, file);
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    this.notify(id);
  }
  async read(id: string, file: string): Promise<unknown> {
    try {
      const content = await readFile(this.filePath(id, file), "utf8");
      return JSON.parse(content);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  }
  async scopes(): Promise<string[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isDirectory() && scopeId.safeParse(entry.name).success,
      )
      .map((entry) => entry.name);
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory(id), { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.directory(id), "operation.lock");
    // A dead process cannot hold a deployment lock after a restart.
    try {
      const owner = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(await readFile(lockPath, "utf8")));
      try {
        process.kill(owner.pid, 0);
        throw new Error(
          "Another operation is already running for this deployment.",
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          throw error;
      }
      await rm(lockPath);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}
