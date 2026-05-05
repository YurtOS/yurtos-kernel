//! Shell arithmetic evaluation for `$((...))` and `((...))` expressions.
//!
//! Two-layer design matching bash behaviour:
//!
//! **Layer 1** – [`safe_eval_arithmetic`]: a recursive-descent parser/evaluator
//! for pure numeric expressions with the full set of C-like operators that bash
//! supports.
//!
//! **Layer 2** – [`eval_arithmetic`]: handles shell-specific features (comma
//! expressions, increment/decrement, assignments, compound assignments, variable
//! expansion) and then delegates to Layer 1.

use crate::state::ShellState;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Evaluate a shell arithmetic expression, mutating `state.env` for any
/// assignments / increments that occur inside the expression.
///
/// Returns the integer result (i64). Division by zero yields 0.
pub fn eval_arithmetic(state: &mut ShellState, expr: &str) -> i64 {
    eval_arith_inner(state, expr)
}

// ---------------------------------------------------------------------------
// Layer 2 – shell-level features
// ---------------------------------------------------------------------------

fn eval_arith_inner(state: &mut ShellState, expr: &str) -> i64 {
    let expr = expr.trim();
    if expr.is_empty() {
        return 0;
    }

    // ---- Comma expressions: evaluate each part, return the last ----
    // We need to be careful not to split on commas inside parentheses.
    if let Some(parts) = split_comma_top_level(expr) {
        let mut result = 0i64;
        for part in &parts {
            result = eval_arith_inner(state, part.trim());
        }
        return result;
    }

    // ---- Post-increment: VAR++, VAR-- ----
    if let Some(caps) = match_post_inc_dec(expr) {
        let var = &caps.0;
        let op = &caps.1;
        let cur = parse_env_int(state, var);
        let new_val = if op == "++" { cur + 1 } else { cur - 1 };
        if !state.readonly_vars.contains(var) {
            state.env.insert(var.clone(), new_val.to_string());
        }
        return cur;
    }

    // ---- Pre-increment: ++VAR, --VAR ----
    if let Some(caps) = match_pre_inc_dec(expr) {
        let op = &caps.0;
        let var = &caps.1;
        let cur = parse_env_int(state, var);
        let new_val = if op == "++" { cur + 1 } else { cur - 1 };
        if !state.readonly_vars.contains(var) {
            state.env.insert(var.clone(), new_val.to_string());
        }
        return new_val;
    }

    // ---- Compound assignment: VAR op= expr ----
    if let Some(caps) = match_compound_assign(expr) {
        let var = caps.0;
        let op = caps.1;
        let rhs_expr = caps.2;
        let cur = parse_env_int(state, &var);
        let rhs = eval_arith_inner(state, &rhs_expr);
        let result = match op.as_str() {
            "+" => cur + rhs,
            "-" => cur - rhs,
            "*" => cur * rhs,
            "/" => {
                if rhs != 0 {
                    div_trunc(cur, rhs)
                } else {
                    0
                }
            }
            "%" => {
                if rhs != 0 {
                    cur % rhs
                } else {
                    0
                }
            }
            "<<" => cur << (rhs & 63),
            ">>" => cur >> (rhs & 63),
            "&" => cur & rhs,
            "|" => cur | rhs,
            "^" => cur ^ rhs,
            "**" => pow_i64(cur, rhs),
            _ => rhs,
        };
        if !state.readonly_vars.contains(&var) {
            state.env.insert(var, result.to_string());
        }
        return result;
    }

    // ---- Simple assignment: VAR = expr ----
    // Must NOT match `==`, `<=`, `>=`, `!=`
    if let Some(caps) = match_simple_assign(expr) {
        let var = caps.0;
        let rhs_expr = caps.1;
        let value = eval_arith_inner(state, &rhs_expr);
        if !state.readonly_vars.contains(&var) {
            state.env.insert(var, value.to_string());
        }
        return value;
    }

    // ---- Variable expansion ----
    // Replace $VAR with env lookup, then bare variable names with env lookup.
    let mut expanded = expand_dollar_vars(state, expr);
    expanded = expand_bare_vars(state, &expanded);

    safe_eval_arithmetic(&expanded)
}

/// Split on commas that are at the top level (not inside parentheses).
/// Returns None if there is only one part (no top-level comma).
fn split_comma_top_level(expr: &str) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    let bytes = expr.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(expr[start..i].to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return None;
    }
    parts.push(expr[start..].to_string());
    Some(parts)
}

