(module
  (import "env" "memory" (memory 1 1 shared))
  (type $entry_type (func (param i32) (result i32)))
  (func $worker_entry (type $entry_type)
    local.get 0
    i32.const 1
    i32.add)
  (table (export "__indirect_function_table") 1 funcref)
  (elem (i32.const 0) $worker_entry)
  (func (export "worker_entry") (param i32) (result i32)
    local.get 0
    i32.const 1
    i32.add))
