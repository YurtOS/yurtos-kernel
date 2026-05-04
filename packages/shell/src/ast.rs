use serde::Serialize;

use crate::token::RedirectType;

/// A word that may contain variable references or command substitutions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum WordPart {
    Literal(String),
    QuotedLiteral(String),
    Variable(String),
    CommandSub(String),
    ParamExpansion {
        var: String,
        op: String,
        default: String,
    },
    ArithmeticExpansion(String),
    ProcessSub(String),
    OutputProcessSub(String),
}

/// A shell word composed of one or more parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Word {
    pub parts: Vec<WordPart>,
}

impl Word {
    pub fn literal(s: &str) -> Self {
        Word {
            parts: vec![WordPart::Literal(s.to_string())],
        }
    }

    pub fn variable(s: &str) -> Self {
        Word {
            parts: vec![WordPart::Variable(s.to_string())],
        }
    }
}

/// An I/O redirection attached to a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Redirect {
    pub redirect_type: RedirectType,
}

/// A variable assignment preceding a command (e.g. `FOO=bar cmd`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Assignment {
    pub name: String,
    pub value: String,
}

/// The operator joining two commands in a list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ListOp {
    And,        // &&
    Or,         // ||
    Seq,        // ;
    Background, // &
}

/// A shell command AST node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Command {
    /// A simple command: words + redirects + optional assignments.
    Simple {
        words: Vec<Word>,
        redirects: Vec<Redirect>,
        assignments: Vec<Assignment>,
    },
    /// A pipeline: cmd1 | cmd2 | cmd3.
    Pipeline { commands: Vec<Command> },
    /// A list: cmd1 && cmd2, cmd1 || cmd2, cmd1 ; cmd2.
    List {
        left: Box<Command>,
        op: ListOp,
        right: Box<Command>,
    },
    /// If conditional.
    If {
        condition: Box<Command>,
        then_body: Box<Command>,
        else_body: Option<Box<Command>>,
    },
    /// For loop.
    For {
        var: String,
        words: Vec<Word>,
        body: Box<Command>,
    },
    /// C-style for loop: for ((init; cond; step)) do ... done
    CFor {
        init: String,
        cond: String,
        step: String,
        body: Box<Command>,
    },
    /// While loop.
    While {
        condition: Box<Command>,
        body: Box<Command>,
    },
    /// Subshell: ( commands ) [redirects].
    Subshell {
        body: Box<Command>,
        redirects: Vec<Redirect>,
    },
    /// Brace group: { commands; } [redirects].
    BraceGroup {
        body: Box<Command>,
        redirects: Vec<Redirect>,
    },
    /// Break out of a loop.
    Break,
    /// Continue to next loop iteration.
    Continue,
    /// Negate exit code of a pipeline.
    Negate { body: Box<Command> },
    /// Function definition.
    Function { name: String, body: Box<Command> },
    /// Case statement.
    Case { word: Word, items: Vec<CaseItem> },
    /// Conditional expression: [[ ... ]].
    DoubleBracket { expr: String },
    /// Standalone arithmetic: (( expr )).
    ArithmeticCommand { expr: String },
}

/// A single arm of a case statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaseItem {
    pub patterns: Vec<Word>,
    pub body: Box<Command>,
}
