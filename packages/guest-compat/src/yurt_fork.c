/* Strong fork(2) shim for Yurt continuation builds.
 *
 * The always-linked compatibility archive keeps weak fork/vfork stubs that
 * return ENOSYS. The continuation archive links this object so asyncify
 * builds import yurt.host_fork and let the kernel split the parent/child
 * return values.
 */

#include <errno.h>
#include <sys/types.h>
#include <unistd.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(fork);

pid_t fork(void) {
    YURT_MARKER_CALL(fork);
    int rc = yurt_host_fork();
    if (rc < 0) {
        errno = -rc;
        return (pid_t)-1;
    }
    return (pid_t)rc;
}
