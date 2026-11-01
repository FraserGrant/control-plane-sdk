import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DataVolumeDefinition } from "../core/resources.js";

const artifactSchema = z.strictObject({
  role: z.string().min(1),
  file: z.string().min(1),
});

export const backupManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stackId: z.string().min(1),
  setupVersion: z.number().int().positive(),
  artifacts: z.array(artifactSchema),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export function backupManifest(
  stackId: string,
  setupVersion: number,
  volumes: readonly DataVolumeDefinition[],
): BackupManifest {
  return backupManifestSchema.parse({
    schemaVersion: 1,
    stackId,
    setupVersion,
    artifacts: volumes.map((volume) => ({
      role: volume.role,
      file: volume.archive,
    })),
  });
}

export function validateBackupManifest(
  value: unknown,
  expected: BackupManifest,
): void {
  const actual = backupManifestSchema.parse(value);
  const canonical = (manifest: BackupManifest) =>
    JSON.stringify({
      ...manifest,
      artifacts: manifest.artifacts.toSorted((left, right) =>
        left.role.localeCompare(right.role),
      ),
    });
  if (canonical(actual) !== canonical(expected))
    throw new Error(
      "Backup artifact manifest is incompatible with this stack.",
    );
}

export interface BackupInventory {
  name: string;
  modifiedAt: string;
  files: { name: string; bytes: number; modifiedAt: string }[];
  missingFiles: string[];
  complete: boolean;
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory())
      throw new Error(
        "Backup inventory requires directories without symbolic links.",
      );
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export async function listBackupInventory(
  deployment: string,
  expectedFiles: readonly string[],
): Promise<BackupInventory[]> {
  if (!(await isDirectory(deployment)))
    throw new Error("Deployment not found.");
  const directory = path.join(deployment, "backups");
  if (!(await isDirectory(directory))) return [];
  const backups: BackupInventory[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const backupDirectory = path.join(directory, entry.name);
    const files: BackupInventory["files"] = [];
    const contents = await readdir(backupDirectory, { withFileTypes: true });
    for (const file of contents) {
      if (!file.isFile()) continue;
      const metadata = await lstat(path.join(backupDirectory, file.name));
      if (metadata.isFile())
        files.push({
          name: file.name,
          bytes: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        });
    }
    files.sort((left, right) => left.name.localeCompare(right.name));
    const missingFiles = expectedFiles.filter((name) =>
      files.every((file) => file.name !== name || file.bytes === 0),
    );
    const metadata = await lstat(backupDirectory);
    backups.push({
      name: entry.name,
      modifiedAt: metadata.mtime.toISOString(),
      files,
      missingFiles,
      complete: missingFiles.length === 0,
    });
  }
  return backups.toSorted(
    (left, right) =>
      backupTime(right) - backupTime(left) ||
      right.name.localeCompare(left.name),
  );
}

function backupTime(backup: BackupInventory): number {
  const timestamp = /^(\d{13})(?:-|$)/.exec(backup.name)?.[1];
  return timestamp === undefined
    ? Date.parse(backup.modifiedAt)
    : Number(timestamp);
}

const configLimit = 8 * 1024 * 1024;

function isSameFile(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

async function requireDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory())
    throw new Error("Restore requires directories without symbolic links.");
}

function backupDirectory(deployment: string, backup: string): string {
  if (
    backup === "." ||
    backup === ".." ||
    backup.length === 0 ||
    /[/\\\0]/.test(backup)
  )
    throw new Error("Choose a single backup directory name.");
  return path.join(deployment, "backups", backup);
}

export async function readBackupConfig<Config>(
  deployment: string,
  backup: string,
  parseConfig: (value: unknown) => Config,
): Promise<Config> {
  const directory = backupDirectory(deployment, backup);
  for (const candidate of [
    deployment,
    path.join(deployment, "backups"),
    directory,
  ])
    await requireDirectory(candidate);
  const file = await readBackupFile(
    path.join(directory, "configuration.json"),
    true,
  );
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch {
    throw new Error("Backup configuration is invalid or incomplete.");
  }
  return parseConfig(value);
}

export type BackupSelection = { names: string[] } | { keepLatest: number };
export interface BackupRemovalPlan {
  revision: string;
  remove: { name: string; bytes: number }[];
  retained: string[];
}

