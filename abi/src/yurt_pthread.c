#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <string.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(pthread_create);
YURT_DECLARE_MARKER(pthread_join);
YURT_DECLARE_MARKER(pthread_detach);
YURT_DECLARE_MARKER(pthread_exit);
YURT_DECLARE_MARKER(pthread_self);
YURT_DECLARE_MARKER(pthread_mutex_lock);
YURT_DECLARE_MARKER(pthread_mutex_unlock);
YURT_DECLARE_MARKER(pthread_cond_wait);
YURT_DECLARE_MARKER(pthread_cond_signal);
YURT_DECLARE_MARKER(pthread_key_create);
YURT_DECLARE_MARKER(pthread_setspecific);
YURT_DECLARE_MARKER(pthread_getspecific);
YURT_DECLARE_MARKER(pthread_once);

YURT_DEFINE_MARKER(pthread_create,       0x70637274u)
YURT_DEFINE_MARKER(pthread_join,         0x706a6f69u)
YURT_DEFINE_MARKER(pthread_detach,       0x70646574u)
YURT_DEFINE_MARKER(pthread_exit,         0x70657874u)
YURT_DEFINE_MARKER(pthread_self,         0x7073656cu)
YURT_DEFINE_MARKER(pthread_mutex_lock,   0x706d6c6bu)
YURT_DEFINE_MARKER(pthread_mutex_unlock, 0x706d756cu)
YURT_DEFINE_MARKER(pthread_cond_wait,    0x70637774u)
YURT_DEFINE_MARKER(pthread_cond_signal,  0x70637367u)
YURT_DEFINE_MARKER(pthread_key_create,   0x70726b63u)
YURT_DEFINE_MARKER(pthread_setspecific,  0x70737073u)
YURT_DEFINE_MARKER(pthread_getspecific,  0x70677073u)
YURT_DEFINE_MARKER(pthread_once,         0x706f6e63u)

static int yurt_attr_store_int(void *attr, int value) {
  if (!attr) return EINVAL;
  memcpy(attr, &value, sizeof(value));
  return 0;
}

static int yurt_attr_load_int(const void *attr, int *value) {
  if (!attr || !value) return EINVAL;
  memcpy(value, attr, sizeof(*value));
  return 0;
}

static int yurt_attr_store_clock(void *attr, clockid_t value) {
  if (!attr) return EINVAL;
  memcpy(attr, &value, sizeof(value));
  return 0;
}

static int yurt_attr_load_clock(const void *attr, clockid_t *value) {
  if (!attr || !value) return EINVAL;
  memcpy(value, attr, sizeof(*value));
  return 0;
}

int pthread_equal(pthread_t a, pthread_t b) {
  return a == b;
}

int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr) {
  (void)attr;
  if (!mutex) return EINVAL;
  memset(mutex, 0, sizeof(*mutex));
  return 0;
}

int pthread_mutex_destroy(pthread_mutex_t *mutex) {
  return mutex ? 0 : EINVAL;
}

int pthread_mutex_lock(pthread_mutex_t *mutex) {
  YURT_MARKER_CALL(pthread_mutex_lock);
  if (!mutex) return EINVAL;
  return yurt_host_mutex_lock((int)(intptr_t)mutex);
}

int pthread_mutex_unlock(pthread_mutex_t *mutex) {
  YURT_MARKER_CALL(pthread_mutex_unlock);
  if (!mutex) return EINVAL;
  return yurt_host_mutex_unlock((int)(intptr_t)mutex);
}

int pthread_mutex_trylock(pthread_mutex_t *mutex) {
  if (!mutex) return EINVAL;
  return yurt_host_mutex_trylock((int)(intptr_t)mutex);
}

int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr) {
  (void)attr;
  if (!cond) return EINVAL;
  memset(cond, 0, sizeof(*cond));
  return 0;
}

int pthread_cond_destroy(pthread_cond_t *cond) {
  return cond ? 0 : EINVAL;
}

int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
  YURT_MARKER_CALL(pthread_cond_wait);
  if (!cond || !mutex) return EINVAL;
  return yurt_host_cond_wait((int)(intptr_t)cond, (int)(intptr_t)mutex);
}

int pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex,
                           const struct timespec *abstime) {
  (void)abstime;
  return pthread_cond_wait(cond, mutex);
}

int pthread_cond_signal(pthread_cond_t *cond) {
  YURT_MARKER_CALL(pthread_cond_signal);
  if (!cond) return EINVAL;
  return yurt_host_cond_signal((int)(intptr_t)cond);
}

int pthread_cond_broadcast(pthread_cond_t *cond) {
  if (!cond) return EINVAL;
  return yurt_host_cond_broadcast((int)(intptr_t)cond);
}

#define YURT_TLS_KEYS_MAX 64
#define YURT_TLS_THREADS_MAX 128

