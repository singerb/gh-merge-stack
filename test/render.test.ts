import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, hyperlink, pad, prCell, widestOf } from "../src/render.ts";

// Tests run piped, so isTTY is false and both color and hyperlinks are suppressed.
test("hyperlinks are suppressed when stdout is not a tty", () => {
	assert.equal(hyperlink("https://example.test/pull/1", "#1"), "#1");
});

test("prCell renders a pr number, and an em dash when there is no pr", () => {
	assert.equal(prCell(123, "https://example.test/pull/123").plain, "#123");
	assert.equal(prCell(undefined, undefined).plain, "—");
});

test("padding uses visible width, so zero-width escapes never skew a column", () => {
	// Simulates the TTY case: rendered carries escapes, plain does not.
	const linked = cell("#123", "\x1b]8;;https://x\x1b\\#123\x1b]8;;\x1b\\");
	const padded = pad(linked, 8);
	assert.ok(padded.startsWith(linked.rendered));
	assert.equal(padded.length - linked.rendered.length, 4, "pads by visible width, not string length");
});

test("widestOf measures plain text", () => {
	assert.equal(widestOf([cell("ab", "\x1b[1mab\x1b[0m"), cell("abcd")]), 4);
});
