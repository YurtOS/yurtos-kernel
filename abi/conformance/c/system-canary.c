#include "yurt_abi.h"

#include <string.h>
#include <stdio.h>

int main(int argc, char **argv) {
  const char *cmd = "echo system-ok";
  const char *success = "system-ok";
  int rc;

  if (argc == 2 && strcmp(argv[1], "large") == 0) {
    cmd = "i=0; while [ $i -lt 6000 ]; do printf x; i=$((i + 1)); done";
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
