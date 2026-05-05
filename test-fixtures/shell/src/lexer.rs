use crate::ast::WordPart;
use crate::token::{RedirectType, Token};

/// Tokenize a shell command string into a vector of tokens.
pub fn lex(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut pos = 0;

    while pos < len {
        // Skip whitespace (but not newlines)
        if chars[pos] == ' ' || chars[pos] == '\t' {
            pos += 1;
            continue;
        }

        // Newline
        if chars[pos] == '\n' {
            tokens.push(Token::Newline);
            pos += 1;
            continue;
        }

        // Comments — skip from # to end of line
        if chars[pos] == '#' {
            while pos < len && chars[pos] != '\n' {
                pos += 1;
            }
            continue; // don't consume newline, let normal processing handle it
        }

        // Semicolon or ;;
        if chars[pos] == ';' {
            if pos + 1 < len && chars[pos + 1] == ';' {
                tokens.push(Token::DoubleSemi);
                pos += 2;
                continue;
            }
            tokens.push(Token::Semi);
            pos += 1;
            continue;
        }

        // Parentheses
        if chars[pos] == '(' {
            // (( ... )) — arithmetic / C-style for expression
            if pos + 1 < len && chars[pos + 1] == '(' {
                pos += 2; // skip "(("
                let mut depth = 1;
                let mut content = String::new();
                while pos < len && depth > 0 {
                    if pos + 1 < len && chars[pos] == ')' && chars[pos + 1] == ')' {
                        depth -= 1;
                        if depth == 0 {
                            pos += 2; // skip "))"
                            break;
                        }
                    }
                    if pos + 1 < len && chars[pos] == '(' && chars[pos + 1] == '(' {
                        depth += 1;
                        content.push('(');
                        content.push('(');
                        pos += 2;
                        continue;
                    }
                    content.push(chars[pos]);
                    pos += 1;
                }
                tokens.push(Token::DoubleParen(content.trim().to_string()));
                continue;
            }
            tokens.push(Token::LParen);
            pos += 1;
            continue;
        }
        if chars[pos] == ')' {
            tokens.push(Token::RParen);
            pos += 1;
            continue;
        }

        // Braces — only special at command-start position (reserved words).
        // In other positions, { and } are literal word characters so that
        // brace expansion patterns like {a,b,c} pass through to the runtime.
        if chars[pos] == '{' || chars[pos] == '}' {
            let is_command_start = tokens.is_empty()
                || matches!(
                    tokens.last(),
                    Some(Token::Pipe)
                        | Some(Token::And)
                        | Some(Token::Or)
                        | Some(Token::Semi)
                        | Some(Token::Newline)
                        | Some(Token::LParen)
                        | Some(Token::RParen)
                        | Some(Token::Do)
                        | Some(Token::Then)
                        | Some(Token::Else)
                        | Some(Token::LBrace)
                        | Some(Token::DoubleSemi)
                );
            if is_command_start {
                if chars[pos] == '{' {
                    tokens.push(Token::LBrace);
                } else {
                    tokens.push(Token::RBrace);
                }
                pos += 1;
                continue;
            }
            // Otherwise fall through to read_word — { and } become literal
            // characters in the word (enabling brace expansion patterns).
        }

        // [[ ... ]] — conditional expression (capture raw content)
        if pos + 1 < len && chars[pos] == '[' && chars[pos + 1] == '[' {
            // Check next non-space is not just a word starting with [[
            let after = if pos + 2 < len { chars[pos + 2] } else { ' ' };
            if after == ' ' || after == '\t' || after == '\n' {
                pos += 2; // skip "[["
                let mut content = String::new();
                while pos < len {
                    if pos + 1 < len && chars[pos] == ']' && chars[pos + 1] == ']' {
                        pos += 2; // skip "]]"
                        break;
                    }
                    content.push(chars[pos]);
                    pos += 1;
                }
                tokens.push(Token::DoubleBracket(content.trim().to_string()));
                continue;
            }
        }

        // Bang (pipeline negation) — standalone ! at command start position
        // Only emit Bang if it's the first token or follows a pipe/semi/newline/&&/||/(
        if chars[pos] == '!' && (pos + 1 >= len || chars[pos + 1] == ' ' || chars[pos + 1] == '\t')
        {
            let mut is_command_start = tokens.is_empty();
            if !is_command_start {
                if let Some(last) = tokens.last() {
                    is_command_start = matches!(
                        last,
                        Token::Pipe
                            | Token::And
                            | Token::Or
                            | Token::Semi
                            | Token::Newline
                            | Token::LParen
                            | Token::Do
                            | Token::Then
                            | Token::Else
                            | Token::LBrace
                            | Token::DoubleSemi
                    );
                }
            }
            if is_command_start {
                tokens.push(Token::Bang);
                pos += 1;
                continue;
            }
            // Otherwise fall through to be read as a word
        }

        // && or &> or lone &
        if chars[pos] == '&' {
            if pos + 1 < len && chars[pos + 1] == '&' {
                tokens.push(Token::And);
                pos += 2;
                continue;
            }
            if pos + 1 < len && chars[pos + 1] == '>' {
                // &> file
                pos += 2;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::BothOverwrite(target)));
                continue;
            }
            tokens.push(Token::Amp);
            pos += 1;
            continue;
        }

        // || or |
        if chars[pos] == '|' {
            if pos + 1 < len && chars[pos + 1] == '|' {
                tokens.push(Token::Or);
                pos += 2;
            } else {
                tokens.push(Token::Pipe);
                pos += 1;
            }
            continue;
        }

        // 2>&1, 2>file, 2>>file
        if chars[pos] == '2' && pos + 1 < len && chars[pos + 1] == '>' {
            if pos + 3 < len && chars[pos + 2] == '&' && chars[pos + 3] == '1' {
                tokens.push(Token::Redirect(RedirectType::StderrToStdout));
                pos += 4;
                continue;
            }
            if pos + 2 < len && chars[pos + 2] == '>' {
                // 2>> file
                pos += 3;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::StderrAppend(target)));
                continue;
            }
            // 2> file
            pos += 2;
            skip_whitespace(&chars, &mut pos);
            let target = read_redirect_target(&chars, &mut pos);
            tokens.push(Token::Redirect(RedirectType::StderrOverwrite(target)));
            continue;
        }

        // Output process substitution: >(cmd)
        if chars[pos] == '>' && pos + 1 < len && chars[pos + 1] == '(' {
            pos += 2;
            let content = read_balanced_parens(&chars, &mut pos);
            tokens.push(Token::DoubleQuoted(vec![WordPart::OutputProcessSub(
                content,
            )]));
            continue;
        }

        // > or >> or >&N or < redirects
        if chars[pos] == '>' {
            if pos + 1 < len && chars[pos + 1] == '>' {
                pos += 2;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::StdoutAppend(target)));
            } else if pos + 1 < len && chars[pos + 1] == '&' {
                // >&N — redirect stdout to fd N
                pos += 2; // skip >&
                let mut fd = String::new();
                while pos < len && chars[pos].is_ascii_digit() {
                    fd.push(chars[pos]);
                    pos += 1;
                }
                if fd.is_empty() || fd == "-" {
                    // >& with no fd number — treat as close (>&-) or error
                    // Just skip; no redirect token emitted
                } else {
                    // >&1, >&2, etc — encode as StdoutOverwrite("&N")
                    tokens.push(Token::Redirect(RedirectType::StdoutOverwrite(format!("&{fd}"))));
                }
            } else {
                pos += 1;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::StdoutOverwrite(target)));
            }
            continue;
        }
        if chars[pos] == '<' {
            // Process substitution: <(cmd) — emit as a word with ProcessSub part
            if pos + 1 < len && chars[pos + 1] == '(' {
                pos += 2; // skip '<('
                let content = read_balanced_parens(&chars, &mut pos);
                tokens.push(Token::DoubleQuoted(vec![WordPart::ProcessSub(content)]));
                continue;
            }
            if pos + 2 < len && chars[pos + 1] == '<' && chars[pos + 2] == '<' {
                // Herestring: <<< word (may be quoted)
                pos += 3;
                skip_whitespace(&chars, &mut pos);
                let target = if pos < len && (chars[pos] == '\'' || chars[pos] == '"') {
                    let quote = chars[pos];
                    pos += 1;
                    let mut val = String::new();
                    while pos < len && chars[pos] != quote {
                        val.push(chars[pos]);
                        pos += 1;
                    }
                    if pos < len {
                        pos += 1; // skip closing quote
                    }
                    val
                } else {
                    read_redirect_target(&chars, &mut pos)
                };
                tokens.push(Token::Redirect(RedirectType::HereString(target)));
                continue;
            }
            if pos + 1 < len && chars[pos + 1] == '<' {
                // Here-document: <<EOF or <<-EOF
                pos += 2;
                let strip_tabs = pos < len && chars[pos] == '-';
                if strip_tabs {
                    pos += 1;
                }
                skip_whitespace(&chars, &mut pos);

                // Read delimiter (may be quoted with ' or ")
                let (delimiter, _quoted) = read_heredoc_delimiter(&chars, &mut pos);

                // Capture any remaining tokens on this line (e.g. `> /tmp/file`)
                // before consuming the heredoc body on subsequent lines.
                let rest_of_line_start = pos;
                while pos < len && chars[pos] != '\n' {
                    pos += 1;
                }
                let rest_of_line: String = chars[rest_of_line_start..pos].iter().collect();
                if pos < len {
                    pos += 1;
                } // skip newline

                let mut content = String::new();
                loop {
                    if pos >= len {
                        break;
                    }
                    let line_start = pos;
                    while pos < len && chars[pos] != '\n' {
                        pos += 1;
                    }
                    let line: String = chars[line_start..pos].iter().collect();
                    let trimmed = if strip_tabs {
                        line.trim_start_matches('\t')
                    } else {
                        &line
                    };
                    if trimmed.trim() == delimiter {
                        if pos < len {
                            pos += 1;
                        } // skip delimiter newline
                        break;
                    }
                    content.push_str(&line);
                    content.push('\n');
                    if pos < len {
                        pos += 1;
                    } else {
                        break;
                    }
                }

                let rtype = match (strip_tabs, _quoted) {
                    (true, true) => RedirectType::HeredocStripQuoted(content),
                    (true, false) => RedirectType::HeredocStrip(content),
                    (false, true) => RedirectType::HeredocQuoted(content),
                    (false, false) => RedirectType::Heredoc(content),
                };
                tokens.push(Token::Redirect(rtype));

                // Lex any remaining tokens from the same line as the heredoc
                // delimiter (e.g. `> /tmp/file` in `cat <<EOF > /tmp/file`).
                let trimmed_rest = rest_of_line.trim();
                if !trimmed_rest.is_empty() {
                    let extra_tokens = lex(trimmed_rest);
                    tokens.extend(extra_tokens);
                }

                // The heredoc body consumed newlines that act as command
                // separators.  Emit a Newline token so the parser can
                // recognise the boundary between this command and whatever
                // follows the heredoc terminator.
                if pos < len {
                    tokens.push(Token::Newline);
                }
                continue;
            }
            pos += 1;
            skip_whitespace(&chars, &mut pos);
            let target = read_redirect_target(&chars, &mut pos);
            tokens.push(Token::Redirect(RedirectType::StdinFrom(target)));
            continue;
        }

        // --- Compound word: accumulate adjacent word parts (unquoted text,
        // quoted strings, variables, command subs) with no whitespace between
        // them into a single word.  POSIX shells treat e.g. test"hello"$VAR
        // as one word.
        let parts = read_compound_word(&chars, &mut pos);
        if !parts.is_empty() {
            tokens.push(compound_to_token(parts));
        }
    }

    tokens
}