typedef struct {
  int in_use;
  void (*destructor)(void *);
  void *values[YURT_TLS_THREADS_MAX];
} yurt_tls_key_t;

static yurt_tls_key_t tls_keys[YURT_TLS_KEYS_MAX];

int pthread_key_create(pthread_key_t *key, void (*destructor)(void *)) {
  YURT_MARKER_CALL(pthread_key_create);
  if (!key) return EINVAL;
  for (unsigned int i = 0; i < YURT_TLS_KEYS_MAX; i++) {
    if (!tls_keys[i].in_use) {
      tls_keys[i].in_use = 1;
      tls_keys[i].destructor = destructor;
      memset(tls_keys[i].values, 0, sizeof(tls_keys[i].values));
      *key = (pthread_key_t)i;
      return 0;
    }
  }
  return EAGAIN;
}

int pthread_key_delete(pthread_key_t key) {
  if (key >= YURT_TLS_KEYS_MAX || !tls_keys[key].in_use) return EINVAL;
  tls_keys[key].in_use = 0;
  tls_keys[key].destructor = NULL;
  memset(tls_keys[key].values, 0, sizeof(tls_keys[key].values));
  return 0;
}

static int yurt_pthread_setspecific_impl(pthread_key_t key, const void *value) {
  YURT_MARKER_CALL(pthread_setspecific);
  if (key >= YURT_TLS_KEYS_MAX || !tls_keys[key].in_use) return EINVAL;
  int tid = yurt_host_thread_self();
  if (tid < 0 || tid >= YURT_TLS_THREADS_MAX) return EINVAL;
  tls_keys[key].values[tid] = (void *)value;
  return 0;
}

int pthread_setspecific(pthread_key_t key, const void *value) {
  return yurt_pthread_setspecific_impl(key, value);
}

int __wrap_pthread_setspecific(pthread_key_t key, const void *value) {
  return yurt_pthread_setspecific_impl(key, value);
}

void *pthread_getspecific(pthread_key_t key) {
  YURT_MARKER_CALL(pthread_getspecific);
  if (key >= YURT_TLS_KEYS_MAX || !tls_keys[key].in_use) return NULL;
  int tid = yurt_host_thread_self();
  if (tid < 0 || tid >= YURT_TLS_THREADS_MAX) return NULL;
  return tls_keys[key].values[tid];
}

int pthread_once(pthread_once_t *once_control, void (*init_routine)(void)) {
  YURT_MARKER_CALL(pthread_once);
  if (!once_control || !init_routine) return EINVAL;
  int *done = (int *)once_control;
  if (!*done) {
    init_routine();
    *done = 1;
  }
  return 0;
}

int pthread_mutexattr_init(pthread_mutexattr_t *attr) {
  memset(attr, 0, sizeof(*attr));
  return yurt_attr_store_int(attr, PTHREAD_MUTEX_NORMAL);
}

int pthread_mutexattr_destroy(pthread_mutexattr_t *attr) {
  return attr ? 0 : EINVAL;
}

int pthread_mutexattr_settype(pthread_mutexattr_t *attr, int type) {
  if (type < PTHREAD_MUTEX_NORMAL || type > PTHREAD_MUTEX_ERRORCHECK) return EINVAL;
  return yurt_attr_store_int(attr, type);
}

int pthread_mutexattr_gettype(const pthread_mutexattr_t *attr, int *type) {
  return yurt_attr_load_int(attr, type);
}

int pthread_condattr_init(pthread_condattr_t *attr) {
  memset(attr, 0, sizeof(*attr));
  return yurt_attr_store_clock(attr, CLOCK_REALTIME);
}

int pthread_condattr_destroy(pthread_condattr_t *attr) {
  return attr ? 0 : EINVAL;
}

int pthread_condattr_setclock(pthread_condattr_t *attr, clockid_t clock_id) {
  if (clock_id != CLOCK_REALTIME && clock_id != CLOCK_MONOTONIC) return EINVAL;
  return yurt_attr_store_clock(attr, clock_id);
}

int pthread_condattr_getclock(const pthread_condattr_t *attr, clockid_t *clock_id) {
  return yurt_attr_load_clock(attr, clock_id);
}

int pthread_cancel(pthread_t thread) {
  (void)thread;
  return ENOTSUP;
}

int pthread_setcancelstate(int state, int *oldstate) {
  if (oldstate) *oldstate = PTHREAD_CANCEL_ENABLE;
  return state == PTHREAD_CANCEL_ENABLE || state == PTHREAD_CANCEL_DISABLE ? 0 : EINVAL;
}

int pthread_setcanceltype(int type, int *oldtype) {
  if (oldtype) *oldtype = PTHREAD_CANCEL_DEFERRED;
  return type == PTHREAD_CANCEL_DEFERRED || type == PTHREAD_CANCEL_ASYNCHRONOUS ? 0 : EINVAL;
}

void pthread_testcancel(void) {}
