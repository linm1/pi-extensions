export const OWNER = "VoltAgent";
export const REPO = "awesome-design-md";

/** One `design-md/<directory>/DESIGN.md` entry from the pinned catalog tree. */
export type CatalogRecord = {
	directory: string;
	path: string;
	blobSha: string;
	previewUrl: string | null;
};

/** The full catalog pinned to one immutable branch-head commit. */
export type PinnedCatalog = {
	commitSha: string;
	treeSha: string;
	records: Map<string, CatalogRecord>;
	branchEtag?: string;
};

export const SCHEMA_VERSION = 1;

/** `.pi/design-profile.json` contract. See .wayfinder/Pinned design handoff contract.md */
export type DesignProfile = {
	schemaVersion: 1;
	owner: typeof OWNER;
	repo: typeof REPO;
	commitSha: string;
	treeSha: string;
	blobSha: string;
	path: string;
	githubPermalink: string;
	rawApiUrl: string;
	previewUrl: string | null;
};

export class DesignGalleryError extends Error {}
export class GithubRateLimitError extends DesignGalleryError {}
