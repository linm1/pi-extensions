/**
 * Runnable self-check for the /app-design command boundary: both the
 * explicitly-delegated path (ticket 01) and manual gallery selection (ticket
 * 02 — recommended gallery, non-recommended selection, the unranked fallback
 * gallery, cancellation, mode gating, and busy-session delivery). Captures
 * the command handler exactly as the real `pi` runtime would register it,
 * then drives it with fake nested-completion, profile, artifact, gallery,
 * and sendUserMessage adapters — no live model, network, or browser involved.
 *
 * The fake sits at `runCompletion` (raw text in/out) and `openTemplateGallery`
 * (catalog+recommendations in, chosen id or null out), not at prebuilt
 * results: every case below runs through the real rankTemplates()/
 * parseRankingResponse() pipeline (prompt construction against the real
 * 20-entry catalog, then strict validation) and the real finalizeSelection/
 * buildHandoffMessage wiring, so a broken prompt, validation, or handoff path
 * would be caught here, not just a broken command-level branch. Actual
 * browser lifecycle (open/confirm/cancel/disconnect/close) is covered
 * separately and in isolation by gallery-session.selfcheck.ts.
 *
 * Run with: node --experimental-strip-types src/templates/app-design-command.selfcheck.ts
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import designGalleryExtension from "../index.ts";
import { TEMPLATE_CATALOG } from "./catalog.ts";
import type { AppDesignDeps } from "./app-design-command.ts";

/** Mirrors ExtensionContext["mode"] (not re-exported from the package root) without depending on its export path. */
type FakeMode = "tui" | "rpc" | "json" | "print";

const FAKE_PROFILE = {
	schemaVersion: 1 as const,
	owner: "VoltAgent" as const,
	repo: "awesome-design-md" as const,
	commitSha: "a".repeat(40),
	treeSha: "b".repeat(40),
	blobSha: "c".repeat(40),
	path: "design-md/claude/DESIGN.md",
	githubPermalink: "https://github.com/VoltAgent/awesome-design-md/blob/a.../design-md/claude/DESIGN.md",
	rawApiUrl: "https://api.github.com/repos/VoltAgent/awesome-design-md/git/blobs/c...",
	previewUrl: null,
};

const ENTRY_A = TEMPLATE_CATALOG.find((e) => e.id === "code-review-pr")!;
const ENTRY_B = TEMPLATE_CATALOG.find((e) => e.id === "design-system")!;
const ENTRY_C = TEMPLATE_CATALOG.find((e) => e.id === "slide-deck")!;
const ENTRY_NON_RECOMMENDED = TEMPLATE_CATALOG.find((e) => e.id === "incident-report")!;
const FAKE_HTML = "<html><body>FAKE TEMPLATE</body></html>";

/** Raw nested-completion text a real model would return: exactly 3 known, distinct ids with reasons. */
function threeValidRankingJson(delegated: boolean): string {
	return JSON.stringify({
		recommendations: [
			{ templateId: ENTRY_A.id, reason: "matches structure" },
			{ templateId: ENTRY_B.id, reason: "also fits" },
			{ templateId: ENTRY_C.id, reason: "reasonable fallback" },
		],
		delegated,
	});
}

type Notification = { message: string; level: string };
type SentMessage = { message: string; options?: { deliverAs?: string } };
type GalleryCall = { catalogSize: number; recommendations: unknown };

interface Harness {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	notifications: Notification[];
	sent: SentMessage[];
	galleryCalls: GalleryCall[];
	makeCtx: (idle: boolean, mode?: FakeMode) => ExtensionCommandContext;
}

