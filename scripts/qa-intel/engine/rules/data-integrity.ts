import type { RuleRegistrar } from "../domain/Rule";
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding, IRule } from "../engine";

/**
 * True when a written value can come from outside the function: it names request, body or params style input, or
 * it reads a parameter of the enclosing function. A value built locally from a trusted config is not external.
 */
function isExternalInput(arg: Node): boolean {
  if (/\b(req|request|body|params|payload|formData|input)\b/i.test(arg.getText())) return true;
  const identifiers = Node.isIdentifier(arg) ? [arg] : arg.getDescendantsOfKind(SyntaxKind.Identifier);
  return identifiers.some((id) => {
    // A shorthand property `{ details }` counts as the identifier it names; its own symbol is the property's.
    const parent = id.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : id.getSymbol();
    return Node.isParameterDeclaration(symbol?.getValueDeclaration());
  });
}

export const DatabaseConstraintRule: IRule = {
  name: "database-constraint-enforcer",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    // Check for SQL migrations missing NOT NULL or CHECK constraints
    if (filePath.includes('migration') || filePath.includes('.sql')) {
      // Look for CREATE TABLE without proper constraints
      if (text.includes('CREATE TABLE')) {
        // Check for numeric columns that should have CHECK constraints
        const numericPattern = /(\w+)\s+(INT|BIGINT|SMALLINT|NUMERIC|DECIMAL|REAL|DOUBLE)\s*[,\s;]/g;
        const matches = text.matchAll(numericPattern);

        for (const match of matches) {
          const columnName = match[1];
          // Look for constraints on this column with word boundaries
          const constraintPattern = new RegExp(`\\b${columnName}\\b.*(?:NOT NULL|CHECK|DEFAULT|PRIMARY)`, 'i');
          if (!constraintPattern.test(text)) {
            // Only flag if column name suggests it should be constrained (e.g., count, count_total, amount)
            if (columnName.includes('count') || columnName.includes('amount') || columnName.includes('total')) {
              findings.push({
                file: filePath,
                severity: "medium",
                title: `Data Integrity: Missing constraints on numeric column '${columnName}'`,
                why: `Numeric column '${columnName}' has no CHECK constraint. Could store invalid values like -1 for count.`,
                fix: `Add CHECK constraint: '${columnName}' ${match[2]} NOT NULL CHECK (${columnName} >= 0)`
              });
            }
          }
        }
      }

      // Check for string columns that should be NOT NULL
      if (text.includes('CREATE TABLE')) {
        const stringPattern = /(\w+)\s+(VARCHAR|TEXT|CHAR)\s*[,\s;]/g;
        const matches = text.matchAll(stringPattern);

        for (const match of matches) {
          const columnName = match[1];
          // Look for NOT NULL on this column with word boundaries
          const notNullPattern = new RegExp(`\\b${columnName}\\b.*NOT NULL`, 'i');
          if (!notNullPattern.test(text)) {
            // Only flag if column name suggests it's required (e.g., userId, status)
            if (columnName.includes('_id') || columnName === 'status' || columnName === 'name') {
              findings.push({
                file: filePath,
                severity: "medium",
                title: `Data Integrity: Missing NOT NULL on key column '${columnName}'`,
                why: `String column '${columnName}' allows NULL. Key columns should be NOT NULL to prevent NULL comparisons in queries.`,
                fix: `Add NOT NULL constraint: '${columnName}' ${match[2]} NOT NULL`
              });
            }
          }
        }
      }
    }

    // Check TypeScript code for missing validation before DB insert
    if (filePath.includes('.ts') && !filePath.includes('test')) {
      // Look for direct DB operations without validation
      source.forEachDescendant((node) => {
        if (Node.isCallExpression(node)) {
          const callee = node.getExpression();
          const expr = callee.getText();
          // The write itself is the call named insert/update: its chained `.eq(...)` is a filter, not a second write.
          const isWrite = Node.isPropertyAccessExpression(callee) && ['insert', 'update'].includes(callee.getName());
          if (isWrite && (expr.includes('db.') || expr.includes('supabase.'))) {
            const args = node.getArguments();
            if (args.length > 0 && args.some(isExternalInput)) {
              // Check if there's validation before this call
              const parent = node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                             node.getFirstAncestorByKind(SyntaxKind.ArrowFunction);

              if (parent && !parent.getText().includes('validate') && !parent.getText().includes('zod') && !parent.getText().includes('schema')) {
                findings.push({
                  file: filePath,
                  severity: "high",
                  title: "Data Integrity: DB operation without validation",
                  why: "Data is inserted/updated into database without schema validation. Invalid data could corrupt database state.",
                  fix: "Add schema validation before DB operation: const validated = MySchema.parse(data); db.insert(validated);"
                });
              }
            }
          }
        }
      });
    }

    return findings;
  }
};

