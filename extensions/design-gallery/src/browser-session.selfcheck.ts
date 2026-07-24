/**
 * Runnable self-check for GallerySession's selection-delivery/cleanup logic
 * (the exact code path behind the popup-capture and duplicate-confirmation
 * fixes). Uses a duck-typed fake Page/Frame so it needs no real browser.
 *
 * Run with: node --experimental-strip-types src/browser-session.selfcheck.ts
 */
import { GallerySession } from "./browser-session.ts";

type Handler = (...args: unknown[]) => void;

/**
 * Mirrors Playwright's real identity model: `page.mainFrame()` always
 * returns the SAME Frame object across navigations (only its url changes).
 * `framenavigated` handlers key off `frame === page.mainFrame()`, so the
 * fake must reuse one persistent frame object, not build a new one per nav.
 */
function fakePage(initialUrl: string) {
	const handlers = new Map<string, Handler[]>();
	const mainFrame = {
		_url: initialUrl,
		url() {
			return mainFrame._url;
		},
	};
	const page: any = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return page;
		},
		off(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			handlers.set(event, list.filter((h) => h !== handler));
			return page;
		},
		mainFrame() {
			return mainFrame;
		},
		emit(event: string, ...args: unknown[]) {
			for (const h of handlers.get(event) ?? []) h(...args);
		},
		navigateMainFrameTo(url: string) {
			mainFrame._url = url;
			page.emit("framenavigated", mainFrame);
		},
		openPopup(popupPage: unknown) {
			page.emit("popup", popupPage);
		},
		close() {
			page.emit("close");
		},
	};
	return page;
}

async function assertResolvesTo<T>(promise: Promise<T>, expected: T, label: string): Promise<void> {
	const actual = await promise;
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

async function main(): Promise<void> {
	const knownSlugs = new Set(["claude", "linear.app"]);

	// 1. Match observed before waitForSelection() is called must be queued, not lost.
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const page = fakePage("https://getdesign.md/");
		session.attachSelectionObserver(page);
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		await assertResolvesTo(session.waitForSelection(), "claude", "queued-before-wait");
	}

	// 2. A waiter registered first must be resolved directly when the match arrives.
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const page = fakePage("https://getdesign.md/");
		session.attachSelectionObserver(page);
		const pending = session.waitForSelection();
		page.navigateMainFrameTo("https://getdesign.md/linear.app/design-md");
		await assertResolvesTo(pending, "linear.app", "waiter-resolved-live");
	}

	// 3. Popups get the same strict observer and can deliver a match (not silently closed).
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const main = fakePage("https://getdesign.md/");
		session.attachSelectionObserver(main);
		session.attachPopupWatcher(main);
		const popup = fakePage("about:blank");
		main.openPopup(popup);
		const pending = session.waitForSelection();
		popup.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		await assertResolvesTo(pending, "claude", "popup-match-delivered");
	}

	// 4. A repeated framenavigated event for a slug still pending confirmation must
	//    not produce a second queued match (duplicate-confirmation guard).
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const page = fakePage("https://getdesign.md/");
		session.attachSelectionObserver(page);
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md"); // duplicate event, same URL
		await assertResolvesTo(session.waitForSelection(), "claude", "dedup-first-match");
		let sawSecond = false;
		const race = Promise.race([
			session.waitForSelection().then(() => { sawSecond = true; }),
			new Promise((resolve) => setTimeout(resolve, 20)),
		]);
		await race;
		if (sawSecond) throw new Error("dedup: duplicate identical navigation produced a second match");
	}

	// 5. Ending the session (disconnect/close) resolves a pending waiter with null exactly once.
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const page = fakePage("https://getdesign.md/");
		session.attachSelectionObserver(page);
		const pending = session.waitForSelection();
		session.handleEnded();
		session.handleEnded(); // idempotent; must not throw or double-resolve
		await assertResolvesTo(pending, null, "ended-resolves-null");
		await assertResolvesTo(session.waitForSelection(), null, "post-ended-resolves-null");
	}

	// 6. A rejected slug must become selectable again (and re-confirmable) later in
	//    the same session, while duplicate events while pending are still suppressed,
	//    and an eventually-accepted slug stays suppressed afterward.
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const page = fakePage("https://getdesign.md/");
		session.attachSelectionObserver(page);

		// observe
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		// duplicate event while pending must still be suppressed
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		await assertResolvesTo(session.waitForSelection(), "claude", "reject-flow-first-observe");

		// reject
		session.resolveMatch("claude", false);

		// observe same URL again: must be selectable, producing a second confirmation
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		await assertResolvesTo(session.waitForSelection(), "claude", "reject-flow-second-observe");

		// accept this time
		session.resolveMatch("claude", true);

		// observe same URL a third time: must now stay suppressed (accepted)
		page.navigateMainFrameTo("https://getdesign.md/claude/design-md");
		let sawThird = false;
		await Promise.race([
			session.waitForSelection().then(() => { sawThird = true; }),
			new Promise((resolve) => setTimeout(resolve, 20)),
		]);
		if (sawThird) throw new Error("reject-flow: accepted slug re-matched instead of staying suppressed");
	}

	// 7. Closing one window must not end the session while another remains;
	// closing the final window must unblock the selection wait with null.
	{
		const session = new GallerySession() as any;
		session.knownSlugs = knownSlugs;
		session.hasOpened = true;
		const main = fakePage("https://getdesign.md/");
		const popup = fakePage("about:blank");
		session.attachSelectionObserver(main);
		session.attachPopupWatcher(main);
		main.openPopup(popup);
		const pending = session.waitForSelection();
		main.close();
		let endedTooSoon = false;
		await Promise.race([
			pending.then(() => { endedTooSoon = true; }),
			new Promise((resolve) => setTimeout(resolve, 20)),
		]);
		if (endedTooSoon) throw new Error("page-close: closing one window ended an active popup session");
		popup.close();
		await assertResolvesTo(pending, null, "page-close-final-window-ends-session");
	}

	console.log("browser-session self-check OK (7 cases)");
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
