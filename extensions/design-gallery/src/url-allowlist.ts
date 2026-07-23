/**
 * Validates a committed main-frame navigation URL against the exact getdesign.md
 * selection shape, pinned to the already-discovered catalog. See
 * .wayfinder/pi-owned-browser-runtime-research.md "Navigation and page model".
 *
 * Returns the matched catalog slug, or null if the URL is not an exact,
 * allow-listed selection.
 */
export function isAllowedGetdesignUrl(urlString: string, knownSlugs: ReadonlySet<string>): string | null {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.hostname !== "getdesign.md") return null;
	if (url.username || url.password) return null;
	if (url.hash) return null;
	if (url.search) return null;

	const match = /^\/([^/]+)\/design-md$/.exec(url.pathname);
	if (!match) return null;
	const slug = match[1];
	if (!knownSlugs.has(slug)) return null;
	return slug;
}

function selfCheck(): void {
	const known = new Set(["claude", "linear.app"]);
	const cases: Array<[string, string | null]> = [
		["https://getdesign.md/claude/design-md", "claude"],
		["https://getdesign.md/linear.app/design-md", "linear.app"],
		["https://getdesign.md/unknown-slug/design-md", null],
		["https://getdesign.md/claude/design-md?ref=1", null],
		["https://getdesign.md/claude/design-md#preview", null],
		["http://getdesign.md/claude/design-md", null],
		["https://evil.example/claude/design-md", null],
		["https://user:pass@getdesign.md/claude/design-md", null],
		["https://getdesign.md/claude/other-path", null],
		["not a url", null],
	];
	for (const [input, expected] of cases) {
		const actual = isAllowedGetdesignUrl(input, known);
		if (actual !== expected) {
			throw new Error(`isAllowedGetdesignUrl(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
		}
	}
	console.log(`url-allowlist self-check OK (${cases.length} cases)`);
}

// ponytail: runnable check for a security-relevant parser branch.
// Run directly with `npx tsx src/url-allowlist.ts` or `node --experimental-strip-types src/url-allowlist.ts` (Node 22.6+).
const isMainModule = typeof process !== "undefined" && !!process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\0");
if (isMainModule) selfCheck();
