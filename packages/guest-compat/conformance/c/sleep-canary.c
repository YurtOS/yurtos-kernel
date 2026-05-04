#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

enum {
  MAX_SLEEP_MILLIS = 60 * 1000,
};

static long elapsed_ms(const struct timespec *start, const struct timespec *now) {
  long sec = (long)(now->tv_sec - start->tv_sec);
  long nsec = (long)(now->tv_nsec - start->tv_nsec);
  return sec * 1000L + nsec / 1000000L;
}

static int sleep_millis(long millis) {
  struct timespec start;
  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) {
    return 1;
  }

  for (;;) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
      return 1;
    }
    if (elapsed_ms(&start, &now) >= millis) {
      break;
    }
  }

  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: sleep-canary <millis>\n");
    return 2;
  }

  errno = 0;
  char *end = NULL;
  long millis = strtol(argv[1], &end, 10);
  if (errno == ERANGE || end == argv[1] || *end != '\0' || millis < 0) {
    fprintf(stderr, "invalid millis: %s\n", argv[1]);
    return 2;
  }
  if (millis > MAX_SLEEP_MILLIS) {
    fprintf(stderr, "sleep duration too large: %s\n", argv[1]);
    return 2;
  }

  if (sleep_millis(millis) != 0) {
    perror("clock_gettime");
    return 1;
  }

  printf("slept:%ld\n", millis);
  return 0;
}
