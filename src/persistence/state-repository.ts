import {
  stateSnapshotSchema,
  type StateSnapshot,
} from "../core/state/model.js";
import type { StateRepository } from "../core/state/reconciliation.js";
import type { FileStore } from "./file-store.js";

/**
Uses protected atomic writes; the caller holds the scope's operation lock.
*/
export class FileStateRepository implements StateRepository {
  constructor(
    readonly store: Pick<FileStore, "read" | "write">,
    readonly deployment: string,
    readonly file = "infrastructure-state.json",
  ) {}

  async load(): Promise<StateSnapshot | undefined> {
    const value = await this.store.read(this.deployment, this.file);
    return value === undefined ? undefined : stateSnapshotSchema.parse(value);
  }

  async save(snapshot: StateSnapshot): Promise<void> {
    await this.store.write(
      this.deployment,
      this.file,
      stateSnapshotSchema.parse(snapshot),
    );
  }
}
