#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
  const char *cmd = "echo system-ok";
  const char *success = "system-ok";
  int rc;

  if (argc == 2 && strcmp(argv[1], "large") == 0) {
    cmd = "i=0; while [ $i -lt 6000 ]; do printf x; i=$((i + 1)); done";
    success = "system-large-ok";
  } else if (argc == 2 && strcmp(argv[1], "redirect") == 0) {
    cmd = "echo redirect-ok > /tmp/system-redirect-out";
    success = "system-redirect-ok";
  } else if (argc != 1) {
    fprintf(stderr, "usage: system-canary [large|redirect]\n");
    return 2;
  }

  rc = system(cmd);
  if (rc == -1 || !WIFEXITED(rc) || WEXITSTATUS(rc) != 0) {
    return rc;
  }

  if (strcmp(success, "system-redirect-ok") == 0) {
    char buf[64];
    FILE *fp = fopen("/tmp/system-redirect-out", "r");
    if (!fp) {
      perror("fopen");
      return 1;
    }
    if (!fgets(buf, sizeof(buf), fp)) {
      fclose(fp);
      return 1;
    }
    fclose(fp);
    if (strcmp(buf, "redirect-ok\n") != 0) {
      return 1;
    }
  }

  puts(success);
  return 0;
}
