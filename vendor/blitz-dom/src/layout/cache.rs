//! The layout cache of a node: taffy's `Cache` (taffy 0.15.1, `src/tree/cache.rs`, MIT, Dioxus Labs / Taffy
//! contributors) with one change: a measurement keeps the baselines of the output it stored, as well as its size.
//!
//! taffy's measure entries keep only the size, and a hit is `LayoutOutput::from_outer_size`, so a measurement the
//! cache answers has no baselines where the same measurement made afresh has them (a block's first baseline comes from
//! its children's) or has none (taffy's flex and grid measure give none). A document edited from another has boxes
//! cached and a document built from the same request has not: the lines round its inline-blocks then differed.
//! Returning what the measurement stored makes a hit the same answer as the run it replaces.

use taffy::{
    AvailableSpace, Baselines, CollapsibleMarginSet, LayoutInput, LayoutOutput, Line, RequestedAxis, RunMode, Size,
    SizingMode,
};

/// The number of cache entries for each node in the tree
const CACHE_SIZE: usize = 9;

const INFINITY_BITS: u32 = 0b_0_11111111_00000000000000000000000_u32;
const NEG_INFINITY_BITS: u32 = 0b_1_11111111_00000000000000000000000_u32;

const SIGN_BIT_1: u64 = 1u64 << 63;
const SIGN_BIT_2: u64 = 1u64 << 31;
const BOTH_SIGN_BITS_MASK: u64 = SIGN_BIT_1 | SIGN_BIT_2;
const NON_SIGN_BITS_MASK: u64 = !BOTH_SIGN_BITS_MASK;
const X_AXIS_VALUE_MASK: u64 = (u32::MAX as u64) << 32;

#[inline(always)]
fn option_cache_key(input: Option<f32>) -> u32 {
    match input {
        Some(value) => value.to_bits(),
        None => INFINITY_BITS,
    }
}

#[inline(always)]
fn size_option_cache_key(input: Size<Option<f32>>) -> u64 {
    (option_cache_key(input.width) as u64) << 32 | option_cache_key(input.height) as u64
}

#[inline(always)]
fn available_space_cache_key(input: AvailableSpace) -> u32 {
    match input {
        AvailableSpace::Definite(value) => (-value).to_bits(),
        AvailableSpace::MinContent => NEG_INFINITY_BITS,
        AvailableSpace::MaxContent => INFINITY_BITS,
    }
}

#[inline(always)]
fn mixed_cache_key(kd: Option<f32>, avs: AvailableSpace) -> u32 {
    kd.map(|kd| kd.to_bits()).unwrap_or_else(|| available_space_cache_key(avs))
}

#[inline(always)]
fn size_mixed_cache_key(kd: Size<Option<f32>>, avs: Size<AvailableSpace>) -> u64 {
    (mixed_cache_key(kd.width, avs.width) as u64) << 32 | mixed_cache_key(kd.height, avs.height) as u64
}

/// Space-optimised cache key that packs bits into as small a size as possible
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CacheKey {
    kd_available_space: u64,
    parent_size: u64,
    known_dimensions_are_definite: Size<bool>,
}

impl CacheKey {
    fn x_axis_parent_size(&self) -> u64 {
        self.parent_size & (X_AXIS_VALUE_MASK & NON_SIGN_BITS_MASK)
    }

    fn requested_axis_bits(&self) -> u64 {
        self.parent_size & BOTH_SIGN_BITS_MASK
    }

    /// Whether a cached entry with this key contains a valid size for the axis requested by `other`.
    fn size_is_valid_for(&self, other: &CacheKey) -> bool {
        let entry_axis = self.requested_axis_bits();
        entry_axis == BOTH_SIGN_BITS_MASK || entry_axis == other.requested_axis_bits()
    }
}

impl From<&LayoutInput> for CacheKey {
    fn from(input: &LayoutInput) -> Self {
        let extra_bits = match input.axis {
            RequestedAxis::Horizontal => SIGN_BIT_1,
            RequestedAxis::Vertical => SIGN_BIT_2,
            RequestedAxis::Both => SIGN_BIT_1 | SIGN_BIT_2,
        };

        Self {
            kd_available_space: size_mixed_cache_key(input.known_dimensions, input.available_space),
            parent_size: (size_option_cache_key(input.parent_size) & NON_SIGN_BITS_MASK) | extra_bits,
            known_dimensions_are_definite: input
                .known_dimensions_are_definite
                .zip_map(input.known_dimensions, |is_definite, kd| is_definite || kd.is_none()),
        }
    }
}

/// The layout inputs that affect a node's layout but are not part of the [`CacheKey`]: the sizing mode and whether
/// each of the node's vertical margins is collapsible, packed into a `u8`. A cache records the single mode that all of
/// its entries were computed with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CacheMode(u8);

impl CacheMode {
    const INHERENT_SIZE_BIT: u8 = 0b001;
    const COLLAPSIBLE_START_MARGIN_BIT: u8 = 0b010;
    const COLLAPSIBLE_END_MARGIN_BIT: u8 = 0b100;

    const INITIAL: Self = Self(0);
}

