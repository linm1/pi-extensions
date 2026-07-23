import { GithubRateLimitError, OWNER, REPO, type CatalogRecord, type PinnedCatalog } from "./types.ts";

const API = "https://api.github.com";
const DESIGN_MD_PATTERN = /^design-md\/([^/]+)\/DESIGN\.md$/;
const README_LINK_PATTERN = /https:\/\/getdesign\.md\/([^/"'()<>\s]+)\/design-md/g;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		...extra,
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	return headers;
}

async function rateLimitCheck(res: Response, path: string): Promise<void> {
	if (res.status !== 403 && res.status !== 429) return;
	const retryAfter = res.headers.get("retry-after");
	if (retryAfter) {
		throw new GithubRateLimitError(
			`GitHub secondary rate limit hit for ${path}. Wait ${retryAfter}s and retry /design-gallery.`,
		);
	}
	const remaining = res.headers.get("x-ratelimit-remaining");
	const reset = res.headers.get("x-ratelimit-reset");
	if (remaining === "0" && reset) {
		const resetAt = new Date(Number(reset) * 1000).toISOString();
		throw new GithubRateLimitError(
			`GitHub rate limit exhausted (resets ${resetAt}). Set GITHUB_TOKEN to raise the 60/hour unauthenticated limit to 5000/hour, then retry /design-gallery.`,
		);
	}
}

async function githubGet(path: string, signal?: AbortSignal): Promise<any> {
	const res = await fetch(`${API}${path}`, { headers: authHeaders(), signal });
	await rateLimitCheck(res, path);
	if (!res.ok) throw new Error(`GitHub request failed: ${res.status} ${res.statusText} (${path})`);
	return res.json();
}

/** Fetches DESIGN.md by immutable blobSha only. Never falls back to `main` or live preview content. */
export async function fetchDesignMdByBlobSha(blobSha: string, signal?: AbortSignal): Promise<string> {
	const path = `/repos/${OWNER}/${REPO}/git/blobs/${blobSha}`;
	const res = await fetch(`${API}${path}`, {
		headers: authHeaders({ Accept: "application/vnd.github.raw+json" }),
		signal,
	});
	await rateLimitCheck(res, path);
	if (!res.ok) throw new Error(`Failed to fetch DESIGN.md by blobSha ${blobSha}: ${res.status} ${res.statusText}`);
	return res.text();
}

/**
 * Discovers and pins the full catalog against one branch-head snapshot:
 * repo -> branch commit -> commit tree -> recursive tree (DESIGN.md blobs) -> pinned README (preview links).
 * See .wayfinder/catalog-discovery-research.md for the verified API sequence.
 */
export async function discoverCatalog(previous: PinnedCatalog | null, signal?: AbortSignal): Promise<PinnedCatalog> {
	const repoInfo = await githubGet(`/repos/${OWNER}/${REPO}`, signal);
	const branch: unknown = repoInfo.default_branch;
	if (typeof branch !== "string" || branch.length === 0) {
		throw new Error(
			`GitHub repo response for ${OWNER}/${REPO} has no default_branch; refusing to guess "main".`,
		);
	}

	const branchPath = `/repos/${OWNER}/${REPO}/branches/${branch}`;
	const branchHeaders = authHeaders();
	if (previous?.branchEtag) branchHeaders["If-None-Match"] = previous.branchEtag;
	const branchRes = await fetch(`${API}${branchPath}`, { headers: branchHeaders, signal });
	if (branchRes.status === 304 && previous) return previous;
	await rateLimitCheck(branchRes, branchPath);
	if (!branchRes.ok) throw new Error(`GitHub request failed: ${branchRes.status} ${branchRes.statusText} (${branchPath})`);
	const branchData = await branchRes.json();
	const commitSha: string = branchData.commit.sha;
	const branchEtag = branchRes.headers.get("etag") ?? undefined;

	if (previous && previous.commitSha === commitSha) {
		previous.branchEtag = branchEtag ?? previous.branchEtag;
		return previous;
	}

	const commitData = await githubGet(`/repos/${OWNER}/${REPO}/git/commits/${commitSha}`, signal);
	const treeSha: string = commitData.tree.sha;

	const treeData = await githubGet(`/repos/${OWNER}/${REPO}/git/trees/${treeSha}?recursive=1`, signal);
	if (treeData.truncated) {
		throw new Error(
			"Catalog tree response was truncated; the recursive-tree limit was exceeded and non-recursive traversal is not implemented.",
		);
	}

	const records = new Map<string, CatalogRecord>();
	for (const entry of treeData.tree as Array<{ type: string; path: string; sha: string }>) {
		if (entry.type !== "blob") continue;
		const match = DESIGN_MD_PATTERN.exec(entry.path);
		if (!match) continue;
		records.set(match[1], { directory: match[1], path: entry.path, blobSha: entry.sha, previewUrl: null });
	}

	const readmePath = `/repos/${OWNER}/${REPO}/contents/README.md?ref=${commitSha}`;
	const readmeRes = await fetch(`${API}${readmePath}`, {
		headers: authHeaders({ Accept: "application/vnd.github.raw+json" }),
		signal,
	});
	await rateLimitCheck(readmeRes, readmePath);
	if (!readmeRes.ok) throw new Error(`Failed to fetch pinned README: ${readmeRes.status} ${readmeRes.statusText}`);
	const readmeText = await readmeRes.text();

	for (const match of readmeText.matchAll(README_LINK_PATTERN)) {
		const slug = match[1];
		const record = records.get(slug);
		// A preview link is only meaningful when the same pinned commit also has that DESIGN.md blob.
		if (record) record.previewUrl = match[0];
	}

	return { commitSha, treeSha, records, branchEtag };
}
