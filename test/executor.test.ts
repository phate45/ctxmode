import { expect, test } from "bun:test";
import { PolyglotExecutor } from "../src/executor.ts";

const executor = new PolyglotExecutor();
const probe = `const { execSync } = require("child_process");
console.log(String(process.env.BUN_BE_BUN), execSync("printenv BUN_BE_BUN || echo unset").toString().trim());`;

for (const language of ["javascript", "typescript"] as const) {
  test(`${language} code and its children never see BUN_BE_BUN`, async () => {
    const r = await executor.execute({ language, code: probe, timeout: 20_000 });
    expect(r.stdout.trim()).toBe("undefined unset");
  });
}

test("error line numbers are unshifted", async () => {
  const r = await executor.execute({ language: "javascript", code: "\n\nthrow new Error('x');", timeout: 20_000 });
  expect(r.stderr).toMatch(/:3:/);
});
