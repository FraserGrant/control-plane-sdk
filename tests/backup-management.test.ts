import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readBackupConfig,
  reviewBackupRemoval,
  removeReviewedBackups,
} from "@frasergrant/control-plane-sdk/persistence";
import { z } from "zod";

test("reviewed cleanup keeps the newest three across mixed backup names and refuses stale inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fg-sdk-backups-"));
  try {
    const backups = path.join(root, "backups");
    await mkdir(backups);
    for (let index = 1; index <= 5; index++) {
      const name =
        index === 4 ? "004-pre-restore" : String(index).padStart(3, "0");
      const directory = path.join(backups, name);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "configuration.json"),
        JSON.stringify({ version: index, secret: "private" }),
      );
      await utimes(directory, index, index);
    }
    const selection = { keepLatest: 3 };
    const review = await reviewBackupRemoval(root, selection);
    expect(review.remove.map((backup) => backup.name)).toEqual(["002", "001"]);
    expect(review.retained).toEqual(["005", "004-pre-restore", "003"]);
    expect(JSON.stringify(review)).not.toContain("private");
    await writeFile(path.join(backups, "001", "changed.tar"), "new");
    expect(
      removeReviewedBackups(root, selection, review.revision),
    ).rejects.toThrow("inventory changed");
    expect(await readdir(backups)).toHaveLength(5);
    const fresh = await reviewBackupRemoval(root, selection);
    await removeReviewedBackups(root, selection, fresh.revision);
    expect(await readdir(backups)).toHaveLength(3);
    expect(reviewBackupRemoval(root, { keepLatest: 0 })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup metadata and removal reject traversal, linked directories and nonregular files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fg-sdk-backup-scope-"));
  try {
    const backup = path.join(root, "backups", "one");
    await mkdir(backup, { recursive: true });
    await writeFile(
      path.join(backup, "configuration.json"),
      JSON.stringify({ version: 1, secret: "private" }),
    );
    const parse = (value: unknown) =>
      z.object({ version: z.number() }).parse(value);
    expect(await readBackupConfig(root, "one", parse)).toEqual({
      version: 1,
    });
    for (const name of ["..", "../outside", "a/b", String.raw`a\b`, "."]) {
      expect(readBackupConfig(root, name, parse)).rejects.toThrow();
      expect(reviewBackupRemoval(root, { names: [name] })).rejects.toThrow();
    }
    await symlink(backup, path.join(root, "backups", "linked"));
    expect(reviewBackupRemoval(root, { names: ["linked"] })).rejects.toThrow(
      "not found",
    );
    await symlink(
      path.join(backup, "configuration.json"),
      path.join(backup, "linked.json"),
    );
    expect(reviewBackupRemoval(root, { names: ["one"] })).rejects.toThrow(
      "without symbolic links",
    );
    await rm(path.join(backup, "linked.json"));
    const review = await reviewBackupRemoval(root, { names: ["one"] });
    await removeReviewedBackups(root, { names: ["one"] }, review.revision);
    expect(await readdir(path.join(root, "backups"))).toEqual(["linked"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention uses generated backup timestamps even when an older directory is touched later", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fg-sdk-backup-order-"));
  try {
    for (const name of ["1792805878480", "1793013684695-pre-restore-test"])
      await mkdir(path.join(root, "backups", name), { recursive: true });
    await writeFile(
      path.join(root, "backups", "1792805878480", "late-file.tar"),
      "later modification",
    );
    const review = await reviewBackupRemoval(root, { keepLatest: 1 });
    expect(review.remove.map((backup) => backup.name)).toEqual([
      "1792805878480",
    ]);
    expect(review.retained).toEqual(["1793013684695-pre-restore-test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
