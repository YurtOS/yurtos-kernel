#include "yurt_abi.h"

#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  char buf[128];
  const char *cmd = "echo hello-from-shell";
  int expect_status = 0;
  FILE *fp;
  int status;

  if (argc == 2 && strcmp(argv[1], "status") == 0) {
    cmd = "printf status-out; exit 7";
    expect_status = 7;
  } else if (argc != 1) {
    fprintf(stderr, "usage: popen-canary [status]\n");
    return 2;
  }

  fp = yurt_popen(cmd, "r");
  if (!fp) {
    perror("yurt_popen");
    return 1;
  }

  if (!fgets(buf, sizeof(buf), fp)) {
    yurt_pclose(fp);
    return 1;
  }

  status = yurt_pclose(fp);
  if (status < 0) {
    perror("yurt_pclose");
    return 1;
  }

  if (expect_status != 0) {
    if (status != expect_status) {
      fprintf(stderr, "unexpected status: %d\n", status);
      return 1;
    }
    printf("pclose:%d\n", status);
    return 0;
  }

  printf("popen:%s", buf);
  return 0;
}
