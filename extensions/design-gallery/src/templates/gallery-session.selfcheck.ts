/**
 * Runnable self-check for TemplateGallerySession's selection-delivery/cleanup
 * logic. Mirrors browser-session.selfcheck.ts's approach: drive the private
 * handleConfirm/handleCancel/handleEnded methods directly (these are exactly
 * what the exposed `__piConfirmSelection`/`__piCancel` bindings and
 * browser/context/page "close"/"disconnected" events call in production), so
 * no real browser is needed.
 *
 * Case 10 is a regression check for the main-frame trust boundary: it drives
 * `confirmFromSource()`/`cancelFromSource()` — the exact methods the real
 * `page.exposeBinding()` callbacks call in open() — with a fake `source.frame`
 * that is NOT the gallery's main frame, proving a template-preview iframe
 * (which `exposeBinding` would otherwise let call these bindings directly)
 * cannot complete or cancel a selection.
 *
 * Run with: node --experimental-strip-types src/templates/gallery-session.selfcheck.ts
 */
import { TemplateGallerySession } from "./gallery-session.ts";

function openedSession(knownIds: ReadonlySet<string>): any {
	const session = new TemplateGallerySession() as any;
	session.knownIds = knownIds;
	session.hasOpened = true;
	return session;
}

async function assertResolvesTo<T>(promise: Promise<T>, expected: T, label: string): Promise<void> {
	const actual = await promise;
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

async function main(): Promise<void> {
	const knownIds = new Set(["a", "b"]);

	// 1. Confirm delivered before waitForSelection() is called must be queued, not lost.
	{
		const session = openedSession(knownIds);
		session.handleConfirm("a");
		await assertResolvesTo(session.waitForSelection(), "a", "queued-before-wait");
	}

	// 2. A waiter registered first must be resolved directly when confirm arrives.
	{
		const session = openedSession(knownIds);
		const pending = session.waitForSelection();
		session.handleConfirm("b");
		await assertResolvesTo(pending, "b", "waiter-resolved-live");
	}

	// 3. An unknown id must never settle the session (defensive boundary check, per spec story 32).
	{
		const session = openedSession(knownIds);
		const pending = session.waitForSelection();
		session.handleConfirm("not-a-known-id");
		session.handleConfirm("a"); // the real, valid confirm that follows must still settle it
		await assertResolvesTo(pending, "a", "unknown-id-ignored-then-valid-confirm-settles");
	}

	// 4. Cancel settles with null.
	{
		const session = openedSession(knownIds);
		const pending = session.waitForSelection();
		session.handleCancel();
		await assertResolvesTo(pending, null, "cancel-resolves-null");
	}

	// 5. Once settled, a second confirm/cancel is ignored (idempotent single-settle contract).
	{
		const session = openedSession(knownIds);
		const pending = session.waitForSelection();
		session.handleConfirm("a");
		session.handleConfirm("b"); // must be a no-op
		session.handleCancel(); // must also be a no-op
		await assertResolvesTo(pending, "a", "settle-is-idempotent");
	}

	// 6. Ending the session (disconnect/close/browser-context-close) resolves a pending waiter with null exactly once.
	{
		const session = openedSession(knownIds);
		const pending = session.waitForSelection();
		session.handleEnded();
		session.handleEnded(); // idempotent; must not throw or double-resolve
		await assertResolvesTo(pending, null, "ended-resolves-null");
		await assertResolvesTo(session.waitForSelection(), null, "post-ended-resolves-null");
	}

	// 7. A confirm delivered after handleEnded() (a race with teardown) must not override the already-settled null outcome.
	{
		const session = openedSession(knownIds);
		session.handleEnded();
		session.handleConfirm("a"); // must be ignored: already settled to null
		await assertResolvesTo(session.waitForSelection(), null, "post-ended-confirm-ignored");
	}

	// 8. close() with no real browser/context/page (defensive no-op path) is idempotent and unblocks a pending waiter.
	{
		const session = openedSession(knownIds);
		const pending = session.waitForSelection();
		await session.close();
		await session.close(); // idempotent: must return the same settled outcome, not throw
		await assertResolvesTo(pending, null, "close-unblocks-pending-waiter");
	}

	// 9. waitForSelection() before open() (hasOpened still false) must throw, not hang.
	{
		const session = new TemplateGallerySession();
		let threw = false;
		try {
			session.waitForSelection();
		} catch {
			threw = true;
		}
		if (!threw) throw new Error("not-open: waitForSelection() before open() must throw");
	}

	// 10. Frame-trust boundary: a confirm/cancel "from" a child (iframe) frame
	// must never settle the session, even with a valid known id; the same call
	// from the real main frame must still work normally afterward. This is the
	// exact scenario a vendored template-preview iframe calling
	// window.__piConfirmSelection()/__piCancel() itself would hit in production.
	{
		const session = openedSession(knownIds);
		const mainFrame = { name: "main" };
		const childFrame = { name: "child-iframe" };
		session.mainFrame = mainFrame;

		const pending = session.waitForSelection();
		session.confirmFromSource({ frame: childFrame }, "a"); // forged call from a template preview iframe
		session.cancelFromSource({ frame: childFrame }); // forged cancel from a template preview iframe too
		session.confirmFromSource({ frame: mainFrame }, "a"); // the real, trusted confirm
		await assertResolvesTo(pending, "a", "child-frame-calls-rejected-then-main-frame-confirm-settles");
	}

	// 10b. A cancel forged from a child frame must not pre-empt a later,
	// legitimate cancel from the main frame (proves rejection, not just delay).
	{
		const session = openedSession(knownIds);
		const mainFrame = { name: "main" };
		const childFrame = { name: "child-iframe" };
		session.mainFrame = mainFrame;

		const pending = session.waitForSelection();
		session.cancelFromSource({ frame: childFrame } as never);
		let settledTooSoon = false;
		await Promise.race([
			pending.then(() => {
				settledTooSoon = true;
			}),
			new Promise((resolve) => setTimeout(resolve, 20)),
		]);
		if (settledTooSoon) throw new Error("child-frame-cancel: a child-frame cancel must not settle the session by itself");
		session.cancelFromSource({ frame: mainFrame } as never);
		await assertResolvesTo(pending, null, "child-frame-cancel-rejected-then-main-frame-cancel-settles");
	}

	console.log("gallery-session self-check OK (11 cases)");
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
