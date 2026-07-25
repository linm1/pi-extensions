import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";

/** Duck-typed subset of Playwright's BindingSource, so the trust check below is unit-testable without a real browser. */
export interface GalleryBindingSource {
	frame: unknown;
}

/**
 * One headed, non-persistent Playwright Chromium session for the local,
 * bundled template gallery (ticket 02). Reuses the same launch/cleanup
 * lifecycle as GallerySession (browser-session.ts), but the selection
 * mechanism differs: there is no remote site to navigate to, so the fully
 * self-contained gallery page (built by gallery-page.ts) delivers its final
 * confirm/cancel choice to Node via `page.exposeBinding` bindings instead of
 * URL matching. Selection AND confirmation both happen inside the page
 * itself (a card click selects, a separate in-page Confirm button
 * completes), so this session only ever settles once per open() — there is
 * no queued-match/reject-and-retry flow like the hosted gallery's slug
 * matching.
 *
 * `exposeBinding` (like `exposeFunction`) registers the binding across every
 * frame on the page, including sandboxed template-preview iframes — so
 * without a frame check, vendored template JavaScript running inside a
 * preview iframe could call `__piConfirmSelection`/`__piCancel` itself and
 * forge a selection or cancellation the user never performed. Every binding
 * callback is routed through `isTrustedSource()`, which accepts a call only
 * when it originates from the gallery's own main frame — never from a child
 * (iframe) frame. See gallery-session.selfcheck.ts for the regression check.
 *
 * External navigation and network requests are blocked at the browser-context
 * level (every request is aborted; the page and every template preview are
 * rendered via setContent()/srcdoc, so nothing legitimate is lost).
 */
export class TemplateGallerySession {
	private browser: Browser | null = null;
	private context: BrowserContext | null = null;
	private page: Page | null = null;
	private mainFrame: Frame | null = null;
	private knownIds: ReadonlySet<string> = new Set();
	private ended = false;
	private hasOpened = false;
	private closingPromise: Promise<void> | null = null;
	private settled = false;
	/** Set once settled, so a late waitForSelection() call after the fact still resolves correctly. */
	private settledValue: string | null | undefined;
	private resolveWaiter: ((id: string | null) => void) | null = null;

	get isOpen(): boolean {
		return this.browser !== null && this.closingPromise === null;
	}

	/** `html` is the complete gallery document (see gallery-page.ts); `knownIds` are the only ids a confirm event may resolve with. */
	async open(html: string, knownIds: ReadonlySet<string>): Promise<void> {
		this.knownIds = knownIds;
		this.hasOpened = true;

		const browser = await chromium.launch({ headless: false });
		this.browser = browser;
		browser.on("disconnected", () => this.handleEnded());

		const context = await browser.newContext();
		this.context = context;
		context.on("close", () => this.handleEnded());
		// The gallery and every template preview are fully self-contained
		// (setContent()/srcdoc); nothing legitimate needs the network.
		await context.route("**/*", (route) => route.abort());

		const page = await context.newPage();
		this.page = page;
		this.mainFrame = page.mainFrame();
		page.on("close", () => this.handleEnded());
		// Bindings must exist before setContent(), matching the "observer before
		// navigation" ordering used by GallerySession, so an immediate click
		// cannot race ahead of the binding being registered.
		await this.attachBindings(page);
		await page.setContent(html, { waitUntil: "load" });
	}

	private async attachBindings(page: Page): Promise<void> {
		await page.exposeBinding("__piConfirmSelection", (source, id: string) => this.confirmFromSource(source, id));
		await page.exposeBinding("__piCancel", (source) => this.cancelFromSource(source));
	}

	/**
	 * Trust boundary for both bindings: only the gallery's own top-level
	 * document (never a template-preview iframe) may confirm or cancel a
	 * selection. `source.frame` is Playwright's real Frame identity, so this
	 * mirrors GallerySession's existing `frame === page.mainFrame()` pattern.
	 */
	private isTrustedSource(source: GalleryBindingSource): boolean {
		return this.mainFrame !== null && source.frame === this.mainFrame;
	}

	/** Same method the real `__piConfirmSelection` binding calls; exposed so the self-check can drive it directly with a fake child-frame source. */
	confirmFromSource(source: GalleryBindingSource, id: string): void {
		if (!this.isTrustedSource(source)) return;
		this.handleConfirm(id);
	}

	/** Same method the real `__piCancel` binding calls; exposed so the self-check can drive it directly with a fake child-frame source. */
	cancelFromSource(source: GalleryBindingSource): void {
		if (!this.isTrustedSource(source)) return;
		this.handleCancel();
	}

	private handleConfirm(id: string): void {
		if (this.settled) return;
		// Defensive: the gallery only ever renders known catalog ids, but an
		// unknown id must never be allowed to settle the session (see spec
		// story 32: "malformed or unknown recommendation identifiers rejected").
		if (!this.knownIds.has(id)) return;
		this.settled = true;
		this.deliver(id);
	}

	private handleCancel(): void {
		if (this.settled) return;
		this.settled = true;
		this.deliver(null);
	}

	private handleEnded(): void {
		if (this.ended) return;
		this.ended = true;
		if (!this.settled) {
			this.settled = true;
			this.deliver(null);
		}
	}

	private deliver(id: string | null): void {
		this.settledValue = id;
		const waiter = this.resolveWaiter;
		this.resolveWaiter = null;
		waiter?.(id);
	}

	/**
	 * Resolves with the confirmed template id, or null on cancellation,
	 * closed/disconnected browser, or session shutdown. Safe to call before or
	 * after the outcome already arrived (queued exactly like GallerySession).
	 */
	waitForSelection(): Promise<string | null> {
		if (!this.hasOpened) throw new Error("Template gallery session is not open");
		if (this.settledValue !== undefined) return Promise.resolve(this.settledValue);
		return new Promise((resolve) => {
			this.resolveWaiter = resolve;
		});
	}

	/** Idempotent: safe to call from command cleanup, cancellation, failure, re-entry, and session_shutdown. */
	async close(): Promise<void> {
		if (this.closingPromise) return this.closingPromise;
		this.closingPromise = this.doClose();
		return this.closingPromise;
	}

	private async doClose(): Promise<void> {
		this.handleEnded(); // unblock any pending waitForSelection() caller before tearing down
		const context = this.context;
		const browser = this.browser;
		this.context = null;
		this.browser = null;
		this.page = null;
		this.mainFrame = null;
		try {
			await context?.close();
		} catch {
			// already closed/disconnected
		}
		try {
			await browser?.close();
		} catch {
			// already closed/disconnected
		}
	}
}
