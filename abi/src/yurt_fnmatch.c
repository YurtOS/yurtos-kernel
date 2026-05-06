#include <ctype.h>
#include <fnmatch.h>
#include <stddef.h>

static int fold_char(int c, int flags) {
  return (flags & FNM_CASEFOLD) ? tolower((unsigned char)c) : c;
}

static int path_separator(int c, int flags) {
  return (flags & FNM_PATHNAME) && c == '/';
}

static int period_special(const char *s, const char *string, int flags) {
  if (!(flags & FNM_PERIOD) || *s != '.') return 0;
  return s == string || ((flags & FNM_PATHNAME) && s[-1] == '/');
}

static int bracket_match(const char **pattern, int sc, int flags) {
  const char *p = *pattern + 1;
  int negate = 0;
  int matched = 0;
  int first = 1;
  int prev = -1;
  int c;
  int escaped;

  if (*p == '!' || *p == '^') {
    negate = 1;
    p++;
  }

  while (*p != '\0') {
    if (*p == ']' && !first) {
      *pattern = p + 1;
      return (matched != negate) ? 1 : 0;
    }

    escaped = 0;
    c = (unsigned char)*p++;
    if (c == '\0') break;

    if (!(flags & FNM_NOESCAPE) && c == '\\' && *p != '\0') {
      c = (unsigned char)*p++;
      escaped = 1;
    }

    if (
      !escaped && c == '-' && prev >= 0 &&
      *p != '\0' && *p != ']'
    ) {
      int end = (unsigned char)*p++;
      if (!(flags & FNM_NOESCAPE) && end == '\\' && *p != '\0') {
        end = (unsigned char)*p++;
      }
      if (fold_char(prev, flags) <= fold_char(sc, flags) &&
          fold_char(sc, flags) <= fold_char(end, flags)) {
        matched = 1;
      }
      prev = -1;
      first = 0;
      continue;
    }

    if (fold_char(c, flags) == fold_char(sc, flags)) matched = 1;
    prev = c;
    first = 0;
  }

  return -1;
}

static int match_here(const char *pattern, const char *string, const char *string_start, int flags) {
  const char *p = pattern;
  const char *s = string;

  for (;;) {
    int pc = (unsigned char)*p;
    int sc = (unsigned char)*s;

    switch (pc) {
      case '\0':
        if (sc == '\0') return 1;
        if ((flags & FNM_LEADING_DIR) && sc == '/') return 1;
        return 0;

      case '?':
        if (sc == '\0' || path_separator(sc, flags) || period_special(s, string_start, flags)) {
          return 0;
        }
        p++;
        s++;
        break;

      case '*':
        while (*p == '*') p++;
        if (period_special(s, string_start, flags)) return 0;
        if (*p == '\0') {
          if (!(flags & FNM_PATHNAME)) return 1;
          while (*s != '\0') {
            if (*s == '/') return (flags & FNM_LEADING_DIR) ? 1 : 0;
            s++;
          }
          return 1;
        }
        for (;;) {
          if (match_here(p, s, string_start, flags)) return 1;
          if (*s == '\0' || path_separator((unsigned char)*s, flags)) return 0;
          s++;
        }

      case '[': {
        int ok;
        if (sc == '\0' || path_separator(sc, flags) || period_special(s, string_start, flags)) {
          return 0;
        }
        ok = bracket_match(&p, sc, flags);
        if (ok < 0) {
          if (fold_char('[', flags) != fold_char(sc, flags)) return 0;
          p++;
          s++;
          break;
        }
        if (!ok) return 0;
        s++;
        break;
      }

      case '\\':
        if (!(flags & FNM_NOESCAPE) && p[1] != '\0') {
          p++;
          pc = (unsigned char)*p;
        }
        /* fall through */
      default:
        if (fold_char(pc, flags) != fold_char(sc, flags)) return 0;
        p++;
        s++;
        break;
    }
  }
}

int fnmatch(const char *pattern, const char *string, int flags) {
  if (pattern == NULL || string == NULL) return FNM_NOMATCH;
  return match_here(pattern, string, string, flags) ? 0 : FNM_NOMATCH;
}
