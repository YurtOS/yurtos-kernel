#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

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

  fp = popen(cmd, "r");
  if (!fp) {
    perror("popen");
    return 1;
  }

  if (!fgets(buf, sizeof(buf), fp)) {
    pclose(fp);
    return 1;
  }

  status = pclose(fp);
  if (status < 0) {
    perror("pclose");
    return 1;
  }

  if (expect_status != 0) {
    if (!WIFEXITED(status) || WEXITSTATUS(status) != expect_status) {
      fprintf(stderr, "unexpected status: %d\n", status);
      return 1;
    }
    printf("pclose:%d\n", WEXITSTATUS(status));
    return 0;
  }

  printf("popen:%s", buf);
  return 0;
}
