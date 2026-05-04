/* setjmp/longjmp conformance canary.
 *
 * Exercises POSIX setjmp/longjmp behavior through yurt's
 * Asyncify-based implementation:
 *
 *   - smoke / direct       : setjmp returns 0; longjmp(env, 42)
 *                            unwinds back so setjmp returns 42.
 *   - longjmp_zero         : longjmp(env, 0) is promoted to 1
 *                            (POSIX requirement).
 *   - longjmp_through_calls: longjmp from N frames deep correctly
 *                            unwinds the intermediate frames.
 *   - longjmp_negative     : longjmp(env, -7) returns -7 from
 *                            setjmp; the value is preserved as-is.
 *
 * Output is JSONL — one line per case — for easy harness parsing. */

#include <setjmp.h>
#include <stdio.h>
#include <string.h>

static void emit(const char *case_name, int exit_code, int observed) {
    printf("{\"case\":\"%s\",\"exit\":%d,\"observed\":%d}\n",
           case_name, exit_code, observed);
}

static int case_smoke(void) {
    jmp_buf env;
    int rc = setjmp(env);
    if (rc == 0) {
        longjmp(env, 42);
    }
    /* On the rewound return setjmp should produce 42. */
    emit("smoke", rc == 42 ? 0 : 1, rc);
    return rc == 42 ? 0 : 1;
}

static int case_longjmp_zero(void) {
    jmp_buf env;
    int rc = setjmp(env);
    if (rc == 0) {
        /* POSIX: longjmp(env, 0) must cause setjmp to return 1. */
        longjmp(env, 0);
    }
    emit("longjmp_zero", rc == 1 ? 0 : 1, rc);
    return rc == 1 ? 0 : 1;
}

/* Forward chain so longjmp fires from a few frames deep. */
static jmp_buf g_env;

static void leaf(int v) {
    longjmp(g_env, v);
}

static void middle(int v) {
    leaf(v);
    /* Unreachable; if we ever see this in the trace something
     * unwound the wrong distance. */
    fprintf(stderr, "middle: returned from longjmp call\n");
}

static int case_longjmp_through_calls(void) {
    int rc = setjmp(g_env);
    if (rc == 0) {
        middle(7);
    }
    emit("longjmp_through_calls", rc == 7 ? 0 : 1, rc);
    return rc == 7 ? 0 : 1;
}

static int case_longjmp_negative(void) {
    jmp_buf env;
    int rc = setjmp(env);
    if (rc == 0) {
        longjmp(env, -7);
    }
    emit("longjmp_negative", rc == -7 ? 0 : 1, rc);
    return rc == -7 ? 0 : 1;
}

static int case_setjmp_returns_zero(void) {
    /* The minimal "does setjmp run at all" test — exercises the
     * Phase 1 stub independently of any longjmp work. */
    jmp_buf env;
    int rc = setjmp(env);
    emit("setjmp_returns_zero", rc == 0 ? 0 : 1, rc);
    return rc == 0 ? 0 : 1;
}

static int run_case(const char *name) {
    if (strcmp(name, "smoke") == 0) return case_smoke();
    if (strcmp(name, "setjmp_returns_zero") == 0) return case_setjmp_returns_zero();
    if (strcmp(name, "longjmp_zero") == 0) return case_longjmp_zero();
    if (strcmp(name, "longjmp_through_calls") == 0) return case_longjmp_through_calls();
    if (strcmp(name, "longjmp_negative") == 0) return case_longjmp_negative();
    fprintf(stderr, "setjmp-canary: unknown case %s\n", name);
    return 2;
}

static int list_cases(void) {
    puts("smoke");
    puts("setjmp_returns_zero");
    puts("longjmp_zero");
    puts("longjmp_through_calls");
    puts("longjmp_negative");
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 1) {
        /* Smoke mode — same as --case smoke for the simple harness. */
        return case_smoke();
    }
    if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) {
        return list_cases();
    }
    if (argc == 3 && strcmp(argv[1], "--case") == 0) {
        return run_case(argv[2]);
    }
    fprintf(stderr, "usage: setjmp-canary [--case <name> | --list-cases]\n");
    return 2;
}
