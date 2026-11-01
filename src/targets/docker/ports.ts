import { createServer } from "node:net";

const probes = new Map<number, Promise<boolean>>();
export async function canBind(port: number): Promise<boolean> {
  const existing = probes.get(port);
  if (existing) return existing;
  const probe = new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
  probes.set(port, probe);
  try {
    return await probe;
  } finally {
    probes.delete(port);
  }
}
