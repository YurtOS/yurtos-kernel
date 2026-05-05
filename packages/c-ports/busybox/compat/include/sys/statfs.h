#ifndef YURT_BUSYBOX_COMPAT_SYS_STATFS_H
#define YURT_BUSYBOX_COMPAT_SYS_STATFS_H

#include <sys/types.h>

typedef struct {
	int __val[2];
} fsid_t;

struct statfs {
	unsigned long f_type;
	unsigned long f_bsize;
	unsigned long long f_blocks;
	unsigned long long f_bfree;
	unsigned long long f_bavail;
	unsigned long long f_files;
	unsigned long long f_ffree;
	fsid_t f_fsid;
	unsigned long f_namelen;
	unsigned long f_frsize;
	unsigned long f_flags;
	unsigned long f_spare[4];
};

int statfs(const char *path, struct statfs *buf);
int fstatfs(int fd, struct statfs *buf);

#endif
