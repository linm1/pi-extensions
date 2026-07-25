import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PROFILE_RELATIVE_PATH } from "../profile.ts";
import type { DesignProfile } from "../types.ts";
import { findCatalogEntry, TEMPLATE_CATALOG, TEMPLATE_COMMIT_SHA, TEMPLATE_OWNER, TEMPLATE_REPO, type TemplateCatalogEntry } from "./catalog.ts";
import { extractDelegationIntent, looksExplicitlyDelegated, rankTemplates, type CompletionFn, type TemplateRecommendation } from "./recommend.ts";
import { buildSelectionArtifact, TEMPLATE_SELECTION_RELATIVE_PATH, type TemplateSelectionArtifact } from "./selection-artifact.ts";

/**
 * Injectable dependencies for the /app-design command handler. Real
 * implementations hit the network, the active model, the filesystem, and (for
 * manual selection) a local browser gallery; the command-level self-check
 * substitutes deterministic fakes for all of them, per .wayfinder/Request-aware
 * app-design template selection spec.md "Testing Decisions".
 *
 * The seam sits at `runCompletion` (raw nested-completion text in/out), not
 * at a prebuilt RankingResult: the real `rankTemplates()`/`parseRankingResponse()`
 * pipeline (prompt construction against the real catalog, strict validation)
 * always runs, in tests and in production alike. Only the actual model call
 * is faked, so a broken prompt/validation wiring is caught by self-checks.
 * `openTemplateGallery` is the equivalent seam for ticket 02's manual path:
 * the real implementation launches TemplateGallerySession behind
 * buildGalleryHtml(); the self-check fakes only the browser interaction.
 */
export interface AppDesignDeps {
	/** Validates the pinned design profile (and its immutable-fetch reachability). Throws with a user-facing message on any problem. */
	loadProfile: (cwd: string) => Promise<DesignProfile>;
	/** Runs one nested completion and returns its raw text. Real implementations call the active session model; throws propagate as a ranking failure. */
	runCompletion: CompletionFn;
	readTemplateSource: (entry: TemplateCatalogEntry) => Promise<string>;
	writeSelectionArtifact: (cwd: string, artifact: TemplateSelectionArtifact) => Promise<string>;
	sendUserMessage: (message: string, options?: { deliverAs: "followUp" }) => void;
	now: () => Date;
	/**
	 * Opens the local template gallery over the full catalog, with `recommendations`
	 * (exactly 3, ranked) shown first and highlighted, or `null` for the unranked
	 * fallback gallery. Resolves with the confirmed template id, or null on
	 * cancellation/close/disconnect. Only called when ctx.mode === "tui".
	 */
	openTemplateGallery: (args: {
		catalog: readonly TemplateCatalogEntry[];
		recommendations: readonly TemplateRecommendation[] | null;
		signal?: AbortSignal;
	}) => Promise<string | null>;
}

function buildHandoffMessage(args: {
	request: string;
	profile: DesignProfile;
	entry: TemplateCatalogEntry;
	reason: string;
}): string {
	const { request, profile, entry, reason } = args;
	const shortCommit = TEMPLATE_COMMIT_SHA.slice(0, 7);
	return `${request}

Pinned design profile: ${PROFILE_RELATIVE_PATH} (${profile.path} pinned at commit ${profile.commitSha}).
Selected structural template: ${TEMPLATE_SELECTION_RELATIVE_PATH} — "${entry.title}" (${entry.category}), from ${TEMPLATE_OWNER}/${TEMPLATE_REPO}@${shortCommit}. ${reason}

Precedence: the selected template governs adaptable structure, information hierarchy, and relevant interaction ideas — replace its fictional sample content and add, remove, or reorder its sections as this request requires. The pinned design profile governs colors, typography, spacing, and component presentation, and overrides any styling choices from the template.`;
}

/** Reads the source, writes the selection artifact, and delivers the handoff message. Shared by the delegated and manual-gallery paths so both produce the identical artifact/handoff contract. */
async function finalizeSelection(
	deps: AppDesignDeps,
	ctx: ExtensionCommandContext,
	args: { request: string; profile: DesignProfile; entry: TemplateCatalogEntry; reason: string },
): Promise<void> {
	const { request, profile, entry, reason } = args;

	let html: string;
	try {
		html = await deps.readTemplateSource(entry);
	} catch (err) {
		ctx.ui.notify(`Could not read the selected template's source: ${(err as Error).message}`, "error");
		return;
	}

	const artifact = buildSelectionArtifact(entry, html, deps.now());
	try {
		await deps.writeSelectionArtifact(ctx.cwd, artifact);
	} catch (err) {
		ctx.ui.notify(`Could not save the template selection: ${(err as Error).message}`, "error");
		return;
	}

	const message = buildHandoffMessage({ request, profile, entry, reason });
	if (ctx.isIdle()) {
		deps.sendUserMessage(message);
	} else {
		deps.sendUserMessage(message, { deliverAs: "followUp" });
	}

	ctx.ui.notify(`Selected template "${entry.title}" (${entry.category}) and handed off to the agent.`, "info");
}

