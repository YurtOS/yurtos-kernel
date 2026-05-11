#include <pthread.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

#define NUM_THREADS 1
#define ITERS_PER_THREAD 10000
#define EXPECTED (NUM_THREADS * ITERS_PER_THREAD)

static int shared_counter = 0;
static pthread_mutex_t shared_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_key_t tls_key;
static int exit_poll_pipe[2] = { -1, -1 };

static void *exit_poll_blocker(void *arg) {
  (void)arg;
  struct pollfd pfd = { .fd = exit_poll_pipe[0], .events = POLLIN, .revents = 0 };
  for (;;) {
    poll(&pfd, 1, -1);
  }
  return NULL;
}
static void *worker(void *arg) {
  int id = (int)(long)arg;
  long initial_tls_value = (long)pthread_getspecific(tls_key);
  if (initial_tls_value != 0) {
    fprintf(stderr, "pthread-canary: initial tls mismatch in thread %d: got %ld\n", id, initial_tls_value);
    return (void *)1;
  }
  if (pthread_setspecific(tls_key, (void *)(long)(id + 100)) != 0) {
    fprintf(stderr, "pthread-canary: pthread_setspecific failed in thread %d\n", id);
    return (void *)1;
  }
  for (int i = 0; i < ITERS_PER_THREAD; i++) {
    int rc = pthread_mutex_lock(&shared_lock);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: mutex_lock returned %d in thread %d\n", rc, id);
      return (void *)1;
    }
    shared_counter++;
    rc = pthread_mutex_unlock(&shared_lock);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: mutex_unlock returned %d in thread %d\n", rc, id);
      return (void *)1;
    }
  }
  long tls_value = (long)pthread_getspecific(tls_key);
  if (tls_value != id + 100) {
    fprintf(stderr, "pthread-canary: tls mismatch in thread %d: got %ld\n", id, tls_value);
    return (void *)1;
  }
  return NULL;
}

int main(void) {
  pthread_mutex_t try_lock = PTHREAD_MUTEX_INITIALIZER;
  int try_rc = pthread_mutex_trylock(&try_lock);
  if (try_rc != 0) {
    fprintf(stderr, "pthread-canary: first pthread_mutex_trylock returned %d\n", try_rc);
    return 1;
  }
  try_rc = pthread_mutex_trylock(&try_lock);
  if (try_rc != EBUSY) {
    fprintf(stderr, "pthread-canary: second pthread_mutex_trylock returned %d, expected EBUSY=%d\n", try_rc, EBUSY);
    return 1;
  }
  if (pthread_mutex_unlock(&try_lock) != 0) {
    fprintf(stderr, "pthread-canary: pthread_mutex_unlock after trylock failed\n");
    return 1;
  }

  pthread_attr_t self_attr;
  void *stackaddr = (void *)1;
  size_t stacksize = 0;
  size_t guardsize = 1;
  if (pthread_getattr_np(pthread_self(), &self_attr) != 0) {
    fprintf(stderr, "pthread-canary: pthread_getattr_np failed\n");
    return 1;
  }
  if (pthread_attr_getstack(&self_attr, &stackaddr, &stacksize) != 0 || stackaddr != NULL || stacksize == 0) {
    fprintf(stderr, "pthread-canary: pthread_attr_getstack failed\n");
    return 1;
  }
  if (pthread_attr_getguardsize(&self_attr, &guardsize) != 0 || guardsize != 0) {
    fprintf(stderr, "pthread-canary: pthread_attr_getguardsize failed\n");
    return 1;
  }
  pthread_condattr_t cond_attr;
  clockid_t cond_clock = CLOCK_REALTIME;
  if (pthread_condattr_init(&cond_attr) != 0) {
    fprintf(stderr, "pthread-canary: pthread_condattr_init failed\n");
    return 1;
  }
  if (pthread_condattr_setclock(&cond_attr, CLOCK_MONOTONIC) != 0) {
    fprintf(stderr, "pthread-canary: pthread_condattr_setclock failed\n");
    return 1;
  }
  if (pthread_condattr_getclock(&cond_attr, &cond_clock) != 0 || cond_clock != CLOCK_MONOTONIC) {
    fprintf(stderr, "pthread-canary: pthread_condattr_getclock failed\n");
    return 1;
  }
  if (pthread_key_create(&tls_key, NULL) != 0) {
    fprintf(stderr, "pthread-canary: pthread_key_create failed\n");
    return 1;
  }
  if (pthread_setspecific(tls_key, (void *)999) != 0) {
    fprintf(stderr, "pthread-canary: main pthread_setspecific failed\n");
    return 1;
  }
  pthread_t tids[NUM_THREADS];
  for (long i = 0; i < NUM_THREADS; i++) {
    int rc = pthread_create(&tids[i], NULL, worker, (void *)i);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: pthread_create #%ld returned %d\n", i, rc);
      return 2;
    }
  }
  for (int i = 0; i < NUM_THREADS; i++) {
    void *retval = NULL;
    int rc = pthread_join(tids[i], &retval);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: pthread_join #%d returned %d\n", i, rc);
      return 3;
    }
    if (retval != NULL) {
      fprintf(stderr, "pthread-canary: thread #%d returned non-null %p\n", i, retval);
      return 4;
    }
  }
  if (shared_counter != EXPECTED) {
    fprintf(stderr, "pthread-canary: counter race: got %d, expected %d\n", shared_counter, EXPECTED);
    return 5;
  }
  if (pipe(exit_poll_pipe) != 0) {
    fprintf(stderr, "pthread-canary: exit poll pipe failed\n");
    return 1;
  }
  pthread_attr_t exit_attr;
  if (pthread_attr_init(&exit_attr) != 0 ||
      pthread_attr_setdetachstate(&exit_attr, PTHREAD_CREATE_DETACHED) != 0) {
    fprintf(stderr, "pthread-canary: exit attr setup failed\n");
    return 1;
  }
  pthread_t exit_tid;
  int exit_rc = pthread_create(&exit_tid, &exit_attr, exit_poll_blocker, NULL);
  pthread_attr_destroy(&exit_attr);
  if (exit_rc != 0) {
    fprintf(stderr, "pthread-canary: exit pthread_create returned %d\n", exit_rc);
    return 1;
  }
  printf("pthread:ok\n");
  return 0;
}
