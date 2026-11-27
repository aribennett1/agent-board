import { registerHooks } from 'node:module';

// The server reuses the UI's pure board logic (ui/src/topics.ts and what it imports) so "done" means exactly what
// the Home tab shows as done. Those files import each other without a file extension, the way Vite expects; this
// resolve hook adds ".ts" for relative imports made from inside ui/src, and nothing else.
//
// WARNING: Node runs these UI files directly with type stripping, so the server breaks at startup if any of them
// (topics, visibility, triage, delivery, messages, others, boardDelta, and everything they import) gains:
//   - a runtime import of a .tsx file or a React/DOM module (`import type` is fine, it is erased),
//   - TypeScript-only syntax that cannot just be erased: enum, namespace, constructor parameter properties,
//     `import x = require()`, or JSX,
//   - a top-level read of Vite-only values such as import.meta.env.X without a guard.
// test/board-view.test.ts imports this module, so `npm test` catches it before a restart does.
const UI_SRC = new URL('../ui/src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(UI_SRC) && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

// A computed path keeps the root typecheck (nodenext, no Vite types) out of the UI files; ui/ typechecks them itself.
type Fn = (...args: any[]) => any;
const ui = async (name: string): Promise<Record<string, Fn>> => import(new URL(`../ui/src/${name}.ts`, import.meta.url).href);

const [topics, visibility, triage, delivery, messages, others, delta] = await Promise.all(
  ['topics', 'visibility', 'triage', 'delivery', 'messages', 'others', 'boardDelta'].map(ui),
);

export const buildTopics = topics.buildTopics;
export const needsYou = visibility.needsYou;
export const staleContext = triage.staleContext;
export const sameSha = triage.sameSha;
export const choiceText = delivery.choiceText;
export const slug = messages.slug;
export const prPath = others.prPath;
export const flattenBoard = delta.flattenBoard;
export const fingerprint = delta.fingerprint;
export const diffBoard = delta.diffBoard;
