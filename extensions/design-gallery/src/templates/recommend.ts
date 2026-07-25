import type { TemplateCatalogEntry } from "./catalog.ts";

export interface TemplateRecommendation {
	templateId: string;
	reason: string;
}

/** Structured, validated result of one nested ranking completion. */
export interface RankingResult {
	/** Exactly 3 distinct, known, ordered recommendations. Never fewer: an incomplete or invalid response fails the whole ranking instead. */
	recommendations: TemplateRecommendation[];
	/** True only when the model judged the request as explicitly delegating template choice. */
	delegated: boolean;
}

/** Runs one nested completion. Implementations return the raw model text (JSON, possibly with surrounding prose). */
export type CompletionFn = (systemPrompt: string, userPrompt: string, signal?: AbortSignal) => Promise<string>;

const RANKING_SYSTEM_PROMPT = `You are a template-ranking assistant for a design tool. Given a user's implementation request and a catalog of reusable HTML page structures, recommend the three best-fitting templates and decide whether the user explicitly delegated the final template choice to you.

Respond with ONLY one JSON object (no prose, no markdown fences) matching exactly this shape:
{
  "recommendations": [
    { "templateId": "<catalog id>", "reason": "<one short sentence>" },
    { "templateId": "<catalog id>", "reason": "<one short sentence>" },
    { "templateId": "<catalog id>", "reason": "<one short sentence>" }
  ],
  "delegated": <true|false>
}

Rules:
- "recommendations" must have exactly 3 entries, ordered strongest first, using only "templateId" values from the provided catalog, with no duplicates.
- Each "reason" is a concise, structural justification (why the template's layout/hierarchy fits), not a restatement of the request.
- Set "delegated" to true only when the request clearly hands the template choice to you (e.g. "you pick the template", "agent's choice", "whatever structure fits best"). If the request does not mention template choice at all, or is ambiguous about who decides, set "delegated" to false.`;

function buildUserPrompt(request: string, catalog: readonly TemplateCatalogEntry[]): string {
	const catalogLines = catalog
		.map((e) => `- id=${e.id} | title="${e.title}" | category=${e.category} | ${e.description} | suitable for: ${e.suitableFor}`)
		.join("\n");
	return `User request:\n${request}\n\nCatalog:\n${catalogLines}`;
}

