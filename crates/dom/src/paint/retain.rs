//! Retained paint: the content of each stacking context, kept from one paint
//! of a document for the next paint of the same document after an edit.
//!
//! A stacking context's layers are in its own frame (`sc_content`), and
//! `paint_context` puts them at their place and under the element's
//! transform, opacity, filter and blend. So when nothing inside the element
//! changed (`crate::changes`), its content is the last paint's, wherever the
//! element now is and whatever its group: only the group is worked out again.
//!
//! The content also depends on what the paint did before it: the layer ids
//! already taken (an id is made unique against them), the reports already
//! made (each is made once) and the elements already audited. Those sets are
//! [`Ledger`]s: while a content is painted, every question it asks one is
//! logged, and the content is replayed only where every answer that came
//! from outside it is the same. A paint with replays is then the paint
//! without them.

use std::collections::HashMap;
use std::hash::Hash;

use blitz_dom::Node;
use blitz_traits::node_id::NodeId;
use serde_json::Value;

use super::Painter;
use crate::changes::Changes;
use crate::request::Unsupported;

/// A set the painter asks whether it holds a key, logging the questions
/// while a content is recorded.
#[derive(Default)]
pub(super) struct Ledger<T> {
    /// Each key, with its place in `order`.
    at: HashMap<T, usize>,
    order: Vec<T>,
    /// The keys asked about since the outermost recording started, each with
    /// the place it had then (`None`: not in the set).
    log: Vec<(T, Option<usize>)>,
    logging: bool,
}

/// Where a ledger was when a recording started.
#[derive(Clone, Copy)]
pub(super) struct Mark {
    log: usize,
    len: usize,
}

/// What a content asked a ledger: each key with whether the set held it
/// before the content, and the keys it added.
pub(super) struct Answers<T> {
    asked: Vec<(T, bool)>,
    added: Vec<T>,
}

impl<T: Hash + Eq + Clone> Ledger<T> {
    fn ask(&mut self, key: &T) -> Option<usize> {
        let at = self.at.get(key).copied();
        if self.logging {
            self.log.push((key.clone(), at));
        }
        at
    }

    pub fn contains(&mut self, key: &T) -> bool {
        self.ask(key).is_some()
    }

    /// Adds `key`; false if it was there.
    pub fn insert(&mut self, key: T) -> bool {
        if self.ask(&key).is_some() {
            return false;
        }
        self.at.insert(key.clone(), self.order.len());
        self.order.push(key);
        true
    }

    fn mark(&self) -> Mark {
        Mark {
            log: self.log.len(),
            len: self.order.len(),
        }
    }

    fn since(&self, mark: Mark) -> Answers<T> {
        Answers {
            asked: self.log[mark.log..]
                .iter()
                .map(|(k, at)| (k.clone(), at.is_some_and(|i| i < mark.len)))
                .collect(),
            added: self.order[mark.len..].to_vec(),
        }
    }

    /// Whether the set answers each of `answers`' questions as it did.
    fn holds(&self, answers: &Answers<T>) -> bool {
        answers
            .asked
            .iter()
            .all(|(k, held)| self.at.contains_key(k) == *held)
    }

    /// Asks `answers`' questions again (for a recording round this one) and adds its keys.
    fn replay(&mut self, answers: &Answers<T>) {
        if self.logging {
            for (k, held) in &answers.asked {
                let at = if *held { self.at.get(k).copied() } else { None };
                self.log.push((k.clone(), at));
            }
        }
        for k in &answers.added {
            self.at.insert(k.clone(), self.order.len());
            self.order.push(k.clone());
        }
    }

    fn set_logging(&mut self, on: bool) {
        self.logging = on;
        if !on {
            self.log.clear();
        }
    }
}

/// The content of one stacking context as a paint made it, and what the
/// painter's state took from it.
pub struct Fragment {
    layers: Vec<Value>,
    ids: Answers<String>,
    seen: Answers<String>,
    audited: Answers<u64>,
    unsupported: Vec<Unsupported>,
    mask_modes: Vec<(String, &'static str)>,
    margin_reach: f64,
    /// What the content read of the rest of the paint: the node whose
    /// background went to the canvas, and whether Blitz made the element a
    /// stacking context (which hoists its z-indexed descendants into it).
    canvas_node: Option<NodeId>,
    blitz_context: bool,
    /// The contexts painted inside it, at any depth: kept with it when it is replayed.
    inner: Vec<NodeId>,
}

/// The fragments of a paint, by element.
#[derive(Default)]
pub struct Fragments(HashMap<NodeId, Fragment>);

/// The fragments a paint can replay and the ones it makes.
pub(super) struct Retain<'c> {
    changes: Option<&'c Changes>,
    kept: Fragments,
    made: Fragments,
    /// The elements of `made`, in the order they were kept.
    order: Vec<NodeId>,
    /// How deep in recordings the paint is.
    depth: usize,
    /// How many contents were replayed and how many painted.
    pub replayed: u64,
    pub painted: u64,
}

