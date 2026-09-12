// Shared error → user-facing text. Pure (no node: imports), so both the node-side code and the
// sandboxed renderer can use it instead of re-inlining `err instanceof Error ? …` at every catch.
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