impl From<&LayoutInput> for CacheMode {
    #[inline(always)]
    fn from(input: &LayoutInput) -> Self {
        let inherent_size = matches!(input.sizing_mode, SizingMode::InherentSize) as u8;
        let collapsible: Line<bool> = input.vertical_margins_are_collapsible;
        Self(
            (inherent_size * Self::INHERENT_SIZE_BIT)
                | (collapsible.start as u8 * Self::COLLAPSIBLE_START_MARGIN_BIT)
                | (collapsible.end as u8 * Self::COLLAPSIBLE_END_MARGIN_BIT),
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CacheEntry<T> {
    key: CacheKey,
    content: T,
}

/// What a measurement keeps: the size, and the baselines the measurement reported.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Measure {
    size: Size<f32>,
    baselines: Baselines,
}

/// A cache for the results of sizing a node as a block, flex or grid item.
#[derive(Debug, Clone, PartialEq)]
pub struct Cache {
    /// The cache entry for the node's final layout
    final_layout_entry: Option<CacheEntry<LayoutOutput>>,
    /// The cache entries for the node's preliminary size measurements
    measure_entries: [Option<CacheEntry<Measure>>; CACHE_SIZE],
    /// Tracks which measure entries have been used since the eviction cursor last passed them
    recently_used_entries: u16,
    /// The next measure entry to consider replacing
    next_measure_entry: u8,
    /// Tracks if all cache entries are empty
    is_empty: bool,
    mode: CacheMode,
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

impl Cache {
    /// Create a new empty cache
    pub const fn new() -> Self {
        const NONE_MEASURE_ENTRY: Option<CacheEntry<Measure>> = None;
        Self {
            final_layout_entry: None,
            measure_entries: [NONE_MEASURE_ENTRY; CACHE_SIZE],
            recently_used_entries: 0,
            next_measure_entry: 0,
            is_empty: true,
            mode: CacheMode::INITIAL,
        }
    }

    /// Try to retrieve a cached result from the cache
    #[inline]
    pub fn get(&mut self, input: &LayoutInput) -> Option<LayoutOutput> {
        if self.mode != CacheMode::from(input) {
            return None;
        }
        let key = CacheKey::from(input);
        match input.run_mode {
            RunMode::PerformLayout => {
                self.final_layout_entry.as_ref().filter(|entry| entry.key == key).map(|e| e.content.clone())
            }
            RunMode::ComputeSize => {
                for (index, entry) in self.measure_entries.iter().enumerate() {
                    let Some(entry) = entry else { continue };
                    if entry.key.kd_available_space == key.kd_available_space
                        && entry.key.known_dimensions_are_definite == key.known_dimensions_are_definite
                        && (entry.key.x_axis_parent_size() == key.x_axis_parent_size())
                        && entry.key.size_is_valid_for(&key)
                    {
                        self.recently_used_entries |= 1 << index;
                        let mut output = LayoutOutput::from_outer_size(entry.content.size);
                        output.baselines = entry.content.baselines;
                        return Some(output);
                    }
                }

                None
            }
            RunMode::PerformHiddenLayout => None,
        }
    }

    /// Store a computed size in the cache
    pub fn store(&mut self, input: &LayoutInput, layout_output: LayoutOutput) {
        if input.run_mode == RunMode::PerformHiddenLayout {
            return;
        }
        let mode = CacheMode::from(input);
        if self.mode != mode {
            self.clear();
            self.mode = mode;
        }
        let key = CacheKey::from(input);
        match input.run_mode {
            RunMode::PerformLayout => {
                self.is_empty = false;
                self.final_layout_entry = Some(CacheEntry { key, content: layout_output })
            }
            RunMode::ComputeSize => {
                // Hits are rebuilt from the size and baselines, which resets the margin-collapse metadata:
                // results that carry any cannot be reconstructed, so they are not cached.
                if layout_output.margins_can_collapse_through
                    || layout_output.top_margin != CollapsibleMarginSet::ZERO
                    || layout_output.bottom_margin != CollapsibleMarginSet::ZERO
                {
                    return;
                }
                let content = Measure { size: layout_output.size, baselines: layout_output.baselines };
                self.is_empty = false;
                if let Some(index) =
                    self.measure_entries.iter().position(|entry| entry.as_ref().is_some_and(|entry| entry.key == key))
                {
                    self.measure_entries[index].as_mut().unwrap().content = content;
                    self.recently_used_entries |= 1 << index;
                    return;
                }
                while self.recently_used_entries & (1 << self.next_measure_entry) != 0 {
                    self.recently_used_entries &= !(1 << self.next_measure_entry);
                    self.next_measure_entry += 1;
                    if self.next_measure_entry == CACHE_SIZE as u8 {
                        self.next_measure_entry = 0;
                    }
                }
                let entry_index = self.next_measure_entry as usize;
                self.measure_entries[entry_index] = Some(CacheEntry { key, content });
                self.recently_used_entries |= 1 << entry_index;
                self.next_measure_entry += 1;
                if self.next_measure_entry == CACHE_SIZE as u8 {
                    self.next_measure_entry = 0;
                }
            }
            RunMode::PerformHiddenLayout => {}
        }
    }

    /// Clear all cache entries
    pub fn clear(&mut self) {
        if self.is_empty {
            return;
        }
        self.is_empty = true;
        self.final_layout_entry = None;
        const NONE_MEASURE_ENTRY: Option<CacheEntry<Measure>> = None;
        self.measure_entries = [NONE_MEASURE_ENTRY; CACHE_SIZE];
        self.recently_used_entries = 0;
        self.next_measure_entry = 0;
    }

    /// Returns true if all cache entries are None, else false
    pub fn is_empty(&self) -> bool {
        self.final_layout_entry.is_none() && !self.measure_entries.iter().any(|entry| entry.is_some())
    }
}
