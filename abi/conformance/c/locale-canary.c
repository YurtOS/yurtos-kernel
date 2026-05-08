#include <errno.h>
#include <langinfo.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wchar.h>

static int unicode_quote_ascii(void) {
  char out[8] = {0};
#ifndef __STDC_ISO_10646__
  printf("locale:iso10646=0\n");
  return 1;
#else
  printf("locale:iso10646=1\n");
#endif

  setenv("LANG", "en_US.UTF-8", 1);
  if (setlocale(LC_ALL, "") == NULL) {
    printf("locale:utf8_setlocale=fail\n");
    return 1;
  }
  printf("locale:utf8_codeset=%s\n", nl_langinfo(CODESET));

  setenv("LC_ALL", "C", 1);
  if (setlocale(LC_ALL, "") == NULL) {
    printf("locale:c_setlocale=fail\n");
    return 1;
  }
  printf("locale:c_codeset=%s\n", nl_langinfo(CODESET));

  errno = 0;
  int wctomb_result = wctomb(out, 0xe9);
  printf("locale:c_wctomb=%d errno=%d\n", wctomb_result, errno);
  if (wctomb_result != -1 || errno != EILSEQ) {
    return 1;
  }

  char time_buffer[8] = {'x', 0};
  struct tm tm = {0};
  errno = 0;
  size_t strftime_result = strftime(time_buffer, sizeof(time_buffer), "%@", &tm);
  printf("locale:strftime_invalid=%zu first=%d errno=%d\n", strftime_result,
         (int)time_buffer[0], errno);
  if (strftime_result != 0 || time_buffer[0] != 'x') {
    return 1;
  }

  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "unicode_quote_ascii") == 0) {
    return unicode_quote_ascii();
  }
  fprintf(stderr, "usage: locale-canary unicode_quote_ascii\n");
  return 2;
}
