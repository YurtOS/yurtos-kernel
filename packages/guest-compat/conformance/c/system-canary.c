#include "yurt_compat.h"

#include <string.h>
#include <stdio.h>

int main(int argc, char **argv) {
  const char *cmd = "echo system-ok";
  const char *success = "system-ok";
  int rc;

  if (argc == 2 && strcmp(argv[1], "large") == 0) {
    cmd = "python3 -c \"print('x' * 6000, end='')\"";
    success = "system-large-ok";
  } else if (argc != 1) {
    fprintf(stderr, "usage: system-canary [large]\n");
    return 2;
  }

  rc = yurt_system(cmd);
  if (rc != 0) {
    return rc;
  }

  puts(success);
  return 0;
}
