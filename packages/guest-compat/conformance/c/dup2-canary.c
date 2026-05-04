#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Print one JSONL trace line. Use printf with explicit field order so the
 * output is byte-stable regardless of compiler. */
static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) {
    printf(",\"stdout\":\"%s\"", stdout_line);
  }
  if (has_errno) {
    printf(",\"errno\":%d", errno_value);
  }
  printf("}\n");
}

static int case_happy_path(void) {
  if (dup2(1, 2) < 0) {
    emit("happy_path", 1, NULL, 1, errno);
    return 1;
  }
  emit("happy_path", 0, "dup2-ok", 0, 0);
  return 0;
}

static int case_invalid_fd(void) {
  errno = 0;
  if (dup2(999, 2) >= 0) {
    emit("invalid_fd", 1, NULL, 0, 0);
    return 1;
  }
  emit("invalid_fd", 1, NULL, 1, errno);
  return 1;
}

static int run_case(const char *name) {
  if (strcmp(name, "happy_path") == 0) return case_happy_path();
  if (strcmp(name, "invalid_fd") == 0) return case_invalid_fd();
  fprintf(stderr, "dup2-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("happy_path");
  puts("invalid_fd");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode — preserves the contract checked by guest-compat.test.ts. */
    if (dup2(1, 2) < 0) {
      perror("dup2");
      return 1;
    }
    if (fprintf(stderr, "dup2-ok\n") < 0) {
      return 1;
    }
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) {
    return list_cases();
  }
  if (argc == 3 && strcmp(argv[1], "--case") == 0) {
    return run_case(argv[2]);
  }
  fprintf(stderr, "usage: dup2-canary [--case <name> | --list-cases]\n");
  return 2;
}
