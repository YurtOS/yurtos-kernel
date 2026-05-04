#include "yurt_compat.h"

#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: fetch-canary URL\n");
    return 2;
  }

  char *out = NULL;
  int rc = yurt_fetch_text(argv[1], "GET", NULL, NULL, &out);
  if (rc != 0) {
    fprintf(stderr, "fetch failed: %d\n", rc);
    return 1;
  }

  printf("%s", out ? out : "");
  free(out);
  return 0;
}
