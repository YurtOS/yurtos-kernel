#include <stdint.h>

#include "yurt_abi.h"

uint32_t yurt_abi_version =
  ((uint32_t)YURT_ABI_VERSION_MAJOR << 16) |
  (uint32_t)YURT_ABI_VERSION_MINOR;