/**
 * Builds the /app-design command handler. Covers both the explicitly-delegated
 * path (ticket 01: top-ranked recommendation, no browser) and manual gallery
 * selection (ticket 02: full catalog with recommendations highlighted, or the
 * unranked fallback gallery on a ranking failure).
 */
export function createAppDesignHandler(deps: AppDesignDeps) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const request = args.trim();
		if (!request) {
			ctx.ui.notify("Usage: /app-design <implementation request>", "warning");
			return;
		}

		let profile: DesignProfile;
		try {
			profile = await deps.loadProfile(ctx.cwd);
		} catch (err) {
			ctx.ui.notify((err as Error).message, "error");
			return;
		}

		ctx.ui.setStatus("app-design", "Ranking templates for this request...");
		const { ranking, raw } = await rankTemplates(request, TEMPLATE_CATALOG, deps.runCompletion, ctx.signal);
		ctx.ui.setStatus("app-design", undefined);

		if (ranking?.delegated) {
			const top = ranking.recommendations[0];
			if (!top) {
				// Unreachable in practice: a valid RankingResult always has exactly 3
				// recommendations. Kept as a defensive guard against a future change
				// to that invariant.
				ctx.ui.notify(
					"Template choice was delegated, but no valid recommendation was returned. No template was selected.",
					"error",
				);
				return;
			}
			// Defensive: rankTemplates already validates ids against the known catalog.
			const entry = findCatalogEntry(top.templateId);
			if (!entry) {
				ctx.ui.notify(`Selected template id "${top.templateId}" is not a known catalog entry.`, "error");
				return;
			}
			await finalizeSelection(deps, ctx, { request, profile, entry, reason: `Recommended because: ${top.reason}` });
			return;
		}

		if (!ranking) {
			// The nested completion either threw, resolved with an empty/unusable
			// response, or returned text that failed strict validation. Determine
			// whether this was a clearly delegated request (must stop safely per
			// spec story 26 — never silently fall back to a gallery the user
			// didn't ask to see) using the best signal actually available:
			//  - Some completion text exists: trust the model's own delegation
			//    verdict (extractDelegationIntent), exactly as before.
			//  - No usable completion text at all (thrown, or an empty/whitespace
			//    response): the model gave us nothing to read, so fall back to a
			//    conservative, model-independent check on the ORIGINAL request
			//    text itself (looksExplicitlyDelegated) instead of defaulting to
			//    "not delegated" purely because the model call failed.
			const hasUsableRaw = raw !== null && raw.trim().length > 0;
			const explicitlyDelegated = hasUsableRaw ? extractDelegationIntent(raw) : looksExplicitlyDelegated(request);
			if (explicitlyDelegated) {
				ctx.ui.notify(
					"Template choice was delegated, but no valid recommendation could be obtained (the nested completion failed or returned an unusable response). No template was selected.",
					"error",
				);
				return;
			}
			ctx.ui.notify(
				"Could not rank templates for this request (the nested completion failed or returned an unusable response). Showing the full template gallery without recommendations.",
				"info",
			);
		}

		// Manual selection: non-delegated/ambiguous request with a valid ranking,
		// or any ranking failure that wasn't a clear delegation (handled above).
		// The interactive gallery is TUI-only; other modes cannot render it.
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				'Manual template selection requires the interactive TUI mode; this mode cannot open the template gallery. Delegate the choice explicitly (e.g. "let the agent choose the template") to continue without opening a gallery.',
				"error",
			);
			return;
		}

		const recommendations = ranking?.recommendations ?? null;
		ctx.ui.setStatus("app-design", "Opening template gallery...");
		let selectedId: string | null;
		try {
			selectedId = await deps.openTemplateGallery({ catalog: TEMPLATE_CATALOG, recommendations, signal: ctx.signal });
		} catch (err) {
			ctx.ui.setStatus("app-design", undefined);
			ctx.ui.notify(`Could not open the template gallery: ${(err as Error).message}`, "error");
			return;
		}
		ctx.ui.setStatus("app-design", undefined);

		if (selectedId === null) {
			ctx.ui.notify("Template gallery closed or cancelled. No template was selected.", "info");
			return;
		}

		// Defensive: the gallery only ever resolves with a known catalog id.
		const entry = findCatalogEntry(selectedId);
		if (!entry) {
			ctx.ui.notify(`Selected template id "${selectedId}" is not a known catalog entry.`, "error");
			return;
		}

		const recommendation = recommendations?.find((r) => r.templateId === entry.id);
		const reason = recommendation ? `Recommended because: ${recommendation.reason}` : "Selected manually from the full template gallery.";
		await finalizeSelection(deps, ctx, { request, profile, entry, reason });
	};
}
