//! Reading a `Layer` in one pass over its keys. Derived, the layer's `kind` would be a `#[serde(flatten)]` of the
//! internally tagged `LayerKind`, which buffers every key of the layer before reading it, and a group's children are
//! in those keys: a leaf of a deep tree was copied once per level above it. Here `type` is read where it comes, and the
//! keys after it go straight to the kind; the few before it (scenes write `type` second, after `id`) are kept until it
//! comes. The layer's own keys are read wherever they are.

use std::borrow::Cow;
use std::fmt;
use std::marker::PhantomData;

use serde::de::value::{CowStrDeserializer, MapAccessDeserializer};
use serde::de::{self, DeserializeSeed, IntoDeserializer, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::{
    BlendMode, Clip, Effect, Layer, LayerKind, LayoutItem, Mask, Matte, MotionBlur, Transform, one,
};
use crate::anim::Num;

/// The `type`s of `LayerKind`, as the scene spells them.
const KINDS: &[&str] = &[
    "shape",
    "text",
    "image",
    "group",
    "noise",
    "meshGradient",
    "lottie",
    "video",
    "gif",
    "canvas",
    "glsl",
    "scene3d",
];

impl<'de> Deserialize<'de> for Layer {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Layer, D::Error> {
        d.deserialize_map(LayerVisitor)
    }
}

/// The fields every layer has, as they are read.
#[derive(Default)]
struct Own {
    id: Option<String>,
    transform: Option<Transform>,
    opacity: Option<Num>,
    blend_mode: Option<BlendMode>,
    effects: Option<Vec<Effect>>,
    clip: Option<Option<Clip>>,
    mask: Option<Option<Mask>>,
    matte: Option<Option<Matte>>,
    motion_blur: Option<Option<MotionBlur>>,
    layout_item: Option<Option<LayoutItem>>,
}

impl Own {
    /// Reads the value of `key` when it is one of these fields; false for any other key (its value is not read).
    fn read<'de, A: MapAccess<'de>>(&mut self, key: &str, map: &mut A) -> Result<bool, A::Error> {
        fn set<'de, T: Deserialize<'de>, A: MapAccess<'de>>(
            slot: &mut Option<T>,
            name: &'static str,
            map: &mut A,
        ) -> Result<(), A::Error> {
            if slot.is_some() {
                return Err(de::Error::duplicate_field(name));
            }
            *slot = Some(map.next_value()?);
            Ok(())
        }
        match key {
            "id" => set(&mut self.id, "id", map)?,
            "transform" => set(&mut self.transform, "transform", map)?,
            "opacity" => set(&mut self.opacity, "opacity", map)?,
            "blendMode" => set(&mut self.blend_mode, "blendMode", map)?,
            "effects" => set(&mut self.effects, "effects", map)?,
            "clip" => set(&mut self.clip, "clip", map)?,
            "mask" => set(&mut self.mask, "mask", map)?,
            "matte" => set(&mut self.matte, "matte", map)?,
            "motionBlur" => set(&mut self.motion_blur, "motionBlur", map)?,
            "layoutItem" => set(&mut self.layout_item, "layoutItem", map)?,
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn into_layer<E: de::Error>(self, kind: LayerKind) -> Result<Layer, E> {
        Ok(Layer {
            id: self.id.ok_or_else(|| E::missing_field("id"))?,
            transform: self.transform.unwrap_or_default(),
            opacity: self.opacity.unwrap_or_else(one),
            blend_mode: self.blend_mode.unwrap_or_default(),
            effects: self.effects.unwrap_or_default(),
            clip: self.clip.flatten(),
            mask: self.mask.flatten(),
            matte: self.matte.flatten(),
            motion_blur: self.motion_blur.flatten(),
            layout_item: self.layout_item.flatten(),
            kind,
        })
    }
}

/// A key, borrowed from the input when it can be.
struct Key<'de>(Cow<'de, str>);

impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Key<'de>, D::Error> {
        struct KeyVisitor;
        impl<'de> Visitor<'de> for KeyVisitor {
            type Value = Key<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a key")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Borrowed(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Owned(v.to_string())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Owned(v)))
            }
        }
        d.deserialize_str(KeyVisitor)
    }
}

struct LayerVisitor;

impl<'de> Visitor<'de> for LayerVisitor {
    type Value = Layer;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a layer object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Layer, A::Error> {
        let mut own = Own::default();
        // The kind's keys that come before `type`.
        let mut early: Vec<(String, Value)> = Vec::new();
        while let Some(Key(key)) = map.next_key()? {
            if key == "type" {
                let Key(name) = map.next_value()?;
                let rest = Rest {
                    map: &mut map,
                    own: &mut own,
                    early: early.into_iter(),
                    pending: None,
                    de: PhantomData,
                };
                let kind = kind(&name, MapAccessDeserializer::new(rest))?;
                return own.into_layer(kind);
            }
            if !own.read(&key, &mut map)? {
                early.push((key.into_owned(), map.next_value()?));
            }
        }
        Err(de::Error::missing_field("type"))
    }
}

