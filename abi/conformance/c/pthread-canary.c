#include <pthread.h>
#include <errno.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <unistd.h>

#define NUM_THREADS 1
#define ITERS_PER_THREAD 10000
#define EXPECTED (NUM_THREADS * ITERS_PER_THREAD)

static int shared_counter = 0;
static pthread_mutex_t shared_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_key_t tls_key;
static int exit_poll_pipe[2] = { -1, -1 };
static pthread_t observed_thread_self;

static void *exit_poll_blocker(void *arg) {
  (void)arg;
  struct pollfd pfd = { .fd = exit_poll_pipe[0], .events = POLLIN, .revents = 0 };
  for (;;) {
    poll(&pfd, 1, -1);
  }
  return NULL;
}

static void *return_arg_worker(void *arg) {
  return arg;
}

static void *record_self_worker(void *arg) {
  (void)arg;
  observed_thread_self = pthread_self();
  return NULL;
}

static void *pthread_exit_worker(void *arg) {
  pthread_exit(arg);
  return (void *)1;
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

static int check_posix_thread_identity(void) {
  pthread_t main_tid = pthread_self();
  pthread_t created_tid;

  if (pthread_create(&created_tid, NULL, record_self_worker, NULL) != 0) {
    fprintf(stderr, "pthread-canary: identity pthread_create failed\n");
    return 1;
  }
  if (pthread_join(created_tid, NULL) != 0) {
    fprintf(stderr, "pthread-canary: identity pthread_join failed\n");
    return 1;
  }
  if (pthread_equal(created_tid, observed_thread_self) == 0) {
    fprintf(stderr, "pthread-canary: created pthread_t did not match child pthread_self\n");
    return 1;
  }
  if (pthread_equal(created_tid, main_tid) != 0) {
    fprintf(stderr, "pthread-canary: child pthread_t matched main pthread_self\n");
    return 1;
  }
  if (pthread_equal(main_tid, pthread_self()) == 0) {
    fprintf(stderr, "pthread-canary: pthread_self not stable in main thread\n");
    return 1;
  }

  pthread_t first_tid;
  pthread_t second_tid;
  if (pthread_create(&first_tid, NULL, return_arg_worker, NULL) != 0 ||
      pthread_create(&second_tid, NULL, return_arg_worker, NULL) != 0) {
    fprintf(stderr, "pthread-canary: distinct-id pthread_create failed\n");
    return 1;
  }
  if (pthread_equal(first_tid, second_tid) != 0) {
    fprintf(stderr, "pthread-canary: two live threads reported equal pthread_t values\n");
    return 1;
  }
  if (pthread_join(first_tid, NULL) != 0 || pthread_join(second_tid, NULL) != 0) {
    fprintf(stderr, "pthread-canary: distinct-id pthread_join failed\n");
    return 1;
  }

  pthread_t default_attr_tid;
  void *default_attr_value = NULL;
  if (pthread_create(&default_attr_tid, NULL, return_arg_worker, (void *)123) != 0) {
    fprintf(stderr, "pthread-canary: default-attr pthread_create failed\n");
    return 1;
  }
  if (pthread_join(default_attr_tid, &default_attr_value) != 0 || default_attr_value != (void *)123) {
    fprintf(stderr, "pthread-canary: NULL attr thread was not joinable by default\n");
    return 1;
  }

  return 0;
}

int main(void) {
  if (check_posix_thread_identity() != 0) {
    return 1;
  }

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

  pthread_t exit_value_tid;
  void *exit_value = NULL;
  int exit_value_rc = pthread_create(&exit_value_tid, NULL, pthread_exit_worker, (void *)42);
  if (exit_value_rc != 0) {
    fprintf(stderr, "pthread-canary: pthread_exit pthread_create returned %d\n", exit_value_rc);
    return 1;
  }
  exit_value_rc = pthread_join(exit_value_tid, &exit_value);
  if (exit_value_rc != 0 || exit_value != (void *)42) {
    fprintf(stderr, "pthread-canary: pthread_exit join returned rc=%d value=%p\n", exit_value_rc, exit_value);
    return 1;
  }

  for (long i = 0; i < 4; i++) {
    pthread_t cycle_tid;
    void *cycle_value = NULL;
    int cycle_rc = pthread_create(&cycle_tid, NULL, return_arg_worker, (void *)(i + 10));
    if (cycle_rc != 0) {
      fprintf(stderr, "pthread-canary: lifecycle pthread_create #%ld returned %d\n", i, cycle_rc);
      return 1;
    }
    cycle_rc = pthread_join(cycle_tid, &cycle_value);
    if (cycle_rc != 0 || cycle_value != (void *)(i + 10)) {
      fprintf(stderr, "pthread-canary: lifecycle join #%ld rc=%d value=%p\n", i, cycle_rc, cycle_value);
      return 1;
    }
  }

  if (pipe(exit_poll_pipe) != 0) {
    fprintf(stderr, "pthread-canary: exit poll pipe failed\n");
    return 1;
  }
  pthread_attr_t exit_attr;
  int detach_state = PTHREAD_CREATE_JOINABLE;
  if (pthread_attr_init(&exit_attr) != 0 ||
      pthread_attr_setdetachstate(&exit_attr, PTHREAD_CREATE_DETACHED) != 0 ||
      pthread_attr_getdetachstate(&exit_attr, &detach_state) != 0 ||
      detach_state != PTHREAD_CREATE_DETACHED) {
    fprintf(stderr, "pthread-canary: exit attr setup failed\n");
    return 1;
  }
  pthread_t detached_return_tid;
  int detached_return_rc = pthread_create(&detached_return_tid, &exit_attr, return_arg_worker, (void *)7);
  if (detached_return_rc != 0) {
    fprintf(stderr, "pthread-canary: detached-return pthread_create returned %d\n", detached_return_rc);
    return 1;
  }
  void *detached_return_value = NULL;
  detached_return_rc = pthread_join(detached_return_tid, &detached_return_value);
  if (detached_return_rc != EINVAL) {
    fprintf(stderr, "pthread-canary: detached pthread_join returned %d, expected EINVAL=%d\n", detached_return_rc, EINVAL);
    return 1;
  }
  detached_return_rc = pthread_detach(detached_return_tid);
  if (detached_return_rc != EINVAL) {
    fprintf(stderr, "pthread-canary: detached pthread_detach returned %d, expected EINVAL=%d\n", detached_return_rc, EINVAL);
    return 1;
  }
  sched_yield();
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
