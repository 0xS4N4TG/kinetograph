//! The uniform blocks of a frame's passes, packed into a few large buffers.
//!
//! A pass's uniforms are a few dozen bytes. Giving each its own buffer cost
//! a call into the kernel to allocate it, a seventh of a frame's CPU time on
//! a busy scene. Here they go one after another into buffers of
//! `CHUNK` bytes, kept from frame to frame, and are written to the GPU
//! (`upload`) before the passes that read them are submitted.

use std::num::NonZeroU64;


/// Bytes in each buffer.
const CHUNK: u64 = 1 << 18;

/// Where one block is: bind it with `binding`.
pub struct Block {
    buffer: wgpu::Buffer,
    offset: u64,
    size: NonZeroU64,
}

impl Block {
    pub fn binding(&self) -> wgpu::BindingResource<'_> {
        wgpu::BindingResource::Buffer(wgpu::BufferBinding {
            buffer: &self.buffer,
            offset: self.offset,
            size: Some(self.size),
        })
    }
}

pub struct Uniforms {
    device: wgpu::Device,
    queue: wgpu::Queue,
    chunks: Vec<wgpu::Buffer>,
    /// The buffer being filled, and the end of its last block.
    current: usize,
    end: u64,
    /// The bytes of the current buffer from `written` on, not yet uploaded.
    staged: Vec<u8>,
    written: u64,
    /// Where a block may start: the device's uniform offset alignment.
    align: u64,
}

impl Uniforms {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Uniforms {
        Uniforms {
            device: device.clone(),
            queue: queue.clone(),
            chunks: Vec::new(),
            current: 0,
            end: 0,
            staged: Vec::new(),
            written: 0,
            align: u64::from(device.limits().min_uniform_buffer_offset_alignment),
        }
    }

    /// A block holding `bytes` (a whole uniform block of a shader, which is
    /// a multiple of 16 bytes).
    pub fn push(&mut self, bytes: &[u8]) -> Block {
        let len = bytes.len() as u64;
        assert!(len > 0 && len <= CHUNK, "a uniform block of {len} bytes");
        let mut at = self.end.next_multiple_of(self.align);
        if self.chunks.is_empty() || at + len > CHUNK {
            if !self.chunks.is_empty() {
                self.upload();
                self.current += 1;
            }
            if self.current == self.chunks.len() {
                self.chunks
                    .push(self.device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("uniforms"),
                        size: CHUNK,
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    }));
            }
            self.written = 0;
            at = 0;
        }
        self.staged.resize((at - self.written) as usize, 0);
        self.staged.extend_from_slice(bytes);
        self.end = at + len;
        Block {
            buffer: self.chunks[self.current].clone(),
            offset: at,
            size: NonZeroU64::new(len).expect("checked above"),
        }
    }

    /// Writes the blocks pushed since the last upload. The write lands
    /// before the next submit, after everything submitted before it.
    pub fn upload(&mut self) {
        if self.staged.is_empty() {
            return;
        }
        self.queue
            .write_buffer(&self.chunks[self.current], self.written, &self.staged);
        self.written += self.staged.len() as u64;
        self.staged.clear();
    }

    /// Starts filling the buffers from the beginning again (once a frame,
    /// after its blocks are uploaded). A frame still on the GPU keeps what
    /// it read: the writes of the next come after its submits.
    pub fn rewind(&mut self) {
        debug_assert!(self.staged.is_empty(), "blocks not uploaded");
        self.current = 0;
        self.end = 0;
        self.written = 0;
    }
}
