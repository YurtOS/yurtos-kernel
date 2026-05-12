#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

  FILE *tmp = tmpfile();
  if (!tmp) {
    perror("tmpfile");
    return 1;
  }
  if (fputs("tmpfile-ok", tmp) < 0 || fflush(tmp) != 0 || fseek(tmp, 0, SEEK_SET) != 0) {
    perror("tmpfile write");
    fclose(tmp);
    return 1;
  }
  char buf[32];
  if (!fgets(buf, sizeof(buf), tmp) || strcmp(buf, "tmpfile-ok") != 0) {
    fprintf(stderr, "tmpfile contents mismatch\n");
    fclose(tmp);
    return 1;
  }
  if (fclose(tmp) != 0) {
    perror("tmpfile close");
    return 1;
  }

  FILE *single = fopen("/tmp/fwrite-single-object.txt", "wb");
  if (!single) {
    perror("fopen single object");
    return 1;
  }
  const char *single_payload = "single-object-ok";
  if (fwrite(single_payload, strlen(single_payload), 1, single) != 1) {
    perror("fwrite single object");
    fclose(single);
    return 1;
  }
  if (fclose(single) != 0) {
    perror("fclose single object");
    return 1;
  }
  single = fopen("/tmp/fwrite-single-object.txt", "rb");
  if (!single) {
    perror("reopen single object");
    return 1;
  }
  memset(buf, 0, sizeof(buf));
  if (!fgets(buf, sizeof(buf), single) || strcmp(buf, single_payload) != 0) {
    fprintf(stderr, "fwrite single-object contents mismatch: %s\n", buf);
    fclose(single);
    return 1;
  }
  if (fclose(single) != 0) {
    perror("fclose single object read");
    return 1;
  }

  puts("stdio-ok");
  return 0;
}
