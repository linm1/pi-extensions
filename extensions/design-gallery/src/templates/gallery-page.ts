import type { TemplateCatalogEntry } from "./catalog.ts";
import type { TemplateRecommendation } from "./recommend.ts";

/** One catalog entry paired with its full vendored HTML source, ready to render. */
export interface GalleryCatalogItem {
	entry: TemplateCatalogEntry;
	html: string;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Also escapes quotes, for use inside a double-quoted HTML attribute (including `srcdoc`). */
function escapeAttr(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}

function slugifyCategory(category: string): string {
	return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Renders one selectable card. `domIdSuffix` disambiguates the DOM id when the
 * same template is rendered twice (once in the recommended row, once again in
 * its category grid) — both instances share the same `data-template-id` and
 * are kept in sync by the client script, per spec: "duplicate representations
 * must resolve to the same template identifier."
 *
 * Every card is a native <button>, so Tab/Enter/Space selection is free —
 * every element used here (span, iframe) is valid phrasing content, so this
 * stays spec-compliant button markup.
 */
function renderCard(item: GalleryCatalogItem, domIdSuffix: string, rank: number | null, reason: string | null): string {
	const { entry, html } = item;
	const idAttr = escapeAttr(entry.id);
	const titleText = escapeHtml(entry.title);
	const titleAttr = escapeAttr(entry.title);
	const categoryText = escapeHtml(entry.category);
	const reasonText = reason ? escapeHtml(reason) : "";
	const srcdocAttr = escapeAttr(html);

	const labelParts = [entry.title, `${entry.category} category`];
	if (rank !== null) labelParts.push(`recommended pick ${rank} of 3${reason ? `: ${reason}` : ""}`);
	const labelAttr = escapeAttr(labelParts.join(", "));

	return `<button type="button" class="card${rank !== null ? " card--recommended" : ""}" id="card-${domIdSuffix}-${idAttr}" data-template-id="${idAttr}" data-title="${titleAttr}" aria-pressed="false" aria-label="${labelAttr}">
<span class="card-media"><iframe title="${titleAttr} preview" tabindex="-1" sandbox="allow-scripts" srcdoc="${srcdocAttr}"></iframe></span>
<span class="card-body">
${rank !== null ? `<span class="badge">&#9733; Recommended #${rank}</span>` : ""}
<span class="card-title">${titleText}</span>
<span class="card-category">${categoryText}</span>
${reasonText ? `<span class="card-reason">${reasonText}</span>` : ""}
<span class="card-status" aria-hidden="true"></span>
</span>
</button>`;
}

function groupByCategory(items: readonly GalleryCatalogItem[]): Map<string, GalleryCatalogItem[]> {
	const map = new Map<string, GalleryCatalogItem[]>();
	for (const item of items) {
		const list = map.get(item.entry.category) ?? [];
		list.push(item);
		map.set(item.entry.category, list);
	}
	return map;
}

const GALLERY_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #14171a; background: #f4f5f7; padding-bottom: 76px; }
header.gallery-header { padding: 16px 20px 4px; }
header.gallery-header h1 { font-size: 1.25rem; margin: 0 0 4px; }
header.gallery-header p { margin: 0; color: #4b5563; font-size: 0.9rem; }
main { padding: 0 20px 20px; }
.notice { margin: 8px 0 16px; padding: 10px 14px; border: 1px solid #b45309; background: #fffbeb; color: #92400e; border-radius: 6px; font-size: 0.9rem; }
section.recommended, section.category { margin-bottom: 22px; }
section h2 { font-size: 1rem; margin: 0 0 8px; }
section h3 { font-size: 0.9rem; margin: 0 0 8px; color: #374151; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.grid--recommended { grid-template-columns: repeat(3, minmax(220px, 1fr)); }
.card { display: block; text-align: left; border: 2px solid #d1d5db; border-radius: 8px; background: #fff; padding: 0; cursor: pointer; font: inherit; color: inherit; overflow: hidden; }
.card:hover { border-color: #6b7280; }
.card:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
.card--recommended { border-color: #b45309; }
.card.selected { border-color: #15803d; border-width: 3px; background: #f0fdf4; }
.card-media { display: block; height: 140px; overflow: hidden; background: #eef0f3; border-bottom: 1px solid #e5e7eb; }
.card-media iframe { width: 285%; height: 285%; border: 0; transform: scale(0.35); transform-origin: top left; pointer-events: none; }
.card-body { display: block; padding: 8px 10px 10px; }
.badge { display: inline-block; font-size: 0.72rem; font-weight: 600; color: #92400e; background: #fef3c7; border: 1px solid #b45309; border-radius: 4px; padding: 1px 6px; margin-bottom: 4px; }
.card-title { display: block; font-weight: 600; font-size: 0.88rem; }
.card-category { display: block; font-size: 0.76rem; color: #6b7280; margin-top: 2px; }
.card-reason { display: block; font-size: 0.78rem; color: #374151; margin-top: 4px; }
.card-status { display: block; font-size: 0.78rem; font-weight: 600; color: #15803d; margin-top: 4px; }
.toolbar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: #ffffff; border-top: 1px solid #d1d5db; }
.toolbar #selection-summary { flex: 1; font-size: 0.88rem; }
.btn { font: inherit; font-size: 0.9rem; padding: 8px 16px; border-radius: 6px; border: 1px solid #9ca3af; background: #fff; cursor: pointer; }
.btn:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
.btn--primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
.btn--primary:disabled { background: #93a3c7; border-color: #93a3c7; cursor: not-allowed; }
.btn--secondary { background: #fff; }
`;

const GALLERY_SCRIPT = `(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card"));
  var confirmBtn = document.getElementById("confirm-btn");
  var cancelBtn = document.getElementById("cancel-btn");
  var summary = document.getElementById("selection-summary");
  var selectedId = null;

  function setSelected(id) {
    selectedId = id;
    var matchedTitle = "";
    cards.forEach(function (card) {
      var isMatch = card.getAttribute("data-template-id") === id;
      card.setAttribute("aria-pressed", isMatch ? "true" : "false");
      card.classList.toggle("selected", isMatch);
      var status = card.querySelector(".card-status");
      if (status) status.textContent = isMatch ? "\\u2713 Selected" : "";
      if (isMatch) matchedTitle = card.getAttribute("data-title") || "";
    });
    if (confirmBtn) confirmBtn.disabled = !id;
    if (summary) summary.textContent = id ? "Selected: " + matchedTitle : "No template selected yet.";
  }

  cards.forEach(function (card) {
    card.addEventListener("click", function () {
      setSelected(card.getAttribute("data-template-id"));
    });
  });

  if (confirmBtn) {
    confirmBtn.addEventListener("click", function () {
      if (selectedId && window.__piConfirmSelection) window.__piConfirmSelection(selectedId);
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function () {
      if (window.__piCancel) window.__piCancel();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && window.__piCancel) window.__piCancel();
  });
})();`;

/**
 * Builds the complete, self-contained local template gallery page: all
 * catalog items as isolated preview cards, the three recommendations (when
 * present) shown first and reachable without scrolling, a persistent
 * cancel/confirm toolbar, and full keyboard/semantic support. Pass
 * `recommendations: null` for the fallback (ranking-failed) gallery, which
 * renders every template unranked with a visible notice instead.
 */
export function buildGalleryHtml(items: readonly GalleryCatalogItem[], recommendations: readonly TemplateRecommendation[] | null): string {
	const recMap = new Map<string, { rank: number; reason: string }>();
	if (recommendations) {
		recommendations.forEach((r, i) => recMap.set(r.templateId, { rank: i + 1, reason: r.reason }));
	}

	const recommendedSection = recommendations
		? `<section aria-labelledby="recommended-heading" class="recommended">
<h2 id="recommended-heading">Recommended for this request</h2>
<div class="grid grid--recommended">
${recommendations
	.map((r, i) => {
		const item = items.find((it) => it.entry.id === r.templateId);
		return item ? renderCard(item, "top", i + 1, r.reason) : "";
	})
	.join("\n")}
</div>
</section>`
		: `<div class="notice" role="status">Recommendation ranking wasn't available for this request. Showing the complete template gallery — pick any template below.</div>`;

	const categorySections = Array.from(groupByCategory(items).entries())
		.map(([category, catItems]) => {
			const catId = `category-${slugifyCategory(category)}`;
			const cards = catItems
				.map((item) => {
					const rec = recMap.get(item.entry.id);
					return renderCard(item, "cat", rec ? rec.rank : null, rec ? rec.reason : null);
				})
				.join("\n");
			return `<section aria-labelledby="${catId}" class="category">
<h3 id="${catId}">${escapeHtml(category)}</h3>
<div class="grid">
${cards}
</div>
</section>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Choose a structural template</title>
<style>${GALLERY_CSS}</style>
</head>
<body>
<header class="gallery-header">
<h1>Choose a structural template</h1>
<p>Pick any template below, including a recommendation, then confirm your choice.</p>
</header>
<main>
${recommendedSection}
<section aria-labelledby="all-heading" class="all-templates">
<h2 id="all-heading">Complete catalog</h2>
${categorySections}
</section>
</main>
<div class="toolbar" role="toolbar" aria-label="Selection actions">
<span id="selection-summary" role="status">No template selected yet.</span>
<button type="button" id="cancel-btn" class="btn btn--secondary">Cancel</button>
<button type="button" id="confirm-btn" class="btn btn--primary" disabled>Confirm selection</button>
</div>
<script>${GALLERY_SCRIPT}</script>
</body>
</html>`;
}

// ponytail: runnable structural check (no real browser — asserts on the
// generated HTML string, per spec's "do not snapshot pixel output" testing
// decision). The actual visual/keyboard acceptance pass is manual.
// Run with: node --experimental-strip-types src/templates/gallery-page.ts
function selfCheck(): void {
	const items: GalleryCatalogItem[] = [
		{ entry: { id: "a", title: "Template A", category: "Cat One", description: "d", suitableFor: "s", sourceFile: "a.html" }, html: "<html><body>A</body></html>" },
		{ entry: { id: "b", title: "Template B", category: "Cat One", description: "d", suitableFor: "s", sourceFile: "b.html" }, html: "<html><body>B</body></html>" },
		{ entry: { id: "c", title: 'Template "C" & <weird>', category: "Cat Two", description: "d", suitableFor: "s", sourceFile: "c.html" }, html: '<html><body>"C" & <script>evil()</script></body></html>' },
	];

	const recommended = buildGalleryHtml(items, [
		{ templateId: "c", reason: "fits best" },
		{ templateId: "a", reason: "second best" },
		{ templateId: "b", reason: "also reasonable" },
	]);
	if (!recommended.includes("Recommended for this request")) throw new Error("recommended-mode: missing recommended section heading");
	if (!recommended.includes("Recommended #1") || !recommended.includes("Recommended #2") || !recommended.includes("Recommended #3")) {
		throw new Error("recommended-mode: missing rank badges");
	}
	if (!recommended.includes("fits best") || !recommended.includes("second best") || !recommended.includes("also reasonable")) {
		throw new Error("recommended-mode: missing rationale text");
	}
	if (recommended.includes("wasn't available")) throw new Error("recommended-mode: fallback notice must not appear when recommendations exist");
	// Recommended entry "c" must also appear once more in its category grid (duplicate representation, same id).
	const dataIdMatches = recommended.match(/data-template-id="c"/g) ?? [];
	if (dataIdMatches.length !== 2) throw new Error(`recommended-mode: expected template "c" to appear twice (top row + category), got ${dataIdMatches.length}`);
	// Escaping: a raw, unescaped <script> tag from title/html must never appear
	// (quotes in ordinary HTML text content, e.g. the title, are harmless and
	// need no escaping — only angle brackets and attribute-context quoting do).
	if (recommended.includes("<script>evil()")) {
		throw new Error("recommended-mode: unescaped srcdoc/title content leaked an executable <script> tag into the page");
	}
	if (!recommended.includes("&lt;script&gt;evil()")) {
		throw new Error("recommended-mode: expected the escaped form of the malicious srcdoc/title content");
	}
	if (!recommended.includes("&quot;C&quot;")) {
		throw new Error("recommended-mode: expected the attribute-escaped form of the title in data-title/aria-label");
	}
	for (const item of items) {
		if (!recommended.includes(`data-template-id="${item.entry.id}"`)) {
			throw new Error(`recommended-mode: missing card for ${item.entry.id}`);
		}
	}
	if (!recommended.includes('id="cancel-btn"') || !recommended.includes('id="confirm-btn"')) {
		throw new Error("recommended-mode: missing confirm/cancel toolbar buttons");
	}
	if (!recommended.includes("disabled")) throw new Error("recommended-mode: confirm button must start disabled");

	const fallback = buildGalleryHtml(items, null);
	if (!fallback.includes("wasn't available")) throw new Error("fallback-mode: missing fallback notice");
	if (fallback.includes("Recommended for this request") || fallback.includes("Recommended #1")) {
		throw new Error("fallback-mode: must not show any recommendation highlights");
	}
	for (const item of items) {
		if (!fallback.includes(`data-template-id="${item.entry.id}"`)) {
			throw new Error(`fallback-mode: missing card for ${item.entry.id}`);
		}
	}
	// Fallback mode: every template appears exactly once (no recommended row to duplicate into).
	const fallbackMatches = fallback.match(/data-template-id="c"/g) ?? [];
	if (fallbackMatches.length !== 1) throw new Error(`fallback-mode: expected template "c" to appear exactly once, got ${fallbackMatches.length}`);

	console.log("gallery-page self-check OK (2 modes)");
}

const isMainModule =
	typeof process !== "undefined" &&
	!!process.argv[1] &&
	import.meta.url.includes(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\0");
if (isMainModule) selfCheck();
