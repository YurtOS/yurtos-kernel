(module
  (import "env" "memory" (memory 1 1 shared))
  (import "yurt" "host_thread_self" (func $host_thread_self (result i32)))
  (func $worker_entry (param i32) (result i32)
    call $host_thread_self)
  (table (export "__indirect_function_table") 1 funcref)
  (elem (i32.const 0) $worker_entry))
