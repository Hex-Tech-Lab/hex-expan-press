import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding, IRule } from "../engine";

export const InpAlertBlockerRule: IRule = {
  name: "inp-alert-blocker",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    if (!filePath.includes('.tsx') && !filePath.includes('.jsx')) return findings;

    source.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression().getText();
        if (expr === 'alert') {
          const func = node.getFirstAncestorByKind(SyntaxKind.ArrowFunction)
            || node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)
            || node.getFirstAncestorByKind(SyntaxKind.FunctionExpression);
          if (func) {
            const parent = func.getParent();
            const isEventHandler = parent && (
              Node.isJsxAttribute(parent) ||
              (Node.isVariableDeclaration(parent) && parent.getName().startsWith('handle'))
            );
            if (isEventHandler) {
              findings.push({
                file: filePath,
                severity: "high",
                title: "INP: alert() blocks main thread in event handler",
                why: "alert() is synchronous and blocks the main thread for 100-500ms. Causes INP regression on every affected click.",
                fix: "Replace alert() with a non-blocking toast: showToast(message) using a CSS-animated DOM element."
              });
            }
          }
        }
      }
    });
    return findings;
  }
};

export const CanvasHoverReRenderRule: IRule = {
  name: "canvas-hover-rerender",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if ((text.includes('<canvas') || text.includes('ForceGraph2D') || text.includes('react-force-graph'))
        && text.includes('setHover') && text.includes('useState')) {
      findings.push({
        file: filePath,
        severity: "high",
        title: "INP: Canvas hover triggers React re-render",
        why: "useState for hover state causes full component re-render on every mousemove. Canvas should redraw imperatively.",
        fix: "Use useRef for hoverId + imperative canvas redraw. Call drawCanvas() directly instead of setState."
      });
    }

    // Hover triggers synchronous state re-render check (CRBench)
    if (text.includes('onMouseEnter') || text.includes('onMouseLeave')) {
      const stateSetters = text.match(/onMouseEnter\s*=\s*\{\s*\(\s*\)\s*=>\s*set(Hovered|Hover|Active|Selected)\([^}]*\)\s*\}/gi);
      if (stateSetters && stateSetters.length > 0) {
        if (!text.includes('useTransition') && !text.includes('startTransition')) {
          findings.push({
            file: filePath,
            severity: "medium",
            title: "Performance: Hover triggers synchronous state re-render",
            why: "Direct state setting on hover events forces synchronous React rendering on mouse interactions.",
            fix: "Wrap hover state updates inside React startTransition or use transition deferral hook."
          });
        }
      }
    }

    return findings;
  }
};

export const OverlayCloseCascadeRule: IRule = {
  name: "overlay-close-cascade",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('inert=') && text.includes('setOverlayOpen')) {
      const closeHandlers = text.match(/onClick=\{[^}]*set\w+\(null\)/g) || [];
      const transitionWrapped = text.includes('startTransition');

      if (closeHandlers.length > 0 && !transitionWrapped) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "INP: Overlay close cascades full component re-render",
          why: "Overlay close triggers state update that re-renders the entire parent (potentially 500+ lines). Blocks UI for 200-500ms.",
          fix: "Wrap close handler in startTransition: onClick={() => startTransition(() => setX(null))}"
        });
      }
    }
    return findings;
  }
};

export const ValidationOnChangeRule: IRule = {
  name: "validation-onchange-detector",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('safeParse') || text.includes('.parse(')) {
      const isStore = filePath.includes('store/') || filePath.includes('Store');
      if (isStore && (text.includes('setUrl') || text.includes('setQuery') || text.includes('setSearch'))) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "INP: Synchronous validation in onChange/state setter",
          why: "Zod safeParse (regex) runs on every keystroke. Blocks UI for 200-500ms per keystroke.",
          fix: "Remove validation from the state setter. Defer to submit/analyze time: validate only when user triggers action."
        });
      }
    }
    return findings;
  }
};

