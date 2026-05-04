/* sys/sendfile.h — sendfile(2) shim for wasm32/wasi. */

#ifndef _SYS_SENDFILE_H
#define _SYS_SENDFILE_H

#include <stddef.h>
#include <sys/types.h>

/* sendfile is not natively available in WASI; callers fall back to
 * read+write when it returns -1/ENOSYS. */
static inline ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count) {
    (void)out_fd; (void)in_fd; (void)offset; (void)count;
    return -1;
}

#endif /* _SYS_SENDFILE_H */
