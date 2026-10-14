//! Textures kept for reuse, by size.
//!
//! The compositor's textures come in a few sizes (`bounds::size_class`), so a
//! released texture is usually the right one for the next pass that wants
//! that size. The pool keeps what was released and hands back the one that
//! was released last, and when it holds more than its byte limit it lets go
//! of what was released first, so that a scene whose layers change size from
//! frame to frame does not grow it without end.

/// What the pool needs to know of a texture.
pub trait Pooled {
    /// Width and height in texels.
    fn dims(&self) -> [u32; 2];

    /// Bytes of memory it holds.
    fn bytes(&self) -> u64;
}

pub struct Pool<T: Pooled> {
    /// In the order they were released.
    items: Vec<T>,
    bytes: u64,
    limit: u64,
}

impl<T: Pooled> Pool<T> {
    /// A pool that keeps up to `limit` bytes.
    pub fn new(limit: u64) -> Pool<T> {
        Pool {
            items: Vec::new(),
            bytes: 0,
            limit,
        }
    }

    /// The texture of exactly `dims` that was released last, if any.
    pub fn take(&mut self, dims: [u32; 2]) -> Option<T> {
        let i = self.items.iter().rposition(|t| t.dims() == dims)?;
        let item = self.items.remove(i);
        self.bytes -= item.bytes();
        Some(item)
    }

    /// Keeps `item` for reuse. If that takes the pool over its limit, the
    /// textures released longest ago are dropped until it fits, `item`
    /// itself last.
    pub fn put(&mut self, item: T) {
        self.bytes += item.bytes();
        self.items.push(item);
        while self.bytes > self.limit && !self.items.is_empty() {
            let oldest = self.items.remove(0);
            self.bytes -= oldest.bytes();
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    struct Fake(u32, u32, u32);

    impl Pooled for Fake {
        fn dims(&self) -> [u32; 2] {
            [self.0, self.1]
        }
        fn bytes(&self) -> u64 {
            u64::from(self.0) * u64::from(self.1)
        }
    }

    #[test]
    fn a_texture_comes_back_only_for_its_own_size() {
        let mut pool = Pool::new(1 << 20);
        pool.put(Fake(64, 64, 1));
        pool.put(Fake(64, 128, 2));
        pool.put(Fake(64, 64, 3));
        assert_eq!(pool.take([128, 64]), None);
        // The one released last, then the one before.
        assert_eq!(pool.take([64, 64]), Some(Fake(64, 64, 3)));
        assert_eq!(pool.take([64, 64]), Some(Fake(64, 64, 1)));
        assert_eq!(pool.take([64, 64]), None);
        assert_eq!(pool.take([64, 128]), Some(Fake(64, 128, 2)));
        assert!(pool.is_empty());
    }

    #[test]
    fn over_its_limit_the_pool_drops_what_it_got_first() {
        let mut pool = Pool::new(10_000);
        pool.put(Fake(50, 50, 1));
        pool.put(Fake(50, 50, 2));
        pool.put(Fake(50, 50, 3));
        assert_eq!(pool.len(), 3);
        // 4 x 2500 is over 10_000 - 2500: the first goes.
        pool.put(Fake(50, 60, 4));
        assert_eq!(pool.len(), 3);
        assert_eq!(pool.take([50, 50]), Some(Fake(50, 50, 3)));
        assert_eq!(pool.take([50, 50]), Some(Fake(50, 50, 2)));
        assert_eq!(pool.take([50, 50]), None);
        // One bigger than the limit is not kept at all.
        pool.put(Fake(200, 200, 5));
        assert!(pool.is_empty());
        // Taking one frees its bytes for the next.
        pool.put(Fake(90, 100, 6));
        assert_eq!(pool.take([90, 100]), Some(Fake(90, 100, 6)));
        pool.put(Fake(90, 100, 7));
        assert_eq!(pool.len(), 1);
    }
}
