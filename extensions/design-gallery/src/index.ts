import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GallerySession } from "./browser-session.ts";
import { discoverCatalog, fetchDesignMdByBlobSha } from "./github.ts";
import { buildProfile, PROFILE_RELATIVE_PATH, readAndValidateProfile, writeProfileAtomic } from "./profile.ts";
import type { PinnedCatalog } from "./types.ts";

const GALLERY_ROOT_URL = "https://getdesign.md/";

// Extension-instance-scoped state. Reset on /reload, which is correct: a
// reload gets a fresh catalog cache and no dangling browser session handle.
let cachedCatalog: PinnedCatalog | null = null;
let activeSession: GallerySession | null = null;

async function closeActiveSession(): Promise<void> {
	const session = activeSession;
	activeSession = null;
	await session?.close();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		await closeActiveSession();
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
		description: "Send the pinned design profile and an implementation request to this agent",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				ctx.ui.notify("Usage: /app-design <implementation request>", "warning");
				return;
			}

			let profile: Awaited<ReturnType<typeof readAndValidateProfile>>;
			try {
				profile = await readAndValidateProfile(ctx.cwd);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
				return;
			}

			try {
				// Validate the pinned content is fetchable by blobSha; content itself is discarded.
				// Never falls back to `main` or live getdesign.md preview content.
				await fetchDesignMdByBlobSha(profile.blobSha);
			} catch (err) {
				ctx.ui.notify(`Could not fetch pinned DESIGN.md by blobSha: ${(err as Error).message}`, "error");
				return;
			}

			const message = `${request}\n\nPinned design profile: ${PROFILE_RELATIVE_PATH} (${profile.path} pinned at commit ${profile.commitSha}).`;

			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}
		},
	});
}
