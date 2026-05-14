(module
  (import "env" "memory" (memory 1 1 shared))
  (import "yurt" "host_mutex_lock" (func $host_mutex_lock (param i32) (result i32)))
  (import "yurt" "host_mutex_unlock" (func $host_mutex_unlock (param i32) (result i32)))
  (import "yurt" "host_cond_wait" (func $host_cond_wait (param i32 i32) (result i32)))
  (func $worker_entry (param $base i32) (result i32)
    (local $mutex i32)
    (local $cond i32)
    (local $ready i32)
    (local $owner i32)
    local.get $base
    local.set $mutex
    local.get $base
    i32.const 4
    i32.add
    local.set $cond
    local.get $base
    i32.const 8
    i32.add
    local.set $ready

    local.get $mutex
    call $host_mutex_lock
    drop

    local.get $ready
    i32.const 1
    i32.store
    local.get $ready
    i32.const 1
    memory.atomic.notify
    drop

    local.get $cond
    local.get $mutex
    call $host_cond_wait
    drop

    local.get $mutex
    i32.load
    local.set $owner
    local.get $mutex
    call $host_mutex_unlock
    drop
    local.get $owner)
  (table (export "__indirect_function_table") 1 funcref)
  (elem (i32.const 0) $worker_entry))
