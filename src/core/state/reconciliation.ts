import { createHash } from "node:crypto";
import diff from "microdiff";
import { z } from "zod";
import {
  type StateModel,
  type StateSnapshot,
  type StateSlot,
  type StateValue,
} from "./model.js";

export type ChangeKind =
  "unchanged" | "update" | "drift" | "conflict" | "introduced" | "released";
export interface FieldChange {
  field: string;
  kind: ChangeKind;
  baseline: StateSlot | undefined;
  observed: StateSlot | undefined;
  desired: StateSlot | undefined;
}
export interface StatePlan {
  schemaVersion: number;
  revision: string;
  changes: FieldChange[];
}
export interface StateMutation {
  field: string;
  before: StateSlot;
  after: StateSlot;
}
export interface StateReader {
  read(): Promise<StateSnapshot>;
}
export interface StateAdapter extends StateReader {
  /**
  Validate the whole selection, including dependencies, before any mutation.
  */
  validate(mutations: readonly StateMutation[]): Promise<void>;
  apply(mutations: readonly StateMutation[]): Promise<void>;
}
export interface StateRepository {
  load(): Promise<StateSnapshot | undefined>;
  save(snapshot: StateSnapshot): Promise<void>;
}
export type StateChoices = Readonly<Record<string, "apply" | "keep">>;

function isEqualSlot(left: StateSlot, right: StateSlot): boolean {
  return diff({ slot: left }, { slot: right }).length === 0;
}
function canonical(value: StateValue): StateValue {
  if (Array.isArray(value)) return value.map((child) => canonical(child));
  return value === null || typeof value !== "object"
    ? value
    : Object.fromEntries(
        Object.entries(value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
}
function revision(
  baseline: StateSnapshot | undefined,
  observed: StateSnapshot,
  desired: StateSnapshot,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({ baseline: baseline ?? null, observed, desired }),
      ),
    )
    .digest("hex");
}
function classify(
  baseline: StateSlot | undefined,
  observed: StateSlot,
  desired: StateSlot,
): ChangeKind {
  if (isEqualSlot(observed, desired)) return "unchanged";
  if (baseline === undefined) return "introduced";
  if (isEqualSlot(observed, baseline)) return "update";
  return isEqualSlot(desired, baseline) ? "drift" : "conflict";
}

export function compareState(
  model: StateModel,
  baselineInput: StateSnapshot | undefined,
  observedInput: StateSnapshot,
  desiredInput: StateSnapshot,
): StatePlan {
  const baseline =
    baselineInput === undefined ? undefined : model.upgrade(baselineInput);
  const observed = model.current(observedInput);
  const desired = model.current(desiredInput);
  const changes: FieldChange[] = Object.keys(model.fields)
    .toSorted((left, right) => left.localeCompare(right))
    .map((field) => {
      const current = observed.values[field];
      const proposed = desired.values[field];
      if (current === undefined || proposed === undefined)
        throw new Error(`Missing current state for ${field}.`);
      const previous =
        baseline && Object.hasOwn(baseline.values, field)
          ? baseline.values[field]
          : undefined;
      return {
        field,
        kind: classify(previous, current, proposed),
        baseline: previous,
        observed: current,
        desired: proposed,
      };
    });
  const historical = Object.entries(baseline?.values ?? {});
  for (const [field, previous] of historical) {
    if (!Object.hasOwn(model.fields, field))
      changes.push({
        field,
        kind: "released",
        baseline: previous,
        observed: undefined,
        desired: undefined,
      });
  }
  return {
    schemaVersion: model.version,
    revision: revision(baseline, observed, desired),
    changes,
  };
}

export async function planState(
  model: StateModel,
  repository: StateRepository,
  reader: StateReader,
  desired: StateSnapshot,
): Promise<StatePlan> {
  const [baseline, observed] = await Promise.all([
    repository.load(),
    reader.read(),
  ]);
  return compareState(model, baseline, observed, desired);
}

export function selectedMutations(
  plan: StatePlan,
  choices: StateChoices,
): StateMutation[] {
  const selections = z
    .record(z.string(), z.enum(["apply", "keep"]))
    .parse(choices);
  for (const field of Object.keys(selections)) {
    const change = plan.changes.find((entry) => entry.field === field);
    if (!change || change.kind === "released" || change.kind === "unchanged")
      throw new Error(
        `The reviewed plan has no selectable change for ${field}.`,
      );
  }
  const mutations: StateMutation[] = [];
  for (const change of plan.changes) {
    if (change.kind === "unchanged" || change.kind === "released") continue;
    const choice = Object.hasOwn(selections, change.field)
      ? selections[change.field]
      : undefined;
    if (choice === undefined && change.kind === "conflict")
      throw new Error(
        `Resolve the conflict for ${change.field} before applying.`,
      );
    // Untracked fields and manual edits are preserved unless explicitly accepted.
    const shouldApply =
      choice === "apply" || (choice === undefined && change.kind === "update");
    if (!shouldApply) continue;
    if (change.observed === undefined || change.desired === undefined)
      throw new Error(`Missing state for ${change.field}.`);
    mutations.push({
      field: change.field,
      before: change.observed,
      after: change.desired,
    });
  }
  return mutations;
}

/**
The caller holds its deployment lock across read, apply, verification and save.
*/
export async function applyState(
  model: StateModel,
  repository: StateRepository,
  adapter: StateAdapter,
  desired: StateSnapshot,
  reviewedRevision: string,
  choices: StateChoices = {},
  shouldApplyWithoutMutations = false,
): Promise<StatePlan> {
  const baseline = await repository.load();
  const observed = model.current(await adapter.read());
  const plan = compareState(model, baseline, observed, desired);
  if (plan.revision !== reviewedRevision)
    throw new Error(
      "State changed after review. Read and review the new plan.",
    );
  const mutations = selectedMutations(plan, choices);
  await adapter.validate(mutations);
  if (shouldApplyWithoutMutations || mutations.length > 0)
    await adapter.apply(mutations);
  const verified = model.current(await adapter.read());
  const expected = new Map(
    mutations.map((mutation) => [mutation.field, mutation.after]),
  );
  for (const [field, previous] of Object.entries(observed.values)) {
    const actual = verified.values[field];
    if (
      actual === undefined ||
      !isEqualSlot(expected.get(field) ?? previous, actual)
    )
      throw new Error(
        `State verification failed for ${field}; the baseline was not advanced.`,
      );
  }
  const nextValues = new Map<string, StateSlot>();
  for (const change of plan.changes) {
    if (change.kind === "released") continue;
    const actual = verified.values[change.field];
    if (actual === undefined)
      throw new Error(`Missing verified state for ${change.field}.`);
    // Keeping a change must not turn it into an apparently successful update.
    if (expected.has(change.field) || change.kind === "unchanged")
      nextValues.set(change.field, actual);
    else if (change.baseline !== undefined)
      nextValues.set(change.field, change.baseline);
  }
  const nextBaseline = {
    schemaVersion: model.version,
    values: Object.fromEntries(nextValues),
  };
  await repository.save(nextBaseline);
  return compareState(model, nextBaseline, verified, desired);
}
