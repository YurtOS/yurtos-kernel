#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_get_reports_one_cpu(void) {
  cpu_set_t mask;
  CPU_ZERO(&mask);
  if (sched_getaffinity(0, sizeof(mask), &mask) != 0) {
    emit("get_reports_one_cpu", 1, NULL, 1, errno);
    return 1;
  }
  if (CPU_COUNT(&mask) != 1 || !CPU_ISSET(0, &mask)) {
    emit("get_reports_one_cpu", 1, NULL, 0, 0);
    return 1;
  }
  emit("get_reports_one_cpu", 0, "affinity:get=1", 0, 0);
  return 0;
}

static int case_set_cpu0_succeeds(void) {
  cpu_set_t mask;
  CPU_ZERO(&mask);
  CPU_SET(0, &mask);
  if (sched_setaffinity(0, sizeof(mask), &mask) != 0) {
    emit("set_cpu0_succeeds", 1, NULL, 1, errno);
    return 1;
  }
  emit("set_cpu0_succeeds", 0, "affinity:set0=ok", 0, 0);
  return 0;
}

static int case_set_cpu1_einval(void) {
  cpu_set_t mask;
  CPU_ZERO(&mask);
  CPU_SET(1, &mask);
  errno = 0;
  if (sched_setaffinity(0, sizeof(mask), &mask) == 0) {
    emit("set_cpu1_einval", 1, NULL, 0, 0);
    return 1;
  }
  emit("set_cpu1_einval", 1, NULL, 1, errno);
  return 1;
}

static int case_getcpu_zero(void) {
  int cpu = sched_getcpu();
  if (cpu < 0) {
    emit("getcpu_zero", 1, NULL, 1, errno);
    return 1;
  }
  if (cpu != 0) {
    emit("getcpu_zero", 1, NULL, 0, 0);
    return 1;
  }
  emit("getcpu_zero", 0, "affinity:cpu=0", 0, 0);
  return 0;
}

static int case_scheduler_policy_metadata(void) {
  struct sched_param param;
  memset(&param, 0, sizeof(param));

  if (sched_getscheduler(0) != SCHED_OTHER) {
    emit("scheduler_policy_metadata", 1, "scheduler:policy_not_other", 1, errno);
    return 1;
  }
  if (sched_getparam(0, &param) != 0 || param.sched_priority != 0) {
    emit("scheduler_policy_metadata", 1, "scheduler:getparam_failed", 1, errno);
    return 1;
  }
  if (sched_setscheduler(0, SCHED_OTHER, &param) != 0) {
    emit("scheduler_policy_metadata", 1, "scheduler:setscheduler_noop_failed", 1, errno);
    return 1;
  }
  if (sched_setparam(0, &param) != 0) {
    emit("scheduler_policy_metadata", 1, "scheduler:setparam_noop_failed", 1, errno);
    return 1;
  }

  param.sched_priority = 1;
  errno = 0;
  if (sched_setparam(0, &param) != -1 || errno != EINVAL) {
    emit("scheduler_policy_metadata", 1, "scheduler:setparam_not_einval", 1, errno);
    return 1;
  }

  errno = 0;
  if (sched_setscheduler(0, SCHED_FIFO, &param) != -1 || errno != EPERM) {
    emit("scheduler_policy_metadata", 1, "scheduler:fifo_not_eperm", 1, errno);
    return 1;
  }

  emit("scheduler_policy_metadata", 0, "scheduler:policy=other,param=0", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "get_reports_one_cpu") == 0) return case_get_reports_one_cpu();
  if (strcmp(name, "set_cpu0_succeeds") == 0) return case_set_cpu0_succeeds();
  if (strcmp(name, "set_cpu1_einval") == 0) return case_set_cpu1_einval();
  if (strcmp(name, "getcpu_zero") == 0) return case_getcpu_zero();
  if (strcmp(name, "scheduler_policy_metadata") == 0) return case_scheduler_policy_metadata();
  fprintf(stderr, "affinity-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("get_reports_one_cpu");
  puts("set_cpu0_succeeds");
  puts("set_cpu1_einval");
  puts("getcpu_zero");
  puts("scheduler_policy_metadata");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved. Reproduces Step 1 output verbatim. */
    cpu_set_t mask;
    int get_count, set0_rc, set1_errno;
    CPU_ZERO(&mask);
    if (sched_getaffinity(0, sizeof(mask), &mask) != 0) { perror("sched_getaffinity"); return 1; }
    get_count = CPU_COUNT(&mask);
    CPU_ZERO(&mask); CPU_SET(0, &mask);
    set0_rc = sched_setaffinity(0, sizeof(mask), &mask);
    if (set0_rc != 0) { perror("sched_setaffinity cpu0"); return 1; }
    CPU_ZERO(&mask); CPU_SET(1, &mask);
    if (sched_setaffinity(0, sizeof(mask), &mask) == 0) {
      fprintf(stderr, "sched_setaffinity unexpectedly accepted cpu1\n"); return 1;
    }
    set1_errno = errno;
    if (set1_errno != EINVAL) { fprintf(stderr, "unexpected errno: %d\n", set1_errno); return 1; }
    printf("affinity:get=%d,set0=%d,set1=einval\n", get_count, set0_rc);
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: affinity-canary [--case <name> | --list-cases]\n");
  return 2;
}
