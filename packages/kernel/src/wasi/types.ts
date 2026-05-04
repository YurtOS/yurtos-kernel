/** WASI Preview 1 constants: error codes, file types, flags. */

// Error codes (errno)
export const WASI_ESUCCESS = 0;
export const WASI_E2BIG = 1;
export const WASI_EACCES = 2;
export const WASI_EADDRINUSE = 3;
export const WASI_EADDRNOTAVAIL = 4;
export const WASI_EAFNOSUPPORT = 5;
export const WASI_EAGAIN = 6;
export const WASI_EALREADY = 7;
export const WASI_EBADF = 8;
export const WASI_EBADMSG = 9;
export const WASI_EBUSY = 10;
export const WASI_ECANCELED = 11;
export const WASI_ECHILD = 12;
export const WASI_ECONNABORTED = 13;
export const WASI_ECONNREFUSED = 14;
export const WASI_ECONNRESET = 15;
export const WASI_EDEADLK = 16;
export const WASI_EDESTADDRREQ = 17;
export const WASI_EDOM = 18;
export const WASI_EDQUOT = 19;
export const WASI_EEXIST = 20;
export const WASI_EFAULT = 21;
export const WASI_EFBIG = 22;
export const WASI_EHOSTUNREACH = 23;
export const WASI_EIDRM = 24;
export const WASI_EILSEQ = 25;
export const WASI_EINPROGRESS = 26;
export const WASI_EINTR = 27;
export const WASI_EINVAL = 28;
export const WASI_EIO = 29;
export const WASI_EISCONN = 30;
export const WASI_EISDIR = 31;
export const WASI_ELOOP = 32;
export const WASI_EMFILE = 33;
export const WASI_EMLINK = 34;
export const WASI_EMSGSIZE = 35;
export const WASI_EMULTIHOP = 36;
export const WASI_ENAMETOOLONG = 37;
export const WASI_ENETDOWN = 38;
export const WASI_ENETRESET = 39;
export const WASI_ENETUNREACH = 40;
export const WASI_ENFILE = 41;
export const WASI_ENOBUFS = 42;
export const WASI_ENODEV = 43;
export const WASI_ENOENT = 44;
export const WASI_ENOEXEC = 45;
export const WASI_ENOLCK = 46;
export const WASI_ENOLINK = 47;
export const WASI_ENOMEM = 48;
export const WASI_ENOMSG = 49;
export const WASI_ENOPROTOOPT = 50;
export const WASI_ENOSPC = 51;
export const WASI_ENOSYS = 52;
export const WASI_ENOTCONN = 53;
export const WASI_ENOTDIR = 54;
export const WASI_ENOTEMPTY = 55;
export const WASI_ENOTRECOVERABLE = 56;
export const WASI_ENOTSOCK = 57;
export const WASI_ENOTSUP = 58;
export const WASI_ENOTTY = 59;
export const WASI_ENXIO = 60;
export const WASI_EOVERFLOW = 61;
export const WASI_EOWNERDEAD = 62;
export const WASI_EPERM = 63;
export const WASI_EPIPE = 64;
export const WASI_EPROTO = 65;
export const WASI_EPROTONOSUPPORT = 66;
export const WASI_EPROTOTYPE = 67;
export const WASI_ERANGE = 68;
export const WASI_EROFS = 69;
export const WASI_ESPIPE = 70;
export const WASI_ESRCH = 71;
export const WASI_ESTALE = 72;
export const WASI_ETIMEDOUT = 73;
export const WASI_ETXTBSY = 74;
export const WASI_EXDEV = 75;
export const WASI_ENOTCAPABLE = 76;

// File types
export const WASI_FILETYPE_UNKNOWN = 0;
export const WASI_FILETYPE_BLOCK_DEVICE = 1;
export const WASI_FILETYPE_CHARACTER_DEVICE = 2;
export const WASI_FILETYPE_DIRECTORY = 3;
export const WASI_FILETYPE_REGULAR_FILE = 4;
export const WASI_FILETYPE_SOCKET_DGRAM = 5;
export const WASI_FILETYPE_SOCKET_STREAM = 6;
export const WASI_FILETYPE_SYMBOLIC_LINK = 7;

// Clock IDs
export const WASI_CLOCK_REALTIME = 0;
export const WASI_CLOCK_MONOTONIC = 1;
export const WASI_CLOCK_PROCESS_CPUTIME_ID = 2;
export const WASI_CLOCK_THREAD_CPUTIME_ID = 3;

// Preopentype
export const WASI_PREOPENTYPE_DIR = 0;

// Fd flags
export const WASI_FDFLAGS_APPEND = 1;
export const WASI_FDFLAGS_DSYNC = 2;
export const WASI_FDFLAGS_NONBLOCK = 4;
export const WASI_FDFLAGS_RSYNC = 8;
export const WASI_FDFLAGS_SYNC = 16;

// Open flags
export const WASI_OFLAGS_CREAT = 1;
export const WASI_OFLAGS_DIRECTORY = 2;
export const WASI_OFLAGS_EXCL = 4;
export const WASI_OFLAGS_TRUNC = 8;

// Whence
export const WASI_WHENCE_SET = 0;
export const WASI_WHENCE_CUR = 1;
export const WASI_WHENCE_END = 2;

// Rights — we grant all rights (no capability enforcement inside the sandbox)
export const WASI_RIGHTS_ALL = BigInt(0x1fffffff);

// Event types (for poll_oneoff subscriptions and events)
export const WASI_EVENTTYPE_CLOCK = 0;
export const WASI_EVENTTYPE_FD_READ = 1;
export const WASI_EVENTTYPE_FD_WRITE = 2;

// Subscription clock flags
export const WASI_SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME = 1;

// Event read/write flags
export const WASI_EVENTRWFLAGS_FD_READWRITE_HANGUP = 1;
