use crate::ast::WordPart;

/// A token produced by the shell lexer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// A plain word (command name, argument, glob pattern, etc.)
    Word(String),
    /// A word that originated from inside quotes — braces should not expand.
    QuotedWord(String),
    /// A double-quoted string that may contain variable/command interpolation.
    DoubleQuoted(Vec<WordPart>),
    /// An assignment: name=value
    Assignment(String, String),
    /// Pipe: |
    Pipe,
    /// And: &&
    And,
    /// Single ampersand: & (background)
    Amp,
    /// Or: ||
    Or,
    /// Semicolon: ;
    Semi,
    /// Newline
    Newline,
    /// Left paren: (
    LParen,
    /// Right paren: )
    RParen,
    /// Redirect
    Redirect(RedirectType),
    /// Variable reference: $VAR, ${VAR}, ${VAR:-default}, $?, $$, etc.
    Variable(String),
    /// Command substitution: $(cmd) or `cmd`
    CommandSub(String),
    // -- Keywords --
    If,
    Then,
    Elif,
    Else,
    Fi,
    For,
    In,
    Do,
    Done,
    While,
    Until,
    Break,
    Continue,
    Case,
    Esac,
    /// `;;` — case item terminator.
    DoubleSemi,
    /// `!` — pipeline negation.
    Bang,
    /// `{`
    LBrace,
    /// `}`
    RBrace,
    /// `(( ... ))` — arithmetic/C-for expression (raw content between the parens).
    DoubleParen(String),
    /// `[[ ... ]]` — conditional expression (raw content between brackets).
    DoubleBracket(String),
}

/// The kind of I/O redirection.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum RedirectType {
    /// > file
    StdoutOverwrite(String),
    /// >> file
    StdoutAppend(String),
    /// < file
    StdinFrom(String),
    /// 2> file
    StderrOverwrite(String),
    /// 2>> file
    StderrAppend(String),
    /// 2>&1
    StderrToStdout,
    /// &> file  (both stdout and stderr)
    BothOverwrite(String),
    /// <<EOF ... content ... EOF (unquoted: expand variables)
    Heredoc(String),
    /// <<'EOF' or <<"EOF" ... content ... EOF (quoted: no expansion)
    HeredocQuoted(String),
    /// <<-EOF (strip leading tabs, unquoted: expand)
    HeredocStrip(String),
    /// <<-'EOF' (strip leading tabs, quoted: no expansion)
    HeredocStripQuoted(String),
    /// <<< word (herestring)
    HereString(String),
}
