use gpudeck_lib::storage::Database;
use std::path::PathBuf;

fn main() {
    let path = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        eprintln!("usage: migrate_storage <gpudeck.sqlite>");
        std::process::exit(2);
    });
    if let Err(error) = Database::open(&path) {
        eprintln!("GPUDeck history migration failed: {error}");
        std::process::exit(1);
    }
    println!("GPUDeck history migration completed: {}", path.display());
}
