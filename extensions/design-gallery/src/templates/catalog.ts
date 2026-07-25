import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pinned vendoring source for all 20 bundled html-effectiveness templates.
 * See .wayfinder/html-effectiveness-template-inventory-research.md for the
 * verified upstream inventory this manifest is built from.
 */
export const TEMPLATE_OWNER = "anthropics";
export const TEMPLATE_REPO = "html-effectiveness";
export const TEMPLATE_COMMIT_SHA = "58c305be97f47b26b678f2c07dec01d4242268ec";

export const TEMPLATE_SCHEMA_VERSION = 1;

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "vendor");

export interface TemplateCatalogEntry {
	/** Stable internal identifier. Only these ids may enter recommendation or handoff state. */
	id: string;
	title: string;
	category: string;
	/** Concise structural description of the template's layout/behavior. */
	description: string;
	/** Guidance on when this template's structure is a good fit. */
	suitableFor: string;
	/** Filename within ./vendor, verbatim from upstream. */
	sourceFile: string;
}

// prettier-ignore
export const TEMPLATE_CATALOG: readonly TemplateCatalogEntry[] = [
	{ id: "exploration-code-approaches", title: "Debounced search — three approaches", category: "Exploration & Planning", sourceFile: "01-exploration-code-approaches.html",
		description: "Side-by-side comparison of several implementation approaches to the same problem.",
		suitableFor: "Comparing candidate implementation strategies before committing to one." },
	{ id: "exploration-visual-designs", title: "Empty state — four visual directions", category: "Exploration & Planning", sourceFile: "02-exploration-visual-designs.html",
		description: "Grid of alternate visual treatments for the same UI element.",
		suitableFor: "Presenting multiple visual directions for one component or screen." },
	{ id: "implementation-plan", title: "Implementation plan — Comment threads on task cards", category: "Exploration & Planning", sourceFile: "16-implementation-plan.html",
		description: "Structured build plan broken into phases with rationale and open questions.",
		suitableFor: "Describing a plan of work before implementation starts." },
	{ id: "code-review-pr", title: "PR #247 — Review Summary", category: "Code Review & Understanding", sourceFile: "03-code-review-pr.html",
		description: "Summary of a pull request's changed files, findings, and severities.",
		suitableFor: "Presenting a structured code review of a pull request." },
	{ id: "pr-writeup", title: "PR #312 — Move notification delivery onto a queue", category: "Code Review & Understanding", sourceFile: "17-pr-writeup.html",
		description: "Narrative write-up of a completed change with motivation, changes, and tradeoffs.",
		suitableFor: "Explaining the rationale and impact of a completed change." },
	{ id: "code-understanding", title: "How authentication flows through acme/web", category: "Code Review & Understanding", sourceFile: "04-code-understanding.html",
		description: "Walkthrough of how a request or data flows across files and layers.",
		suitableFor: "Explaining how an existing system or flow works end to end." },
	{ id: "design-system", title: "Acme — Design System Reference", category: "Design", sourceFile: "05-design-system.html",
		description: "Reference sheet of design tokens: color, type, and spacing scales.",
		suitableFor: "Documenting the building blocks of a design system." },
	{ id: "component-variants", title: "Acme — Card Variant Matrix", category: "Design", sourceFile: "06-component-variants.html",
		description: "Grid matrix showing every state and variant of one component.",
		suitableFor: "Cataloging the states and variants of a single component." },
	{ id: "prototype-animation", title: "Acme — Task completed micro-interaction", category: "Prototyping", sourceFile: "07-prototype-animation.html",
		description: "Small animated micro-interaction demo with replayable states.",
		suitableFor: "Prototyping one small interaction, transition, or animation." },
	{ id: "prototype-interaction", title: "Acme — Sidebar drag-to-reorder", category: "Prototyping", sourceFile: "08-prototype-interaction.html",
		description: "Interactive drag-and-drop reordering demo.",
		suitableFor: "Prototyping a direct-manipulation interaction such as drag-to-reorder." },
	{ id: "svg-illustrations", title: "Background jobs — header illustrations", category: "Illustrations & Diagrams", sourceFile: "10-svg-illustrations.html",
		description: "Set of inline SVG illustrations suited to section headers.",
		suitableFor: "Adding illustrative header or hero graphics without image assets." },
	{ id: "flowchart-diagram", title: "Deploy pipeline — annotated flowchart", category: "Illustrations & Diagrams", sourceFile: "13-flowchart-diagram.html",
		description: "Annotated flowchart diagram with labeled stages and notes.",
		suitableFor: "Visualizing a pipeline, process, or decision flow." },
	{ id: "slide-deck", title: "Platform Eng — Week of Mar 10", category: "Decks", sourceFile: "09-slide-deck.html",
		description: "Paginated slide-deck layout with per-slide navigation.",
		suitableFor: "Status updates or presentations broken into discrete slides." },
	{ id: "research-feature-explainer", title: "How rate limiting works in acme/api", category: "Research & Learning", sourceFile: "14-research-feature-explainer.html",
		description: "Feature explainer combining prose, diagrams, and worked examples.",
		suitableFor: "Explaining how one specific feature works and why." },
	{ id: "research-concept-explainer", title: "Consistent hashing — an interactive explainer", category: "Research & Learning", sourceFile: "15-research-concept-explainer.html",
		description: "Interactive explainer with manipulable visualizations of a concept.",
		suitableFor: "Teaching a general technical concept through interactive exploration." },
	{ id: "status-report", title: "Acme — Engineering Status — Week 11", category: "Reports", sourceFile: "11-status-report.html",
		description: "Weekly status report with highlights, metrics, and risks.",
		suitableFor: "Recurring status reporting across a team or project." },
	{ id: "incident-report", title: "INC-2025-0412 — Elevated 502s on task sync", category: "Reports", sourceFile: "12-incident-report.html",
		description: "Incident postmortem with timeline, impact, and root cause.",
		suitableFor: "Writing an incident report or postmortem." },
	{ id: "editor-triage-board", title: "Acme — Cycle 14 triage", category: "Custom Editing Interfaces", sourceFile: "18-editor-triage-board.html",
		description: "Kanban-style board of editable cards grouped into columns.",
		suitableFor: "Building a custom triage, kanban, or board-style editor." },
	{ id: "editor-feature-flags", title: "Acme — flags.production.json", category: "Custom Editing Interfaces", sourceFile: "19-editor-feature-flags.html",
		description: "Structured editor over hierarchical configuration data.",
		suitableFor: "Editing structured configuration or JSON-like data." },
	{ id: "editor-prompt-tuner", title: "Acme — Support reply prompt tuner", category: "Custom Editing Interfaces", sourceFile: "20-editor-prompt-tuner.html",
		description: "Split editor with an input pane and a live output preview.",
		suitableFor: "Building a tuning or editing tool with a live preview pane." },
];

