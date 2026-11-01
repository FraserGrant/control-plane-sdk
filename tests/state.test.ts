import { expect, test } from "bun:test";
import { z } from "zod";
import { rejects } from "node:assert/strict";
import {
  StateModel,
  type StateSnapshot,
} from "@frasergrant/control-plane-sdk/core";
import {
  applyState,
  compareState,
  planState,
  type StateAdapter,
  type StateMutation,
  type StateRepository,
} from "@frasergrant/control-plane-sdk/core";

const image = { path: ["image"], value: z.string() };
const memory = { path: ["memory"], value: z.number().nonnegative() };
const v1 = new StateModel(1, { image });
const v2 = new StateModel(2, { image, memory }, [{ from: 1, to: 2 }]);

class MemoryRepository implements StateRepository {
  saves = 0;
  constructor(public baseline: StateSnapshot | undefined) {
    this.baseline = structuredClone(baseline);
  }
  load(): Promise<StateSnapshot | undefined> {
    return Promise.resolve(structuredClone(this.baseline));
  }
  save(snapshot: StateSnapshot): Promise<void> {
    this.baseline = structuredClone(snapshot);
    this.saves++;
    return Promise.resolve();
  }
}
class MemoryAdapter implements StateAdapter {
  reads = 0;
  writes: StateMutation[] = [];
  constructor(public snapshot: StateSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }
  read(): Promise<StateSnapshot> {
    this.reads++;
    return Promise.resolve(structuredClone(this.snapshot));
  }
  validate(): Promise<void> {
    return Promise.resolve();
  }
  apply(mutations: readonly StateMutation[]): Promise<void> {
    this.writes.push(...mutations);
    for (const mutation of mutations)
      this.snapshot.values[mutation.field] = structuredClone(mutation.after);
    return Promise.resolve();
  }
}

test("a conflicting manual memory edit is kept while an independent image update applies and is re-read", async () => {
  const repository = new MemoryRepository(
    v2.capture({ image: "A", memory: 4 }),
  );
  const adapter = new MemoryAdapter(v2.capture({ image: "A", memory: 8 }));
  const desired = v2.capture({ image: "B", memory: 6 });
  const review = await planState(v2, repository, adapter, desired);
  expect(review.changes.map(({ field, kind }) => [field, kind])).toEqual([
    ["image", "update"],
    ["memory", "conflict"],
  ]);
  await rejects(
    applyState(v2, repository, adapter, desired, review.revision),
    /Resolve the conflict/,
  );
  expect(adapter.writes).toEqual([]);
  expect(repository.saves).toBe(0);
  const pending = await applyState(
    v2,
    repository,
    adapter,
    desired,
    review.revision,
    { memory: "keep" },
  );
  expect(adapter.writes.map((mutation) => mutation.field)).toEqual(["image"]);
  expect(adapter.snapshot).toEqual(v2.capture({ image: "B", memory: 8 }));
  expect(repository.baseline).toEqual(v2.capture({ image: "B", memory: 4 }));
  expect(
    pending.changes.find((change) => change.field === "memory")?.kind,
  ).toBe("conflict");
  expect(repository.saves).toBe(1);
  expect(adapter.reads).toBe(4);
});

test("schema expansion introduces RAM without manufacturing a default or a conflict", async () => {
  const repository = new MemoryRepository(v1.capture({ image: "A" }));
  const adapter = new MemoryAdapter(v2.capture({ image: "A", memory: 8 }));
  const desired = v2.capture({ image: "B", memory: 4 });
  const review = await planState(v2, repository, adapter, desired);
  const ram = review.changes.find((change) => change.field === "memory");
  expect(ram?.kind).toBe("introduced");
  expect(ram?.baseline).toBeUndefined();
  const pending = await applyState(
    v2,
    repository,
    adapter,
    desired,
    review.revision,
  );
  expect(adapter.snapshot.values.memory).toEqual({ present: true, value: 8 });
  expect(repository.baseline?.values.memory).toBeUndefined();
  expect(repository.baseline?.schemaVersion).toBe(2);
  expect(
    pending.changes.find((change) => change.field === "memory")?.kind,
  ).toBe("introduced");
  await applyState(v2, repository, adapter, desired, pending.revision, {
    memory: "apply",
  });
  expect(repository.baseline).toEqual(desired);
  expect(adapter.snapshot).toEqual(desired);
});

