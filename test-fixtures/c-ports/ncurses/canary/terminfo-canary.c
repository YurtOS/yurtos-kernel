#include <curses.h>
#include <stdio.h>
#include <term.h>

static int terminfo_outc(int ch) {
  return ch;
}

int main(void) {
  char termcap[4096];
  int rc = tgetent(termcap, "xterm-256color");
  if (rc != 1) {
    printf("termcap:error:%d\n", rc);
    return 1;
  }

  char area[1024];
  char *area_ptr = area;
  char *termcap_clear = tgetstr("cl", &area_ptr);
  if (termcap_clear == 0) {
    printf("termcap:missing-clear\n");
    return 1;
  }
  int err = 0;
  if (setupterm("xterm-256color", 1, &err) != OK) {
    printf("terminfo:error:%d\n", err);
    return 1;
  }

  int colors = tigetnum("colors");
  if (colors == -2) {
    printf("terminfo:invalid-colors\n");
    return 1;
  }
  if (colors < 8) {
    printf("terminfo:colors:%d\n", colors);
    return 1;
  }

  char *clear = tigetstr("clear");
  if (clear == 0 || clear == (char *)-1) {
    printf("terminfo:missing-clear\n");
    return 1;
  }

  char *green = tigetstr("setaf");
  if (green == 0 || green == (char *)-1) {
    printf("terminfo:missing-setaf\n");
    return 1;
  }
  if (tputs(tparm(green, 2), 1, terminfo_outc) == ERR) {
    printf("terminfo:tputs-failed\n");
    return 1;
  }

  printf("terminfo-ok\n");
  return 0;
}
