import type { ComputerMode } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";

/** Exact `true`, matching the other feature switches. Anything else stays off. */
export function restaurantComputerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RESTAURANT_COMPUTER_ENABLED === "true";
}

/** Exact `true`. New workspaces copy `restaurant-templates/` only when this is on. */
export function restaurantStarterBotsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RESTAURANT_STARTER_BOTS_ENABLED === "true";
}

/**
 * Kinds that place every workspace on one machine.
 * `none` has no computer. `desktop` is the host. `wuying` is one configured desktop.
 * Docker, fake, and the remote sandbox providers each allocate a machine per computer.
 */
const SHARED_MACHINE_SANDBOXES = new Set(["none", "desktop", "wuying"]);

export function sandboxSharesOneMachine(kind: string): boolean {
  return SHARED_MACHINE_SANDBOXES.has(kind);
}

export function sharedMachineSandboxMessage(): string {
  return "Each restaurant needs its own computer. This sandbox provider cannot give one.";
}

export class SharedMachineSandboxError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(sharedMachineSandboxMessage());
    this.name = "SharedMachineSandboxError";
    this.kind = kind;
  }
}

/** Refuse to place a restaurant on a provider that cannot keep workspaces apart. */
export function assertRestaurantComputerIsolated(
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!restaurantComputerEnabled(env)) return;
  if (sandboxSharesOneMachine(kind)) throw new SharedMachineSandboxError(kind);
}

export class DedicatedComputerDisabledError extends Error {
  constructor() {
    super("Every bot in this restaurant shares one computer.");
    this.name = "DedicatedComputerDisabledError";
  }
}

/** One computer for the workspace when restaurant computers are on; otherwise the request. */
export function restaurantComputerMode(
  requested: ComputerMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ComputerMode {
  if (restaurantComputerEnabled(env)) return "team";
  return requested === "dedicated" ? "dedicated" : "team";
}

/** Log once per process start. Provision still refuses, so a bad provider cannot boot. */
export function warnIfRestaurantComputerIsShared(
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!restaurantComputerEnabled(env) || !sandboxSharesOneMachine(kind)) return;
  getLogger().warn("restaurant.computer.shared_machine", { provider: kind });
}