function buildHarness(overrides: Partial<AppDesignDeps>): Harness {
	const sent: SentMessage[] = [];
	const galleryCalls: GalleryCall[] = [];
	let captured: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const fakePi = {
		on: () => {},
		registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			if (name === "app-design") captured = def.handler;
		},
		sendUserMessage: (message: string, options?: { deliverAs?: string }) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	// openTemplateGallery is handled specially (not spread verbatim) so every
	// test's override still gets recorded into galleryCalls, instead of each
	// test having to remember to push into it itself.
	const { openTemplateGallery: resolveGallery, ...restOverrides } = overrides;
	(designGalleryExtension as (pi: ExtensionAPI, overrides?: Partial<AppDesignDeps>) => void)(fakePi, {
		sendUserMessage: (message, options) => fakePi.sendUserMessage(message, options),
		openTemplateGallery: async (args) => {
			galleryCalls.push({ catalogSize: args.catalog.length, recommendations: args.recommendations });
			return resolveGallery ? resolveGallery(args) : null; // default: cancellation, unless a test overrides it
		},
		...restOverrides,
	});
	if (!captured) throw new Error("app-design command was not registered");
	const handler = captured;

	const notifications: Notification[] = [];
	const makeCtx = (idle: boolean, mode: FakeMode = "tui"): ExtensionCommandContext =>
		({
			cwd: "/fake/cwd",
			mode,
			signal: undefined,
			isIdle: () => idle,
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setStatus: () => {},
			},
		}) as unknown as ExtensionCommandContext;

	return { handler, notifications, sent, galleryCalls, makeCtx };
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

let writtenArtifact: unknown;

function successDeps(delegated = true): Partial<AppDesignDeps> {
	return {
		loadProfile: async () => FAKE_PROFILE,
		runCompletion: async () => threeValidRankingJson(delegated),
		readTemplateSource: async () => FAKE_HTML,
		writeSelectionArtifact: async (_cwd, artifact) => {
			writtenArtifact = artifact;
			return "/fake/cwd/.pi/template-selection.json";
		},
		now: () => new Date("2026-07-25T00:00:00.000Z"),
	};
}

