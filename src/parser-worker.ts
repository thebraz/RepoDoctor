import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { compareText, type Dependency, type Diagnostic, type DuplicationSource, type FileMetric } from './model.js';

export interface ParseJob { file: string; source: string; maxNodes: number; maxDependencies: number; maxDuplicationTokens: number; maxFunctions: number }
export interface ParsedSource { dependencies: Dependency[]; diagnostics: Diagnostic[]; valid: boolean; generated: boolean; metrics: FileMetric | null; duplication: DuplicationSource | null; duplicationComplete: boolean; duplicationTokensRead: number }

function parseSource({ file, source, maxNodes, maxDependencies, maxDuplicationTokens, maxFunctions }: ParseJob): ParsedSource {
  const result: ParsedSource = { dependencies: [], diagnostics: [], valid: true, generated: false, metrics: null, duplication: null, duplicationComplete: true, duplicationTokensRead: 0 };
  if (/^\s*(?:\/\/[^\n]*@generated\b|\/\*[\s\S]{0,500}?@generated\b)/.test(source.slice(0, 600))) { result.generated = true; return result; }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  // The public compiler API exposes syntax diagnostics via a program. The host
  // reuses this AST and cannot read imports, libraries or the target filesystem.
  const host: ts.CompilerHost = {
    getSourceFile: name => name === file ? ast : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n', fileExists: name => name === file, readFile: () => undefined
  };
  const program = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, host);
  const errors = program.getSyntacticDiagnostics(ast);
  if (errors.length) {
    result.valid = false;
    for (const error of errors.slice(0, 100)) {
      const location = ast.getLineAndCharacterOfPosition(error.start ?? 0);
      result.diagnostics.push({ code: 'SYNTAX_ERROR', severity: 'error', message: `Invalid syntax (TS${error.code}); references from this file were not used.`,
        file, line: location.line + 1, column: location.character + 1 });
    }
    return result;
  }
  if (ast.referencedFiles.length || ast.typeReferenceDirectives.length || ast.libReferenceDirectives.length) {
    result.diagnostics.push({ code: 'UNSUPPORTED_REFERENCE', severity: 'warning', message: 'Triple-slash directives are not resolved at this stage.', file });
  }
  const nodes: { node: ts.Node; ambient: boolean }[] = [];
  const stack: typeof nodes = [{ node: ast, ambient: ast.isDeclarationFile }];
  let shadowedRequire = false;
  const functionNames = new Map<ts.Node, string>();
  const bindsRequire = (name: ts.BindingName): boolean => ts.isIdentifier(name) ? name.text === 'require' :
    name.elements.some(element => ts.isBindingElement(element) && bindsRequire(element.name));
  const writesRequire = (target: ts.Node): boolean => {
    if (ts.isIdentifier(target)) return target.text === 'require';
    if (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target) || ts.isNonNullExpression(target) || ts.isSatisfiesExpression(target) || ts.isSpreadElement(target) || ts.isSpreadAssignment(target)) return writesRequire(target.expression);
    if (ts.isArrayLiteralExpression(target)) return target.elements.some(writesRequire);
    if (ts.isObjectLiteralExpression(target)) return target.properties.some(property => ts.isShorthandPropertyAssignment(property) ? property.name.text === 'require' : ts.isPropertyAssignment(property) ? writesRequire(property.initializer) : ts.isSpreadAssignment(property) && writesRequire(property.expression));
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) return writesRequire(target.left);
    return false;
  };
  while (stack.length) {
    const frame = stack.pop()!;
    const node = frame.node;
    const ambient = frame.ambient || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true);
    if (nodes.length >= maxNodes) {
      result.valid = false;
      result.diagnostics.push({ code: 'AST_LIMIT', severity: 'warning', message: 'Syntax node limit reached; file not analyzed.', file });
      return result;
    }
    nodes.push({ node, ambient });
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functionNames.set(node.initializer, node.name.text);
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && bindsRequire(node.name) ||
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isImportEqualsDeclaration(node)) && node.name?.text === 'require' ||
      ts.isNamespaceImport(node) && node.name.text === 'require' ||
      (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name.text === 'require' ||
      ts.isImportClause(node) && node.name?.text === 'require' ||
      ts.isImportSpecifier(node) && node.name.text === 'require') shadowedRequire = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && writesRequire(node.left) ||
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && writesRequire(node.operand) ||
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) && writesRequire(node.initializer)) shadowedRequire = true;
    ts.forEachChild(node, child => { stack.push({ node: child, ambient }); });
  }
  const lineCount = source.length === 0 ? 0 : ast.getLineStarts().length - (/[\r\n\u2028\u2029]$/.test(source) ? 1 : 0);
  result.metrics = { file, lines: lineCount, functions: [] };
  const bodies: ts.Node[] = [];
  for (const { node, ambient } of nodes) {
    if (ambient || !(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) || !node.body) continue;
    if (result.metrics.functions.length >= maxFunctions) {
      result.diagnostics.push({ code: 'METRIC_LIMIT', severity: 'warning', message: 'Global metric function limit reached; partial metrics and duplication bodies.', file });
      break;
    }
    const start = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    const end = ast.getLineAndCharacterOfPosition(Math.max(node.getStart(ast), node.getEnd() - 1));
    const name = functionNames.get(node) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : node.name && !ts.isComputedPropertyName(node.name) ? ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(ast) : '(anonymous/computed)');
    result.metrics.functions.push({ name, line: start.line + 1, column: start.character + 1, endLine: end.line + 1, lines: end.line - start.line + 1 });
    bodies.push(node.body);
  }
  result.metrics.functions.sort((a, b) => a.line - b.line || a.column - b.column || compareText(a.name, b.name));
  const tokens: DuplicationSource['tokens'] = [];
  const positions: number[] = [];
  const lexical: ts.Node[] = [ast];
  let visitedTokens = 0;
  while (lexical.length) {
    const node = lexical.pop()!;
    if (++visitedTokens > maxNodes * 3) { result.duplicationComplete = false; break; }
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) continue;
    const children = node.getChildren(ast);
    if (children.length) { for (let i = children.length - 1; i >= 0; i--) lexical.push(children[i]!); continue; }
    if (node.kind <= ts.SyntaxKind.LastToken && node.kind !== ts.SyntaxKind.EndOfFileToken) {
      if (tokens.length >= maxDuplicationTokens) { result.duplicationComplete = false; break; }
      const position = node.getStart(ast); positions.push(position);
      const start = ast.getLineAndCharacterOfPosition(position);
      const end = ast.getLineAndCharacterOfPosition(Math.max(position, node.getEnd() - 1));
      tokens.push({ hash: createHash('sha256').update(`${node.kind}:${node.getText(ast)}`).digest('hex'), line: start.line + 1, column: start.character + 1, endLine: end.line + 1 });
    }
  }
  result.duplicationTokensRead = tokens.length;
  if (!result.duplicationComplete) result.diagnostics.push({ code: 'DUPLICATION_TOKEN_LIMIT', severity: 'warning', message: 'Duplication token/traversal limit reached; duplication for this file not assessed.', file });
  else {
    const lowerBound = (position: number): number => {
      let low = 0; let high = positions.length;
      while (low < high) { const middle = (low + high) >>> 1; if (positions[middle]! < position) low = middle + 1; else high = middle; }
      return low;
    };
    result.duplication = { file, tokens, blocks: [{ start: 0, end: tokens.length }, ...bodies.map(body => ({ start: lowerBound(body.getStart(ast)), end: lowerBound(body.getEnd()) }))] };
  }
  let ambientScope = false;
  const add = (node: ts.Node, specifier: string | null, kind: Dependency['kind'], syntax: Dependency['syntax'], reason: string | null = null): void => {
    if (!result.valid) return;
    if (result.dependencies.length >= maxDependencies) {
      result.valid = false;
      result.dependencies = [];
      result.diagnostics.push({ code: 'DEPENDENCY_LIMIT', severity: 'warning', message: 'Reference limit reached; file not analyzed.', file });
      return;
    }
    const position = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    const explanation = reason ?? (specifier === null ? 'Dynamic reference without a literal argument; target cannot be determined.' : null);
    result.dependencies.push({ from: file, line: position.line + 1, column: position.character + 1, specifier, kind: ambientScope ? 'type-only' : kind, syntax,
      resolution: explanation ? 'indeterminate' : 'unresolved', to: null, reason: explanation });
    if (reason || specifier === null) result.diagnostics.push({ code: 'INDETERMINATE_REFERENCE', severity: 'warning',
      message: reason ?? 'Dynamic reference without a literal argument; target cannot be determined.', file, line: position.line + 1, column: position.character + 1 });
  };
  const literal = (node: ts.Node | undefined): string | null => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  for (const { node, ambient } of nodes) {
    ambientScope = ambient;
    if (!result.valid) break;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      const onlyType = clause?.isTypeOnly || (!clause?.name && named.length > 0 && named.every(item => item.isTypeOnly));
      add(node, literal(node.moduleSpecifier), onlyType ? 'type-only' : 'runtime', 'import');
      if (!onlyType && named.some(item => item.isTypeOnly)) add(node, literal(node.moduleSpecifier), 'type-only', 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [];
      const onlyType = node.isTypeOnly || (named.length > 0 && named.every(item => item.isTypeOnly));
      add(node, literal(node.moduleSpecifier), onlyType ? 'type-only' : 'runtime', 're-export');
      if (!onlyType && named.some(item => item.isTypeOnly)) add(node, literal(node.moduleSpecifier), 'type-only', 're-export');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, literal(node.moduleReference.expression), node.isTypeOnly ? 'type-only' : 'runtime', 'require');
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : null, 'type-only', 'import-type');
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, literal(node.arguments[0]), 'runtime', 'dynamic-import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node, shadowedRequire ? null : literal(node.arguments[0]), 'runtime', 'require', shadowedRequire ? 'A local binding or modification of require prevents confirmation of CommonJS resolution.' : null);
      } else if (ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'require' || ts.isMetaProperty(node.expression.expression))) {
        add(node, null, 'runtime', 'dynamic-import', 'Indirect or tool-specific loader is not supported.');
      }
    }
  }
  return result;
}

parentPort?.on('message', (job: ParseJob) => {
  try { parentPort?.postMessage(parseSource(job)); }
  catch { parentPort?.postMessage({ dependencies: [], diagnostics: [{ code: 'PARSE_ERROR', severity: 'error', message: 'Parser failed; file not analyzed.', file: job.file }], valid: false, generated: false, metrics: null, duplication: null, duplicationComplete: false, duplicationTokensRead: 0 } satisfies ParsedSource); }
});