/// Match `VAR++` or `VAR--` (post-increment/decrement).
fn match_post_inc_dec(expr: &str) -> Option<(String, String)> {
    let s = expr.trim();
    if s.len() < 3 {
        return None;
    }
    if !(s.ends_with("++") || s.ends_with("--")) {
        return None;
    }
    let op = &s[s.len() - 2..];
    let var_part = s[..s.len() - 2].trim();
    if is_identifier(var_part) {
        Some((var_part.to_string(), op.to_string()))
    } else {
        None
    }
}

/// Match `++VAR` or `--VAR` (pre-increment/decrement).
fn match_pre_inc_dec(expr: &str) -> Option<(String, String)> {
    let s = expr.trim();
    if s.len() < 3 {
        return None;
    }
    if !(s.starts_with("++") || s.starts_with("--")) {
        return None;
    }
    let op = &s[..2];
    let var_part = s[2..].trim();
    if is_identifier(var_part) {
        Some((op.to_string(), var_part.to_string()))
    } else {
        None
    }
}

/// Match `VAR op= expr` for compound assignment.
/// Operators: `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `|=`, `^=`, `**=`
fn match_compound_assign(expr: &str) -> Option<(String, String, String)> {
    let s = expr.trim();

    // Find the first `=` that is part of a compound operator.
    // We scan for patterns like `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`,
    // `&=`, `|=`, `^=`, `**=`.
    // The identifier must come first.
    let bytes = s.as_bytes();
    // Find end of identifier
    let mut id_end = 0;
    while id_end < bytes.len() && is_ident_char(bytes[id_end], id_end == 0) {
        id_end += 1;
    }
    if id_end == 0 {
        return None;
    }
    let var = &s[..id_end];
    if !is_identifier(var) {
        return None;
    }

    // Skip whitespace after identifier
    let mut i = id_end;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }

    if i >= bytes.len() {
        return None;
    }

    // Try to match compound operator followed by `=`
    // Three-char operators: `<<=`, `>>=`, `**=`
    if i + 2 < bytes.len() && bytes[i + 2] == b'=' {
        let op2 = &s[i..i + 2];
        if op2 == "<<" || op2 == ">>" || op2 == "**" {
            let rhs = s[i + 3..].to_string();
            return Some((var.to_string(), op2.to_string(), rhs));
        }
    }

    // Two-char operators: `+=`, `-=`, `*=`, `/=`, `%=`, `&=`, `|=`, `^=`
    if i + 1 < bytes.len() && bytes[i + 1] == b'=' {
        let op_ch = bytes[i];
        if matches!(op_ch, b'+' | b'-' | b'*' | b'/' | b'%' | b'&' | b'|' | b'^') {
            // Make sure this isn't `==` part of something else
            // (but we already know `op_ch` is one of the compound chars, not `=`)
            let rhs = s[i + 2..].to_string();
            return Some((var.to_string(), (op_ch as char).to_string(), rhs));
        }
    }

    None
}

/// Match `VAR = expr` for simple assignment.
/// Must NOT match `==`, `!=`, `<=`, `>=`.
fn match_simple_assign(expr: &str) -> Option<(String, String)> {
    let s = expr.trim();
    let bytes = s.as_bytes();

    // Find end of identifier
    let mut id_end = 0;
    while id_end < bytes.len() && is_ident_char(bytes[id_end], id_end == 0) {
        id_end += 1;
    }
    if id_end == 0 {
        return None;
    }
    let var = &s[..id_end];
    if !is_identifier(var) {
        return None;
    }

    // Skip whitespace
    let mut i = id_end;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }

    if i >= bytes.len() || bytes[i] != b'=' {
        return None;
    }

    // Make sure it's not `==`
    if i + 1 < bytes.len() && bytes[i + 1] == b'=' {
        return None;
    }

    // Also check the character before `=` isn't a compound op char
    // (those are already handled by compound_assign above)
    // Since we've already stripped var and whitespace, if we're here it's just `=`.
    // But let's double-check: the char right before `=` should be whitespace or end-of-var.
    // We need to also check the char before isn't part of `+=`, `-=` etc.
    // Actually, compound_assign runs first and takes priority, so if we reach here,
    // it wasn't a compound assign.

    let rhs = s[i + 1..].to_string();
    Some((var.to_string(), rhs))
}

fn is_identifier(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    if !(bytes[0] == b'_' || bytes[0].is_ascii_alphabetic()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b == b'_' || b.is_ascii_alphanumeric())
}

fn is_ident_char(b: u8, first: bool) -> bool {
    if first {
        b == b'_' || b.is_ascii_alphabetic()
    } else {
        b == b'_' || b.is_ascii_alphanumeric()
    }
}

