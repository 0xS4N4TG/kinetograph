//! Animatable numbers: a constant or a list of keyframes.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

impl Easing {
    /// Maps linear progress `t` in 0..=1 to eased progress.
    pub fn apply(self, t: f64) -> f64 {
        match self {
            Easing::Linear => t,
            Easing::EaseIn => t * t * t,
            Easing::EaseOut => 1.0 - (1.0 - t).powi(3),
            Easing::EaseInOut => {
                if t < 0.5 {
                    4.0 * t * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
                }
            }
        }
    }
}

/// `easing` shapes the segment that starts at this keyframe.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Keyframe {
    pub frame: f64,
    pub value: f64,
    #[serde(default)]
    pub easing: Easing,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(try_from = "NumRaw")]
pub enum Num {
    Const(f64),
    /// Non-empty, frames in non-decreasing order.
    Keys(Vec<Keyframe>),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NumRaw {
    Const(f64),
    Keys(Vec<Keyframe>),
}

impl TryFrom<NumRaw> for Num {
    type Error = String;

    fn try_from(raw: NumRaw) -> Result<Num, String> {
        match raw {
            NumRaw::Const(v) if v.is_finite() => Ok(Num::Const(v)),
            NumRaw::Const(_) => Err("number must be finite".into()),
            NumRaw::Keys(keys) => {
                if keys.is_empty() {
                    return Err("keyframe list is empty".into());
                }
                if keys
                    .iter()
                    .any(|k| !k.frame.is_finite() || !k.value.is_finite())
                {
                    return Err("keyframe frame and value must be finite".into());
                }
                if keys.windows(2).any(|w| w[1].frame < w[0].frame) {
                    return Err("keyframes must be in increasing frame order".into());
                }
                Ok(Num::Keys(keys))
            }
        }
    }
}

impl Num {
    /// Value at `frame`. Holds the first value before the first keyframe and
    /// the last value after the last one.
    pub fn at(&self, frame: f64) -> f64 {
        let keys = match self {
            Num::Const(v) => return *v,
            Num::Keys(keys) => keys,
        };
        let next = keys.partition_point(|k| k.frame <= frame);
        if next == 0 {
            return keys[0].value;
        }
        let a = keys[next - 1];
        let Some(b) = keys.get(next) else {
            return a.value;
        };
        let t = (frame - a.frame) / (b.frame - a.frame);
        a.value + (b.value - a.value) * a.easing.apply(t)
    }

    /// Smallest value the number can take. Easing never overshoots, so this
    /// is the smallest keyframe value.
    pub fn min(&self) -> f64 {
        match self {
            Num::Const(v) => *v,
            Num::Keys(keys) => keys.iter().map(|k| k.value).fold(f64::INFINITY, f64::min),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(json: &str) -> Num {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn constant_ignores_frame() {
        assert_eq!(num("5").at(0.0), 5.0);
        assert_eq!(num("5").at(1000.0), 5.0);
    }

    #[test]
    fn linear_interpolates_and_holds() {
        let n = num(r#"[{"frame":10,"value":100},{"frame":20,"value":200}]"#);
        assert_eq!(n.at(0.0), 100.0);
        assert_eq!(n.at(10.0), 100.0);
        assert_eq!(n.at(15.0), 150.0);
        assert_eq!(n.at(20.0), 200.0);
        assert_eq!(n.at(99.0), 200.0);
    }

    #[test]
    fn easing_curves() {
        let at_quarter = |e: &str| {
            let json =
                format!(r#"[{{"frame":0,"value":0,"easing":"{e}"}},{{"frame":4,"value":1}}]"#);
            num(&json).at(1.0)
        };
        assert_eq!(at_quarter("linear"), 0.25);
        assert!((at_quarter("easeIn") - 0.015625).abs() < 1e-12);
        assert!((at_quarter("easeOut") - 0.578125).abs() < 1e-12);
        assert!((at_quarter("easeInOut") - 0.0625).abs() < 1e-12);
        // easeInOut is symmetric around the midpoint
        let mid = num(r#"[{"frame":0,"value":0,"easing":"easeInOut"},{"frame":4,"value":1}]"#);
        assert!((mid.at(2.0) - 0.5).abs() < 1e-12);
        assert!((mid.at(3.0) - 0.9375).abs() < 1e-12);
    }

    #[test]
    fn each_segment_uses_its_own_easing() {
        let n = num(r#"[{"frame":0,"value":0,"easing":"easeIn"},
                {"frame":10,"value":10,"easing":"linear"},
                {"frame":20,"value":30}]"#);
        assert!((n.at(5.0) - 10.0 * 0.125).abs() < 1e-12);
        assert_eq!(n.at(15.0), 20.0);
    }

    #[test]
    fn duplicate_frames_step() {
        let n = num(r#"[{"frame":5,"value":1},{"frame":5,"value":9}]"#);
        assert_eq!(n.at(4.0), 1.0);
        assert_eq!(n.at(5.0), 9.0);
    }

    #[test]
    fn rejects_bad_keyframes() {
        assert!(serde_json::from_str::<Num>("[]").is_err());
        let unordered = r#"[{"frame":5,"value":1},{"frame":2,"value":9}]"#;
        assert!(serde_json::from_str::<Num>(unordered).is_err());
        let bad_easing = r#"[{"frame":0,"value":1,"easing":"bounce"}]"#;
        assert!(serde_json::from_str::<Num>(bad_easing).is_err());
    }
}