/// Advance `pos` past any spaces and tabs.
fn skip_whitespace(chars: &[char], pos: &mut usize) {
    while *pos < chars.len() && (chars[*pos] == ' ' || chars[*pos] == '\t') {
        *pos += 1;
    }
}

/// Check if a character can start or continue a word (not a structural delimiter).
fn is_word_char(ch: char) -> bool {
    !matches!(
        ch,
        ' ' | '\t' | '\n' | ';' | '|' | '&' | '>' | '<' | '(' | ')' | '#'
    )
}

/// Read a compound word: a sequence of adjacent unquoted text, quoted strings,
/// variables, and command substitutions with no whitespace between them.
/// In POSIX shells, `test"hello"$VAR` forms a single word.
fn read_compound_word(chars: &[char], pos: &mut usize) -> Vec<WordPart> {
    let mut parts: Vec<WordPart> = Vec::new();

    while *pos < chars.len() && is_word_char(chars[*pos]) {
        let ch = chars[*pos];

        // Single-quoted string
        if ch == '\'' {
            *pos += 1;
            let content = read_until_char(chars, pos, '\'');
            parts.push(WordPart::QuotedLiteral(content));
            continue;
        }

        // Double-quoted string
        if ch == '"' {
            *pos += 1;
            let inner = lex_double_quoted(chars, pos);
            parts.extend(inner);
            continue;
        }

        // $ — variable, command substitution, arithmetic, or ANSI-C quoting
        if ch == '$' {
            *pos += 1;
            // $'...' ANSI-C quoting: process escape sequences
            if *pos < chars.len() && chars[*pos] == '\'' {
                *pos += 1; // skip opening '
                let mut s = String::new();
                while *pos < chars.len() && chars[*pos] != '\'' {
                    if chars[*pos] == '\\' && *pos + 1 < chars.len() {
                        *pos += 1;
                        match chars[*pos] {
                            'n' => s.push('\n'),
                            't' => s.push('\t'),
                            'r' => s.push('\r'),
                            'a' => s.push('\x07'),
                            'b' => s.push('\x08'),
                            'e' | 'E' => s.push('\x1b'),
                            'f' => s.push('\x0c'),
                            'v' => s.push('\x0b'),
                            '\\' => s.push('\\'),
                            '\'' => s.push('\''),
                            '"' => s.push('"'),
                            '0' => {
                                // Octal: \0nnn
                                let mut val = 0u32;
                                let mut count = 0;
                                while *pos + 1 < chars.len()
                                    && count < 3
                                    && chars[*pos + 1].is_ascii_digit()
                                    && chars[*pos + 1] <= '7'
                                {
                                    *pos += 1;
                                    val = val * 8 + (chars[*pos] as u32 - '0' as u32);
                                    count += 1;
                                }
                                if let Some(c) = char::from_u32(val) {
                                    s.push(c);
                                }
                            }
                            'x' => {
                                // Hex: \xHH
                                let mut val = 0u32;
                                let mut count = 0;
                                while *pos + 1 < chars.len()
                                    && count < 2
                                    && chars[*pos + 1].is_ascii_hexdigit()
                                {
                                    *pos += 1;
                                    let d = chars[*pos].to_digit(16).unwrap();
                                    val = val * 16 + d;
                                    count += 1;
                                }
                                if let Some(c) = char::from_u32(val) {
                                    s.push(c);
                                }
                            }
                            other => {
                                s.push('\\');
                                s.push(other);
                            }
                        }
                    } else {
                        s.push(chars[*pos]);
                    }
                    *pos += 1;
                }
                if *pos < chars.len() {
                    *pos += 1; // skip closing '
                }
                parts.push(WordPart::Literal(s));
                continue;
            }
            if *pos < chars.len() && chars[*pos] == '(' {
                if *pos + 1 < chars.len() && chars[*pos + 1] == '(' {
                    // Arithmetic: $((...))
                    *pos += 2;
                    let mut depth = 1;
                    let mut expr = String::new();
                    while *pos < chars.len() && depth > 0 {
                        if chars[*pos] == '(' {
                            depth += 1;
                        }
                        if chars[*pos] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        expr.push(chars[*pos]);
                        *pos += 1;
                    }
                    if *pos < chars.len() {
                        *pos += 1; // skip inner )
                    }
                    if *pos < chars.len() && chars[*pos] == ')' {
                        *pos += 1; // skip outer )
                    }
                    parts.push(WordPart::ArithmeticExpansion(expr));
                    continue;
                }
                // Command substitution: $(...)
                *pos += 1; // skip '('
                let content = read_balanced_parens(chars, pos);
                parts.push(WordPart::CommandSub(content));
                continue;
            }
            if *pos < chars.len() && chars[*pos] == '{' {
                // Braced variable: ${...}
                *pos += 1; // skip '{'
                let var = read_until_char(chars, pos, '}');
                parts.push(parse_braced_var(&var));
                continue;
            }
            // Special variables: $?, $$, $!, $#, $@, $*, $0-$9
            if *pos < chars.len() && "?$!#@*".contains(chars[*pos]) {
                let var = chars[*pos].to_string();
                *pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            if *pos < chars.len() && chars[*pos].is_ascii_digit() {
                let var = chars[*pos].to_string();
                *pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            // Simple variable: $NAME
            let var = read_var_name(chars, pos);
            parts.push(WordPart::Variable(var));
            continue;
        }

        // Backtick command substitution
        if ch == '`' {
            *pos += 1;
            let content = read_until_char(chars, pos, '`');
            parts.push(WordPart::CommandSub(content));
            continue;
        }

        // Unquoted word characters (read_word stops at quotes/$, which is
        // exactly what we want — the outer loop handles those).
        let word = read_word(chars, pos);
        if !word.is_empty() {
            parts.push(WordPart::Literal(word));
        } else {
            break; // safety: avoid infinite loop if nothing was consumed
        }
    }

    parts
}

/// Convert accumulated compound word parts into the most specific Token.
fn compound_to_token(parts: Vec<WordPart>) -> Token {
    // Single part — use the more specific token types
    if parts.len() == 1 {
        match &parts[0] {
            WordPart::Literal(s) => return classify_word(s.clone()),
            WordPart::QuotedLiteral(s) => return Token::QuotedWord(s.clone()),
            WordPart::Variable(v) => return Token::Variable(v.clone()),
            WordPart::CommandSub(c) => return Token::CommandSub(c.clone()),
            _ => return Token::DoubleQuoted(parts),
        }
    }

    // Check for assignment: first part is a Literal containing '='
    if let WordPart::Literal(ref first) = parts[0] {
        if let Some(eq_pos) = first.find('=') {
            let name = &first[..eq_pos];
            if !name.is_empty() && is_valid_var_name(name) {
                // Concatenate the value portion: rest of first literal + all remaining parts
                let after_eq = &first[eq_pos + 1..];
                let mut value = after_eq.to_string();
                for part in &parts[1..] {
                    match part {
                        WordPart::Literal(s) | WordPart::QuotedLiteral(s) => {
                            value.push_str(s);
                        }
                        _ => {
                            // For variable/cmdsub in assignment values, embed the
                            // raw syntax so the evaluator can expand it later.
                            // This keeps the existing Assignment(name, value) contract.
                            match part {
                                WordPart::Variable(v) => {
                                    value.push('$');
                                    value.push_str(v);
                                }
                                WordPart::CommandSub(c) => {
                                    value.push_str("$(");
                                    value.push_str(c);
                                    value.push(')');
                                }
                                WordPart::ParamExpansion { var, op, default } => {
                                    value.push_str("${");
                                    value.push_str(var);
                                    value.push_str(op);
                                    value.push_str(default);
                                    value.push('}');
                                }
                                WordPart::ArithmeticExpansion(e) => {
                                    value.push_str("$((");
                                    value.push_str(e);
                                    value.push_str("))");
                                }
                                _ => {}
                            }
                        }
                    }
                }
                return Token::Assignment(name.to_string(), value);
            }
        }
    }

    // Multiple parts — emit as DoubleQuoted (compound word)
    Token::DoubleQuoted(parts)
}

/// Read an unquoted word for a redirect target (stops at whitespace and operators).
fn read_redirect_target(chars: &[char], pos: &mut usize) -> String {
    let mut result = String::new();
    while *pos < chars.len() {
        let ch = chars[*pos];
        if ch == ' '
            || ch == '\t'
            || ch == '\n'
            || ch == ';'
            || ch == '|'
            || ch == '&'
            || ch == '>'
            || ch == '<'
            || ch == '('
            || ch == ')'
        {
            break;
        }
        result.push(ch);
        *pos += 1;
    }
    result
}

/// Read until a matching close parenthesis, handling nesting.
fn read_balanced_parens(chars: &[char], pos: &mut usize) -> String {
    let mut result = String::new();
    let mut depth = 1;
    while *pos < chars.len() && depth > 0 {
        let ch = chars[*pos];
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                *pos += 1; // skip closing ')'
                break;
            }
        }
        result.push(ch);
        *pos += 1;
    }
    result
}