fn parse_env_int(state: &ShellState, var: &str) -> i64 {
    state
        .env
        .get(var)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

/// Resolve a variable name, checking positional parameters and special
/// variables in addition to the environment.
fn resolve_var(state: &ShellState, name: &str) -> String {
    // Special variables
    match name {
        "?" => return state.last_exit_code.to_string(),
        "#" => return state.positional_args.len().to_string(),
        "@" | "*" => return state.positional_args.join(" "),
        _ => {}
    }
    // Positional parameters ($1, $2, ...)
    if let Ok(idx) = name.parse::<usize>() {
        if idx == 0 {
            return "0".to_string();
        }
        return state
            .positional_args
            .get(idx - 1)
            .cloned()
            .unwrap_or_else(|| "0".to_string());
    }
    // Environment variable
    state
        .env
        .get(name)
        .cloned()
        .unwrap_or_else(|| "0".to_string())
}

/// Replace `$VAR` and `${VAR}` with their values from env.
fn expand_dollar_vars(state: &ShellState, expr: &str) -> String {
    let mut result = String::with_capacity(expr.len());
    let bytes = expr.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            i += 1;
            if i < bytes.len() && bytes[i] == b'{' {
                // ${VAR}
                i += 1;
                let start = i;
                while i < bytes.len() && bytes[i] != b'}' {
                    i += 1;
                }
                let name = &expr[start..i];
                if i < bytes.len() {
                    i += 1; // skip '}'
                }
                result.push_str(&resolve_var(state, name));
            } else {
                // $VAR
                let start = i;
                while i < bytes.len() && (bytes[i] == b'_' || bytes[i].is_ascii_alphanumeric()) {
                    i += 1;
                }
                if i > start {
                    let name = &expr[start..i];
                    result.push_str(&resolve_var(state, name));
                } else {
                    result.push('$');
                }
            }
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }
    result
}

/// Replace bare variable names with their values from env.
/// Must not replace things that are already numbers or operators.
/// Skips identifiers that immediately follow a digit (e.g. the `xFF` in `0xFF`).
fn expand_bare_vars(state: &ShellState, expr: &str) -> String {
    let mut result = String::with_capacity(expr.len());
    let bytes = expr.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'_' || bytes[i].is_ascii_alphabetic() {
            // Check if this identifier is part of a numeric literal.
            // Covers: digit immediately before (e.g. `0x` in hex) or
            // hex prefix `0x`/`0X` before (e.g. `FF` in `0xFF`).
            let rb = result.as_bytes();
            let preceded_by_digit = !rb.is_empty() && rb[rb.len() - 1].is_ascii_digit();
            let preceded_by_hex_prefix = rb.len() >= 2
                && (rb[rb.len() - 1] == b'x' || rb[rb.len() - 1] == b'X')
                && rb[rb.len() - 2] == b'0';
            let in_numeric_literal = preceded_by_digit || preceded_by_hex_prefix;
            let start = i;
            while i < bytes.len() && (bytes[i] == b'_' || bytes[i].is_ascii_alphanumeric()) {
                i += 1;
            }
            if in_numeric_literal {
                // Part of a numeric literal — pass through unchanged
                result.push_str(&expr[start..i]);
            } else {
                let name = &expr[start..i];
                let val = state.env.get(name).map(|s| s.as_str()).unwrap_or("0");
                result.push_str(val);
            }
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }
    result
}

/// Truncating integer division (like C / bash).
fn div_trunc(a: i64, b: i64) -> i64 {
    if b == 0 {
        return 0;
    }
    // Rust's `/` for i64 already truncates toward zero.
    a / b
}

/// Integer exponentiation. Negative exponent yields 0 (matches bash).
fn pow_i64(base: i64, exp: i64) -> i64 {
    if exp < 0 {
        return 0;
    }
    let mut result: i64 = 1;
    let mut b = base;
    let mut e = exp as u64;
    while e > 0 {
        if e & 1 == 1 {
            result = result.wrapping_mul(b);
        }
        b = b.wrapping_mul(b);
        e >>= 1;
    }
    result
}

// ---------------------------------------------------------------------------
// Layer 1 – pure numeric expression evaluator (recursive descent)
// ---------------------------------------------------------------------------

/// Evaluate a pure numeric expression string (no variable names, no
/// assignments). All operands must be integer literals.
fn safe_eval_arithmetic(expr: &str) -> i64 {
    let tokens = tokenize(expr);
    let mut parser = Parser::new(tokens);
    parser.parse_expr()
}

