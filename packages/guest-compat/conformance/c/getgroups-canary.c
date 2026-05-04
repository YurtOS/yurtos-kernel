#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_count_only(void) {
  int count = getgroups(0, NULL);
  if (count < 0) {
    emit("count_only", 1, NULL, 1, errno);
    return 1;
  }
  if (count != 1) {
    emit("count_only", 1, NULL, 0, 0);
    return 1;
  }
  emit("count_only", 0, "getgroups:1", 0, 0);
  return 0;
}

static int case_fetch_one(void) {
  gid_t groups[1] = {99};
  int count = getgroups(1, groups);
  if (count < 0) {
    emit("fetch_one", 1, NULL, 1, errno);
    return 1;
  }
  if (count != 1 || groups[0] != 1000) {
    emit("fetch_one", 1, NULL, 0, 0);
    return 1;
  }
  emit("fetch_one", 0, "getgroups:1:1000", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "count_only") == 0) return case_count_only();
  if (strcmp(name, "fetch_one") == 0) return case_fetch_one();
  fprintf(stderr, "getgroups-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("count_only");
  puts("fetch_one");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved for guest-compat.test.ts. */
    gid_t groups[1];
    int count = getgroups(0, NULL);
    if (count != 1) {
      fprintf(stderr, "unexpected group count: %d\n", count);
      return 1;
    }
    count = getgroups(1, groups);
    if (count != 1) {
      fprintf(stderr, "unexpected getgroups result: %d\n", count);
      return 1;
    }
    printf("getgroups:%d:%u\n", count, (unsigned)groups[0]);
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: getgroups-canary [--case <name> | --list-cases]\n");
  return 2;
}
