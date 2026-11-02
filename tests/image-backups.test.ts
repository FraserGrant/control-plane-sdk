import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Docker } from "../src/targets/docker/index.js";

test("public Docker image archive transport streams private files and refuses overwrites and daemon import errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdk-image-"));
  const socket = path.join(directory, "docker.sock");
  const payload = Buffer.alloc(512 * 1024, 42);
  let uploaded = Buffer.alloc(0);
  let hasImportError = false;
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url === "/images/snapshot/get") {
      response.end(payload);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    }
    uploaded = Buffer.concat(chunks);
    response.end(
      JSON.stringify(
        hasImportError
          ? { error: "invalid image archive" }
          : { stream: `Loaded image ID: sha256:${"a".repeat(64)}\n` },
      ) + "\n",
    );
  };
  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error("Request failed"),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const docker = new Docker(socket);
    const file = path.join(directory, "snapshot.tar");
    await docker.saveImage("snapshot", file);
    expect(await readFile(file)).toEqual(payload);
    await rejects(docker.saveImage("snapshot", file));
    expect(await docker.loadImage(file)).toEqual([`sha256:${"a".repeat(64)}`]);
    expect(uploaded).toEqual(payload);
    hasImportError = true;
    await rejects(docker.loadImage(file), /invalid image archive/);
    await writeFile(file, "retained");
    expect(await readFile(file, "utf8")).toBe("retained");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