// ---- Tokenizer ----

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(i64),
    Op(String),
}

fn tokenize(expr: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let bytes = expr.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        // Skip whitespace
        if ch == b' ' || ch == b'\t' || ch == b'\n' || ch == b'\r' {
            i += 1;
            continue;
        }
        // Numbers (including hex 0x... and octal 0...)
        if ch.is_ascii_digit() {
            let start = i;
            if ch == b'0' && i + 1 < bytes.len() && (bytes[i + 1] == b'x' || bytes[i + 1] == b'X') {
                // Hex
                i += 2;
                while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                    i += 1;
                }
                let hex_str = &expr[start + 2..i];
                let val = i64::from_str_radix(hex_str, 16).unwrap_or(0);
                tokens.push(Token::Num(val));
            } else if ch == b'0'
                && i + 1 < bytes.len()
                && bytes[i + 1] >= b'0'
                && bytes[i + 1] <= b'7'
            {
                // Octal — only consume valid octal digits (0-7)
                i += 1;
                while i < bytes.len() && bytes[i] >= b'0' && bytes[i] <= b'7' {
                    i += 1;
                }
                let oct_str = &expr[start + 1..i];
                let val = i64::from_str_radix(oct_str, 8).unwrap_or(0);
                tokens.push(Token::Num(val));
            } else {
                // Decimal
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                let num_str = &expr[start..i];
                let val = num_str.parse::<i64>().unwrap_or(0);
                tokens.push(Token::Num(val));
            }
            continue;
        }
        // Two-character operators
        if i + 1 < bytes.len() {
            let two = &expr[i..i + 2];
            match two {
                "**" | "==" | "!=" | "<=" | ">=" | "<<" | ">>" | "&&" | "||" => {
                    tokens.push(Token::Op(two.to_string()));
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        // Single-character operators
        if matches!(
            ch,
            b'+' | b'-'
                | b'*'
                | b'/'
                | b'%'
                | b'('
                | b')'
                | b'<'
                | b'>'
                | b'!'
                | b'~'
                | b'&'
                | b'|'
                | b'^'
                | b'?'
                | b':'
                | b'='
        ) {
            tokens.push(Token::Op((ch as char).to_string()));
            i += 1;
            continue;
        }
        // Skip unknown characters
        i += 1;
    }
    tokens
}

// ---- Parser ----

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn peek_op(&self) -> Option<&str> {
        match self.peek() {
            Some(Token::Op(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    fn next_token(&mut self) -> Option<Token> {
        if self.pos < self.tokens.len() {
            let tok = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(tok)
        } else {
            None
        }
    }

    fn eat_op(&mut self, op: &str) -> bool {
        if self.peek_op() == Some(op) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    // Precedence levels (lowest to highest):
    //  1. Ternary  ? :
    //  2. Logical OR  ||
    //  3. Logical AND  &&
    //  4. Bitwise OR  |
    //  5. Bitwise XOR  ^
    //  6. Bitwise AND  &
    //  7. Equality  == !=
    //  8. Comparison  < > <= >=
    //  9. Shift  << >>
    // 10. Add/Sub  + -
    // 11. Mul/Div/Mod  * / %
    // 12. Exponentiation  **
    // 13. Unary  + - ! ~
    // 14. Primary  (numbers, parens)

    fn parse_expr(&mut self) -> i64 {
        self.parse_ternary()
    }

    // Level 1: ternary ? :
    fn parse_ternary(&mut self) -> i64 {
        let cond = self.parse_logical_or();
        if self.eat_op("?") {
            let then_val = self.parse_ternary();
            self.eat_op(":"); // consume ':'
            let else_val = self.parse_ternary();
            if cond != 0 {
                then_val
            } else {
                else_val
            }
        } else {
            cond
        }
    }

    // Level 2: logical OR ||
    fn parse_logical_or(&mut self) -> i64 {
        let mut left = self.parse_logical_and();
        while self.peek_op() == Some("||") {
            self.next_token();
            let right = self.parse_logical_and();
            left = if left != 0 || right != 0 { 1 } else { 0 };
        }
        left
    }

    // Level 3: logical AND &&
    fn parse_logical_and(&mut self) -> i64 {
        let mut left = self.parse_bitwise_or();
        while self.peek_op() == Some("&&") {
            self.next_token();
            let right = self.parse_bitwise_or();
            left = if left != 0 && right != 0 { 1 } else { 0 };
        }
        left
    }

    // Level 4: bitwise OR |
    fn parse_bitwise_or(&mut self) -> i64 {
        let mut left = self.parse_bitwise_xor();
        // Must match single `|` but not `||`
        while self.peek_op() == Some("|") {
            self.next_token();
            let right = self.parse_bitwise_xor();
            left |= right;
        }
        left
    }

    // Level 5: bitwise XOR ^
    fn parse_bitwise_xor(&mut self) -> i64 {
        let mut left = self.parse_bitwise_and();
        while self.peek_op() == Some("^") {
            self.next_token();
            let right = self.parse_bitwise_and();
            left ^= right;
        }
        left
    }

    // Level 6: bitwise AND &
    fn parse_bitwise_and(&mut self) -> i64 {
        let mut left = self.parse_equality();
        // Must match single `&` but not `&&`
        while self.peek_op() == Some("&") {
            self.next_token();
            let right = self.parse_equality();
            left &= right;
        }
        left
    }

    // Level 7: equality == !=
    fn parse_equality(&mut self) -> i64 {
        let mut left = self.parse_comparison();
        loop {
            match self.peek_op() {
                Some("==") => {
                    self.next_token();
                    let right = self.parse_comparison();
                    left = if left == right { 1 } else { 0 };
                }
                Some("!=") => {
                    self.next_token();
                    let right = self.parse_comparison();
                    left = if left != right { 1 } else { 0 };
                }
                _ => break,
            }
        }
        left
    }

    // Level 8: comparison < > <= >=
    fn parse_comparison(&mut self) -> i64 {
        let mut left = self.parse_shift();
        loop {
            match self.peek_op() {
                Some("<") => {
                    self.next_token();
                    let right = self.parse_shift();
                    left = if left < right { 1 } else { 0 };
                }
                Some(">") => {
                    self.next_token();
                    let right = self.parse_shift();
                    left = if left > right { 1 } else { 0 };
                }
                Some("<=") => {
                    self.next_token();
                    let right = self.parse_shift();
                    left = if left <= right { 1 } else { 0 };
                }
                Some(">=") => {
                    self.next_token();
                    let right = self.parse_shift();
                    left = if left >= right { 1 } else { 0 };
                }
                _ => break,
            }
        }
        left
    }

    // Level 9: bitwise shift << >>
    fn parse_shift(&mut self) -> i64 {
        let mut left = self.parse_add_sub();
        loop {
            match self.peek_op() {
                Some("<<") => {
                    self.next_token();
                    let right = self.parse_add_sub();
                    left <<= right & 63;
                }
                Some(">>") => {
                    self.next_token();
                    let right = self.parse_add_sub();
                    left >>= right & 63;
                }
                _ => break,
            }
        }
        left
    }

    // Level 10: addition and subtraction
    fn parse_add_sub(&mut self) -> i64 {
        let mut left = self.parse_mul_div();
        loop {
            match self.peek_op() {
                Some("+") => {
                    self.next_token();
                    let right = self.parse_mul_div();
                    left = left.wrapping_add(right);
                }
                Some("-") => {
                    self.next_token();
                    let right = self.parse_mul_div();
                    left = left.wrapping_sub(right);
                }
                _ => break,
            }
        }
        left
    }

    // Level 11: multiplication, division, modulo
    fn parse_mul_div(&mut self) -> i64 {
        let mut left = self.parse_exponent();
        loop {
            match self.peek_op() {
                Some("*") => {
                    // Tokenizer already handles `**` as one token, so `*` here is multiplication.
                    self.next_token();
                    let right = self.parse_exponent();
                    left = left.wrapping_mul(right);
                }
                Some("/") => {
                    self.next_token();
                    let right = self.parse_exponent();
                    left = if right != 0 {
                        div_trunc(left, right)
                    } else {
                        0
                    };
                }
                Some("%") => {
                    self.next_token();
                    let right = self.parse_exponent();
                    left = if right != 0 { left % right } else { 0 };
                }
                _ => break,
            }
        }
        left
    }

    // Level 12: exponentiation ** (right-associative)
    fn parse_exponent(&mut self) -> i64 {
        let base = self.parse_unary();
        if self.peek_op() == Some("**") {
            self.next_token();
            let exp = self.parse_exponent(); // right-associative
            pow_i64(base, exp)
        } else {
            base
        }
    }

    // Level 13: unary + - ! ~
    fn parse_unary(&mut self) -> i64 {
        match self.peek_op() {
            Some("-") => {
                self.next_token();
                let val = self.parse_unary();
                val.wrapping_neg()
            }
            Some("+") => {
                self.next_token();
                self.parse_unary()
            }
            Some("!") => {
                self.next_token();
                let val = self.parse_unary();
                if val == 0 {
                    1
                } else {
                    0
                }
            }
            Some("~") => {
                self.next_token();
                let val = self.parse_unary();
                !val
            }
            _ => self.parse_primary(),
        }
    }

    // Level 14: primary (numbers, parenthesized expressions)
    fn parse_primary(&mut self) -> i64 {
        if self.eat_op("(") {
            let val = self.parse_expr();
            self.eat_op(")");
            return val;
        }
        match self.next_token() {
            Some(Token::Num(n)) => n,
            _ => 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ShellState;

    fn state() -> ShellState {
        ShellState::new_default()
    }

    // ---- Basic arithmetic ----

    #[test]
    fn basic_addition() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "1+2"), 3);
    }

    #[test]
    fn basic_subtraction() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "10-3"), 7);
    }

    #[test]
    fn basic_multiplication() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "4*5"), 20);
    }

    #[test]
    fn basic_division() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "20/3"), 6);
    }

    #[test]
    fn basic_modulo() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "10%3"), 1);
    }

    // ---- Exponentiation ----

    #[test]
    fn exponentiation() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "2**10"), 1024);
    }

    #[test]
    fn exponentiation_zero() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5**0"), 1);
    }

    #[test]
    fn exponentiation_right_assoc() {
        let mut s = state();
        // 2**(3**2) = 2**9 = 512, not (2**3)**2 = 64
        assert_eq!(eval_arithmetic(&mut s, "2**3**2"), 512);
    }

    // ---- Comparisons ----

    #[test]
    fn comparison_eq() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5==5"), 1);
        assert_eq!(eval_arithmetic(&mut s, "5==6"), 0);
    }

    #[test]
    fn comparison_ne() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "3!=4"), 1);
        assert_eq!(eval_arithmetic(&mut s, "3!=3"), 0);
    }

    #[test]
    fn comparison_lt() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "1<2"), 1);
        assert_eq!(eval_arithmetic(&mut s, "2<1"), 0);
    }

    #[test]
    fn comparison_gt() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "3>2"), 1);
        assert_eq!(eval_arithmetic(&mut s, "2>3"), 0);
    }

    #[test]
    fn comparison_le() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "1<=2"), 1);
        assert_eq!(eval_arithmetic(&mut s, "2<=2"), 1);
        assert_eq!(eval_arithmetic(&mut s, "3<=2"), 0);
    }

    #[test]
    fn comparison_ge() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "3>=2"), 1);
        assert_eq!(eval_arithmetic(&mut s, "2>=2"), 1);
        assert_eq!(eval_arithmetic(&mut s, "1>=2"), 0);
    }

    // ---- Logical ----

    #[test]
    fn logical_and() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "1&&1"), 1);
        assert_eq!(eval_arithmetic(&mut s, "1&&0"), 0);
        assert_eq!(eval_arithmetic(&mut s, "0&&1"), 0);
        assert_eq!(eval_arithmetic(&mut s, "0&&0"), 0);
    }

    #[test]
    fn logical_or() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "0||1"), 1);
        assert_eq!(eval_arithmetic(&mut s, "1||0"), 1);
        assert_eq!(eval_arithmetic(&mut s, "0||0"), 0);
        assert_eq!(eval_arithmetic(&mut s, "1||1"), 1);
    }

    #[test]
    fn logical_not() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "!0"), 1);
        assert_eq!(eval_arithmetic(&mut s, "!1"), 0);
        assert_eq!(eval_arithmetic(&mut s, "!42"), 0);
    }

    // ---- Bitwise ----

    #[test]
    fn bitwise_and() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5&3"), 1);
    }

    #[test]
    fn bitwise_or() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5|3"), 7);
    }

    #[test]
    fn bitwise_xor() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5^3"), 6);
    }

    #[test]
    fn bitwise_not() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "~0"), -1);
        assert_eq!(eval_arithmetic(&mut s, "~1"), -2);
    }

    #[test]
    fn bitwise_shift_left() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "4<<2"), 16);
    }

    #[test]
    fn bitwise_shift_right() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "16>>2"), 4);
    }

    // ---- Ternary ----

    #[test]
    fn ternary_true() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "1?10:20"), 10);
    }

    #[test]
    fn ternary_false() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "0?10:20"), 20);
    }

    #[test]
    fn ternary_nested() {
        let mut s = state();
        // 1 ? (0 ? 5 : 10) : 20 = 10
        assert_eq!(eval_arithmetic(&mut s, "1 ? 0 ? 5 : 10 : 20"), 10);
    }

    // ---- Parentheses ----

    #[test]
    fn parentheses() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "(2+3)*4"), 20);
    }

    #[test]
    fn nested_parentheses() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "((2+3)*(4+1))"), 25);
    }

    // ---- Unary minus ----

    #[test]
    fn unary_minus() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "-5"), -5);
    }

    #[test]
    fn unary_minus_parens() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "-(2+3)"), -5);
    }

    #[test]
    fn unary_plus() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "+5"), 5);
    }

    // ---- Variable references ----

    #[test]
    fn variable_reference_bare() {
        let mut s = state();
        s.env.insert("x".into(), "42".into());
        assert_eq!(eval_arithmetic(&mut s, "x + 1"), 43);
    }

    #[test]
    fn variable_reference_dollar() {
        let mut s = state();
        s.env.insert("x".into(), "42".into());
        assert_eq!(eval_arithmetic(&mut s, "$x + 1"), 43);
    }

    #[test]
    fn variable_undefined_defaults_to_zero() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "undefined_var"), 0);
    }

    #[test]
    fn variable_in_expression() {
        let mut s = state();
        s.env.insert("a".into(), "10".into());
        s.env.insert("b".into(), "20".into());
        assert_eq!(eval_arithmetic(&mut s, "a + b"), 30);
    }

    // ---- Assignment ----

    #[test]
    fn simple_assignment() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "x=5"), 5);
        assert_eq!(s.env.get("x"), Some(&"5".to_string()));
    }

    #[test]
    fn assignment_with_expression() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "x=2+3"), 5);
        assert_eq!(s.env.get("x"), Some(&"5".to_string()));
    }

    // ---- Compound assignment ----

    #[test]
    fn compound_add_assign() {
        let mut s = state();
        s.env.insert("x".into(), "10".into());
        assert_eq!(eval_arithmetic(&mut s, "x+=3"), 13);
        assert_eq!(s.env.get("x"), Some(&"13".to_string()));
    }

    #[test]
    fn compound_sub_assign() {
        let mut s = state();
        s.env.insert("x".into(), "10".into());
        assert_eq!(eval_arithmetic(&mut s, "x-=3"), 7);
        assert_eq!(s.env.get("x"), Some(&"7".to_string()));
    }

    #[test]
    fn compound_mul_assign() {
        let mut s = state();
        s.env.insert("x".into(), "10".into());
        assert_eq!(eval_arithmetic(&mut s, "x*=3"), 30);
        assert_eq!(s.env.get("x"), Some(&"30".to_string()));
    }

    #[test]
    fn compound_div_assign() {
        let mut s = state();
        s.env.insert("x".into(), "10".into());
        assert_eq!(eval_arithmetic(&mut s, "x/=3"), 3);
        assert_eq!(s.env.get("x"), Some(&"3".to_string()));
    }

    #[test]
    fn compound_mod_assign() {
        let mut s = state();
        s.env.insert("x".into(), "10".into());
        assert_eq!(eval_arithmetic(&mut s, "x%=3"), 1);
        assert_eq!(s.env.get("x"), Some(&"1".to_string()));
    }

    // ---- Pre/post increment/decrement ----

    #[test]
    fn post_increment() {
        let mut s = state();
        s.env.insert("x".into(), "5".into());
        assert_eq!(eval_arithmetic(&mut s, "x++"), 5); // returns old value
        assert_eq!(s.env.get("x"), Some(&"6".to_string()));
    }

    #[test]
    fn post_decrement() {
        let mut s = state();
        s.env.insert("x".into(), "5".into());
        assert_eq!(eval_arithmetic(&mut s, "x--"), 5); // returns old value
        assert_eq!(s.env.get("x"), Some(&"4".to_string()));
    }

    #[test]
    fn pre_increment() {
        let mut s = state();
        s.env.insert("x".into(), "5".into());
        assert_eq!(eval_arithmetic(&mut s, "++x"), 6); // returns new value
        assert_eq!(s.env.get("x"), Some(&"6".to_string()));
    }

    #[test]
    fn pre_decrement() {
        let mut s = state();
        s.env.insert("x".into(), "5".into());
        assert_eq!(eval_arithmetic(&mut s, "--x"), 4); // returns new value
        assert_eq!(s.env.get("x"), Some(&"4".to_string()));
    }

    // ---- Comma expression ----

    #[test]
    fn comma_expression() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "1+2, 3+4"), 7);
    }

    #[test]
    fn comma_expression_with_assignment() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "x=5, x+1"), 6);
        assert_eq!(s.env.get("x"), Some(&"5".to_string()));
    }

    // ---- Division by zero ----

    #[test]
    fn division_by_zero() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5/0"), 0);
    }

    #[test]
    fn modulo_by_zero() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "5%0"), 0);
    }

    // ---- Nested / complex expressions ----

    #[test]
    fn nested_expression() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "2 + 3 * 4"), 14);
    }

    #[test]
    fn complex_expression() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "(1 + 2) * (3 + 4)"), 21);
    }

    #[test]
    fn precedence_mul_over_add() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "2+3*4"), 14);
    }

    #[test]
    fn precedence_exp_over_mul() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "2*3**2"), 18); // 2 * 9
    }

    #[test]
    fn empty_expression() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, ""), 0);
    }

    #[test]
    fn whitespace_only() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "   "), 0);
    }

    #[test]
    fn spaces_in_expression() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "  1 + 2  "), 3);
    }

    // ---- Hex and octal ----

    #[test]
    fn hex_literal() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "0xFF"), 255);
    }

    #[test]
    fn octal_literal() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "010"), 8);
    }

    // ---- Negative exponent ----

    #[test]
    fn negative_exponent() {
        let mut s = state();
        // bash: 2**(-1) is some large number or error, we return 0
        assert_eq!(eval_arithmetic(&mut s, "2**(-1)"), 0);
    }

    // ---- Compound shift/bitwise assigns ----

    #[test]
    fn compound_shift_left_assign() {
        let mut s = state();
        s.env.insert("x".into(), "1".into());
        assert_eq!(eval_arithmetic(&mut s, "x<<=3"), 8);
        assert_eq!(s.env.get("x"), Some(&"8".to_string()));
    }

    #[test]
    fn compound_shift_right_assign() {
        let mut s = state();
        s.env.insert("x".into(), "16".into());
        assert_eq!(eval_arithmetic(&mut s, "x>>=2"), 4);
        assert_eq!(s.env.get("x"), Some(&"4".to_string()));
    }

    #[test]
    fn compound_bitwise_and_assign() {
        let mut s = state();
        s.env.insert("x".into(), "7".into());
        assert_eq!(eval_arithmetic(&mut s, "x&=3"), 3);
        assert_eq!(s.env.get("x"), Some(&"3".to_string()));
    }

    #[test]
    fn compound_bitwise_or_assign() {
        let mut s = state();
        s.env.insert("x".into(), "5".into());
        assert_eq!(eval_arithmetic(&mut s, "x|=3"), 7);
        assert_eq!(s.env.get("x"), Some(&"7".to_string()));
    }

    #[test]
    fn compound_bitwise_xor_assign() {
        let mut s = state();
        s.env.insert("x".into(), "5".into());
        assert_eq!(eval_arithmetic(&mut s, "x^=3"), 6);
        assert_eq!(s.env.get("x"), Some(&"6".to_string()));
    }

    #[test]
    fn compound_exp_assign() {
        let mut s = state();
        s.env.insert("x".into(), "2".into());
        assert_eq!(eval_arithmetic(&mut s, "x**=10"), 1024);
        assert_eq!(s.env.get("x"), Some(&"1024".to_string()));
    }

    // ---- Multiple operations with variables ----

    #[test]
    fn increment_then_use() {
        let mut s = state();
        s.env.insert("i".into(), "0".into());
        // Comma expression: increment i, then return i+10
        assert_eq!(eval_arithmetic(&mut s, "i=i+1, i+10"), 11);
    }

    // ---- Ternary with expressions ----

    #[test]
    fn ternary_with_comparison() {
        let mut s = state();
        assert_eq!(eval_arithmetic(&mut s, "3>2 ? 100 : 200"), 100);
        assert_eq!(eval_arithmetic(&mut s, "3<2 ? 100 : 200"), 200);
    }

    // ---- Mixed operators precedence ----

    #[test]
    fn mixed_logical_and_comparison() {
        let mut s = state();
        // (1<2) && (3>2) = 1 && 1 = 1
        assert_eq!(eval_arithmetic(&mut s, "1<2 && 3>2"), 1);
    }

    #[test]
    fn mixed_bitwise_and_arithmetic() {
        let mut s = state();
        // 3 + 5 & 6 = 8 & 6 = 0 ... wait, precedence:
        // & is lower than +, so: (3+5) & 6 = 8 & 6 = 0
        assert_eq!(eval_arithmetic(&mut s, "3+5 & 6"), 0);
    }
}
