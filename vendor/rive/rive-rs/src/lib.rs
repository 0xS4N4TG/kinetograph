#![no_std]

//! # Rive runtime bindings
//!
//! [Rive] is a real-time interactive design and animation tool that helps teams create and run
//! interactive animations anywhere. Designers and developers use our collaborative editor to
//! create motion graphics that respond to different states and user inputs. Our lightweight
//! open-source runtime libraries allow them to load their animations into apps, games, and
//! websites.
//!
//! [Rive]: https://rive.app

extern crate alloc;

mod artboard;
mod ffi;
mod file;
mod instantiate;
mod linear_animation;
pub mod path;
mod raw_iter;
pub mod renderer;
pub mod scene;
pub mod state_machine;

pub use crate::{
    artboard::components,
    artboard::Artboard,
    file::{AssetKind, AssetRequest, Error, File},
    instantiate::{Handle, Instantiate},
    linear_animation::{Direction, LinearAnimation, Loop},
    scene::{Scene, Viewport},
    state_machine::StateMachine,
};
