import { AsyncLocalStorage } from "node:async_hooks";
export type TokenUsage = { input: number; output: number };
const context = new AsyncLocalStorage<TokenUsage>();
/** Account for nested search and reviewer calls without mixing concurrent callers. */
export function recordUsage(usage: TokenUsage): void {
  const current = context.getStore();
  if (current) {
    current.input += usage.input;
    current.output += usage.output;
  }
}
export async function captureUsage<T>(
  work: () => Promise<T>,
): Promise<{ value: T; usage: TokenUsage }> {
  const usage = { input: 0, output: 0 };
  const value = await context.run(usage, work);
  return { value, usage };
}
