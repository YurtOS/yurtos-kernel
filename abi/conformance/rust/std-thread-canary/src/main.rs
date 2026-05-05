use std::num::NonZeroUsize;

fn main() {
    let n: NonZeroUsize = std::thread::available_parallelism().unwrap();
    let handle = std::thread::spawn(|| 40 + 2);
    let value = handle.join().expect("thread panicked");
    let values = [1, 2, 3];
    let scoped = std::thread::scope(|scope| {
        scope
            .spawn(|| values.iter().sum::<i32>())
            .join()
            .expect("scoped thread panicked")
    });
    println!("parallelism={} joined={} scoped={}", n.get(), value, scoped);
}