test("schema contraction releases ownership without deleting or overwriting the live value", async () => {
  const contracted = new StateModel(3, { image }, [{ from: 2, to: 3 }]);
  const repository = new MemoryRepository(
    v2.capture({ image: "A", memory: 8 }),
  );
  const adapter = new MemoryAdapter(
    contracted.capture({ image: "A", memory: 12 }),
  );
  const desired = contracted.capture({ image: "B" });
  const review = await planState(contracted, repository, adapter, desired);
  expect(review.changes.find((change) => change.field === "memory")?.kind).toBe(
    "released",
  );
  await applyState(contracted, repository, adapter, desired, review.revision);
  expect(adapter.writes.map((mutation) => mutation.field)).toEqual(["image"]);
  expect(repository.baseline?.values.memory).toBeUndefined();
  // The adapter never received a deletion for the retired field.
  expect(adapter.writes.some((mutation) => mutation.field === "memory")).toBe(
    false,
  );
});

test("renames carry historical values forward, and ambiguous migrations refuse to overwrite history", () => {
  const old = new StateModel(1, { ram: memory });
  const renamed = new StateModel(2, { memory }, [
    { from: 1, to: 2, renames: { ram: "memory" } },
  ]);
  const plan = compareState(
    renamed,
    old.capture({ memory: 4 }),
    renamed.capture({ memory: 4 }),
    renamed.capture({ memory: 6 }),
  );
  expect(plan.changes[0]?.kind).toBe("update");
  expect(() =>
    renamed.upgrade({
      schemaVersion: 1,
      values: {
        ram: { present: true, value: 4 },
        memory: { present: true, value: 8 },
      },
    }),
  ).toThrow("overwrite history");
  const duplicate = new StateModel(2, { memory }, [
    { from: 1, to: 2, renames: { ram: "memory", other: "memory" } },
  ]);
  expect(() => duplicate.upgrade(old.capture({ memory: 4 }))).toThrow(
    "duplicate destinations",
  );
});

test("future schemas, missing migration steps and incompatible value types are refused", () => {
  expect(() => v1.upgrade(v2.capture({ image: "A", memory: 4 }))).toThrow(
    "newer control plane",
  );
  expect(() =>
    new StateModel(3, { image }).upgrade(v1.capture({ image: "A" })),
  ).toThrow("No state migration");
  expect(() =>
    v2.upgrade({
      schemaVersion: 1,
      values: {
        image: { present: true, value: 123 },
      },
    }),
  ).toThrow();
  expect(() => v2.current(v1.capture({ image: "A" }))).toThrow(
    "current schema",
  );
  expect(() => v2.current({ schemaVersion: 2, values: {} })).toThrow(
    "reader omitted",
  );
  expect(() => new StateModel(3, {}, [{ from: 1.5, to: 2.5 }])).toThrow();
  expect(
    () =>
      new StateModel(1, {
        parent: { path: ["config"], value: z.json() },
        child: { path: ["config", "nested"], value: z.string() },
      }),
  ).toThrow("must not overlap");
});

test("untracked history, a tracked missing value and an explicit null have different meanings", async () => {
  const model = new StateModel(1, {
    optional: { path: ["optional"], value: z.string().nullable() },
  });
  const missing = model.capture({});
  const explicitNull = model.capture({ optional: null });
  const deletion = compareState(model, explicitNull, explicitNull, missing);
  expect(deletion.changes[0]?.kind).toBe("update");
  expect(deletion.changes[0]?.desired).toEqual({ present: false });
  expect(
    compareState(model, undefined, explicitNull, missing).changes[0]?.kind,
  ).toBe("introduced");
  const repository = new MemoryRepository(explicitNull);
  const adapter = new MemoryAdapter(explicitNull);
  await applyState(model, repository, adapter, missing, deletion.revision);
  expect(adapter.snapshot).toEqual(missing);
  expect(repository.baseline).toEqual(missing);
});

test("manual drift defaults to preservation, and a skipped update remains pending", async () => {
  const baseline = v2.capture({ image: "A", memory: 4 });
  const observed = v2.capture({ image: "A", memory: 8 });
  const desired = v2.capture({ image: "B", memory: 4 });
  const repository = new MemoryRepository(baseline);
  const adapter = new MemoryAdapter(observed);
  const review = await planState(v2, repository, adapter, desired);
  expect(review.changes.find((change) => change.field === "memory")?.kind).toBe(
    "drift",
  );
  const pending = await applyState(
    v2,
    repository,
    adapter,
    desired,
    review.revision,
    { image: "keep" },
  );
  expect(adapter.writes).toEqual([]);
  expect(repository.baseline).toEqual(baseline);
  expect(pending.changes.find((change) => change.field === "image")?.kind).toBe(
    "update",
  );
});

