#include <stdint.h>

#include "yurt_compat.h"

uint32_t yurt_guest_compat_version =
  ((uint32_t)YURT_GUEST_COMPAT_VERSION_MAJOR << 16) |
  (uint32_t)YURT_GUEST_COMPAT_VERSION_MINOR;
