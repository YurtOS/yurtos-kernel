#include <stdio.h>
#include <stdlib.h>

static int copy_file(FILE *in, FILE *out) {
  unsigned char buf[4096];

  for (;;) {
    size_t n = fread(buf, 1, sizeof(buf), in);
    if (n > 0 && fwrite(buf, 1, n, out) != n) {
      return 1;
    }
    if (n < sizeof(buf)) {
      if (ferror(in)) {
        return 1;
      }
      return 0;
    }
  }
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: stdio-canary <in> <out>\n");
    return 2;
  }

  FILE *in = fopen(argv[1], "rb");
  if (!in) {
    perror("fopen input");
    return 1;
  }

  FILE *out = fopen(argv[2], "wb");
  if (!out) {
    perror("fopen output");
    fclose(in);
    return 1;
  }

  int rc = copy_file(in, out);
  if (fclose(in) != 0) {
    return 1;
  }
  if (fclose(out) != 0) {
    return 1;
  }

  if (rc != 0) {
    return rc;
  }

  puts("stdio-ok");
  return 0;
}
