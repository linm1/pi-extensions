import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GallerySession } from "./browser-session.ts";
import { discoverCatalog, fetchDesignMdByBlobSha } from "./github.ts";
import { buildProfile, PROFILE_RELATIVE_PATH, readAndValidateProfile, writeProfileAtomic } from "./profile.ts";
import { type AppDesignDeps, createAppDesignHandler } from "./templates/app-design-command.ts";
import { readTemplateSource, type TemplateCatalogEntry } from "./templates/catalog.ts";
import { buildGalleryHtml, type GalleryCatalogItem } from "./templates/gallery-page.ts";
import { TemplateGallerySession } from "./templates/gallery-session.ts";
import type { TemplateRecommendation } from "./templates/recommend.ts";
import { writeTemplateSelectionAtomic } from "./templates/selection-artifact.ts";
import type { DesignProfile, PinnedCatalog } from "./types.ts";

const GALLERY_ROOT_URL = "https://getdesign.md/";

/** Validates the pinned profile and confirms its immutable DESIGN.md blob is still fetchable. */
async function loadValidatedProfile(cwd: string): Promise<DesignProfile> {
	const profile = await readAndValidateProfile(cwd);
	try {
		// Validate the pinned content is fetchable by blobSha; content itself is discarded.
		// Never falls back to `main` or live getdesign.md preview content.
		await fetchDesignMdByBlobSha(profile.blobSha);
	} catch (err) {
		throw new Error(`Could not fetch pinned DESIGN.md by blobSha: ${(err as Error).message}`);
	}
	return profile;
}

// Extension-instance-scoped state. Reset on /reload, which is correct: a
// reload gets a fresh catalog cache and no dangling browser session handle.
let cachedCatalog: PinnedCatalog | null = null;
let activeSession: GallerySession | null = null;
// Separate from `activeSession`: /design-gallery and /app-design's manual
// gallery are two different browser sessions that can never legitimately
// overlap with each other's kind, so each keeps its own single-active-session
// slot (re-entry only closes the stale session of the *same* command).
let activeTemplateGallerySession: TemplateGallerySession | null = null;

async function closeActiveSession(): Promise<void> {
	const session = activeSession;
	activeSession = null;
	await session?.close();
}

async function closeActiveTemplateGallerySession(): Promise<void> {
	const session = activeTemplateGallerySession;
	activeTemplateGallerySession = null;
	await session?.close();
}

/** Real openTemplateGallery: builds the local gallery page and drives one TemplateGallerySession end to end. */
async function openTemplateGalleryReal(args: {
	catalog: readonly TemplateCatalogEntry[];
	recommendations: readonly TemplateRecommendation[] | null;
	signal?: AbortSignal;
}): Promise<string | null> {
	// Re-entry closes any stale gallery before starting another (only one
	// active template-gallery session per extension instance).
	await closeActiveTemplateGallerySession();

	const items: GalleryCatalogItem[] = await Promise.all(
		args.catalog.map(async (entry) => ({ entry, html: await readTemplateSource(entry) })),
	);
	const html = buildGalleryHtml(items, args.recommendations);
	const knownIds = new Set(args.catalog.map((e) => e.id));

	const session = new TemplateGallerySession();
	activeTemplateGallerySession = session;

	const onAbort = () => {
		void session.close();
	};
	args.signal?.addEventListener("abort", onAbort);
	try {
		await session.open(html, knownIds);
		return await session.waitForSelection();
	} finally {
		args.signal?.removeEventListener("abort", onAbort);
		if (activeTemplateGallerySession === session) activeTemplateGallerySession = null;
		await session.close();
	}
}

/** Builds real AppDesignDeps for one command invocation, letting a test override any subset. */
function buildAppDesignDeps(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	overrides: Partial<AppDesignDeps> = {},
): AppDesignDeps {
	return {
		loadProfile: overrides.loadProfile ?? loadValidatedProfile,
		// Dynamic import: "@earendil-works/pi-ai/compat" only resolves via the
		// real `pi` runtime's jiti aliases, never under plain `node`. Deferring
		// the import means self-checks (which always override runCompletion)
		// never have to resolve it. The real recommend.ts rankTemplates()
		// pipeline (prompt construction + strict validation) is called by
		// app-design-command.ts itself, so both real and faked completions run
		// through the same production wiring.
		runCompletion:
			overrides.runCompletion ??
			(async (systemPrompt, userPrompt, signal) => {
				const { createModelCompletion } = await import("./templates/model-completion.ts");
				return createModelCompletion(ctx)(systemPrompt, userPrompt, signal);
			}),
		readTemplateSource: overrides.readTemplateSource ?? readTemplateSource,
		writeSelectionArtifact: overrides.writeSelectionArtifact ?? writeTemplateSelectionAtomic,
		sendUserMessage: overrides.sendUserMessage ?? ((message, options) => pi.sendUserMessage(message, options)),
		now: overrides.now ?? (() => new Date()),
		openTemplateGallery: overrides.openTemplateGallery ?? openTemplateGalleryReal,
	};
}