/// Read characters until `terminator` is found. Consumes the terminator.
fn read_until_char(chars: &[char], pos: &mut usize, terminator: char) -> String {
    let mut result = String::new();
    while *pos < chars.len() && chars[*pos] != terminator {
        result.push(chars[*pos]);
        *pos += 1;
    }
    if *pos < chars.len() {
        *pos += 1; // skip terminator
    }
    result
}

/// Read a simple variable name (alphanumeric + underscore).
fn read_var_name(chars: &[char], pos: &mut usize) -> String {
    let mut name = String::new();
    while *pos < chars.len() && (chars[*pos].is_alphanumeric() || chars[*pos] == '_') {
        name.push(chars[*pos]);
        *pos += 1;
    }
    name
}

/// Lex the inside of a double-quoted string into a sequence of WordParts.
/// Handles `$VAR`, `${VAR}`, `$(cmd)`, backtick substitution, and backslash
/// escapes for `$`, `"`, `\`, and `` ` ``.
fn lex_double_quoted(chars: &[char], pos: &mut usize) -> Vec<WordPart> {
    let mut parts: Vec<WordPart> = Vec::new();
    let mut literal = String::new();

    while *pos < chars.len() && chars[*pos] != '"' {
        // Backslash escape
        if chars[*pos] == '\\' && *pos + 1 < chars.len() {
            let next = chars[*pos + 1];
            if next == '$' || next == '"' || next == '\\' || next == '`' {
                literal.push(next);
                *pos += 2;
                continue;
            }
        }

        // $ — variable or command substitution
        if chars[*pos] == '$' {
            // Flush accumulated literal text
            if !literal.is_empty() {
                parts.push(WordPart::QuotedLiteral(std::mem::take(&mut literal)));
            }
            *pos += 1;
            if *pos < chars.len() && chars[*pos] == '(' {
                if *pos + 1 < chars.len() && chars[*pos + 1] == '(' {
                    // Arithmetic: $((...))
                    *pos += 2;
                    let mut depth = 1;
                    let mut expr = String::new();
                    while *pos < chars.len() && depth > 0 {
                        if chars[*pos] == '(' {
                            depth += 1;
                        }
                        if chars[*pos] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        expr.push(chars[*pos]);
                        *pos += 1;
                    }
                    if *pos < chars.len() {
                        *pos += 1;
                    } // skip inner )
                    if *pos < chars.len() && chars[*pos] == ')' {
                        *pos += 1;
                    } // skip outer )
                    parts.push(WordPart::ArithmeticExpansion(expr));
                    continue;
                }
                // Command substitution: $(...)
                *pos += 1;
                let content = read_balanced_parens(chars, pos);
                parts.push(WordPart::CommandSub(content));
                continue;
            }
            if *pos < chars.len() && chars[*pos] == '{' {
                // Braced variable: ${...}
                *pos += 1;
                let var = read_until_char(chars, pos, '}');
                parts.push(parse_braced_var(&var));
                continue;
            }
            // Special variables: $?, $$, $!, $#, $@, $*
            if *pos < chars.len() && "?$!#@*".contains(chars[*pos]) {
                let var = chars[*pos].to_string();
                *pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            // Positional parameters: $0-$9
            if *pos < chars.len() && chars[*pos].is_ascii_digit() {
                let var = chars[*pos].to_string();
                *pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            // Simple variable: $NAME
            let var = read_var_name(chars, pos);
            parts.push(WordPart::Variable(var));
            continue;
        }

        // Backtick command substitution
        if chars[*pos] == '`' {
            if !literal.is_empty() {
                parts.push(WordPart::QuotedLiteral(std::mem::take(&mut literal)));
            }
            *pos += 1;
            let content = read_until_char(chars, pos, '`');
            parts.push(WordPart::CommandSub(content));
            continue;
        }

        literal.push(chars[*pos]);
        *pos += 1;
    }

    if *pos < chars.len() {
        *pos += 1; // skip closing '"'
    }

    // Flush remaining literal text
    if !literal.is_empty() {
        parts.push(WordPart::QuotedLiteral(literal));
    }

    // If completely empty (e.g. ""), return a single empty quoted literal
    if parts.is_empty() {
        parts.push(WordPart::QuotedLiteral(String::new()));
    }

    parts
}

/// Parse a raw string for variable/command expansion (like double-quoted content).
///
/// This is used by the executor to expand heredoc/herestring content.
/// It handles `$VAR`, `${VAR}`, `$(cmd)`, `$((expr))`, and backtick substitution.
pub fn parse_string_expansion(input: &str) -> Vec<WordPart> {
    let chars: Vec<char> = input.chars().collect();
    let mut pos = 0;
    let mut parts: Vec<WordPart> = Vec::new();
    let mut literal = String::new();

    while pos < chars.len() {
        // Backslash escape
        if chars[pos] == '\\' && pos + 1 < chars.len() {
            let next = chars[pos + 1];
            if next == '$' || next == '\\' || next == '`' {
                literal.push(next);
                pos += 2;
                continue;
            }
        }

        // $ — variable or command substitution
        if chars[pos] == '$' {
            if !literal.is_empty() {
                parts.push(WordPart::QuotedLiteral(std::mem::take(&mut literal)));
            }
            pos += 1;
            if pos < chars.len() && chars[pos] == '(' {
                if pos + 1 < chars.len() && chars[pos + 1] == '(' {
                    // Arithmetic: $((...))
                    pos += 2;
                    let mut depth = 1;
                    let mut expr = String::new();
                    while pos < chars.len() && depth > 0 {
                        if chars[pos] == '(' {
                            depth += 1;
                        }
                        if chars[pos] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        expr.push(chars[pos]);
                        pos += 1;
                    }
                    if pos < chars.len() {
                        pos += 1;
                    }
                    if pos < chars.len() && chars[pos] == ')' {
                        pos += 1;
                    }
                    parts.push(WordPart::ArithmeticExpansion(expr));
                    continue;
                }
                // Command substitution: $(...)
                pos += 1;
                let content = read_balanced_parens(&chars, &mut pos);
                parts.push(WordPart::CommandSub(content));
                continue;
            }
            if pos < chars.len() && chars[pos] == '{' {
                pos += 1;
                let var = read_until_char(&chars, &mut pos, '}');
                parts.push(parse_braced_var(&var));
                continue;
            }
            if pos < chars.len() && "?$!#@*".contains(chars[pos]) {
                let var = chars[pos].to_string();
                pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            if pos < chars.len() && chars[pos].is_ascii_digit() {
                let var = chars[pos].to_string();
                pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            let var = read_var_name(&chars, &mut pos);
            parts.push(WordPart::Variable(var));
            continue;
        }

        // Backtick command substitution
        if chars[pos] == '`' {
            if !literal.is_empty() {
                parts.push(WordPart::QuotedLiteral(std::mem::take(&mut literal)));
            }
            pos += 1;
            let content = read_until_char(&chars, &mut pos, '`');
            parts.push(WordPart::CommandSub(content));
            continue;
        }

        literal.push(chars[pos]);
        pos += 1;
    }

    if !literal.is_empty() {
        parts.push(WordPart::QuotedLiteral(literal));
    }

    parts
}

/// Read an unquoted word, handling backslash escapes.
///
/// When the word contains `=` (making it an assignment like `X=value`), the
/// value portion may include `$(cmd)` or `$VAR` which should be kept inline
/// so that `classify_word` produces a single `Assignment` token.
fn read_word(chars: &[char], pos: &mut usize) -> String {
    let mut word = String::new();
    let mut seen_eq = false;
    while *pos < chars.len() {
        let ch = chars[*pos];

        // Stop at word boundaries (but handle $ specially after = for assignments)
        if ch == ' '
            || ch == '\t'
            || ch == '\n'
            || ch == ';'
            || ch == '|'
            || ch == '&'
            || ch == '>'
            || ch == '<'
            || ch == '('
            || ch == ')'
            || ch == '\''
            || ch == '"'
        {
            // Array assignment: NAME=( ... ) — include parenthesized content in value
            if ch == '(' && seen_eq {
                word.push('(');
                *pos += 1;
                let content = read_balanced_parens(chars, pos);
                word.push_str(&content);
                word.push(')');
                continue;
            }
            break;
        }

        // Track = for assignment detection
        if ch == '=' && !seen_eq {
            seen_eq = true;
            word.push(ch);
            *pos += 1;
            continue;
        }

        // $ and ` are word boundaries unless we're in the value of an assignment
        if (ch == '$' || ch == '`') && !seen_eq {
            break;
        }

        // If in assignment value and we see $( or $VAR, include inline
        if ch == '$' && seen_eq {
            if *pos + 1 < chars.len() && chars[*pos + 1] == '(' {
                // Include $(cmd) in the word
                word.push('$');
                word.push('(');
                *pos += 2;
                let content = read_balanced_parens(chars, pos);
                word.push_str(&content);
                word.push(')');
                continue;
            }
            if *pos + 1 < chars.len() && chars[*pos + 1] == '{' {
                // Include ${VAR} in the word
                word.push('$');
                word.push('{');
                *pos += 2;
                let content = read_until_char(chars, pos, '}');
                word.push_str(&content);
                word.push('}');
                continue;
            }
            // Simple $VAR
            word.push('$');
            *pos += 1;
            let var_name = read_var_name(chars, pos);
            word.push_str(&var_name);
            continue;
        }

        // Backtick in assignment value
        if ch == '`' && seen_eq {
            word.push('`');
            *pos += 1;
            let content = read_until_char(chars, pos, '`');
            word.push_str(&content);
            word.push('`');
            continue;
        }

        // Backslash escape
        if ch == '\\' && *pos + 1 < chars.len() {
            *pos += 1;
            word.push(chars[*pos]);
            *pos += 1;
            continue;
        }

        word.push(ch);
        *pos += 1;
    }
    word
}

/// Classify a plain word as a keyword, assignment, or plain word.
fn classify_word(word: String) -> Token {
    match word.as_str() {
        "if" => Token::If,
        "then" => Token::Then,
        "elif" => Token::Elif,
        "else" => Token::Else,
        "fi" => Token::Fi,
        "for" => Token::For,
        "in" => Token::In,
        "do" => Token::Do,
        "done" => Token::Done,
        "while" => Token::While,
        "until" => Token::Until,
        "break" => Token::Break,
        "continue" => Token::Continue,
        "case" => Token::Case,
        "esac" => Token::Esac,
        _ => {
            // Append assignment: VAR+=value (check before simple = assignment)
            if let Some(plus_eq) = word.find("+=") {
                let name = &word[..plus_eq];
                if !name.is_empty() && is_valid_var_name(name) {
                    let value = word[plus_eq + 2..].to_string();
                    // Encode append by suffixing name with "+"
                    return Token::Assignment(format!("{}+", name), value);
                }
            }
            if let Some(eq_pos) = word.find('=') {
                let name = &word[..eq_pos];
                if !name.is_empty() {
                    // Regular variable assignment: FOO=bar
                    if is_valid_var_name(name) {
                        let value = word[eq_pos + 1..].to_string();
                        return Token::Assignment(name.to_string(), value);
                    }
                    // Array element assignment: arr[idx]=value or assoc[key]=value
                    if let Some(bracket_pos) = name.find('[') {
                        let base = &name[..bracket_pos];
                        if name.ends_with(']') && !base.is_empty() && is_valid_var_name(base) {
                            let value = word[eq_pos + 1..].to_string();
                            return Token::Assignment(name.to_string(), value);
                        }
                    }
                }
            }
            Token::Word(word)
        }
    }
}

/// Parse the content of `${...}` into a WordPart.
/// Detects parameter expansion operators like `:-`, `:=`, `:+`, `:?`,
/// case modification (`^^`, `,,`, `^`, `,`), and substring (`:N` or `:N:M`).
fn parse_braced_var(content: &str) -> WordPart {
    // Indirect expansion: ${!var} or ${!arr[@]} / ${!arr[*]}
    if let Some(var_name) = content.strip_prefix('!') {
        if !var_name.is_empty()
            && (is_valid_var_name(var_name)
                || var_name.ends_with("[@]")
                || var_name.ends_with("[*]"))
        {
            return WordPart::ParamExpansion {
                var: String::new(),
                op: "!".to_string(),
                default: var_name.to_string(),
            };
        }
    }

    // Case modification: ${var^^}, ${var,,}, ${var^}, ${var,}
    // Check longest operators first to avoid matching ^ before ^^
    for op in &["^^", ",,", "^", ","] {
        if let Some(var_name) = content.strip_suffix(op) {
            if !var_name.is_empty() && is_valid_var_name(var_name) {
                return WordPart::ParamExpansion {
                    var: var_name.to_string(),
                    op: op.to_string(),
                    default: String::new(),
                };
            }
        }
    }

    // Substring: ${var:N} or ${var:N:M} — colon followed by digit
    // Negative offset requires a space: ${var: -N} (to distinguish from ${var:-default})
    // Must check before :- :+ := :? operators
    if let Some(colon_pos) = content.find(':') {
        let var_name = &content[..colon_pos];
        let after = &content[colon_pos + 1..];
        if !var_name.is_empty() && is_valid_var_name(var_name) && !after.is_empty() {
            let first_char = after.as_bytes()[0];
            if first_char.is_ascii_digit() {
                // Positive offset: ${var:2} or ${var:2:3}
                return WordPart::ParamExpansion {
                    var: var_name.to_string(),
                    op: ":".to_string(),
                    default: after.to_string(),
                };
            }
            // Negative offset with space: ${var: -2} or ${var: -2:3}
            let trimmed = after.trim_start();
            if after.starts_with(' ')
                && trimmed.starts_with('-')
                && trimmed.len() > 1
                && trimmed.as_bytes()[1].is_ascii_digit()
            {
                return WordPart::ParamExpansion {
                    var: var_name.to_string(),
                    op: ":".to_string(),
                    default: trimmed.to_string(),
                };
            }
        }
    }

    for op in &[":-", ":=", ":+", ":?", "##", "/#", "%%", "/%", "#", "%", "//", "/"] {
        if let Some(idx) = content.find(op) {
            return WordPart::ParamExpansion {
                var: content[..idx].to_string(),
                op: op.to_string(),
                default: content[idx + op.len()..].to_string(),
            };
        }
    }
    WordPart::Variable(content.to_string())
}

/// Read a here-document delimiter. May be quoted with ' or ".
/// Returns (delimiter, was_quoted).
fn read_heredoc_delimiter(chars: &[char], pos: &mut usize) -> (String, bool) {
    if *pos < chars.len() && (chars[*pos] == '\'' || chars[*pos] == '"') {
        let quote = chars[*pos];
        *pos += 1;
        let delim = read_until_char(chars, pos, quote);
        (delim, true)
    } else {
        let mut delim = String::new();
        while *pos < chars.len() && !chars[*pos].is_whitespace() && chars[*pos] != '\n' {
            delim.push(chars[*pos]);
            *pos += 1;
        }
        (delim, false)
    }
}

/// Check whether `name` is a valid shell variable name (starts with letter or
/// underscore, then alphanumeric or underscore).
fn is_valid_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::*;

    #[test]
    fn simple_command() {
        let tokens = lex("echo hello world");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello".into()),
                Token::Word("world".into()),
            ]
        );
    }

    #[test]
    fn pipe() {
        let tokens = lex("cat file | grep pattern");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cat".into()),
                Token::Word("file".into()),
                Token::Pipe,
                Token::Word("grep".into()),
                Token::Word("pattern".into()),
            ]
        );
    }

    #[test]
    fn operators() {
        let tokens = lex("cmd1 && cmd2 || cmd3 ; cmd4");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cmd1".into()),
                Token::And,
                Token::Word("cmd2".into()),
                Token::Or,
                Token::Word("cmd3".into()),
                Token::Semi,
                Token::Word("cmd4".into()),
            ]
        );
    }

    #[test]
    fn single_quotes() {
        let tokens = lex("echo 'hello world'");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::QuotedWord("hello world".into()),
            ]
        );
    }

    #[test]
    fn double_quotes_plain() {
        let tokens = lex(r#"echo "hello world""#);
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::QuotedWord("hello world".into()),
            ]
        );
    }

    #[test]
    fn variable_reference() {
        let tokens = lex("echo $HOME");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::Variable("HOME".into()),]
        );
    }

    #[test]
    fn variable_braces() {
        let tokens = lex("echo ${HOME}");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::Variable("HOME".into()),]
        );
    }

    #[test]
    fn command_substitution() {
        let tokens = lex("echo $(date)");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::CommandSub("date".into()),]
        );
    }

    #[test]
    fn redirect_stdout() {
        let tokens = lex("echo hello > file.txt");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello".into()),
                Token::Redirect(RedirectType::StdoutOverwrite("file.txt".into())),
            ]
        );
    }

    #[test]
    fn redirect_append() {
        let tokens = lex("echo hello >> file.txt");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello".into()),
                Token::Redirect(RedirectType::StdoutAppend("file.txt".into())),
            ]
        );
    }

    #[test]
    fn redirect_stderr_to_stdout() {
        let tokens = lex("cmd 2>&1");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cmd".into()),
                Token::Redirect(RedirectType::StderrToStdout),
            ]
        );
    }

    #[test]
    fn assignment() {
        let tokens = lex("FOO=bar");
        assert_eq!(tokens, vec![Token::Assignment("FOO".into(), "bar".into()),]);
    }

    #[test]
    fn parens() {
        let tokens = lex("( cmd1 ; cmd2 )");
        assert_eq!(
            tokens,
            vec![
                Token::LParen,
                Token::Word("cmd1".into()),
                Token::Semi,
                Token::Word("cmd2".into()),
                Token::RParen,
            ]
        );
    }

    #[test]
    fn keywords() {
        let tokens = lex("if true; then echo yes; fi");
        assert_eq!(
            tokens,
            vec![
                Token::If,
                Token::Word("true".into()),
                Token::Semi,
                Token::Then,
                Token::Word("echo".into()),
                Token::Word("yes".into()),
                Token::Semi,
                Token::Fi,
            ]
        );
    }

    #[test]
    fn for_loop() {
        let tokens = lex("for x in a b c; do echo $x; done");
        assert_eq!(
            tokens,
            vec![
                Token::For,
                Token::Word("x".into()),
                Token::In,
                Token::Word("a".into()),
                Token::Word("b".into()),
                Token::Word("c".into()),
                Token::Semi,
                Token::Do,
                Token::Word("echo".into()),
                Token::Variable("x".into()),
                Token::Semi,
                Token::Done,
            ]
        );
    }

    #[test]
    fn backtick_substitution() {
        let tokens = lex("echo `date`");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::CommandSub("date".into()),]
        );
    }

    #[test]
    fn escaped_space() {
        let tokens = lex(r"echo hello\ world");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello world".into()),
            ]
        );
    }

    #[test]
    fn comment_after_command() {
        let tokens = lex("echo hello # comment");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::Word("hello".into()),]
        );
    }

    #[test]
    fn full_line_comment() {
        let tokens = lex("# full line comment\necho hi");
        assert_eq!(
            tokens,
            vec![
                Token::Newline,
                Token::Word("echo".into()),
                Token::Word("hi".into()),
            ]
        );
    }

    #[test]
    fn comment_inside_single_quotes() {
        let tokens = lex("echo 'hello # not comment'");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::QuotedWord("hello # not comment".into()),
            ]
        );
    }

    #[test]
    fn comment_inside_double_quotes() {
        let tokens = lex("echo \"hello # not comment\"");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::QuotedWord("hello # not comment".into()),
            ]
        );
    }

    #[test]
    fn stdin_redirect() {
        let tokens = lex("cmd < input.txt");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cmd".into()),
                Token::Redirect(RedirectType::StdinFrom("input.txt".into())),
            ]
        );
    }

    #[test]
    fn compound_word_unquoted_and_double_quoted() {
        // test"hello"test → single compound word
        let tokens = lex(r#"echo test"hello"test"#);
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::DoubleQuoted(vec![
                    WordPart::Literal("test".into()),
                    WordPart::QuotedLiteral("hello".into()),
                    WordPart::Literal("test".into()),
                ]),
            ]
        );
    }

    #[test]
    fn compound_word_unquoted_and_single_quoted() {
        let tokens = lex("echo test'hello'test");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::DoubleQuoted(vec![
                    WordPart::Literal("test".into()),
                    WordPart::QuotedLiteral("hello".into()),
                    WordPart::Literal("test".into()),
                ]),
            ]
        );
    }

    #[test]
    fn compound_word_assignment_with_quotes() {
        // FOO="bar" → single assignment with value "bar"
        let tokens = lex(r#"FOO="bar""#);
        assert_eq!(tokens, vec![Token::Assignment("FOO".into(), "bar".into())]);
    }

    #[test]
    fn compound_word_variable_suffix() {
        // $HOME/bin → compound word
        let tokens = lex("echo $HOME/bin");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::DoubleQuoted(vec![
                    WordPart::Variable("HOME".into()),
                    WordPart::Literal("/bin".into()),
                ]),
            ]
        );
    }

    #[test]
    fn heredoc_with_output_redirect() {
        // cat > /tmp/file <<EOF\nhello\nEOF should produce both redirects
        // No trailing content → no Newline emitted
        let tokens = lex("cat > /tmp/file <<EOF\nhello\nEOF");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cat".into()),
                Token::Redirect(RedirectType::StdoutOverwrite("/tmp/file".into())),
                Token::Redirect(RedirectType::Heredoc("hello\n".into())),
            ]
        );
    }

    #[test]
    fn heredoc_redirect_after_delimiter() {
        // cat <<EOF > /tmp/file\nhello\nEOF — redirect comes after heredoc delimiter
        // No trailing content → no Newline emitted
        let tokens = lex("cat <<EOF > /tmp/file\nhello\nEOF");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cat".into()),
                Token::Redirect(RedirectType::Heredoc("hello\n".into())),
                Token::Redirect(RedirectType::StdoutOverwrite("/tmp/file".into())),
            ]
        );
    }

    #[test]
    fn heredoc_followed_by_command() {
        // Heredoc followed by another command on the next line
        let tokens = lex("cat <<EOF\nhello\nEOF\necho ok");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cat".into()),
                Token::Redirect(RedirectType::Heredoc("hello\n".into())),
                Token::Newline,
                Token::Word("echo".into()),
                Token::Word("ok".into()),
            ]
        );
    }

    #[test]
    fn case_modification_operators() {
        let tokens = lex("echo ${x^^}");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::DoubleQuoted(vec![WordPart::ParamExpansion {
                    var: "x".into(),
                    op: "^^".into(),
                    default: String::new(),
                }]),
            ]
        );
    }

    #[test]
    fn substring_operator() {
        let tokens = lex("echo ${x:1:3}");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::DoubleQuoted(vec![WordPart::ParamExpansion {
                    var: "x".into(),
                    op: ":".into(),
                    default: "1:3".into(),
                }]),
            ]
        );
    }

    #[test]
    fn lex_ampersand() {
        let tokens = lex("echo hello &");
        assert!(tokens.contains(&Token::Amp));
        // Make sure && still works
        let tokens2 = lex("cmd1 && cmd2");
        assert!(tokens2.contains(&Token::And));
        assert!(!tokens2.contains(&Token::Amp));
    }

    #[test]
    fn output_process_sub() {
        let tokens = lex(">(cat)");
        assert_eq!(
            tokens,
            vec![Token::DoubleQuoted(vec![WordPart::OutputProcessSub(
                "cat".into()
            )])]
        );
    }

    #[test]
    fn input_process_sub_still_works() {
        let tokens = lex("<(echo a)");
        assert_eq!(
            tokens,
            vec![Token::DoubleQuoted(vec![WordPart::ProcessSub(
                "echo a".into()
            )])]
        );
    }
}
