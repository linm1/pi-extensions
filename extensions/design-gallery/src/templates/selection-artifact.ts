import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { TEMPLATE_COMMIT_SHA, TEMPLATE_OWNER, TEMPLATE_REPO, TEMPLATE_SCHEMA_VERSION, type TemplateCatalogEntry } from "./catalog.ts";

export const TEMPLATE_SELECTION_RELATIVE_PATH = `${CONFIG_DIR_NAME}/template-selection.json`;

/**
 * One atomic, project-local selection artifact for the active /app-design
 * request. Overwritten on the next successful selection; never treated as an
 * implicit default for a later request.
 */
export interface TemplateSelectionArtifact {
	schemaVersion: 1;
	owner: typeof TEMPLATE_OWNER;
	repo: typeof TEMPLATE_REPO;
	commitSha: string;
	templateId: string;
	title: string;
	category: string;
	sourceFile: string;
	/** Complete selected HTML source, verbatim from the vendored artifact. */
	html: string;
	selectedAt: string;
}

export function buildSelectionArtifact(entry: TemplateCatalogEntry, html: string, selectedAt: Date): TemplateSelectionArtifact {
	return {
		schemaVersion: TEMPLATE_SCHEMA_VERSION,
		owner: TEMPLATE_OWNER,
		repo: TEMPLATE_REPO,
		commitSha: TEMPLATE_COMMIT_SHA,
		templateId: entry.id,
		title: entry.title,
		category: entry.category,
		sourceFile: entry.sourceFile,
		html,
		selectedAt: selectedAt.toISOString(),
	};
}

/** Replaces `.pi/template-selection.json` atomically (write to temp file, then rename). */
export async function writeTemplateSelectionAtomic(cwd: string, artifact: TemplateSelectionArtifact): Promise<string> {
	const dir = join(cwd, CONFIG_DIR_NAME);
	await mkdir(dir, { recursive: true });
	const target = join(dir, "template-selection.json");
	const tmp = join(dir, `.template-selection.json.${process.pid}.${Date.now()}.tmp`);
	await writeFile(tmp, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
	await rename(tmp, target);
	return target;
}