export const DefaultValueConsistencyRule: IRule = {
  name: "default-value-consistency",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    // Check for inconsistent default values across migrations and schema
    if (filePath.includes('migration') || filePath.includes('schema')) {
      // Look for DEFAULT clauses with different values for same column across files
      const defaultPattern = /DEFAULT\s+(?:'[^']*'|\d+|NULL|false|true)/gi;
      const matches = text.match(defaultPattern) || [];

      // Check for FALSE vs 'false' (string) inconsistency - be precise about word boundaries
      const hasBooleanFalse = matches.some(m => /DEFAULT\s+false\b/i.test(m));
      const hasStringFalse = matches.some(m => /DEFAULT\s+'false'/i.test(m));
      const hasBooleanTrue = matches.some(m => /DEFAULT\s+true\b/i.test(m));
      const hasStringTrue = matches.some(m => /DEFAULT\s+'true'/i.test(m));

      if ((hasBooleanFalse && hasStringFalse) || (hasBooleanTrue && hasStringTrue)) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "Data Integrity: Inconsistent DEFAULT values (boolean vs string)",
          why: "Some columns default to boolean false/true, others to string 'false'/'true'. This can cause comparison bugs.",
          fix: "Standardize all boolean defaults: use FALSE/TRUE (not 'false'/'true') for boolean columns, check type consistency."
        });
      }

      // Check for NULL defaults on columns that should be NOT NULL (only for explicit constraints)
      const nullDefaults = text.match(/NOT\s+NULL.*DEFAULT\s+NULL|DEFAULT\s+NULL.*NOT\s+NULL/gi) || [];
      if (nullDefaults.length > 0) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "Data Integrity: Column with NOT NULL and DEFAULT NULL",
          why: "Column marked as NOT NULL but has DEFAULT NULL. This is contradictory and will cause insert failures.",
          fix: "Remove DEFAULT NULL or remove NOT NULL constraint depending on intended behavior."
        });
      }
    }

    return findings;
  }
};

const SINK_CALL = /^(insert|update|upsert|upload|put|send|json|write|writeFile|set|save|store|append|post|publish)$/;

/**
 * True when the value of `start` reaches storage or a caller: it is returned, written to a property, or passed to a
 * storing call (a DB write, an upload, a response). A local alias is followed to each of its reads.
 */
function reachesSink(start: Node, seen = new Set<Node>()): boolean {
  let child: Node = start;
  for (let cur = start.getParent(); cur; child = cur, cur = cur.getParent()) {
    if (Node.isReturnStatement(cur)) return true;
    if (Node.isArrowFunction(cur)) return cur.getBody() === child;
    if (Node.isCallExpression(cur) && cur.getArguments().includes(child)) {
      const callee = cur.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      if (SINK_CALL.test(name)) return true;
    }
    if (Node.isBinaryExpression(cur) && cur.getRight() === child && cur.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const target = cur.getLeft();
      if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) return true;
    }
    if (Node.isVariableDeclaration(cur)) {
      const name = cur.getNameNode();
      if (!Node.isIdentifier(name) || seen.has(cur)) return false;
      seen.add(cur);
      // Same-name reads inside the declaring function (or file): cheaper and steadier than a language-service lookup.
      const scope = cur.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a)) ?? cur.getSourceFile();
      return scope
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((ref) => ref !== name && ref.getText() === name.getText() && reachesSink(ref, seen));
    }
    if (Node.isStatement(cur)) return false;
  }
  return false;
}

export const TruncationValidationRule: IRule = {
  name: "truncation-validation-enforcer",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      // Look for string truncation without ellipsis or validation
      if (Node.isCallExpression(node)) {
        // Only the actual string-truncation METHODS count (x.slice / x.substring /
        // x.substr). A substring match on the callee text also flagged any
        // function merely NAMED like them (sliceText, sliceDigest in the R3b
        // transcript-slice module, 2026-10-01) -- not truncation at all.
        const callee = node.getExpression();
        const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
        if (method === 'slice' || method === 'substring' || method === 'substr') {
          // Array.prototype.slice copies a range of elements; it is not text
          // truncation (e.g. words.slice(start, end) in transcript-slice.ts).
          if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getType().isArray()) return;
          // A negative end index (e.g. slice(0, -1)) means "drop the last N
          // characters" -- structurally never a "truncate to length N for
          // display" operation, so it can't need an ellipsis (real
          // false-positive class, review finding 2026-09-07:
          // trimUrlTrailingPunctuation's slice(0, -1) loop flagged as if it
          // were lossy display truncation).
          // A single-argument slice (`.slice(7)`, `.slice(prefix.length)`) strips a prefix and keeps the rest, and a
          // fixed-width date (`toISOString().slice(0, 10)`) is a format, not lossy truncation.
          if (node.getArguments().length < 2) return;
          if (Node.isPropertyAccessExpression(callee) && /\.toISOString\(\)$/.test(callee.getExpression().getText())) return;
          // Lossy only if the result is kept: stored, written to a row, or returned to a caller or response.
          if (!reachesSink(node)) return;
          const endArg = node.getArguments()[1];
          const isNegativeEnd = endArg && (
            Node.isPrefixUnaryExpression(endArg) && endArg.getOperatorToken() === SyntaxKind.MinusToken
          );
          if (isNegativeEnd) return;

          // Check if this is truncating without indicating truncation (no ellipsis)
          const parent = node.getParent();
          if (parent && !parent.getText().includes('...') && !parent.getText().includes('ellipsis')) {
            findings.push({
              file: filePath,
              severity: "low",
              title: "Data Quality: String truncation without ellipsis indicator",
              why: "String is truncated but doesn't add '...' to indicate more content. User sees incomplete text.",
              fix: "Add ellipsis when truncating: text.slice(0, 50) + (text.length > 50 ? '...' : '')"
            });
          }
        }
      }
    });

    return findings;
  }
};

/**
 * Register all data-integrity rules with the QA-Intel engine.
 * Includes rules for database schema constraints, default value consistency,
 * and string truncation validation.
 * @param engine - The QA-Intel engine instance
 */
export function registerDataIntegrityRules(engine: unknown) {
  const e = engine as RuleRegistrar;
  e.addRule(DatabaseConstraintRule);
  e.addRule(DefaultValueConsistencyRule);
  e.addRule(TruncationValidationRule);
}
