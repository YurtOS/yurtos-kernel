/* sys/sendfile.h — sendfile(2) shim for wasm32/wasi. */

#ifndef _SYS_SENDFILE_H
#define _SYS_SENDFILE_H

#include <stddef.h>
#include <sys/types.h>

/* sendfile is not natively available in WASI. Yurt provides a compatibility
 * symbol in libyurt_abi.a, implemented over read/write/lseek. */
ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count);

#endif /* _SYS_SENDFILE_H */
