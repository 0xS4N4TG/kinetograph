//! Reading a `DomNode` in one pass over its keys. Derived, the internally tagged enum buffers every key of a node
//! before it reads `kind`, the node's children with them, so a node of a deep tree was copied once per level above it.
//! Here each key is read into the fields of the node's kind as it comes; requests write `kind` first, and the few keys
//! that come before it are kept until it does.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::DomNode;

/// The `kind`s, as requests spell them.
const KINDS: &[&str] = &["element", "text", "native"];

#[derive(Clone, Copy)]
enum Kind {
    Element,
    Text,
    Native,
}

impl<'de> Deserialize<'de> for DomNode {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<DomNode, D::Error> {
        d.deserialize_map(NodeVisitor)
    }
}

/// The fields of a node as they are read: those of its kind.
#[derive(Default)]
struct Fields {
    tag: Option<String>,
    path: Option<String>,
    attrs: Option<BTreeMap<String, String>>,
    style: Option<String>,
    children: Option<Vec<DomNode>>,
    text: Option<String>,
    width: Option<Option<f64>>,
    height: Option<Option<f64>>,
    overlay: Option<bool>,
}

/// Reads the value of `key` into `fields`, for a node of `kind`; a key the kind does not have is skipped.
struct Field<'a> {
    fields: &'a mut Fields,
    kind: Kind,
    key: &'a str,
}

impl<'de> DeserializeSeed<'de> for Field<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        fn set<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
            slot: &mut Option<T>,
            name: &'static str,
            d: D,
        ) -> Result<(), D::Error> {
            if slot.is_some() {
                return Err(de::Error::duplicate_field(name));
            }
            *slot = Some(T::deserialize(d)?);
            Ok(())
        }
        let f = self.fields;
        match (self.kind, self.key) {
            (Kind::Element, "tag") => set(&mut f.tag, "tag", d),
            (Kind::Element | Kind::Native, "path") => set(&mut f.path, "path", d),
            (Kind::Element, "attrs") => set(&mut f.attrs, "attrs", d),
            (Kind::Element, "style") => set(&mut f.style, "style", d),
            (Kind::Element, "children") => set(&mut f.children, "children", d),
            (Kind::Text, "text") => set(&mut f.text, "text", d),
            (Kind::Native, "width") => set(&mut f.width, "width", d),
            (Kind::Native, "height") => set(&mut f.height, "height", d),
            (Kind::Native, "overlay") => set(&mut f.overlay, "overlay", d),
            _ => IgnoredAny::deserialize(d).map(|_| ()),
        }
    }
}

/// A key or the `kind`, borrowed from the input when it can be.
struct Name<'de>(Cow<'de, str>);

impl<'de> Deserialize<'de> for Name<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Name<'de>, D::Error> {
        struct NameVisitor;
        impl<'de> Visitor<'de> for NameVisitor {
            type Value = Name<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Name<'de>, E> {
                Ok(Name(Cow::Borrowed(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Name<'de>, E> {
                Ok(Name(Cow::Owned(v.to_string())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Name<'de>, E> {
                Ok(Name(Cow::Owned(v)))
            }
        }
        d.deserialize_str(NameVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = DomNode;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a DOM node object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<DomNode, A::Error> {
        let mut fields = Fields::default();
        let mut kind = None;
        // The keys that come before `kind`.
        let mut early: Vec<(String, Value)> = Vec::new();
        while let Some(Name(key)) = map.next_key()? {
            match kind {
                Some(_) if key == "kind" => return Err(de::Error::duplicate_field("kind")),
                Some(kind) => map.next_value_seed(Field {
                    fields: &mut fields,
                    kind,
                    key: &key,
                })?,
                None if key == "kind" => {
                    let Name(name) = map.next_value()?;
                    let known = match &*name {
                        "element" => Kind::Element,
                        "text" => Kind::Text,
                        "native" => Kind::Native,
                        other => return Err(de::Error::unknown_variant(other, KINDS)),
                    };
                    for (key, value) in early.drain(..) {
                        Field {
                            fields: &mut fields,
                            kind: known,
                            key: &key,
                        }
                        .deserialize(value)
                        .map_err(de::Error::custom)?;
                    }
                    kind = Some(known);
                }
                None => early.push((key.into_owned(), map.next_value()?)),
            }
        }
        let missing = |name: &'static str| <A::Error as de::Error>::missing_field(name);
        Ok(match kind.ok_or_else(|| missing("kind"))? {
            Kind::Element => DomNode::Element {
                tag: fields.tag.ok_or_else(|| missing("tag"))?,
                path: fields.path.ok_or_else(|| missing("path"))?,
                attrs: fields.attrs.unwrap_or_default(),
                style: fields.style.unwrap_or_default(),
                children: fields.children.unwrap_or_default(),
            },
            Kind::Text => DomNode::Text {
                text: fields.text.ok_or_else(|| missing("text"))?,
            },
            Kind::Native => DomNode::Native {
                path: fields.path.ok_or_else(|| missing("path"))?,
                width: fields.width.flatten(),
                height: fields.height.flatten(),
                overlay: fields.overlay.unwrap_or_default(),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(json: &str) -> Result<DomNode, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }

    #[test]
    fn reads_the_keys_in_any_order() {
        for json in [
            r#"{"kind": "element", "tag": "div", "path": "$0", "children": [{"kind": "text", "text": "a"}]}"#,
            r#"{"tag": "div", "children": [{"text": "a", "kind": "text"}], "kind": "element", "path": "$0"}"#,
        ] {
            let DomNode::Element {
                tag,
                path,
                children,
                style,
                ..
            } = node(json).unwrap()
            else {
                panic!("not an element: {json}")
            };
            assert_eq!(
                (tag.as_str(), path.as_str(), style.as_str()),
                ("div", "$0", "")
            );
            assert!(
                matches!(&children[..], [DomNode::Text { text }] if text == "a"),
                "{json}"
            );
        }
    }

    #[test]
    fn skips_the_keys_of_other_kinds() {
        let n = node(r#"{"kind": "native", "path": "$1", "tag": 5, "width": 3, "height": null}"#)
            .unwrap();
        assert!(matches!(
            n,
            DomNode::Native {
                width: Some(3.0),
                height: None,
                overlay: false,
                ..
            }
        ));
    }

    #[test]
    fn says_what_is_wrong() {
        for (json, want) in [
            (r#"{"tag": "div"}"#, "missing field `kind`"),
            (
                r#"{"kind": "element", "path": "$0"}"#,
                "missing field `tag`",
            ),
            (r#"{"kind": "blob"}"#, "unknown variant `blob`"),
            (
                r#"{"kind": "text", "text": "a", "text": "b"}"#,
                "duplicate field `text`",
            ),
            (
                r#"{"kind": "text", "kind": "text", "text": "a"}"#,
                "duplicate field `kind`",
            ),
        ] {
            let msg = node(json).unwrap_err();
            assert!(msg.contains(want), "{json}: {msg}");
        }
    }
}
