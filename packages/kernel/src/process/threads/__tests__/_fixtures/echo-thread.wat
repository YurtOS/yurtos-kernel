(module
  (import "env" "memory" (memory 1 1 shared))
  (table (export "__indirect_function_table") 1 funcref)
  (func $worker_entry (param $arg i32) (result i32)
    local.get $arg
    i32.const 1
    i32.add)
  (elem (i32.const 0) $worker_entry))