test("stale observed, desired or applied state invalidates review before mutations", async () => {
  const baseline = v2.capture({ image: "A", memory: 4 });
  const desired = v2.capture({ image: "B", memory: 4 });
  const modified = v2.capture({ image: "C", memory: 4 });
  const cases = [
    { observed: v2.capture({ image: "A", memory: 8 }), baseline, desired },
    { observed: baseline, baseline: modified, desired },
    { observed: baseline, baseline, desired: modified },
  ];
  for (const changed of cases) {
    const repository = new MemoryRepository(baseline);
    const adapter = new MemoryAdapter(structuredClone(baseline));
    const review = await planState(v2, repository, adapter, desired);
    adapter.snapshot = changed.observed;
    repository.baseline = changed.baseline;
    await rejects(
      applyState(v2, repository, adapter, changed.desired, review.revision),
      /changed after review/,
    );
    expect(adapter.writes).toEqual([]);
    expect(repository.saves).toBe(0);
  }
});

test("validation and failed post-apply observation never advance the baseline", async () => {
  const baseline = v2.capture({ image: "A", memory: 4 });
  const desired = v2.capture({ image: "B", memory: 4 });
  const repository = new MemoryRepository(baseline);
  class RefusingAdapter extends MemoryAdapter {
    override validate(): Promise<void> {
      return Promise.reject(new Error("Incompatible selections"));
    }
  }
  const refused = new RefusingAdapter(baseline);
  const review = await planState(v2, repository, refused, desired);
  await rejects(
    applyState(v2, repository, refused, desired, review.revision),
    /Incompatible/,
  );
  expect(refused.writes).toEqual([]);
  class IgnoringAdapter extends MemoryAdapter {
    override apply(): Promise<void> {
      return Promise.resolve();
    }
  }
  const ignored = new IgnoringAdapter(baseline);
  await rejects(
    applyState(v2, repository, ignored, desired, review.revision),
    /verification failed/,
  );
  expect(repository.saves).toBe(0);
  expect(repository.baseline).toEqual(baseline);
});

test("failed or partially successful adapters do not declare the requested state applied", async () => {
  const baseline = v2.capture({ image: "A", memory: 4 });
  const desired = v2.capture({ image: "B", memory: 6 });
  const repository = new MemoryRepository(baseline);
  class PartialAdapter extends MemoryAdapter {
    override async apply(mutations: readonly StateMutation[]): Promise<void> {
      await super.apply(mutations.slice(0, 1));
      throw new Error("Runtime failed after first write");
    }
  }
  const adapter = new PartialAdapter(baseline);
  const review = await planState(v2, repository, adapter, desired);
  await rejects(
    applyState(v2, repository, adapter, desired, review.revision),
    /Runtime failed/,
  );
  expect(repository.saves).toBe(0);
  const retry = await planState(v2, repository, adapter, desired);
  expect(retry.changes.find((change) => change.field === "image")?.kind).toBe(
    "unchanged",
  );
  expect(retry.changes.find((change) => change.field === "memory")?.kind).toBe(
    "update",
  );
});

test("object key order is immaterial, arrays remain ordered and nested fields form atomic groups", () => {
  const model = new StateModel(1, {
    config: { path: ["config"], value: z.record(z.string(), z.json()) },
  });
  const first = model.capture({ config: { a: 1, b: [1, 2] } });
  const reordered = model.capture({ config: { b: [1, 2], a: 1 } });
  expect(compareState(model, first, first, first).revision).toBe(
    compareState(model, reordered, reordered, reordered).revision,
  );
  const plan = compareState(
    model,
    first,
    model.capture({ config: { a: 2, b: [1, 2] } }),
    model.capture({ config: { a: 1, b: [2, 1] } }),
  );
  expect(plan.changes[0]?.kind).toBe("conflict");
});

test("post-apply verification also protects the fields selected to keep", async () => {
  const baseline = v2.capture({ image: "A", memory: 4 });
  const repository = new MemoryRepository(baseline);
  class ChangingKeptAdapter extends MemoryAdapter {
    override async apply(mutations: readonly StateMutation[]): Promise<void> {
      await super.apply(mutations);
      this.snapshot.values.memory = { present: true, value: 12 };
    }
  }
  const adapter = new ChangingKeptAdapter(
    v2.capture({ image: "A", memory: 8 }),
  );
  const desired = v2.capture({ image: "B", memory: 4 });
  const review = await planState(v2, repository, adapter, desired);
  await rejects(
    applyState(v2, repository, adapter, desired, review.revision),
    /verification failed for memory/,
  );
  expect(repository.saves).toBe(0);
  expect(repository.baseline).toEqual(baseline);
});

test("a selection for a field outside the reviewed plan fails before validation or mutation", async () => {
  const baseline = v1.capture({ image: "A" });
  const desired = v1.capture({ image: "B" });
  const repository = new MemoryRepository(baseline);
  const adapter = new MemoryAdapter(baseline);
  const review = await planState(v1, repository, adapter, desired);
  await rejects(
    applyState(v1, repository, adapter, desired, review.revision, {
      memory: "apply",
    }),
    /no selectable change/,
  );
  expect(adapter.writes).toEqual([]);
  expect(repository.saves).toBe(0);
});
