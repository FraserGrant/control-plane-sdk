/**
Browser-only launch authentication. Each product supplies its storage key.
*/
export class LaunchAuthentication {
  private token: string;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private isRejected = false;

  constructor(private readonly storageKey: string) {
    this.token = sessionStorage.getItem(storageKey) ?? "";
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private acceptFragment(): void {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (!token) return;
    history.replaceState(null, "", location.pathname + location.search);
    this.token = token;
    this.revision += 1;
    this.isRejected = false;
    sessionStorage.setItem(this.storageKey, token);
    this.notify();
  }

  getRevision(): number {
    return this.revision;
  }
  rejected(): boolean {
    return this.isRejected;
  }
  authorization(): string {
    return `Bearer ${this.token}`;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reject(): void {
    if (this.isRejected) return;
    this.isRejected = true;
    this.notify();
  }

  observe(response: Response): Response {
    if (response.status === 401) this.reject();
    return response;
  }

  watchLaunchTokens(): () => void {
    const accept = () => {
      this.acceptFragment();
    };
    accept();
    globalThis.addEventListener("hashchange", accept);
    return () => {
      globalThis.removeEventListener("hashchange", accept);
    };
  }
}