/** Finds the first balanced top-level `{...}` substring, tolerating surrounding prose or code fences. */
function extractJsonObject(raw: string): string | null {
	const start = raw.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < raw.length; i++) {
		if (raw[i] === "{") depth++;
		else if (raw[i] === "}") {
			depth--;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Validates a nested-completion response at the extension boundary. A
 * response is valid only when it has exactly 3 distinct, known template ids
 * with non-empty reasons, in order — anything else (malformed JSON, wrong
 * count, an unknown id, a duplicate id, a missing/empty reason) fails the
 * whole ranking (returns null) rather than silently filtering down to a
 * partial, still-"successful" ranking. Only the delegation flag is coerced:
 * an invalid/missing value defaults to false, since ambiguous delegation
 * must never silently choose a template.
 */
export function parseRankingResponse(raw: string, knownIds: ReadonlySet<string>): RankingResult | null {
	const jsonText = extractJsonObject(raw);
	if (!jsonText) return null;

	let data: unknown;
	try {
		data = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;

	if (!Array.isArray(d.recommendations) || d.recommendations.length !== 3) return null;

	const seen = new Set<string>();
	const recommendations: TemplateRecommendation[] = [];
	for (const item of d.recommendations) {
		if (typeof item !== "object" || item === null) return null;
		const { templateId, reason } = item as Record<string, unknown>;
		if (typeof templateId !== "string" || !knownIds.has(templateId)) return null;
		if (seen.has(templateId)) return null;
		if (typeof reason !== "string" || reason.trim().length === 0) return null;
		seen.add(templateId);
		recommendations.push({ templateId, reason });
	}

	// Invalid/missing delegation values default to false: ambiguous delegation
	// must never silently choose a template.
	const delegated = d.delegated === true;

	return { recommendations, delegated };
}

/** Outcome of one nested ranking completion, including the raw text even when validation failed. */
export interface RankingOutcome {
	/** Null when the completion call itself threw, or the response failed strict validation. */
	ranking: RankingResult | null;
	/** Raw completion text, or null when the completion call itself threw (no text at all). */
	raw: string | null;
}

/**
 * Runs the nested completion and validates its output. `ranking` is null on any failure
 * (network, model, or parse); `raw` is still populated when the call returned text that
 * merely failed strict validation, so a caller can fall back to a lenient delegation check.
 */
export async function rankTemplates(
	request: string,
	catalog: readonly TemplateCatalogEntry[],
	runCompletion: CompletionFn,
	signal?: AbortSignal,
): Promise<RankingOutcome> {
	const userPrompt = buildUserPrompt(request, catalog);
	let raw: string;
	try {
		raw = await runCompletion(RANKING_SYSTEM_PROMPT, userPrompt, signal);
	} catch {
		return { ranking: null, raw: null };
	}
	return { ranking: parseRankingResponse(raw, new Set(catalog.map((e) => e.id))), raw };
}

/**
 * Best-effort, lenient check for whether raw (possibly otherwise-invalid) completion text
 * indicates explicit delegation. Used ONLY to decide whether a *failed* ranking should stop
 * with an error (request was explicitly delegated, per spec story 26) or fall back to the
 * manual gallery (non-delegated or undeterminable) — never to select a template, and never
 * as a substitute for the strict validation in parseRankingResponse().
 */
export function extractDelegationIntent(raw: string): boolean {
	const jsonText = extractJsonObject(raw);
	if (!jsonText) return false;
	try {
		const data: unknown = JSON.parse(jsonText);
		if (typeof data !== "object" || data === null) return false;
		return (data as Record<string, unknown>).delegated === true;
	} catch {
		return false;
	}
}

/**
 * Conservative, model-INDEPENDENT check for explicit delegation wording in the
 * user's original request text. Used ONLY as the last resort when the nested
 * completion produced no usable text at all (it threw, or resolved with an
 * empty/whitespace-only response) — there is no model output to defer to, so
 * this is the sole signal available to tell "clearly delegated, must stop
 * safely per spec story 26" apart from "ambiguous, open the fallback gallery
 * per spec story 25." When any completion text IS available, prefer
 * extractDelegationIntent() over this function — the model's own judgment on
 * the full request is a strictly better signal than this fixed phrase list.
 *
 * Scoped to TEMPLATE/STRUCTURE/LAYOUT choice only: every pattern requires one
 * of those words directly inside the matched phrase, not merely present
 * somewhere else in the request. `/app-design` requests separately delegate
 * (or don't) colors, typography, and other DESIGN.md-governed decisions —
 * "use your choice of colors; I will choose the template" must stay
 * non-delegated for template purposes even though "your choice" appears,
 * because it never pairs with template/structure/layout. Earlier unscoped
 * patterns like bare "you choose"/"your choice"/"up to you" were removed for
 * exactly this reason (see gallery-session task_12e5a2071502 review).
 *
 * Deliberately narrow: matches only the same explicit-delegation phrasing the
 * ranking system prompt itself teaches the model to recognize ("you pick the
 * template", "agent's choice on structure", "whatever structure fits best",
 * and close variants), each requiring the scope word inline. False negatives
 * (missing a real delegation) are safe — the command falls back to the
 * manual gallery, which the user can still use to pick nothing/anything.
 * False positives (wrongly detecting delegation) are NOT safe — they would
 * stop the command instead of opening a gallery the user needed — so this
 * stays intentionally strict/narrow rather than fuzzy.
 */
export function looksExplicitlyDelegated(request: string): boolean {
	const text = request.trim().toLowerCase();
	if (!text) return false;
	const SCOPE = "(template|structure|layout)";
	const patterns: RegExp[] = [
		new RegExp(`\\byou (pick|choose|decide|select) the ${SCOPE}\\b`),
		new RegExp(`\\byour (choice|call|pick) (of|on|for) (the )?${SCOPE}\\b`),
		new RegExp(`\\bagent'?s?\\s+(pick|choice|decision) (of|on|for) (the )?${SCOPE}\\b`),
		new RegExp(`\\blet the agent (pick|choose|decide|select) the ${SCOPE}\\b`),
		new RegExp(`\\b(pick|choose|decide|select) the ${SCOPE} for me\\b`),
		new RegExp(`\\bwhatever ${SCOPE}\\b.{0,40}\\b(fits|works|you think|is best)\\b`),
		new RegExp(`\\bup to you (which|what) ${SCOPE}\\b`),
		new RegExp(`\\b${SCOPE} choice is up to you\\b`),
	];
	return patterns.some((pattern) => pattern.test(text));
}

// ponytail: runnable check for the security-relevant validation branch
// (exact-3 requirement, unknown ids, duplicates, extra prose, empty/missing
// reasons, malformed/invalid delegation). A response that is anything less
// than exactly 3 valid, distinct, known recommendations must fail entirely
// (null), never silently degrade into a partial "successful" ranking.
// Run with: node --experimental-strip-types src/templates/recommend.ts
function selfCheck(): void {
	const known = new Set(["a", "b", "c", "d"]);
	const threeValid = { recommendations: [{ templateId: "a", reason: "fits" }, { templateId: "b", reason: "fits" }, { templateId: "c", reason: "fits" }], delegated: true };

	const clean = parseRankingResponse(JSON.stringify(threeValid), known);
	if (!clean || clean.recommendations.length !== 3 || clean.delegated !== true) {
		throw new Error(`clean case failed: ${JSON.stringify(clean)}`);
	}

	const prosed = parseRankingResponse(
		`Sure, here is my answer:\n\`\`\`json\n${JSON.stringify(threeValid)}\n\`\`\`\nHope that helps!`,
		known,
	);
	if (!prosed || prosed.recommendations.length !== 3 || prosed.recommendations.map((r) => r.templateId).join(",") !== "a,b,c") {
		throw new Error(`prose-wrapped case failed: ${JSON.stringify(prosed)}`);
	}

	const invalidDelegationCoercedFalse = parseRankingResponse(JSON.stringify({ ...threeValid, delegated: "yes" }), known);
	if (!invalidDelegationCoercedFalse || invalidDelegationCoercedFalse.recommendations.length !== 3 || invalidDelegationCoercedFalse.delegated !== false) {
		throw new Error(`invalid-delegation-value case failed: ${JSON.stringify(invalidDelegationCoercedFalse)}`);
	}

	const tooFew = parseRankingResponse(
		JSON.stringify({ recommendations: [{ templateId: "a", reason: "fits" }, { templateId: "b", reason: "fits" }], delegated: true }),
		known,
	);
	if (tooFew !== null) throw new Error(`incomplete (2-item) ranking must fail entirely, got ${JSON.stringify(tooFew)}`);

	const tooMany = parseRankingResponse(
		JSON.stringify({
			recommendations: [
				{ templateId: "a", reason: "fits" },
				{ templateId: "b", reason: "fits" },
				{ templateId: "c", reason: "fits" },
				{ templateId: "d", reason: "fits" },
			],
			delegated: true,
		}),
		known,
	);
	if (tooMany !== null) throw new Error(`4-item ranking must fail entirely, got ${JSON.stringify(tooMany)}`);

	const unknownId = parseRankingResponse(
		JSON.stringify({ recommendations: [{ templateId: "a", reason: "fits" }, { templateId: "unknown-id", reason: "bad" }, { templateId: "c", reason: "fits" }], delegated: true }),
		known,
	);
	if (unknownId !== null) throw new Error(`an unknown id must fail the whole ranking, got ${JSON.stringify(unknownId)}`);

	const duplicateId = parseRankingResponse(
		JSON.stringify({ recommendations: [{ templateId: "a", reason: "fits" }, { templateId: "a", reason: "duplicate" }, { templateId: "c", reason: "fits" }], delegated: true }),
		known,
	);
	if (duplicateId !== null) throw new Error(`a duplicate id must fail the whole ranking, got ${JSON.stringify(duplicateId)}`);

	const emptyReason = parseRankingResponse(
		JSON.stringify({ recommendations: [{ templateId: "a", reason: "fits" }, { templateId: "b", reason: "" }, { templateId: "c", reason: "fits" }], delegated: true }),
		known,
	);
	if (emptyReason !== null) throw new Error(`an empty reason must fail the whole ranking, got ${JSON.stringify(emptyReason)}`);

	const missingReason = parseRankingResponse(
		JSON.stringify({ recommendations: [{ templateId: "a", reason: "fits" }, { templateId: "b" }, { templateId: "c", reason: "fits" }], delegated: true }),
		known,
	);
	if (missingReason !== null) throw new Error(`a missing reason must fail the whole ranking, got ${JSON.stringify(missingReason)}`);

	const unparsable = parseRankingResponse("not json at all", known);
	if (unparsable !== null) throw new Error(`unparsable case should return null, got ${JSON.stringify(unparsable)}`);

	// extractDelegationIntent: lenient delegation peek used only to route a
	// *failed* ranking (ticket 02), independent of full strict validation.
	if (extractDelegationIntent(JSON.stringify({ recommendations: [], delegated: true })) !== true) {
		throw new Error("extractDelegationIntent must detect delegated:true even when recommendations are otherwise invalid");
	}
	if (extractDelegationIntent(JSON.stringify({ recommendations: [], delegated: false })) !== false) {
		throw new Error("extractDelegationIntent must return false for delegated:false");
	}
	if (extractDelegationIntent("not json at all") !== false) {
		throw new Error("extractDelegationIntent must return false for unparsable text");
	}
	if (extractDelegationIntent(JSON.stringify({ delegated: "yes" })) !== false) {
		throw new Error("extractDelegationIntent must return false for a non-boolean delegated value");
	}

	// looksExplicitlyDelegated: conservative, model-independent request-text
	// heuristic, used only when the completion gave back no text at all.
	// Scoped to template/structure/layout choice only (task_12e5a2071502).
	const clearlyDelegatedRequests = [
		"build a dashboard, you pick the template",
		"Build a PR review page — agent's choice on structure.",
		"whatever template fits best is fine",
		"let the agent decide the layout",
		"your call on the template, just build a status page",
		"choose the template for me please",
		"it's up to you which structure to use",
		"the layout choice is up to you",
	];
	for (const request of clearlyDelegatedRequests) {
		if (!looksExplicitlyDelegated(request)) {
			throw new Error(`looksExplicitlyDelegated must detect explicit delegation in: ${JSON.stringify(request)}`);
		}
	}
	const ambiguousOrUndelegatedRequests = [
		"build a dashboard",
		"make it look nice and modern",
		"I already picked a template, just build it",
		"choose sensible defaults for the layout",
		"",
		"   ",
		"build whatever the design needs",
		// Generic/unscoped phrasing that must NOT be read as template delegation:
		// it's about colors or some other decision, not the template/structure/layout.
		"pick one for me",
		"use your choice of colors; I will choose the template",
		"your choice of colors, but I'll pick the template",
		"you choose the color scheme",
		"it's your call on the color palette",
		"pick whatever colors work, I've already chosen the template",
	];
	for (const request of ambiguousOrUndelegatedRequests) {
		if (looksExplicitlyDelegated(request)) {
			throw new Error(`looksExplicitlyDelegated must NOT flag as delegated: ${JSON.stringify(request)}`);
		}
	}

	console.log("template recommendation self-check OK (10 cases)");
}

async function rankTemplatesSelfCheck(): Promise<void> {
	const catalog = [
		{ id: "a", title: "A", category: "Cat", description: "d", suitableFor: "s", sourceFile: "a.html" },
		{ id: "b", title: "B", category: "Cat", description: "d", suitableFor: "s", sourceFile: "b.html" },
		{ id: "c", title: "C", category: "Cat", description: "d", suitableFor: "s", sourceFile: "c.html" },
	] as const;
	const threeValidJson = JSON.stringify({
		recommendations: [
			{ templateId: "a", reason: "fits" },
			{ templateId: "b", reason: "fits" },
			{ templateId: "c", reason: "fits" },
		],
		delegated: true,
	});

	const ok = await rankTemplates("req", catalog, async () => threeValidJson);
	if (!ok.ranking || ok.ranking.recommendations.length !== 3 || ok.raw !== threeValidJson) {
		throw new Error(`rankTemplates success case failed: ${JSON.stringify(ok)}`);
	}

	const thrown = await rankTemplates("req", catalog, async () => {
		throw new Error("network down");
	});
	if (thrown.ranking !== null || thrown.raw !== null) {
		throw new Error(`rankTemplates thrown-completion case must yield {ranking:null, raw:null}, got ${JSON.stringify(thrown)}`);
	}

	const invalidButRawKept = await rankTemplates("req", catalog, async () => "not json at all");
	if (invalidButRawKept.ranking !== null || invalidButRawKept.raw !== "not json at all") {
		throw new Error(`rankTemplates invalid-but-parseable-attempt case failed: ${JSON.stringify(invalidButRawKept)}`);
	}

	console.log("rankTemplates self-check OK (3 cases)");
}

const isMainModule =
	typeof process !== "undefined" &&
	!!process.argv[1] &&
	import.meta.url.includes(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\0");
if (isMainModule) {
	selfCheck();
	rankTemplatesSelfCheck().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
