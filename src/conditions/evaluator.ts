/**
 * Safe condition evaluator for `when:` clauses. Supports the object form
 * `{ task, status }` and a tiny expression grammar (no code evaluation):
 *
 *   expr   := or ; or := and ('||' and)* ; and := unary ('&&' unary)*
 *   unary  := '!' unary | cmp
 *   cmp    := value (('==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'contains') value)?
 *   value  := STRING | NUMBER | true | false | null | list | path | '(' expr ')'
 *   path   := IDENT ('.' IDENT | '[' STRING ']')*   with `.length` on arrays/strings
 */
import type { WhenSpec } from '../types/workflow.js';

type Token =
  | { kind: 'op'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'eof' };

export type ExprNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'path'; parts: string[] }
  | { kind: 'list'; items: ExprNode[] }
  | { kind: 'not'; operand: ExprNode }
  | { kind: 'binary'; op: string; left: ExprNode; right: ExprNode };

const TWO_CHAR = ['==', '!=', '>=', '<=', '&&', '||'];
const ONE_CHAR = ['!', '>', '<', '(', ')', '[', ']', ',', '.'];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error(`Unterminated string in expression: ${src}`);
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && !/[A-Za-z_]/.test(src[i - 1] ?? '')) {
      tokens.push({ kind: 'number', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (ident) {
      tokens.push({ kind: 'ident', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in expression: ${src}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode {
    const node = this.or();
    if (this.peek().kind !== 'eof') throw new Error(`Unexpected token after expression: ${this.describe(this.peek())}`);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private describe(t: Token): string {
    return t.kind === 'eof' ? 'end of input' : `"${String((t as { value: unknown }).value)}"`;
  }
  private isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.value === value;
  }
  private isIdent(value: string): boolean {
    const t = this.peek();
    return t.kind === 'ident' && t.value === value;
  }
  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new Error(`Expected "${value}" but found ${this.describe(this.peek())}`);
    this.next();
  }

  private or(): ExprNode {
    let left = this.and();
    while (this.isOp('||')) {
      this.next();
      left = { kind: 'binary', op: '||', left, right: this.and() };
    }
    return left;
  }
  private and(): ExprNode {
    let left = this.unary();
    while (this.isOp('&&')) {
      this.next();
      left = { kind: 'binary', op: '&&', left, right: this.unary() };
    }
    return left;
  }
  private unary(): ExprNode {
    if (this.isOp('!')) {
      this.next();
      return { kind: 'not', operand: this.unary() };
    }
    return this.cmp();
  }
  private cmp(): ExprNode {
    const left = this.value();
    const t = this.peek();
    if (t.kind === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(t.value)) {
      this.next();
      return { kind: 'binary', op: t.value, left, right: this.value() };
    }
    if (t.kind === 'ident' && (t.value === 'in' || t.value === 'contains')) {
      this.next();
      return { kind: 'binary', op: t.value, left, right: this.value() };
    }
    return left;
  }
  private value(): ExprNode {
    const t = this.next();
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'number') return { kind: 'literal', value: t.value };
    if (t.kind === 'op' && t.value === '(') {
      const inner = this.or();
      this.expectOp(')');
      return inner;
    }
    if (t.kind === 'op' && t.value === '[') {
      const items: ExprNode[] = [];
      if (!this.isOp(']')) {
        items.push(this.value());
        while (this.isOp(',')) {
          this.next();
          items.push(this.value());
        }
      }
      this.expectOp(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'ident') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      const parts = [t.value];
      for (;;) {
        if (this.isOp('.')) {
          this.next();
          const id = this.next();
          if (id.kind !== 'ident') throw new Error(`Expected identifier after "." but found ${this.describe(id)}`);
          parts.push(id.value);
        } else if (this.isOp('[')) {
          this.next();
          const key = this.next();
          if (key.kind !== 'string' && key.kind !== 'number') {
            throw new Error(`Expected string or number inside [] but found ${this.describe(key)}`);
          }
          parts.push(String(key.value));
          this.expectOp(']');
        } else break;
      }
      return { kind: 'path', parts };
    }
    throw new Error(`Unexpected ${this.describe(t)} in expression`);
  }
}

export function parseExpression(src: string): ExprNode {
  return new Parser(tokenize(src)).parse();
}

/** Task ids referenced through `tasks.<id>` or `tasks["<id>"]`. */
export function referencedTasks(node: ExprNode): string[] {
  const out = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'path':
        if (n.parts[0] === 'tasks' && n.parts[1]) out.add(n.parts[1]);
        break;
      case 'list':
        n.items.forEach(walk);
        break;
      case 'not':
        walk(n.operand);
        break;
      case 'binary':
        walk(n.left);
        walk(n.right);
        break;
      default:
        break;
    }
  };
  walk(node);
  return [...out];
}

function resolvePath(scope: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = scope;
  for (const part of parts) {
    if (cur === null || cur === undefined) return null;
    if (part === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
      continue;
    }
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return cur === undefined ? null : cur;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  return false;
}

export function evaluateExpression(node: ExprNode, scope: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return resolvePath(scope, node.parts);
    case 'list':
      return node.items.map((i) => evaluateExpression(i, scope));
    case 'not':
      return !truthy(evaluateExpression(node.operand, scope));
    case 'binary': {
      if (node.op === '&&') return truthy(evaluateExpression(node.left, scope)) && truthy(evaluateExpression(node.right, scope));
      if (node.op === '||') return truthy(evaluateExpression(node.left, scope)) || truthy(evaluateExpression(node.right, scope));
      const l = evaluateExpression(node.left, scope);
      const r = evaluateExpression(node.right, scope);
      switch (node.op) {
        case '==':
          return looseEquals(l, r);
        case '!=':
          return !looseEquals(l, r);
        case '>':
          return Number(l) > Number(r);
        case '>=':
          return Number(l) >= Number(r);
        case '<':
          return Number(l) < Number(r);
        case '<=':
          return Number(l) <= Number(r);
        case 'in':
          if (Array.isArray(r)) return r.some((x) => looseEquals(x, l));
          if (typeof r === 'string') return r.includes(String(l));
          return false;
        case 'contains':
          if (Array.isArray(l)) return l.some((x) => looseEquals(x, r));
          if (typeof l === 'string') return l.includes(String(r));
          return false;
        default:
          throw new Error(`Unknown operator ${node.op}`);
      }
    }
    default:
      return null;
  }
}

export function compileWhen(when: WhenSpec): { ast: ExprNode; refs: string[] } {
  let ast: ExprNode;
  if ('expr' in when) {
    ast = parseExpression(when.expr);
  } else {
    const statuses = Array.isArray(when.status) ? when.status : [when.status];
    ast = {
      kind: 'binary',
      op: 'in',
      left: { kind: 'path', parts: ['tasks', when.task, 'status'] },
      right: { kind: 'list', items: statuses.map((s) => ({ kind: 'literal', value: s }) as ExprNode) },
    };
  }
  return { ast, refs: referencedTasks(ast) };
}

export function evaluateWhen(when: WhenSpec, scope: Record<string, unknown>): boolean {
  return truthy(evaluateExpression(compileWhen(when).ast, scope));
}
