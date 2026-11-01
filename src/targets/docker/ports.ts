import { createServer } from "node:net";

const probes = new Map<string, Promise<boolean>>();
export async function canBind(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  const key = `${host}:${String(port)}`;
  const existing = probes.get(key);
  if (existing) return existing;
  const probe = new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
  probes.set(key, probe);
  try {
    return await probe;
  } finally {
    probes.delete(key);
  }
}