export const UnhandledClipboardPromiseRule: IRule = {
  name: "unhandled-clipboard-promise",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('navigator.clipboard')) {
      source.forEachDescendant((node) => {
        if (Node.isCallExpression(node)) {
          const expr = node.getExpression().getText();
          if (expr.includes('clipboard.writeText') || expr.includes('clipboard.readText')) {
            const tryStatement = node.getFirstAncestorByKind(SyntaxKind.TryStatement);
            const hasCatch = node.getFirstAncestorByKind(SyntaxKind.CatchClause);
            const parentText = node.getParent()?.getText() || '';
            const hasDotCatch = parentText.includes('.catch(');

            if (!tryStatement && !hasCatch && !hasDotCatch) {
              findings.push({
                file: filePath,
                severity: "medium",
                title: "Promise: Unhandled clipboard promise rejection",
                why: "navigator.clipboard returns a Promise. Without catch, permission denial causes unhandled rejection in console.",
                fix: "Wrap in try/catch or add .catch(() => {}): await navigator.clipboard.writeText(text).catch(() => {})"
              });
            }
          }
        }
      });
    }
    return findings;
  }
};

export const StartTransitionWrappingRule: IRule = {
  name: "start-transition-wrapping",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (!filePath.includes('Dashboard') && !filePath.includes('Container')) return findings;

    const directPasses = text.match(/onSelect=\{set\w+\}/g) || [];
    if (directPasses.length > 0 && !text.includes('startTransition')) {
      findings.push({
        file: filePath,
        severity: "medium",
        title: "INP: High-frequency state setter passed directly to child",
        why: "setSelectedNodeId/setConsoleTab passed directly to child. Each click/hover triggers full re-render of 500+ line parent.",
        fix: "Create handleSelectNode = (id) => startTransition(() => setSelectedNodeId(id)) and pass that instead."
      });
    }
    return findings;
  }
};

export const ToastAccessibilityRule: IRule = {
  name: "toast-accessibility-audit",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('showToast') || text.includes('toast(')) {
      const hasRole = text.includes('role="alert"') || text.includes("role='alert'") || text.includes('role={');
      const hasAriaLive = text.includes('aria-live');

      if (!hasRole && !hasAriaLive) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "Accessibility: Toast notification missing role/aria-live",
          why: "showToast() renders a notification but the container lacks role='alert' or aria-live='polite'. Screen readers won't announce the toast.",
          fix: "Add role='alert' aria-live='assertive' (for errors) or role='status' aria-live='polite' (for info) to the toast container element."
        });
      }
    }
    return findings;
  }
};

export const SwallowedErrorRule: IRule = {
  name: "swallowed-error-detector",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      if (Node.isCatchClause(node)) {
        const block = node.getBlock();
        const statements = block.getStatements();
        // CodeQL-flagged ReDoS: /^(\s*\/\/.*\s*)*$/ nests a `*`-repeated group
        // around `\s*...\s*`, causing exponential backtracking on adversarial
        // input (many `//` sequences with no full match). Same "every line is
        // a // comment" check, done via a line-by-line loop instead of a
        // single regex with nested quantifiers -- linear time, no
        // backtracking possible.
        const isAllLineComments = (text: string): boolean => {
          const lines = text.split('\n');
          return lines.every((line) => {
            const trimmed = line.trim();
            return trimmed === '' || trimmed.startsWith('//');
          });
        };
        const hasOnlyComments = statements.length === 0 && block.getFullText().trim().length > 0 && (/^\s*\/\*[\s\S]*\*\/\s*$/.test(block.getFullText()) || isAllLineComments(block.getFullText().trim()));
        if (statements.length === 0 && !hasOnlyComments) {
          findings.push({
            file: filePath,
            severity: "high",
            title: "Error: Empty catch block swallows error silently",
            why: "Empty catch() hides failures. Clipboard, fetch, or persist errors are silently lost.",
            fix: "At minimum, log the error: catch(e) { console.error('[context]', e) }"
          });
        }
      }

      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'catch') {
          const arg = node.getArguments()[0];
          if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
            const body = arg.getBody();
            const isBlock = Node.isBlock(body);
            if (isBlock && body.getStatements().length === 0) {
              findings.push({
                file: filePath,
                severity: "medium",
                title: "Error: .catch(() => {}) swallows promise rejection",
                why: "Empty .catch(() => {}) hides failures. User gets no feedback when action fails.",
                fix: "Replace with .catch(e => console.error('[context]', e)) or .catch(e => showToast('Error: ' + e.message))"
              });
            }
          }
        }
      }
    });
    return findings;
  }
};

