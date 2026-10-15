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

test("a shebang and a \"use strict\" directive keep working, with unshifted line numbers", async () => {
  const code = `#!/usr/bin/env bun\n"use strict";\nconsole.log(String(process.env.BUN_BE_BUN), (function () { return this; })() === undefined);\nthrow new Error("x");`;
  const r = await executor.execute({ language: "javascript", code, timeout: 20_000 });
  expect(r.stdout.trim()).toBe("undefined true");
  expect(r.stderr).toMatch(/script\.js:4:/);
});

test("shell error line numbers are unshifted", async () => {
  const r = await executor.execute({ language: "shell", code: "true\nfalse-command-xyz", timeout: 20_000 });
  expect(r.stderr).toMatch(/line 2: false-command-xyz/);
});
