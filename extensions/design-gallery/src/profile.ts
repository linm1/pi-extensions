import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DesignGalleryError, OWNER, REPO, SCHEMA_VERSION, type CatalogRecord, type DesignProfile } from "./types.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;
const PATH_RE = /^design-md\/[^/]+\/DESIGN\.md$/;

export const PROFILE_RELATIVE_PATH = `${CONFIG_DIR_NAME}/design-profile.json`;

export function buildProfile(commitSha: string, treeSha: string, record: CatalogRecord): DesignProfile {
	return {
		schemaVersion: SCHEMA_VERSION,
		owner: OWNER,
		repo: REPO,
		commitSha,
		treeSha,
		blobSha: record.blobSha,
		path: record.path,
		githubPermalink: `https://github.com/${OWNER}/${REPO}/blob/${commitSha}/${record.path}`,
		rawApiUrl: `https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${record.blobSha}`,
		previewUrl: record.previewUrl,
	};
}

/** Replaces `.pi/design-profile.json` atomically (write to temp file, then rename). */
export async function writeProfileAtomic(cwd: string, profile: DesignProfile): Promise<string> {
	const dir = join(cwd, CONFIG_DIR_NAME);
	await mkdir(dir, { recursive: true });
	const target = join(dir, "design-profile.json");
	const tmp = join(dir, `.design-profile.json.${process.pid}.${Date.now()}.tmp`);
	await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
	await rename(tmp, target);
	return target;
}

/** Reads and strictly validates `.pi/design-profile.json`. Throws a clear, specific error on any problem. */
export async function readAndValidateProfile(cwd: string): Promise<DesignProfile> {
	const target = join(cwd, CONFIG_DIR_NAME, "design-profile.json");
	let raw: string;
	try {
		raw = await readFile(target, "utf8");
	} catch {
		throw new DesignGalleryError(`No pinned design profile at ${PROFILE_RELATIVE_PATH}. Run /design-gallery first.`);
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new DesignGalleryError(`${PROFILE_RELATIVE_PATH} is not valid JSON. Run /design-gallery again to regenerate it.`);
	}

	if (typeof data !== "object" || data === null) {
		throw new DesignGalleryError(`${PROFILE_RELATIVE_PATH} must contain a JSON object.`);
	}
	const p = data as Record<string, unknown>;

	const missing: string[] = [];
	const require = (key: string, ok: boolean) => {
		if (!ok) missing.push(key);
	};

	require("schemaVersion", p.schemaVersion === SCHEMA_VERSION);
	require("owner", p.owner === OWNER);
	require("repo", p.repo === REPO);
	require("commitSha", typeof p.commitSha === "string" && SHA_RE.test(p.commitSha));
	require("treeSha", typeof p.treeSha === "string" && SHA_RE.test(p.treeSha));
	require("blobSha", typeof p.blobSha === "string" && SHA_RE.test(p.blobSha));
	require("path", typeof p.path === "string" && PATH_RE.test(p.path));

	const commitSha = typeof p.commitSha === "string" ? p.commitSha : "";
	const path = typeof p.path === "string" ? p.path : "";
	const expectedPermalink = `https://github.com/${OWNER}/${REPO}/blob/${commitSha}/${path}`;
	require("githubPermalink", p.githubPermalink === expectedPermalink);

	const blobSha = typeof p.blobSha === "string" ? p.blobSha : "";
	const expectedRawApiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${blobSha}`;
	require("rawApiUrl", p.rawApiUrl === expectedRawApiUrl);

	require(
		"previewUrl",
		p.previewUrl === null || (typeof p.previewUrl === "string" && p.previewUrl.startsWith("https://getdesign.md/")),
	);

	if (missing.length > 0) {
		throw new DesignGalleryError(
			`${PROFILE_RELATIVE_PATH} is missing or has an invalid field: ${missing.join(", ")}. Run /design-gallery again to regenerate it.`,
		);
	}

	return p as DesignProfile;
}
