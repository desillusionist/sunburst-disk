//! Scan progress on the Dock icon.
//!
//! macOS has no public API for a Dock progress bar: an app installs its own view
//! into `NSDockTile.contentView` (what Safari does for downloads) and asks the
//! tile to redraw.
//!
//! Two bars are possible:
//!   * no colour given — a real `NSProgressIndicator`, so the bar uses the
//!     system accent colour and looks native in the default theme;
//!   * a colour given — a small custom view draws a rounded track and fill in
//!     that colour, which is how the Matrix theme gets its green bar.
//!
//! The tile only re-snapshots its content view when the view hierarchy changes,
//! so changing the value of an already-attached bar never repaints it: every
//! update detaches the previous bar and attaches a fresh one that already carries
//! the new state.
//!
//! Everything is best effort: without a content view (very early in launch) or
//! off the main thread, the call is a no-op.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSBezierPath, NSColor, NSControlSize, NSProgressIndicator,
    NSProgressIndicatorStyle, NSView,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

const BAR_HEIGHT: f64 = 14.0;
const BAR_INSET: f64 = 2.0;
const BAR_RADIUS: f64 = 5.0;

struct DockBarIvars {
    value: f64,
    red: f64,
    green: f64,
    blue: f64,
}

define_class!(
    // SAFETY: NSView is a normal AppKit superclass and this class only overrides
    // drawing, which AppKit calls on the main thread.
    #[unsafe(super(NSView))]
    #[name = "SunburstDockBarView"]
    #[ivars = DockBarIvars]
    struct DockBarView;

    impl DockBarView {
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty_rect: NSRect) {
            let bounds = self.bounds();
            let ivars = self.ivars();

            // Track: a translucent groove over the icon.
            NSColor::colorWithWhite_alpha(0.0, 0.55).setFill();
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                bounds,
                BAR_RADIUS,
                BAR_RADIUS,
            )
            .fill();

            let width = bounds.size.width * ivars.value.clamp(0.0, 1.0);
            if width <= 0.5 {
                return;
            }
            let filled = NSRect {
                origin: bounds.origin,
                size: NSSize {
                    width,
                    height: bounds.size.height,
                },
            };
            NSColor::colorWithRed_green_blue_alpha(ivars.red, ivars.green, ivars.blue, 1.0)
                .setFill();
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(filled, BAR_RADIUS, BAR_RADIUS)
                .fill();
        }
    }
);

impl DockBarView {
    fn new(
        mtm: MainThreadMarker,
        frame: NSRect,
        value: f64,
        (red, green, blue): (f64, f64, f64),
    ) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(DockBarIvars {
            value,
            red,
            green,
            blue,
        });
        // SAFETY: `initWithFrame:` is NSView's designated initialiser and the
        // ivars are already set.
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

thread_local! {
    // Main-thread only, like every AppKit object it holds.
    static BAR: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
}

fn detach_current() {
    BAR.with(|slot| {
        if let Some(previous) = slot.borrow_mut().take() {
            previous.removeFromSuperview();
        }
    });
}

/// Show `progress` (clamped to 0..=1) on the Dock icon, or remove the bar when
/// `None`. `color` is an RGB triple in 0..=1; without it the bar uses the system
/// accent colour.
pub fn set(progress: Option<f64>, color: Option<(f64, f64, f64)>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let tile = NSApplication::sharedApplication(mtm).dockTile();

    // An attached bar never repaints: drop the old one first, both to change the
    // value and to clear it.
    detach_current();

    let Some(value) = progress else {
        tile.display();
        return;
    };
    let Some(content) = tile.contentView(mtm) else {
        return;
    };
    let tile_size = tile.size();
    let frame = NSRect {
        origin: NSPoint {
            x: 0.0,
            y: BAR_INSET,
        },
        size: NSSize {
            width: if tile_size.width > 0.0 {
                tile_size.width
            } else {
                128.0
            },
            height: BAR_HEIGHT,
        },
    };
    let value = value.clamp(0.0, 1.0);

    let bar: Retained<NSView> = match color {
        Some(rgb) => {
            let custom = DockBarView::new(mtm, frame, value, rgb);
            Retained::into_super(custom)
        }
        None => {
            let indicator = NSProgressIndicator::initWithFrame(mtm.alloc(), frame);
            indicator.setStyle(NSProgressIndicatorStyle::Bar);
            indicator.setIndeterminate(false);
            indicator.setMinValue(0.0);
            indicator.setMaxValue(1.0);
            indicator.setControlSize(NSControlSize::Small);
            // Set the value before attaching so the first frame is already right.
            indicator.setDoubleValue(value);
            Retained::into_super(indicator)
        }
    };

    content.addSubview(&bar);
    BAR.with(|slot| *slot.borrow_mut() = Some(bar));
    tile.display();
}

/// Parse `#rrggbb` (or `rrggbb`) into 0..=1 components; anything else means
/// "use the system accent colour".
pub(crate) fn parse_color(value: &str) -> Option<(f64, f64, f64)> {
    let hex = value.trim();
    let hex = hex.strip_prefix('#').unwrap_or(hex);
    if hex.len() != 6 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |index: usize| {
        u8::from_str_radix(&hex[index..index + 2], 16)
            .ok()
            .map(|value| f64::from(value) / 255.0)
    };
    Some((channel(0)?, channel(2)?, channel(4)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_progress_is_a_noop_off_the_main_thread() {
        // AppKit may only be touched on the main thread; the guard must return
        // instead of panicking (test threads are not the main thread).
        set(Some(0.5), None);
        set(Some(0.5), Some((0.2, 1.0, 0.4)));
        set(None, None);
    }

    #[test]
    fn hex_colours_parse_and_everything_else_means_system_accent() {
        assert_eq!(
            parse_color("#39ff66"),
            Some((57.0 / 255.0, 1.0, 102.0 / 255.0))
        );
        assert_eq!(
            parse_color("39ff66"),
            Some((57.0 / 255.0, 1.0, 102.0 / 255.0))
        );
        assert_eq!(parse_color(" #000000 "), Some((0.0, 0.0, 0.0)));
        for bad in ["", "#", "#39ff6", "#39ff6g", "#39ff66ff", "blue"] {
            assert_eq!(parse_color(bad), None, "{bad:?} must not parse");
        }
    }
}