/**
 * @param appDesignOverrides Test-only seam: substitutes fake AppDesignDeps for
 * the /app-design command's real model/filesystem/network dependencies. Never
 * passed by the real `pi` runtime.
 */
export default function (pi: ExtensionAPI, appDesignOverrides?: Partial<AppDesignDeps>) {
	pi.on("session_shutdown", async () => {
		await closeActiveSession();
		await closeActiveTemplateGallerySession();
	});

	pi.registerCommand("design-gallery", {
		description: "Browse the pinned awesome-design-md catalog via getdesign.md and confirm a design to pin",
		handler: async (_args, ctx) => {
			if (activeSession) {
				ctx.ui.notify("Closing the previous design-gallery browser session first.", "info");
				await closeActiveSession();
			}

			ctx.ui.setStatus("design-gallery", "Discovering catalog...");
			let catalog: PinnedCatalog;
			try {
				catalog = await discoverCatalog(cachedCatalog);
				cachedCatalog = catalog;
			} catch (err) {
				ctx.ui.setStatus("design-gallery", undefined);
				ctx.ui.notify(`Catalog discovery failed: ${(err as Error).message}`, "error");
				return;
			}

			if (catalog.records.size === 0) {
				ctx.ui.setStatus("design-gallery", undefined);
				ctx.ui.notify("Pinned catalog has no design-md/*/DESIGN.md entries.", "error");
				return;
			}

			const knownSlugs = new Set(catalog.records.keys());
			const session = new GallerySession();
			activeSession = session;
			const shortSha = catalog.commitSha.slice(0, 7);

			try {
				ctx.ui.setStatus("design-gallery", `Opening browser (${catalog.records.size} designs pinned at ${shortSha})...`);
				await session.open(GALLERY_ROOT_URL, knownSlugs);
				ctx.ui.notify(
					`Gallery browser open (${catalog.records.size} designs pinned at commit ${shortSha}). Click a design to select it. Close the browser window to cancel.`,
					"info",
				);

				let imported = false;
				while (!imported) {
					ctx.ui.setStatus("design-gallery", "Waiting for a design selection in the browser...");
					const slug = await session.waitForSelection();
					if (slug === null) {
						ctx.ui.notify("Gallery browser closed. No design imported.", "info");
						break;
					}

					const record = catalog.records.get(slug);
					if (!record) {
						session.resolveMatch(slug, false); // defensive; slug always comes from knownSlugs
						continue;
					}

					ctx.ui.setStatus("design-gallery", undefined);
					const confirmed = await ctx.ui.confirm(
						"Import selected design?",
						`${record.path}\npinned at commit ${shortSha}\n${record.previewUrl ?? "(no README preview link at this commit)"}`,
					);
					session.resolveMatch(slug, confirmed);

					if (!confirmed) {
						ctx.ui.notify("Selection discarded. Keep browsing to pick a different design.", "info");
						continue;
					}

					const profile = buildProfile(catalog.commitSha, catalog.treeSha, record);
					await writeProfileAtomic(ctx.cwd, profile);
					ctx.ui.notify(`Pinned ${record.path} to ${PROFILE_RELATIVE_PATH}. Run /app-design <request> to hand it off.`, "info");
					imported = true;
				}
			} catch (err) {
				ctx.ui.notify(`design-gallery failed: ${(err as Error).message}`, "error");
			} finally {
				ctx.ui.setStatus("design-gallery", undefined);
				if (activeSession === session) activeSession = null;
				await session.close();
			}
		},
	});

	pi.registerCommand("app-design", {
		description: "Rank bundled HTML templates for a request, select one (delegated) or via gallery, and hand off with the pinned design profile",
		handler: async (args, ctx) => {
			// Delegated selection needs no dialog UI (nested completion +
			// sendUserMessage only), so it stays available in every mode. Manual
			// selection opens the local template gallery, which is TUI-only; the
			// handler itself enforces that mode gate before calling openTemplateGallery.
			const deps = buildAppDesignDeps(pi, ctx, appDesignOverrides);
			await createAppDesignHandler(deps)(args, ctx);
		},
	});
}
