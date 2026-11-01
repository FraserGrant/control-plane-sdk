import { z } from "zod";

export type StateValue = z.infer<ReturnType<typeof z.json>>;
export const stateSlotSchema = z.discriminatedUnion("present", [
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({ present: z.literal(true), value: z.json() }),
]);
export type StateSlot = z.infer<typeof stateSlotSchema>;
export const stateSnapshotSchema = z.strictObject({
  schemaVersion: z.number().int().positive(),
  values: z.record(z.string(), stateSlotSchema),
});
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

export interface StateField {
  path: readonly string[];
  value: z.ZodType<StateValue>;
}
export interface StateMigration {
  from: number;
  to: number;
  renames?: Readonly<Record<string, string>>;
}

function readPath(
  input: Record<string, StateValue>,
  path: readonly string[],
): StateSlot {
  let value: StateValue = input;
  for (const key of path) {
    if (value === null) return { present: false };
    if (typeof value !== "object" || Array.isArray(value))
      throw new TypeError(
        `Expected an object while reading ${path.join(".")}.`,
      );
    if (!Object.hasOwn(value, key)) return { present: false };
    const child: StateValue | undefined = value[key];
    if (child === undefined) throw new Error("State cannot contain undefined.");
    value = child;
  }
  return { present: true, value };
}

/**
Defines the owned fields. Snapshot migrations never invent past values.
*/
export class StateModel {
  constructor(
    readonly version: number,
    readonly fields: Readonly<Record<string, StateField>>,
    readonly migrations: readonly StateMigration[] = [],
  ) {
    z.number().int().positive().parse(version);
    for (const [id, field] of Object.entries(fields)) {
      if (!id || field.path.length === 0)
        throw new Error("State fields need an identity and a nonempty path.");
    }
    const paths = Object.values(fields).map((field) => field.path);
    for (const [index, path] of paths.entries()) {
      if (
        paths.slice(index + 1).some((other) => {
          const shorter = path.length < other.length ? path : other;
          const longer = path.length < other.length ? other : path;
          return shorter.every((key, offset) => key === longer[offset]);
        })
      )
        throw new Error(
          "Managed field paths must not overlap; use one atomic group.",
        );
    }
    const sources = new Set<number>();
    for (const migration of migrations) {
      if (
        !Number.isSafeInteger(migration.from) ||
        migration.from < 1 ||
        migration.to !== migration.from + 1 ||
        migration.to > version ||
        sources.has(migration.from)
      )
        throw new Error(
          "State migrations must form unambiguous single-version steps.",
        );
      sources.add(migration.from);
    }
  }

  private validate(
    snapshot: StateSnapshot,
    requiresComplete: boolean,
  ): StateSnapshot {
    const values = { ...snapshot.values };
    for (const [id, field] of Object.entries(this.fields)) {
      const slot = Object.hasOwn(values, id) ? values[id] : undefined;
      if (slot === undefined) {
        if (requiresComplete)
          throw new Error(`The current state reader omitted ${id}.`);
        continue;
      }
      if (slot.present)
        values[id] = { present: true, value: field.value.parse(slot.value) };
    }
    return { schemaVersion: snapshot.schemaVersion, values };
  }

  capture(input: unknown): StateSnapshot {
    const object = z.record(z.string(), z.json()).parse(input);
    const snapshot: StateSnapshot = {
      schemaVersion: this.version,
      values: Object.fromEntries(
        Object.entries(this.fields).map(([id, field]) => [
          id,
          readPath(object, field.path),
        ]),
      ),
    };
    return this.validate(snapshot, true);
  }

  current(input: unknown): StateSnapshot {
    const snapshot = stateSnapshotSchema.parse(input);
    if (snapshot.schemaVersion !== this.version)
      throw new Error(
        "Read and desired state must use the current schema version.",
      );
    const unexpected = Object.keys(snapshot.values).filter(
      (id) => !Object.hasOwn(this.fields, id),
    );
    if (unexpected.length > 0)
      throw new Error(
        `Current state contains unmanaged fields: ${unexpected.join(", ")}.`,
      );
    return this.validate(snapshot, true);
  }

  upgrade(input: unknown): StateSnapshot {
    let snapshot = stateSnapshotSchema.parse(input);
    if (snapshot.schemaVersion > this.version)
      throw new Error("This state was written by a newer control plane.");
    while (snapshot.schemaVersion < this.version) {
      const migration = this.migrations.find(
        (step) => step.from === snapshot.schemaVersion,
      );
      if (!migration)
        throw new Error(
          `No state migration from schema ${String(snapshot.schemaVersion)}.`,
        );
      const values = new Map(Object.entries(snapshot.values));
      // Copy from the original so chained renames cannot consume their own output.
      const renames = Object.entries(migration.renames ?? {});
      const destinations = new Set(renames.map(([, to]) => to));
      if (destinations.size !== renames.length)
        throw new Error("State migration renames have duplicate destinations.");
      for (const [from, to] of renames) {
        if (!Object.hasOwn(snapshot.values, from)) continue;
        if (from !== to && Object.hasOwn(snapshot.values, to))
          throw new Error(`State migration would overwrite history for ${to}.`);
        values.delete(from);
      }
      for (const [from, to] of renames) {
        const slot = snapshot.values[from];
        if (slot !== undefined && Object.hasOwn(snapshot.values, from))
          values.set(to, slot);
      }
      // Retired fields remain available to classify as released, never deleted live.
      snapshot = {
        schemaVersion: migration.to,
        values: Object.fromEntries(values),
      };
    }
    return this.validate(snapshot, false);
  }
}