async function main(): Promise<void> {
	// 1. Missing profile stops before ranking; no artifact, no message.
	{
		writtenArtifact = undefined;
		let completionCalled = false;
		const h = buildHarness({
			loadProfile: async () => {
				throw new Error("No pinned design profile at .pi/design-profile.json. Run /design-gallery first.");
			},
			runCompletion: async () => {
				completionCalled = true;
				return threeValidRankingJson(true);
			},
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(!completionCalled, "missing-profile: nested completion must not be called");
		assert(h.sent.length === 0, "missing-profile: no message sent");
		assert(writtenArtifact === undefined, "missing-profile: no artifact written");
		assert(h.notifications.some((n) => n.level === "error" && n.message.includes("design-profile.json")), "missing-profile: actionable error notification");
	}

	// 2. Unparsable nested-completion output with no delegation signal falls
	// back to the unranked gallery (ticket 02) instead of hard-failing; a
	// cancelled gallery still ends with no artifact/message.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => "not json at all",
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "ranking-failure-fallback: gallery was opened exactly once");
		assert(h.galleryCalls[0].recommendations === null, "ranking-failure-fallback: gallery opened with no recommendations (unranked)");
		assert(h.galleryCalls[0].catalogSize === TEMPLATE_CATALOG.length, "ranking-failure-fallback: gallery received the full catalog");
		assert(h.sent.length === 0, "ranking-failure-fallback: cancelled gallery sends no message");
		assert(writtenArtifact === undefined, "ranking-failure-fallback: cancelled gallery writes no artifact");
		assert(
			h.notifications.some((n) => n.level === "info" && n.message.toLowerCase().includes("full template gallery")),
			"ranking-failure-fallback: informative notification about the fallback",
		);
		assert(
			h.notifications.some((n) => n.level === "info" && n.message.toLowerCase().includes("no template was selected")),
			"ranking-failure-fallback: cancellation notification",
		);
	}

	// 3. A partial delegated ranking (2 valid + 1 unknown id, via the real
	// parser) must fail entirely, not silently hand off with fewer than 3
	// recommendations — and because the raw text clearly says delegated:true,
	// it must stop with an error rather than opening a gallery the user never
	// asked to see (spec story 26).
	{
		writtenArtifact = undefined;
		const partialJson = JSON.stringify({
			recommendations: [
				{ templateId: ENTRY_A.id, reason: "ok" },
				{ templateId: "not-a-real-catalog-id", reason: "unknown" },
				{ templateId: ENTRY_B.id, reason: "ok" },
			],
			delegated: true,
		});
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => partialJson,
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.galleryCalls.length === 0, "delegated-ranking-failure: gallery must never open for a clearly-delegated request");
		assert(h.sent.length === 0, "delegated-ranking-failure: no message sent");
		assert(writtenArtifact === undefined, "delegated-ranking-failure: no artifact written, not even for a partial/degraded selection");
		assert(h.notifications.some((n) => n.level === "error"), "delegated-ranking-failure: error notification, not a silent partial success or gallery fallback");
	}

	// 3a. Thrown completion + clearly delegated request text: no raw text at
	// all is available, so the model-independent looksExplicitlyDelegated()
	// check on the ORIGINAL request must catch this and stop safely — a
	// gallery must never open for a request that explicitly said "you pick".
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => {
				throw new Error("model unavailable");
			},
		});
		await h.handler("build a dashboard, you pick the template", h.makeCtx(true));
		assert(h.galleryCalls.length === 0, "thrown-completion-delegated: gallery must never open for a clearly-delegated request");
		assert(h.sent.length === 0, "thrown-completion-delegated: no message sent");
		assert(writtenArtifact === undefined, "thrown-completion-delegated: no artifact written");
		assert(h.notifications.some((n) => n.level === "error"), "thrown-completion-delegated: error notification, not a silent gallery fallback");
	}

	// 3b. Thrown completion + ordinary (non-delegated) request text: falls
	// back to the unranked gallery, exactly like an unparsable response would.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => {
				throw new Error("model unavailable");
			},
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "thrown-completion-non-delegated: gallery opened once");
		assert(h.galleryCalls[0].recommendations === null, "thrown-completion-non-delegated: gallery opened unranked");
		assert(h.sent.length === 0, "thrown-completion-non-delegated: cancelled gallery sends no message");
		assert(writtenArtifact === undefined, "thrown-completion-non-delegated: no artifact written");
	}

	// 3c. Empty (whitespace-only) completion response + clearly delegated
	// request text: same as a thrown completion, there is no usable raw text,
	// so the request-text check must still catch this and stop safely.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => "   ",
		});
		await h.handler("agent's choice on the template, build a status page", h.makeCtx(true));
		assert(h.galleryCalls.length === 0, "empty-response-delegated: gallery must never open for a clearly-delegated request");
		assert(h.sent.length === 0, "empty-response-delegated: no message sent");
		assert(writtenArtifact === undefined, "empty-response-delegated: no artifact written");
		assert(h.notifications.some((n) => n.level === "error"), "empty-response-delegated: error notification, not a silent gallery fallback");
	}

	// 3d. Empty completion response + ordinary (non-delegated) request text:
	// falls back to the unranked gallery.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => "",
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "empty-response-non-delegated: gallery opened once");
		assert(h.galleryCalls[0].recommendations === null, "empty-response-non-delegated: gallery opened unranked");
		assert(h.sent.length === 0, "empty-response-non-delegated: cancelled gallery sends no message");
		assert(writtenArtifact === undefined, "empty-response-non-delegated: no artifact written");
	}

	// 3e. Thrown completion + a request that delegates COLORS, not the
	// template ("use your choice of colors; I will choose the template" —
	// task_12e5a2071502 regression): looksExplicitlyDelegated() must stay
	// scoped to template/structure/layout, so this still falls back to the
	// unranked gallery instead of stopping with a delegated-ranking error.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => {
				throw new Error("model unavailable");
			},
		});
		await h.handler("use your choice of colors; I will choose the template", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "thrown-completion-color-delegation-only: gallery opened once (not a template delegation)");
		assert(h.galleryCalls[0].recommendations === null, "thrown-completion-color-delegation-only: gallery opened unranked");
		assert(h.sent.length === 0, "thrown-completion-color-delegation-only: no message sent");
		assert(writtenArtifact === undefined, "thrown-completion-color-delegation-only: no artifact written");
	}

	// 3f. Same non-template delegation wording, but with an empty completion
	// response instead of a thrown error — same expected outcome.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => "",
		});
		await h.handler("your choice of colors, but I'll pick the template myself", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "empty-response-color-delegation-only: gallery opened once (not a template delegation)");
		assert(h.galleryCalls[0].recommendations === null, "empty-response-color-delegation-only: gallery opened unranked");
		assert(h.sent.length === 0, "empty-response-color-delegation-only: no message sent");
		assert(writtenArtifact === undefined, "empty-response-color-delegation-only: no artifact written");
	}

	// 4. Ambiguous/non-delegated request with a valid ranking opens the gallery
	// with the 3 recommendations; selecting the top recommendation completes
	// the same artifact/handoff contract as the delegated path.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => threeValidRankingJson(false),
			readTemplateSource: async () => FAKE_HTML,
			writeSelectionArtifact: async (_cwd, artifact) => {
				writtenArtifact = artifact;
				return "/fake/cwd/.pi/template-selection.json";
			},
			now: () => new Date("2026-07-25T00:00:00.000Z"),
			openTemplateGallery: async () => ENTRY_A.id,
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "manual-recommended: gallery opened once");
		const recs = h.galleryCalls[0].recommendations as Array<{ templateId: string }>;
		assert(!!recs && recs.length === 3 && recs[0].templateId === ENTRY_A.id, "manual-recommended: gallery received the 3 ranked recommendations");
		assert(h.sent.length === 1, "manual-recommended: exactly one message sent");
		assert(h.sent[0].message.includes("Recommended because:"), "manual-recommended: handoff cites the recommendation reason");
		assert(!!writtenArtifact, "manual-recommended: artifact was written");
		assert((writtenArtifact as Record<string, unknown>).templateId === ENTRY_A.id, "manual-recommended: artifact matches the selected recommended template");
	}

	// 5. Manual selection of a template that was NOT among the 3 recommendations.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => threeValidRankingJson(false),
			readTemplateSource: async () => FAKE_HTML,
			writeSelectionArtifact: async (_cwd, artifact) => {
				writtenArtifact = artifact;
				return "/fake/cwd/.pi/template-selection.json";
			},
			now: () => new Date("2026-07-25T00:00:00.000Z"),
			openTemplateGallery: async () => ENTRY_NON_RECOMMENDED.id,
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.sent.length === 1, "manual-non-recommended: exactly one message sent");
		assert(h.sent[0].message.includes("Selected manually from the full template gallery."), "manual-non-recommended: handoff reflects a non-recommended manual pick");
		assert(!h.sent[0].message.includes("Recommended because:"), "manual-non-recommended: must not falsely claim a recommendation reason");
		assert((writtenArtifact as Record<string, unknown>).templateId === ENTRY_NON_RECOMMENDED.id, "manual-non-recommended: artifact matches the selected non-recommended template");
	}

	// 6. Cancelling the gallery (default harness behavior: resolves null) writes nothing and sends nothing.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => threeValidRankingJson(false),
		});
		await h.handler("build a dashboard", h.makeCtx(true));
		assert(h.galleryCalls.length === 1, "cancellation: gallery opened once");
		assert(h.sent.length === 0, "cancellation: no message sent");
		assert(writtenArtifact === undefined, "cancellation: no artifact written");
		assert(h.notifications.some((n) => n.level === "info" && n.message.includes("cancelled")), "cancellation: informative notification");
	}

	// 7. Mode gating: a non-TUI mode cannot open the gallery for manual
	// selection; it must fail loudly instead of silently doing nothing.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => threeValidRankingJson(false),
		});
		await h.handler("build a dashboard", h.makeCtx(true, "rpc"));
		assert(h.galleryCalls.length === 0, "mode-gating: gallery must never open outside tui mode");
		assert(h.sent.length === 0, "mode-gating: no message sent");
		assert(writtenArtifact === undefined, "mode-gating: no artifact written");
		assert(
			h.notifications.some((n) => n.level === "error" && n.message.toLowerCase().includes("tui")),
			"mode-gating: clear unsupported-mode error",
		);
	}

	// 8. Successful delegated choice, delivered immediately while idle, via the real ranking pipeline.
	{
		writtenArtifact = undefined;
		const h = buildHarness(successDeps());
		await h.handler("build a PR review page", h.makeCtx(true));
		assert(h.galleryCalls.length === 0, "delegated-idle: gallery must never open on the delegated path");
		assert(h.sent.length === 1, "delegated-idle: exactly one message sent");
		assert(h.sent[0].options === undefined, "delegated-idle: delivered immediately (no deliverAs)");
		const msg = h.sent[0].message;
		assert(msg.startsWith("build a PR review page"), "delegated-idle: message includes original request");
		assert(msg.includes(FAKE_PROFILE.path) && msg.includes(FAKE_PROFILE.commitSha), "delegated-idle: message references pinned design profile");
		assert(msg.includes(ENTRY_A.title), "delegated-idle: message references the top-ranked (first) template title");
		assert(msg.includes("governs adaptable structure") && msg.includes("governs colors, typography, spacing"), "delegated-idle: precedence contract stated");
		assert(!!writtenArtifact, "delegated-idle: artifact was written");
		const artifact = writtenArtifact as Record<string, unknown>;
		assert(artifact.schemaVersion === 1, "delegated-idle: artifact schemaVersion");
		assert(artifact.templateId === ENTRY_A.id, "delegated-idle: artifact templateId is the top-ranked recommendation");
		assert(artifact.html === FAKE_HTML, "delegated-idle: artifact carries full selected HTML source");
	}

	// 9. The real prompt-construction wiring reaches the fake completion: the
	// request text and every known catalog id land in the user prompt, the
	// exact-3 contract lands in the system prompt, and no full template HTML
	// (which would waste context, per the spec's Testing Decisions) leaks in.
	{
		writtenArtifact = undefined;
		let capturedSystemPrompt = "";
		let capturedUserPrompt = "";
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async (systemPrompt, userPrompt) => {
				capturedSystemPrompt = systemPrompt;
				capturedUserPrompt = userPrompt;
				return threeValidRankingJson(true);
			},
			readTemplateSource: async () => FAKE_HTML,
			writeSelectionArtifact: async (_cwd, artifact) => {
				writtenArtifact = artifact;
				return "/fake/cwd/.pi/template-selection.json";
			},
			now: () => new Date("2026-07-25T00:00:00.000Z"),
		});
		await h.handler("build a PR review page with inline diff comments", h.makeCtx(true));
		assert(h.sent.length === 1, "prompt-wiring: selection still succeeded");
		assert(capturedUserPrompt.includes("build a PR review page with inline diff comments"), "prompt-wiring: user prompt carries the request verbatim");
		assert(
			TEMPLATE_CATALOG.every((e) => capturedUserPrompt.includes(`id=${e.id}`)),
			"prompt-wiring: all 20 known catalog ids reach the ranker",
		);
		assert(!capturedUserPrompt.includes("<html"), "prompt-wiring: full template HTML must not be sent to the ranker, only compact metadata");
		assert(capturedSystemPrompt.includes("exactly 3 entries"), "prompt-wiring: system prompt states the exact-3 contract");
	}

	// 10. Successful delegated choice while busy is delivered as a follow-up.
	{
		writtenArtifact = undefined;
		const h = buildHarness(successDeps());
		await h.handler("build a PR review page", h.makeCtx(false));
		assert(h.sent.length === 1, "delegated-busy: exactly one message sent");
		assert(h.sent[0].options?.deliverAs === "followUp", "delegated-busy: delivered as follow-up");
	}

	// 11. Manual gallery choice while busy is also delivered as a follow-up
	// (finalizeSelection is shared by both paths, exercised here via the gallery).
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			loadProfile: async () => FAKE_PROFILE,
			runCompletion: async () => threeValidRankingJson(false),
			readTemplateSource: async () => FAKE_HTML,
			writeSelectionArtifact: async (_cwd, artifact) => {
				writtenArtifact = artifact;
				return "/fake/cwd/.pi/template-selection.json";
			},
			now: () => new Date("2026-07-25T00:00:00.000Z"),
			openTemplateGallery: async () => ENTRY_A.id,
		});
		await h.handler("build a PR review page", h.makeCtx(false));
		assert(h.sent.length === 1, "manual-busy: exactly one message sent");
		assert(h.sent[0].options?.deliverAs === "followUp", "manual-busy: delivered as follow-up");
	}

	// 12. Artifact-write failure stops safely without sending a message.
	{
		writtenArtifact = undefined;
		const h = buildHarness({
			...successDeps(),
			writeSelectionArtifact: async () => {
				throw new Error("disk full");
			},
		});
		await h.handler("build a PR review page", h.makeCtx(true));
		assert(h.sent.length === 0, "artifact-write-failure: no message sent");
		assert(h.notifications.some((n) => n.level === "error" && n.message.includes("disk full")), "artifact-write-failure: actionable error");
	}

	// 13. Empty request shows usage and touches nothing else.
	{
		writtenArtifact = undefined;
		let loadProfileCalled = false;
		const h = buildHarness({
			loadProfile: async () => {
				loadProfileCalled = true;
				return FAKE_PROFILE;
			},
		});
		await h.handler("   ", h.makeCtx(true));
		assert(!loadProfileCalled, "empty-request: stops before profile loading");
		assert(h.notifications.some((n) => n.level === "warning"), "empty-request: usage warning");
	}

	console.log("app-design command self-check OK (19 cases)");
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
