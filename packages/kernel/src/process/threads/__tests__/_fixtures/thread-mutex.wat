(module
  (import "env" "memory" (memory 1 1 shared))
  (import "yurt" "host_mutex_lock" (func $host_mutex_lock (param i32) (result i32)))
  (import "yurt" "host_mutex_unlock" (func $host_mutex_unlock (param i32) (result i32)))
  (func $worker_entry (param $mutex i32) (result i32)
    local.get $mutex
    call $host_mutex_lock
    drop
    local.get $mutex
    i32.load
    local.get $mutex
    call $host_mutex_unlock
    drop)
  (table (export "__indirect_function_table") 1 funcref)
  (elem (i32.const 0) $worker_entry))
