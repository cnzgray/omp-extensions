import { basename } from "node:path";
import { describe, expect, it } from "vitest";

import { matchesGlobs } from "../index";

const CASES: Array<[string[], string, boolean]> = [
	[["**/*.ts"], "src/auth/login.ts", true],
	[["**/*.ts"], "login.ts", true],
	[["**/*.ts"], "src/auth/login.js", false],
	[["src/**"], "src/auth/login.ts", true],
	[["src/**"], "packages/api/index.ts", false],
	// basename matching (pi-rules semantics): `*.md` applies to md files at any depth
	[["*.md"], "README.md", true],
	[["*.md"], "docs/README.md", true],
	[["**/*.{ts,tsx}"], "components/Button.tsx", true],
	[["**/*.{ts,tsx}"], "components/Button.jsx", false],
	[["!**/test/**"], "test/util.test.ts", false],
];

describe("matchesGlobs", () => {
	it.each(CASES)("%#: %j ~ %s -> %s", (globs, rel, want) => {
		expect(matchesGlobs(globs, rel, basename(rel))).toBe(want);
	});
});