export const SyncImportBeforeRedirectRule: IRule = {
  name: "sync-import-before-redirect",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    if (!filePath.includes('.tsx') && !filePath.includes('.jsx')) return findings;

    source.forEachDescendant((node) => {
      if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        const funcText = node.getText();
        const hasDynamicImport = funcText.includes('import(');
        const hasRedirect = funcText.includes('signInWithOAuth') || funcText.includes('router.push') || funcText.includes('window.location');
        const hasSetLoading = funcText.includes('setLoading') || funcText.includes('loading = true');

        if (hasDynamicImport && hasRedirect && hasSetLoading) {
          const hasYield = funcText.includes('setTimeout(resolve') || funcText.includes('await new Promise');
          if (!hasYield) {
            findings.push({
              file: filePath,
              severity: "high",
              title: "INP: Synchronous import before redirect blocks paint",
              why: "loading=true set, then synchronous import resolves, then redirect blocks thread. Button 'Signing in...' state never paints. INP attributed to ancestor layout div.",
              fix: "After setting loading=true, yield the thread: await new Promise(r => setTimeout(r, 0)). This lets browser paint the disabled button before the heavy redirect sequence."
            });
          }
        }
      }
    });
    return findings;
  }
};

export const CanvasStaleDataRule: IRule = {
  name: "canvas-stale-data-audit",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if ((text.includes('d3.') || text.includes('canvas') || text.includes('ForceGraph')) && text.includes('useEffect')) {
      const effectBlocks = text.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[[\s\S]*?\]\)/g) || [];
      for (const block of effectBlocks) {
        const hasGraphData = block.includes('graphData') || block.includes('nodes') || block.includes('words') || block.includes('data');
        if (!hasGraphData && (block.includes('d3.') || block.includes('canvas'))) {
          findings.push({
            file: filePath,
            severity: "high",
            title: "Canvas: d3/canvas render effect missing data dependency",
            why: "useEffect renders d3 visualization but dependency array doesn't include the data variable.",
            fix: "Add graphData/nodes/words to the useEffect dependency array."
          });
          break;
        }
      }
    }
    return findings;
  }
};

export const ZustandWholeStoreInEffectDepsRule: IRule = {
  name: "zustand-whole-store-effect-deps",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    // A Zustand store hook called with NO selector argument (`useXStore()`)
    // subscribes to the WHOLE store object. Every set() call anywhere in
    // that store produces a new top-level object reference -- so binding
    // that whole-store value and then including it in a useEffect/useMemo/
    // useCallback dependency array causes the effect to re-run on ANY
    // unrelated store update, including its own setter calls made inside
    // the same effect. Confirmed real bug (hex-yt-intel useChapters.ts,
    // 2026-08-06): this made an entire feature non-functional -- an
    // in-flight async fetch was silently cancelled by the effect's own
    // state-setting call, permanently stuck at a "loading" status.
    const noSelectorCalls = [...text.matchAll(/const\s+(\w+)\s*=\s*(use\w*Store)\(\s*\)/g)];
    for (const match of noSelectorCalls) {
      const varName = match[1]!;
      const storeHookName = match[2]!;
      // Match the standard `useEffect(() => { ...body... }, [deps])` shape --
      // [\s\S]*? (not [^;]*?) so the scan isn't blocked by semicolons inside
      // the callback body, which real effect bodies always have.
      const depArrayRe = new RegExp(`use(?:Effect|Memo|Callback)\\([\\s\\S]*?\\},\\s*\\[[^\\]]*\\b${varName}\\b[^\\]]*\\]\\)`);
      if (depArrayRe.test(text)) {
        findings.push({
          file: filePath,
          severity: "critical",
          title: "React: whole Zustand store object in effect/memo dependency array",
          why: `'${varName}' is bound from '${storeHookName}()' with no selector -- it subscribes to the WHOLE store and gets a new object reference on every state change anywhere in the store. Including it in a dependency array can self-trigger the effect on its own setter calls, silently cancelling in-flight async work.`,
          fix: `Select only what's needed: 'const ${varName} = ${storeHookName}((state) => state.someField)' for values, or 'const setX = ${storeHookName}((state) => state.setX)' for stable action references. Never put a whole un-selected store binding in a dependency array.`
        });
      }
    }

    return findings;
  }
};