export async function reviewBackupRemoval(
  deployment: string,
  selection: BackupSelection,
): Promise<BackupRemovalPlan> {
  const inventory = await listBackupInventory(deployment, []);
  let names: string[];
  if ("keepLatest" in selection) {
    const count = z.number().int().min(1).max(1000).parse(selection.keepLatest);
    names = inventory.slice(count).map((backup) => backup.name);
  } else {
    names = z.array(z.string().min(1)).min(1).parse(selection.names);
    if (new Set(names).size !== names.length)
      throw new Error("Choose each backup only once.");
  }
  for (const name of names) {
    backupDirectory(deployment, name);
    if (inventory.every((backup) => backup.name !== name))
      throw new Error("Backup not found. Refresh the inventory.");
  }
  const identities = [];
  for (const backup of inventory) {
    const directory = backupDirectory(deployment, backup.name);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory())
      throw new Error("Backup directory changed. Review it again.");
    identities.push([
      backup.name,
      metadata.dev,
      metadata.ino,
      metadata.ctimeMs,
    ]);
    const entries = await readdir(directory);
    const filenames = entries.toSorted((a, b) => a.localeCompare(b));
    for (const file of filenames) {
      const entry = await lstat(path.join(directory, file));
      if (names.includes(backup.name) && !entry.isFile())
        throw new Error(
          "Backup removal requires regular files without symbolic links or subdirectories.",
        );
      identities.push([
        backup.name,
        file,
        entry.dev,
        entry.ino,
        entry.size,
        entry.mtimeMs,
        entry.ctimeMs,
      ]);
    }
  }
  return {
    revision: createHash("sha256")
      .update(JSON.stringify({ selection, inventory, identities }))
      .digest("hex"),
    remove: inventory
      .filter((backup) => names.includes(backup.name))
      .map((backup) => ({
        name: backup.name,
        bytes: backup.files.reduce((total, file) => total + file.bytes, 0),
      })),
    retained: inventory
      .filter((backup) => !names.includes(backup.name))
      .map((backup) => backup.name),
  };
}

/**
The caller holds its deployment lock across review validation and deletion.
*/
export async function removeReviewedBackups(
  deployment: string,
  selection: BackupSelection,
  revision: string,
): Promise<string[]> {
  const plan = await reviewBackupRemoval(deployment, selection);
  if (plan.revision !== revision)
    throw new Error("Backup inventory changed. Review the removal again.");
  for (const backup of plan.remove)
    await rm(backupDirectory(deployment, backup.name), { recursive: true });
  return plan.remove.map((backup) => backup.name);
}

async function readBackupFile(
  filename: string,
  isConfig = false,
): Promise<{ hash: string; content: string }> {
  const before = await lstat(filename);
  if (!before.isFile() || before.size === 0)
    throw new Error(
      "Backup requires non-empty regular files without symbolic links.",
    );
  if (isConfig && before.size > configLimit)
    throw new Error("Backup configuration exceeds the supported size.");
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!isSameFile(before, await handle.stat()))
      throw new Error("Backup changed while being read. Review it again.");
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (isConfig && total > configLimit)
        throw new Error("Backup configuration exceeds the supported size.");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (isConfig) chunks.push(Buffer.from(chunk));
    }
    if (
      total !== before.size ||
      !isSameFile(before, await handle.stat()) ||
      !isSameFile(before, await lstat(filename))
    )
      throw new Error("Backup changed while being read. Review it again.");
    return {
      hash: hash.digest("hex"),
      content: isConfig ? Buffer.concat(chunks).toString("utf8") : "",
    };
  } finally {
    await handle.close();
  }
}

export interface BackupSnapshot<Config> {
  directory: string;
  config: Config;
  fingerprint: string;
  archives: Record<string, string>;
}

export async function readBackupSnapshot<Config>(
  deployment: string,
  backup: string,
  volumes: readonly DataVolumeDefinition[],
  parseConfig: (value: unknown) => Config,
): Promise<BackupSnapshot<Config>> {
  const directory = backupDirectory(deployment, backup);
  const backups = path.join(deployment, "backups");
  for (const candidate of [deployment, backups, directory])
    await requireDirectory(candidate);
  const configFile = await readBackupFile(
    path.join(directory, "configuration.json"),
    true,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(configFile.content);
  } catch {
    throw new Error("Backup configuration is invalid or incomplete.");
  }
  const config = parseConfig(raw);
  const archives: Record<string, string> = {};
  const hashes = [configFile.hash];
  const filenames = new Set<string>();
  for (const volume of volumes) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(volume.archive) ||
      Object.hasOwn(archives, volume.role) ||
      filenames.has(volume.archive)
    )
      throw new Error(
        "Backup artifacts require unique roles and scoped filenames.",
      );
    filenames.add(volume.archive);
    const filename = path.join(directory, volume.archive);
    const file = await readBackupFile(filename);
    archives[volume.role] = filename;
    hashes.push(file.hash);
  }
  for (const candidate of [deployment, backups, directory])
    await requireDirectory(candidate);
  return {
    directory,
    config,
    archives,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(hashes))
      .digest("hex"),
  };
}
