import type { Classification, MergePair, Relink } from "./plan.ts";

const isTty = () => process.stdout.isTTY === true;

export const useColor = () => isTty() && process.env.TERM !== "dumb" && !process.env.NO_COLOR;

/**
 * OSC 8 hyperlinks: supported by Ghostty, iTerm2, WezTerm, VS Code and friends, and ignored
 * harmlessly elsewhere. Suppressed when piped so captured output stays clean.
 */
export const useHyperlinks = () =>
	isTty() && process.env.TERM !== "dumb" && process.env.GMS_NO_HYPERLINKS !== "1";

const SGR = { dim: "2", bold: "1", red: "31", green: "32", yellow: "33", blue: "34", cyan: "36" } as const;
export type Style = keyof typeof SGR;

export function style(text: string, ...styles: Style[]): string {
	if (!useColor() || styles.length === 0) return text;
	return `\x1b[${styles.map((s) => SGR[s]).join(";")}m${text}\x1b[0m`;
}

export function hyperlink(url: string, text: string): string {
	if (!useHyperlinks()) return text;
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * A rendered cell that knows its own visible width — escape sequences (hyperlinks, colors)
 * have zero display width, so padding must never use `rendered.length`.
 */
export type Cell = { plain: string; rendered: string };

export const cell = (plain: string, rendered = plain): Cell => ({ plain, rendered });

export function pad(c: Cell, width: number): string {
	return c.rendered + " ".repeat(Math.max(0, width - c.plain.length));
}

export const widestOf = (cells: Cell[]): number => cells.reduce((max, c) => Math.max(max, c.plain.length), 0);

export function prCell(pr: number | undefined, url: string | undefined): Cell {
	if (pr === undefined) return cell("—", style("—", "dim"));
	const label = `#${pr}`;
	return cell(label, url ? hyperlink(url, label) : label);
}

export function stateCell(state: string | undefined): Cell {
	if (!state) return cell("");
	const color: Style = state === "OPEN" ? "green" : state === "MERGED" ? "blue" : "red";
	return cell(state, style(state, color));
}

export function renderMergePlan(pairs: MergePair[]): string {
	const lines = pairs.map(
		(p, i) => `  ${i + 1}. merge ${style(p.parent, "cyan")} into ${style(p.child, "bold")}`,
	);
	return [`merge plan (${pairs.length} step${pairs.length === 1 ? "" : "s"}):`, ...lines].join("\n");
}

const CLASSIFICATION_LABEL: Record<Classification, string> = {
	merged: "merged",
	"merged-remote-gone": "merged, remote deleted",
	abandoned: "abandoned (remote deleted, not merged)",
	new: "new (never pushed)",
	gone: "gone (no local branch)",
	unsubmitted: "no pr yet",
	ok: "open",
};

export function classificationLabel(c: Classification): string {
	return CLASSIFICATION_LABEL[c];
}

export function classificationStyle(c: Classification): Style[] {
	if (c === "abandoned") return ["yellow"];
	if (c === "gone") return ["yellow"];
	if (c === "merged" || c === "merged-remote-gone") return ["blue"];
	return ["dim"];
}

export function renderRelinks(relinks: Relink[]): string[] {
	return relinks.map(
		(r) => `  re-link ${style(r.branch, "bold")}: parent ${r.oldParent} -> ${style(r.newParent, "cyan")}`,
	);
}
