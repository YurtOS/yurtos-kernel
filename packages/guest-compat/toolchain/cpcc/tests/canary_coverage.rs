use cpcc_toolchain::conform::canary_symbol_map;
use cpcc_toolchain::TIER1;

#[test]
fn every_tier1_symbol_is_covered_by_some_canary() {
    let mut covered: std::collections::HashSet<&str> = Default::default();
    for (_canary, symbols) in canary_symbol_map() {
        for s in *symbols {
            covered.insert(*s);
        }
    }
    let missing: Vec<&&str> = TIER1.iter().filter(|s| !covered.contains(*s)).collect();
    assert!(missing.is_empty(), "Tier 1 symbols not covered by any canary: {missing:?}");
}
