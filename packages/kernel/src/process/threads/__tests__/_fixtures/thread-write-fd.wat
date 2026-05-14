(module
  (import "env" "memory" (memory 1 1 shared))
  (import "yurt" "host_write_fd" (func $host_write_fd (param i32 i32 i32) (result i32)))
  (data (i32.const 256) "hello")
  (func $worker_entry (param $data i32) (result i32)
    i32.const 1
    local.get $data
    i32.const 5
    call $host_write_fd)
  (table (export "__indirect_function_table") 1 funcref)
  (elem (i32.const 0) $worker_entry))