impl<'c> Retain<'c> {
    /// `kept` is replayed where `changes` allow; with no changes, nothing is.
    pub fn new(kept: Fragments, changes: Option<&'c Changes>) -> Self {
        Retain {
            changes,
            kept,
            made: Fragments::default(),
            order: Vec::new(),
            depth: 0,
            replayed: 0,
            painted: 0,
        }
    }

    pub fn into_made(self) -> Fragments {
        self.made
    }

    fn keep(&mut self, node: NodeId, fragment: Fragment) {
        self.order.push(node);
        self.made.0.insert(node, fragment);
    }
}

impl<'a> Painter<'a> {
    /// The content of the stacking context `node` (`sc_content`), replayed
    /// from the last paint when it can be, and kept for the next.
    pub(super) fn retained_content(&mut self, node: &'a Node) -> Vec<Value> {
        if self.retain.is_none() {
            return self.sc_content(node);
        }
        if let Some(fragment) = self.replayable(node) {
            let layers = self.replay(&fragment);
            let retain = self.retain.as_mut().expect("retaining");
            retain.replayed += 1;
            // The contexts inside it are as they were too: the next paint can replay them on their own.
            for id in &fragment.inner {
                if let Some(inner) = retain.kept.0.remove(id) {
                    retain.keep(*id, inner);
                }
            }
            retain.keep(node.id, fragment);
            return layers;
        }
        self.record(node)
    }

    /// The last paint's fragment of `node`, taken out, if nothing it was made
    /// of changed.
    fn replayable(&mut self, node: &'a Node) -> Option<Fragment> {
        let retain = self.retain.as_mut()?;
        let changes = retain.changes?;
        let fragment = retain.kept.0.remove(&node.id)?;
        // Its own change is to its group at most, nothing inside it changed,
        // and its parent's change (if any) is to the parent's group alone.
        let unchanged = changes.of(node.id) != Some(false)
            && !changes.inside(node.id)
            && node.parent.is_none_or(|p| changes.of(p) != Some(false));
        let same_context = fragment.blitz_context == node.stacking_context.is_some()
            && fragment.canvas_node == self.canvas_node;
        let same_answers = self.ids.holds(&fragment.ids)
            && self.unsupported_seen.holds(&fragment.seen)
            && self.audited.holds(&fragment.audited);
        (unchanged && same_context && same_answers).then_some(fragment)
    }

    /// Puts what `fragment` took from the painter's state back, and hands out its layers.
    fn replay(&mut self, fragment: &Fragment) -> Vec<Value> {
        self.ids.replay(&fragment.ids);
        self.unsupported_seen.replay(&fragment.seen);
        self.audited.replay(&fragment.audited);
        self.unsupported
            .extend(fragment.unsupported.iter().cloned());
        for (id, mode) in &fragment.mask_modes {
            self.mask_modes.insert(id.clone(), mode);
        }
        self.margin_reach = self.margin_reach.max(fragment.margin_reach);
        fragment.layers.clone()
    }

    /// Paints the content of `node` and keeps it as a fragment.
    fn record(&mut self, node: &'a Node) -> Vec<Value> {
        let marks = (
            self.ids.mark(),
            self.unsupported_seen.mark(),
            self.audited.mark(),
        );
        let unsupported = self.unsupported.len();
        let reach = std::mem::replace(&mut self.margin_reach, 0.0);
        let had_camera = self.camera.is_some();
        let inner = self.retain.as_ref().expect("retaining").order.len();
        self.set_recording(1);
        let layers = self.sc_content(node);
        // (Read before the recording ends: the outermost one's end clears the logs.)
        let (ids, seen, audited) = (
            self.ids.since(marks.0),
            self.unsupported_seen.since(marks.1),
            self.audited.since(marks.2),
        );
        self.set_recording(-1);
        let fragment_reach = self.margin_reach;
        self.margin_reach = reach.max(fragment_reach);
        let fragment = Fragment {
            mask_modes: ids
                .added
                .iter()
                .filter_map(|id| self.mask_modes.get(id).map(|m| (id.clone(), *m)))
                .collect(),
            ids,
            seen,
            audited,
            unsupported: self.unsupported[unsupported..].to_vec(),
            margin_reach: fragment_reach,
            canvas_node: self.canvas_node,
            blitz_context: node.stacking_context.is_some(),
            layers: layers.clone(),
            inner: self.retain.as_ref().expect("retaining").order[inner..].to_vec(),
        };
        let retain = self.retain.as_mut().expect("retaining");
        retain.painted += 1;
        // A content that set the camera is painted every time.
        if had_camera || self.camera.is_none() {
            retain.keep(node.id, fragment);
        }
        layers
    }

    fn set_recording(&mut self, step: isize) {
        let retain = self.retain.as_mut().expect("retaining");
        retain.depth = retain
            .depth
            .checked_add_signed(step)
            .expect("balanced recordings");
        let on = retain.depth > 0;
        self.ids.set_logging(on);
        self.unsupported_seen.set_logging(on);
        self.audited.set_logging(on);
    }
}
