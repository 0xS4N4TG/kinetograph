//! GPU time of each render pass, for `bench --passes`.
//!
//! Each pass that asks (`stamp`) gets two timestamp queries, written by the
//! GPU when the pass starts and when it ends, and is recorded under a name
//! (its pipeline's, `"clear"`, a blur step) with the size of the texture it
//! draws into. `take` reads the queries back after the frame. Only whole
//! passes can be timed on Apple GPUs (`TIMESTAMP_QUERY` without the
//! `_INSIDE_` features), so copies between textures and Skia's work
//! are not in it.
//!
//! The timer never changes what is drawn: a pass with timestamps does the
//! same work. It is off unless `Renderer::set_pass_timing` turns it on.

use std::sync::Mutex;


/// Queries per query set, the most wgpu allows: 2,048 passes. A frame with
/// more passes gets another set.
const SET_QUERIES: u32 = wgpu::QUERY_SET_MAX_QUERIES;

/// One timed pass of a frame.
#[derive(Clone, Debug)]
pub struct PassTime {
    pub name: &'static str,
    /// From the pass's start to its end on the GPU.
    pub ms: f64,
    /// The pass's start, in ms on the GPU's clock .
    pub begin_ms: f64,
    /// Width times height of the texture the pass draws into.
    pub texels: u64,
}

pub struct PassTimer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    sets: Mutex<Vec<wgpu::QuerySet>>,
    /// The name and target size of each pass stamped since the last `take`.
    passes: Mutex<Vec<(&'static str, u64)>>,
}

impl PassTimer {
    /// `None` when the device was made without `TIMESTAMP_QUERY`.
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<PassTimer> {
        device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY)
            .then(|| PassTimer {
                device: device.clone(),
                queue: queue.clone(),
                sets: Mutex::new(Vec::new()),
                passes: Mutex::new(Vec::new()),
            })
    }

    /// The query set and first index for a pass called `name` drawing into
    /// `target`. Pass the result to `writes` for the pass descriptor.
    pub fn stamp(&self, name: &'static str, target: &wgpu::TextureView) -> Stamp {
        let size = target.texture().size();
        let mut passes = self.passes.lock().expect("pass timer");
        let index = passes.len() as u32 * 2;
        passes.push((name, size.width as u64 * size.height as u64));
        let (set, at) = (index / SET_QUERIES, index % SET_QUERIES);
        let mut sets = self.sets.lock().expect("pass timer");
        if sets.len() <= set as usize {
            sets.push(self.device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("pass timer"),
                ty: wgpu::QueryType::Timestamp,
                count: SET_QUERIES,
            }));
        }
        Stamp {
            set: sets[set as usize].clone(),
            at,
        }
    }

    /// The times of the passes stamped since the last call, in the order
    /// they were recorded. Waits for the GPU; everything stamped must have
    /// been submitted.
    pub fn take(&self) -> Vec<PassTime> {
        let passes = std::mem::take(&mut *self.passes.lock().expect("pass timer"));
        if passes.is_empty() {
            return Vec::new();
        }
        let queries = passes.len() as u32 * 2;
        let bytes = queries as u64 * 8;
        let resolve = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pass timer resolve"),
            size: bytes,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let read = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pass timer read"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        for (i, set) in self.sets.lock().expect("pass timer").iter().enumerate() {
            let first = i as u32 * SET_QUERIES;
            if first >= queries {
                break;
            }
            let count = (queries - first).min(SET_QUERIES);
            encoder.resolve_query_set(set, 0..count, &resolve, first as u64 * 8);
        }
        encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, bytes);
        self.queue.submit([encoder.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| ());
        // A lost device leaves the buffer unmapped: no times.
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let Ok(mapped) = read.slice(..).get_mapped_range() else {
            return Vec::new();
        };
        let ticks: Vec<u64> = mapped
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| u64::from_le_bytes(*b))
            .collect();
        let ns_per_tick = self.queue.get_timestamp_period() as f64;
        passes
            .into_iter()
            .enumerate()
            .map(|(i, (name, texels))| PassTime {
                name,
                ms: ticks[2 * i + 1].saturating_sub(ticks[2 * i]) as f64 * ns_per_tick / 1e6,
                begin_ms: ticks[2 * i] as f64 * ns_per_tick / 1e6,
                texels,
            })
            .collect()
    }
}

/// Where a pass writes its two timestamps.
pub struct Stamp {
    set: wgpu::QuerySet,
    at: u32,
}

/// The pass descriptor's `timestamp_writes` for an optional stamp.
pub fn writes(stamp: &Option<Stamp>) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
    stamp.as_ref().map(|s| wgpu::RenderPassTimestampWrites {
        query_set: &s.set,
        beginning_of_pass_write_index: Some(s.at),
        end_of_pass_write_index: Some(s.at + 1),
    })
}
