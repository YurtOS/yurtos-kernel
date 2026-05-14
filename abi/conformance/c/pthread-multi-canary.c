// pthread-multi-canary: covers the condvar broadcast path through the
// Worker/SAB threads backend. Four workers block on a shared condvar;
// main flips `ready` under the lock and broadcasts. Each worker
// returns its own arg, which main verifies on join. This exercises
// the multi-waiter wake fan-out in `SabCondvar.broadcast` (Task 3)
// plus the per-thread mutex/condvar views (Task 7).
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define N 4

static int ready = 0;
static pthread_mutex_t lk = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;

static void *waiter(void *arg) {
  pthread_mutex_lock(&lk);
  while (!ready) {
    pthread_cond_wait(&cv, &lk);
  }
  pthread_mutex_unlock(&lk);
  return arg;
}

int main(void) {
  pthread_t t[N];
  for (int i = 0; i < N; i++) {
    if (pthread_create(&t[i], NULL, waiter, (void *)(long)(i + 1)) != 0) {
      fprintf(stderr, "pthread_create failed\n");
      return 1;
    }
  }

  // Flip `ready` and broadcast under the lock. Even if a waiter raced
  // past `while (!ready)` before pthread_cond_wait latched, the
  // mutex-protected predicate keeps the wait/wake handshake correct.
  pthread_mutex_lock(&lk);
  ready = 1;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&lk);

  for (int i = 0; i < N; i++) {
    void *r;
    if (pthread_join(t[i], &r) != 0) {
      fprintf(stderr, "pthread_join failed\n");
      return 1;
    }
    long expected = i + 1;
    if ((long)r != expected) {
      fprintf(stderr, "mismatch: %d expected %ld got %ld\n", i, expected, (long)r);
      return 1;
    }
  }
  printf("OK\n");
  return 0;
}
