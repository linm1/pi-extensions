// Production-only adapter: `@earendil-works/pi-ai/compat` resolves via the
// real `pi` runtime's jiti aliases (see node_modules/@earendil-works/pi-coding-agent
// dist/core/extensions/loader.js `getAliases()`), the same way the built-in
// qna.ts/custom-compaction.ts example extensions use it. Not resolvable under
// plain `node`, so this file must never be imported by a self-check.
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CompletionFn } from "./recommend.ts";

/** Builds the real nested-completion adapter from the active session model and credentials. */
export function createModelCompletion(ctx: ExtensionCommandContext): CompletionFn {
	return async (systemPrompt, userPrompt, signal) => {
		if (!ctx.model) throw new Error("No model selected.");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) throw new Error(auth.error);
		if (!auth.apiKey) throw new Error(`No API key configured for ${ctx.model.provider}.`);

		const response = await complete(
			ctx.model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
		);

		if (response.stopReason === "aborted") throw new Error("Template ranking was cancelled.");

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	};
}