/// The kind named `name`, read from `d`.
fn kind<'de, D: Deserializer<'de>>(name: &str, d: D) -> Result<LayerKind, D::Error> {
    Ok(match name {
        "shape" => LayerKind::Shape(Deserialize::deserialize(d)?),
        "text" => LayerKind::Text(Deserialize::deserialize(d)?),
        "image" => LayerKind::Image(Deserialize::deserialize(d)?),
        "group" => LayerKind::Group(Deserialize::deserialize(d)?),
        "noise" => LayerKind::Noise(Deserialize::deserialize(d)?),
        "meshGradient" => LayerKind::MeshGradient(Deserialize::deserialize(d)?),
        "lottie" => LayerKind::Lottie(Deserialize::deserialize(d)?),
        "video" => LayerKind::Video(Deserialize::deserialize(d)?),
        "gif" => LayerKind::Gif(Deserialize::deserialize(d)?),
        "canvas" => LayerKind::Canvas(Deserialize::deserialize(d)?),
        "glsl" => LayerKind::Glsl(Deserialize::deserialize(d)?),
        "scene3d" => LayerKind::Scene3d(Deserialize::deserialize(d)?),
        other => return Err(de::Error::unknown_variant(other, KINDS)),
    })
}

/// The keys of a layer after its `type`, as the kind reads them: first the kind's keys that came before `type`, then
/// the rest, without the layer's own (read into `own` as they pass).
struct Rest<'a, 'de, A> {
    map: &'a mut A,
    own: &'a mut Own,
    early: std::vec::IntoIter<(String, Value)>,
    /// The value of the early key just given.
    pending: Option<Value>,
    de: PhantomData<&'de ()>,
}

impl<'de, A: MapAccess<'de>> MapAccess<'de> for Rest<'_, 'de, A> {
    type Error = A::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, A::Error> {
        if let Some((key, value)) = self.early.next() {
            self.pending = Some(value);
            return seed.deserialize(key.into_deserializer()).map(Some);
        }
        while let Some(Key(key)) = self.map.next_key()? {
            if key == "type" {
                return Err(de::Error::duplicate_field("type"));
            }
            if !self.own.read(&key, self.map)? {
                let key: CowStrDeserializer<A::Error> = key.into_deserializer();
                return seed.deserialize(key).map(Some);
            }
        }
        Ok(None)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, A::Error> {
        match self.pending.take() {
            Some(value) => seed.deserialize(value).map_err(de::Error::custom),
            None => self.map.next_value_seed(seed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(json: &str) -> Result<Layer, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }

    #[test]
    fn reads_the_keys_in_any_order() {
        let shape = r#""shape": {"kind": "rect", "width": 4, "height": 2}, "fill": "red""#;
        for json in [
            format!(r#"{{"id": "a", "type": "shape", {shape}, "opacity": 0.5}}"#),
            format!(r#"{{{shape}, "opacity": 0.5, "type": "shape", "id": "a"}}"#),
            format!(r#"{{"opacity": 0.5, {shape}, "id": "a", "type": "shape"}}"#),
        ] {
            let l = layer(&json).unwrap();
            assert_eq!((l.id.as_str(), l.opacity.at(0.0)), ("a", 0.5), "{json}");
            assert!(
                matches!(&l.kind, LayerKind::Shape(s) if s.fill.is_some()),
                "{json}"
            );
        }
    }

    #[test]
    fn reads_a_group_of_groups() {
        let l = layer(
            r#"{"id": "g", "type": "group", "children": [{"id": "h", "type": "group", "transform": {"x": 3},
                "children": [{"id": "s", "type": "shape", "shape": {"kind": "ellipse", "width": 1, "height": 1}}]}]}"#,
        )
        .unwrap();
        let LayerKind::Group(g) = &l.kind else {
            panic!("not a group")
        };
        let LayerKind::Group(h) = &g.children[0].kind else {
            panic!("not a group")
        };
        assert_eq!(
            (g.children[0].transform.x.at(0.0), h.children[0].id.as_str()),
            (3.0, "s")
        );
    }

    #[test]
    fn says_what_is_wrong() {
        for (json, want) in [
            (r#"{"id": "a"}"#, "missing field `type`"),
            (r#"{"type": "group", "children": []}"#, "missing field `id`"),
            (r#"{"id": "a", "type": "blob"}"#, "unknown variant `blob`"),
            (
                r#"{"id": "a", "id": "b", "type": "group", "children": []}"#,
                "duplicate field `id`",
            ),
            (
                r#"{"id": "a", "type": "group", "type": "group", "children": []}"#,
                "duplicate field `type`",
            ),
            (
                r#"{"id": "a", "type": "group"}"#,
                "missing field `children`",
            ),
        ] {
            let msg = layer(json).unwrap_err();
            assert!(msg.contains(want), "{json}: {msg}");
        }
    }
}