if (new Set(TEMPLATE_CATALOG.map((e) => e.id)).size !== TEMPLATE_CATALOG.length) {
	throw new Error("Template catalog has duplicate ids");
}
if (new Set(TEMPLATE_CATALOG.map((e) => e.sourceFile)).size !== TEMPLATE_CATALOG.length) {
	throw new Error("Template catalog has duplicate sourceFiles");
}

export function findCatalogEntry(id: string): TemplateCatalogEntry | undefined {
	return TEMPLATE_CATALOG.find((e) => e.id === id);
}

/** Reads one vendored template's full HTML source from disk. */
export async function readTemplateSource(entry: TemplateCatalogEntry): Promise<string> {
	return readFile(join(VENDOR_DIR, entry.sourceFile), "utf8");
}

export function vendorLicensePath(): string {
	return join(VENDOR_DIR, "LICENSE");
}

// ponytail: runnable integrity check for the vendored catalog (20 unique
// known entries, every referenced artifact present, MIT notice bundled).
// Run with: node --experimental-strip-types src/templates/catalog.ts
async function selfCheck(): Promise<void> {
	const { readdir, stat } = await import("node:fs/promises");

	if (TEMPLATE_CATALOG.length !== 20) {
		throw new Error(`Expected exactly 20 catalog entries, got ${TEMPLATE_CATALOG.length}`);
	}

	const vendorFiles = new Set(await readdir(VENDOR_DIR));
	for (const entry of TEMPLATE_CATALOG) {
		if (!vendorFiles.has(entry.sourceFile)) {
			throw new Error(`Missing vendored artifact for ${entry.id}: ${entry.sourceFile}`);
		}
		const html = await readTemplateSource(entry);
		if (!html.includes("<html")) {
			throw new Error(`${entry.sourceFile} does not look like a self-contained HTML document`);
		}
	}

	if (!TEMPLATE_COMMIT_SHA || !/^[0-9a-f]{40}$/i.test(TEMPLATE_COMMIT_SHA)) {
		throw new Error(`TEMPLATE_COMMIT_SHA is not a full commit sha: ${TEMPLATE_COMMIT_SHA}`);
	}

	const licenseStat = await stat(vendorLicensePath()).catch(() => null);
	if (!licenseStat || !licenseStat.isFile()) {
		throw new Error("Vendored MIT LICENSE file is missing");
	}
	const licenseText = await readFile(vendorLicensePath(), "utf8");
	if (!licenseText.includes("MIT License") || !licenseText.includes("Anthropic PBC")) {
		throw new Error("Vendored LICENSE does not contain the expected MIT notice");
	}

	console.log(`template catalog self-check OK (${TEMPLATE_CATALOG.length} entries, commit ${TEMPLATE_COMMIT_SHA.slice(0, 7)})`);
}

const isMainModule =
	typeof process !== "undefined" &&
	!!process.argv[1] &&
	import.meta.url.includes(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\0");
if (isMainModule) {
	selfCheck().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
