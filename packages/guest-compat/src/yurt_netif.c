#include "yurt_markers.h"

#include <errno.h>
#include <net/if.h>
#include <string.h>

YURT_DECLARE_MARKER(if_nametoindex);
YURT_DECLARE_MARKER(if_indextoname);

YURT_DEFINE_MARKER(if_nametoindex,  0x69666e69u) /* "ifni" */
YURT_DEFINE_MARKER(if_indextoname,  0x6966696eu) /* "ifin" */

unsigned int if_nametoindex(const char *ifname) {
  YURT_MARKER_CALL(if_nametoindex);
  if (ifname == NULL) {
    errno = EINVAL;
    return 0;
  }
  if (strcmp(ifname, "lo") == 0) {
    return 1;
  }
  errno = ENODEV;
  return 0;
}

char *if_indextoname(unsigned int ifindex, char *ifname) {
  YURT_MARKER_CALL(if_indextoname);
  if (ifname == NULL) {
    errno = EINVAL;
    return NULL;
  }
  if (ifindex != 1) {
    errno = ENXIO;
    return NULL;
  }
  memcpy(ifname, "lo", 3);
  return ifname;
}
