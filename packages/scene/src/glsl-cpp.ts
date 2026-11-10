// The conditionals and macros of a GLSL shader, as far as reading its declarations needs them: which lines an `#if`
// leaves out, and what an array length written as a macro is. The renderer does the same for the program it draws
// (`crates/core/src/glsl_cpp.rs`), so what the context lists, `getActiveUniform` and `getAttribLocation`, is what the
// renderer reads. Object-like macros, `#if`, `#ifdef`, `#ifndef`, `#elif`, `#else`, `#endif`, `#undef`, integer
// expressions with `defined` and the C operators. Function-like macros are known by name only.

interface Macro {
  functionLike: boolean;
  value: string;
}

const MAX_DEPTH = 16;

class Calculator {
  private tokens: string[];
  private at = 0;

  constructor(
    private readonly macros: Map<string, Macro>,
    text: string,
    private readonly depth: number,
    private readonly strict: boolean,
  ) {
    if (depth > MAX_DEPTH) throw new Error('a macro expands without end');
    this.tokens = text.match(/[A-Za-z_0-9]+|&&|\|\||==|!=|<=|>=|<<|>>|[!~+\-*/%<>&|^()?:]/g) ?? [];
    if (this.tokens.join('').length !== text.replace(/\s+/g, '').length) throw new Error(`unexpected character in \`${text}\``);
  }

  run(): number {
    const value = this.ternary();
    if (this.at < this.tokens.length) throw new Error(`unexpected \`${this.tokens[this.at]}\``);
    return value;
  }

  private ternary(): number {
    const condition = this.binary(1);
    if (this.tokens[this.at] !== '?') return condition;
    this.at += 1;
    const yes = this.ternary();
    if (this.tokens[this.at++] !== ':') throw new Error('`?` without `:`');
    const no = this.ternary();
    return condition !== 0 ? yes : no;
  }

  private static level(op: string | undefined): number {
    switch (op) {
      case '||': return 1;
      case '&&': return 2;
      case '|': return 3;
      case '^': return 4;
      case '&': return 5;
      case '==': case '!=': return 6;
      case '<': case '>': case '<=': case '>=': return 7;
      case '<<': case '>>': return 8;
      case '+': case '-': return 9;
      case '*': case '/': case '%': return 10;
      default: return 0;
    }
  }

  private binary(min: number): number {
    let left = this.unary();
    for (;;) {
      const op = this.tokens[this.at];
      const level = Calculator.level(op);
      if (level === 0 || level < min) return left;
      this.at += 1;
      const right = this.binary(level + 1);
      switch (op) {
        case '||': left = left !== 0 || right !== 0 ? 1 : 0; break;
        case '&&': left = left !== 0 && right !== 0 ? 1 : 0; break;
        case '|': left |= right; break;
        case '^': left ^= right; break;
        case '&': left &= right; break;
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
        case '<': left = left < right ? 1 : 0; break;
        case '>': left = left > right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
        case '<<': left <<= right & 31; break;
        case '>>': left >>= right & 31; break;
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        default:
          if (right === 0) throw new Error('division by zero');
          left = op === '/' ? Math.trunc(left / right) : left % right;
      }
    }
  }

  private unary(): number {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Error('the expression ends early');
    if (token === '!') return this.unary() === 0 ? 1 : 0;
    if (token === '~') return ~this.unary();
    if (token === '-') return -this.unary();
    if (token === '+') return this.unary();
    if (token === '(') {
      const value = this.ternary();
      if (this.tokens[this.at++] !== ')') throw new Error('`(` without `)`');
      return value;
    }
    if (token === 'defined') {
      const open = this.tokens[this.at] === '(';
      if (open) this.at += 1;
      const name = this.tokens[this.at++];
      if (name === undefined || (open && this.tokens[this.at++] !== ')')) throw new Error('`defined` without a name');
      return this.macros.has(name) ? 1 : 0;
    }
    if (/^\d/.test(token)) {
      const digits = token.replace(/[uUlL]+$/, '');
      const n = Number(digits);
      if (!Number.isInteger(n)) throw new Error(`\`${token}\` is not an integer`);
      return n;
    }
    const macro = this.macros.get(token);
    if (macro === undefined) {
      if (this.strict) throw new Error(`\`${token}\` is not defined`);
      return 0;
    }
    if (macro.functionLike) throw new Error(`\`${token}\` is a macro with arguments`);
    return new Calculator(this.macros, macro.value, this.depth + 1, this.strict).run();
  }
}

/** `source` with its comments and directives blanked and the lines its conditionals leave out, and the macros it defines. */
export function preprocess(source: string): { code: string; length: (text: string) => number | null } {
  const macros = new Map<string, Macro>([['GL_ES', { functionLike: false, value: '1' }]]);
  const open: { active: boolean; taken: boolean }[] = [];
  const calc = (text: string, strict = false): number => new Calculator(macros, text, 0, strict).run();
  const live = () => open.length === 0 || open[open.length - 1]!.active;
  const out: string[] = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  for (const line of stripped.split('\n')) {
    const m = /^[ \t]*#[ \t]*(\w*)(.*)$/.exec(line);
    if (m === null) {
      out.push(live() ? line : '');
      continue;
    }
    out.push('');
    const keyword = m[1]!;
    const rest = m[2]!.trim();
    const parentLive = live();
    try {
      if (keyword === 'if' || keyword === 'ifdef' || keyword === 'ifndef') {
        const name = /^\w*/.exec(rest)![0];
        const on = parentLive && (keyword === 'if' ? calc(rest) !== 0 : keyword === 'ifdef' ? macros.has(name) : !macros.has(name));
        open.push({ active: on, taken: on });
      } else if ((keyword === 'elif' || keyword === 'else') && open.length > 0) {
        const top = open[open.length - 1]!;
        const outer = open.length < 2 || open[open.length - 2]!.active;
        const on = outer && !top.taken && (keyword === 'else' || calc(rest) !== 0);
        top.active = on;
        top.taken = top.taken || on || keyword === 'else';
      } else if (keyword === 'endif') {
        open.pop();
      } else if (keyword === 'define' && parentLive) {
        const name = /^\w+/.exec(rest)?.[0];
        if (name !== undefined) {
          const after = rest.slice(name.length);
          macros.set(name, { functionLike: after.startsWith('('), value: after.trim() });
        }
      } else if (keyword === 'undef' && parentLive) {
        macros.delete(/^\w*/.exec(rest)![0]);
      }
    } catch {
      // An expression this cannot read leaves the branch out; the renderer refuses a program it cannot read.
      if (keyword === 'if') open.push({ active: false, taken: false });
    }
  }
  const length = (text: string): number | null => {
    try {
      const n = calc(text, true);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  };
  return { code: out.join('\n'), length };
}
