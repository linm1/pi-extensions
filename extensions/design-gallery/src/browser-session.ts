import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { isAllowedGetdesignUrl } from "./url-allowlist.ts";

const NAV_TIMEOUT_MS = 60_000;

/**
 * One headed, non-persistent Playwright Chromium session dedicated to browsing
 * getdesign.md. No CDP, no persistent profile, no existing tabs/pi-chrome.
 * See .wayfinder/Pi-owned browser runtime.md.
 *
 * The same strict main-frame allow-list observer is attached to the main page
 * and to every popup it opens (recursively), so a selection made in a new
 * window is captured exactly like one made in the main page — never silently
 * closed. Observers are attached before any navigation starts, so an
 * immediate qualifying redirect cannot be missed.
 */
export class GallerySession {
	private browser: Browser | null = null;
	private context: BrowserContext | null = null;
	private knownSlugs: ReadonlySet<string> = new Set();
	/** Slugs already surfaced and not yet resolved via resolveMatch() (queued or mid-confirmation). */
	private pendingSlugs = new Set<string>();
	/** Slugs the consumer accepted; kept suppressed for the rest of the session. */
	private acceptedSlugs = new Set<string>();
	private pendingMatches: string[] = [];
	private waiters: Array<(slug: string | null) => void> = [];
	private ended = false;
	private hasOpened = false;
	private closingPromise: Promise<void> | null = null;

	get isOpen(): boolean {
		return this.browser !== null && this.closingPromise === null;
	}

	async open(rootUrl: string, knownSlugs: ReadonlySet<string>): Promise<void> {
		this.knownSlugs = knownSlugs;
		this.hasOpened = true;

		const browser = await chromium.launch({ headless: false });
		this.browser = browser;
		browser.on("disconnected", () => this.handleEnded());

		const context = await browser.newContext();
		this.context = context;
		context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
		context.setDefaultTimeout(NAV_TIMEOUT_MS);

		const page = await context.newPage();
		// Observer and popup watcher must be live before goto, or an immediate
		// qualifying redirect on the very first navigation could be missed.
		this.attachSelectionObserver(page);
		this.attachPopupWatcher(page);

		await page.goto(rootUrl);
	}

	/** Applies the same strict allow-list check to every popup a page opens (including nested popups). */
	private attachPopupWatcher(page: Page): void {
		page.on("popup", (popup) => {
			this.attachSelectionObserver(popup);
			this.attachPopupWatcher(popup);
		});
	}

	private attachSelectionObserver(page: Page): void {
		page.on("framenavigated", (frame: Frame) => {
			if (frame !== page.mainFrame()) return;
			const slug = isAllowedGetdesignUrl(frame.url(), this.knownSlugs);
			if (!slug) return;
			// A repeated framenavigated event for a slug that is already queued or
			// mid-confirmation (duplicate event, soft re-navigation) must not prompt
			// a second confirmation for what the user experienced as one click. An
			// accepted slug stays suppressed for the rest of the session. A slug the
			// user rejected is NOT in either set, so it becomes selectable again.
			if (this.pendingSlugs.has(slug) || this.acceptedSlugs.has(slug)) return;
			this.pendingSlugs.add(slug);
			this.deliverMatch(slug);
		});
	}

	private deliverMatch(slug: string): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(slug);
			return;
		}
		this.pendingMatches.push(slug);
	}

	/**
	 * Reports the confirmation outcome for a slug delivered by waitForSelection().
	 * Rejecting clears the slug's pending state so an identical later navigation
	 * can be observed and confirmed again. Accepting suppresses it permanently.
	 */
	resolveMatch(slug: string, accepted: boolean): void {
		this.pendingSlugs.delete(slug);
		if (accepted) this.acceptedSlugs.add(slug);
	}

	private handleEnded(): void {
		if (this.ended) return;
		this.ended = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.(null);
		}
	}

	/**
	 * Resolves with the next main-frame navigation matching an allow-listed
	 * catalog slug (from the main page or any of its popups), or null once the
	 * browser has been closed/disconnected. Already-observed matches queue up
	 * and are delivered in order, so no selection is lost while a caller is
	 * busy (for example awaiting a confirmation dialog).
	 */
	waitForSelection(): Promise<string | null> {
		if (!this.hasOpened) throw new Error("Gallery session is not open");
		const queued = this.pendingMatches.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.ended) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	/** Idempotent: safe to call from command cleanup, cancellation, failure, and session_shutdown. */
	async close(): Promise<void> {
		if (this.closingPromise) return this.closingPromise;
		this.closingPromise = this.doClose();
		return this.closingPromise;
	}

	private async doClose(): Promise<void> {
		this.handleEnded(); // unblock any pending waitForSelection() callers before tearing down
		const context = this.context;
		const browser = this.browser;
		this.context = null;
		this.browser = null;
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
