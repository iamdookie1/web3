export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const expr = req.query.expr || (req.body && req.body.expr) || "";

  if (!expr || expr.trim() === "") {
    return res.status(400).json({ error: "No expression provided.", result: null });
  }

  try {
    const result = evaluate(expr.trim());
    return res.status(200).json({ result, expression: expr.trim() });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid expression.", result: null });
  }
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(expr) {
  // Normalize word operators (case-insensitive)
  let s = expr
    // constants
    .replace(/\bpi\b/gi, "3.141592653589793")
    .replace(/\be\b/gi, "2.718281828459045")
    .replace(/\binfinity\b|\binf\b/gi, "Infinity")
    // trig
    .replace(/\basin\b/gi, "asin")
    .replace(/\bacos\b/gi, "acos")
    .replace(/\batan2\b/gi, "atan2")
    .replace(/\batan\b/gi, "atan")
    .replace(/\bsinh\b/gi, "sinh")
    .replace(/\bcosh\b/gi, "cosh")
    .replace(/\btanh\b/gi, "tanh")
    .replace(/\bsin\b/gi, "sin")
    .replace(/\bcos\b/gi, "cos")
    .replace(/\btan\b/gi, "tan")
    // log/exp
    .replace(/\blog2\b/gi, "log2")
    .replace(/\blog10\b|\blog\b/gi, "log10")
    .replace(/\bln\b/gi, "ln")
    .replace(/\bexp\b/gi, "exp")
    // rounding
    .replace(/\bfloor\b/gi, "floor")
    .replace(/\bceil(ing)?\b/gi, "ceil")
    .replace(/\bround\b/gi, "round")
    .replace(/\babs(olute)?\b/gi, "abs")
    // root/power
    .replace(/\bsqrt\b|\bsquare\s+root\s+of\b/gi, "sqrt")
    .replace(/\bcbrt\b|\bcube\s+root\s+of\b/gi, "cbrt")
    // power operators (word forms) — replace before ** 
    .replace(/\bto\s+the\s+power\s+of\b|\bto\s+the\s+power\b|\bpow(er)?\b|\braise[d]?\s+to\b/gi, "**")
    .replace(/\bsquared\b/gi, "**2")
    .replace(/\bcubed\b/gi, "**3")
    // modulo
    .replace(/\bmod(ulo)?\b|\bremainder\b/gi, "%")
    // division
    .replace(/\bdivided\s+by\b|\bdiv\b/gi, "/")
    // multiplication
    .replace(/\btimes\b|\bmultiplied\s+by\b|\bx\b(?=\s*[\d(])/gi, "*")
    // addition
    .replace(/\bplus\b/gi, "+")
    // subtraction
    .replace(/\bminus\b/gi, "-")
    // factorial word
    .replace(/\bfactorial\s+of\b/gi, "factorial")
    // clean up extra spaces
    .replace(/\s+/g, " ")
    .trim();

  // Tokenize into numbers, operators, functions, parens
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    // skip whitespace
    if (s[i] === " ") { i++; continue; }

    // number (including decimals and Infinity)
    if (/[0-9.]/.test(s[i]) || (s[i] === "I" && s.slice(i, i + 8) === "Infinity")) {
      if (s.slice(i, i + 8) === "Infinity") {
        tokens.push({ type: "num", val: Infinity });
        i += 8;
      } else {
        let num = "";
        while (i < s.length && /[0-9._]/.test(s[i])) { num += s[i++]; }
        // scientific notation
        if (i < s.length && (s[i] === "e" || s[i] === "E")) {
          num += s[i++];
          if (s[i] === "+" || s[i] === "-") num += s[i++];
          while (i < s.length && /[0-9]/.test(s[i])) num += s[i++];
        }
        tokens.push({ type: "num", val: parseFloat(num.replace(/_/g, "")) });
      }
      continue;
    }

    // function names
    const funcs = ["asin","acos","atan2","atan","sinh","cosh","tanh","sin","cos","tan","log2","log10","ln","exp","floor","ceil","round","abs","sqrt","cbrt","factorial","nCr","nPr"];
    let matched = false;
    for (const fn of funcs) {
      if (s.slice(i, i + fn.length).toLowerCase() === fn.toLowerCase()) {
        tokens.push({ type: "func", val: fn.toLowerCase() });
        i += fn.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // two-char operators
    if (s.slice(i, i + 2) === "**") { tokens.push({ type: "op", val: "**" }); i += 2; continue; }

    // single char
    const ch = s[i];
    if ("+-*/%^()!,".includes(ch)) {
      if (ch === "^") { tokens.push({ type: "op", val: "**" }); }
      else if (ch === "!") { tokens.push({ type: "op", val: "!" }); }
      else if ("+-*/%".includes(ch)) { tokens.push({ type: "op", val: ch }); }
      else { tokens.push({ type: ch === "(" ? "lparen" : ch === ")" ? "rparen" : "comma", val: ch }); }
      i++;
      continue;
    }

    throw new Error(`Unknown character: '${ch}'`);
  }
  return tokens;
}

// ─── Parser (Pratt / recursive descent) ──────────────────────────────────────

function parse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }
  function expect(type, val) {
    const t = consume();
    if (t?.type !== type || (val !== undefined && t.val !== val))
      throw new Error(`Expected ${val || type}, got ${t?.val ?? "end of input"}`);
    return t;
  }

  function parseExpr(minPrec = 0) {
    let left = parseUnary();

    while (true) {
      const t = peek();
      if (!t || t.type === "rparen" || t.type === "comma") break;
      if (t.type !== "op") break;

      const { prec, right: rightAssoc } = infixPrec(t.val);
      if (prec < minPrec) break;
      consume();
      const right = parseExpr(rightAssoc ? prec : prec + 1);
      left = applyOp(t.val, left, right);
    }
    return left;
  }

  function infixPrec(op) {
    const table = { "+": { prec: 1, right: false }, "-": { prec: 1, right: false }, "*": { prec: 2, right: false }, "/": { prec: 2, right: false }, "%": { prec: 2, right: false }, "**": { prec: 4, right: true } };
    return table[op] || { prec: -1, right: false };
  }

  function parseUnary() {
    const t = peek();
    if (t?.type === "op" && t.val === "-") { consume(); return -parseUnary(); }
    if (t?.type === "op" && t.val === "+") { consume(); return parseUnary(); }
    return parsePostfix(parsePrimary());
  }

  function parsePostfix(val) {
    while (true) {
      const t = peek();
      if (t?.type === "op" && t.val === "!") { consume(); val = factorial(Math.round(val)); }
      else break;
    }
    return val;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression");

    // number
    if (t.type === "num") { consume(); return t.val; }

    // parenthesised group
    if (t.type === "lparen") {
      consume();
      const val = parseExpr(0);
      expect("rparen");
      return val;
    }

    // function call
    if (t.type === "func") {
      consume();
      expect("lparen");
      const args = [];
      if (peek()?.type !== "rparen") {
        args.push(parseExpr(0));
        while (peek()?.type === "comma") { consume(); args.push(parseExpr(0)); }
      }
      expect("rparen");
      return applyFunc(t.val, args);
    }

    throw new Error(`Unexpected token: '${t.val}'`);
  }

  const result = parseExpr(0);
  if (pos < tokens.length) throw new Error(`Unexpected token: '${tokens[pos].val}'`);
  return result;
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function factorial(n) {
  if (n < 0) throw new Error("Factorial of negative number");
  if (n > 170) return Infinity;
  if (n === 0 || n === 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function applyOp(op, a, b) {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
      if (b === 0) throw new Error("Division by zero");
      return a / b;
    case "%": return a % b;
    case "**": return Math.pow(a, b);
    default: throw new Error(`Unknown operator: ${op}`);
  }
}

function applyFunc(fn, args) {
  const a = args[0], b = args[1];
  switch (fn) {
    case "sin": return Math.sin(a);
    case "cos": return Math.cos(a);
    case "tan": return Math.tan(a);
    case "asin": return Math.asin(a);
    case "acos": return Math.acos(a);
    case "atan": return Math.atan(a);
    case "atan2": return Math.atan2(a, b);
    case "sinh": return Math.sinh(a);
    case "cosh": return Math.cosh(a);
    case "tanh": return Math.tanh(a);
    case "log10": return Math.log10(a);
    case "log2": return Math.log2(a);
    case "ln": return Math.log(a);
    case "exp": return Math.exp(a);
    case "sqrt": return Math.sqrt(a);
    case "cbrt": return Math.cbrt(a);
    case "abs": return Math.abs(a);
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
    case "round": return Math.round(a);
    case "factorial": return factorial(Math.round(a));
    case "ncr": { const n=Math.round(a),r=Math.round(b); return factorial(n)/(factorial(r)*factorial(n-r)); }
    case "npr": { const n=Math.round(a),r=Math.round(b); return factorial(n)/factorial(n-r); }
    default: throw new Error(`Unknown function: ${fn}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function evaluate(expr) {
  const tokens = tokenize(expr);
  const result = parse(tokens);
  if (typeof result !== "number") throw new Error("Expression did not produce a number");
  if (!isFinite(result) && !isNaN(result)) return result === Infinity ? "Infinity" : "-Infinity";
  if (isNaN(result)) throw new Error("Result is not a number (check your expression)");
  // Format: avoid floating point noise
  const fixed = parseFloat(result.toPrecision(15));
  return fixed;
}
