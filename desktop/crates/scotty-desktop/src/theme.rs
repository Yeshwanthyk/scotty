//! Scotty's system-aware palette and typography tokens.

use gpui::{App, Global, Hsla, SharedString, WindowAppearance, hsla};

use crate::preferences::{
    AppearancePreference, DesktopPreferences, MonoFontPreference, UiFontPreference,
};

#[derive(Debug, Clone)]
pub struct Theme {
    pub bg: Hsla,
    pub surface: Hsla,
    pub surface_raised: Hsla,
    pub element_hover: Hsla,
    pub element_active: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub text: Hsla,
    pub text_muted: Hsla,
    pub text_faint: Hsla,
    pub accent: Hsla,
    pub danger: Hsla,
    pub warning: Hsla,
    pub font_sans: SharedString,
    pub font_mono: SharedString,
    pub ui_text_size: f32,
    pub composer_text_size: f32,
    pub mono_text_size: f32,
    pub density: f32,
    glass: Hsla,
}

impl Theme {
    pub fn from_preferences(
        preferences: &DesktopPreferences,
        appearance: WindowAppearance,
    ) -> Self {
        let use_light = preferences.appearance == AppearancePreference::System
            && matches!(
                appearance,
                WindowAppearance::Light | WindowAppearance::VibrantLight
            );
        let mut theme = if use_light {
            Self::light()
        } else {
            Self::dark()
        };
        theme.font_sans = match preferences.ui_font {
            UiFontPreference::Geist => "Geist".into(),
            UiFontPreference::System => ".SystemUIFont".into(),
        };
        theme.font_mono = match preferences.mono_font {
            MonoFontPreference::GeistMono => "Geist Mono".into(),
            MonoFontPreference::System if cfg!(target_os = "macos") => "Menlo".into(),
            MonoFontPreference::System => ".ZedMono".into(),
        };
        theme.ui_text_size = preferences.ui_text_size;
        theme.composer_text_size = preferences.composer_text_size;
        theme.mono_text_size = preferences.mono_text_size;
        theme.density = preferences.density.scale();
        theme
    }

    pub fn glass(&self) -> Hsla {
        self.glass
    }

    pub fn rem_size(&self) -> f32 {
        16.0 * self.ui_text_size / 13.0
    }

    pub fn space(&self, value: f32) -> gpui::Pixels {
        gpui::px(value * self.density)
    }

    pub fn mono_size(&self, value: f32) -> gpui::Pixels {
        gpui::px(value * self.mono_text_size / 11.5)
    }

    pub fn dark() -> Self {
        Self {
            bg: grey(6),
            surface: grey(13),
            surface_raised: neutral(0.235),
            element_hover: wash(0.14),
            element_active: wash(0.16),
            border: white_alpha(0.08),
            border_strong: white_alpha(0.14),
            text: neutral(0.922),
            text_muted: neutral(0.708),
            text_faint: neutral(0.556),
            accent: oklch(0.673, 0.182, 276.935),
            danger: oklch(0.704, 0.191, 22.216),
            warning: oklch(0.828, 0.189, 84.429),
            font_sans: "Geist".into(),
            font_mono: "Geist Mono".into(),
            ui_text_size: 13.0,
            composer_text_size: 13.0,
            mono_text_size: 11.5,
            density: 1.0,
            glass: if cfg!(target_os = "macos") {
                grey(8).opacity(0.90)
            } else {
                grey(13)
            },
        }
    }

    pub fn light() -> Self {
        Self {
            bg: grey(250),
            surface: grey(242),
            surface_raised: grey(255),
            element_hover: black_alpha(0.055),
            element_active: black_alpha(0.085),
            border: black_alpha(0.09),
            border_strong: black_alpha(0.16),
            text: grey(28),
            text_muted: grey(82),
            text_faint: grey(116),
            accent: oklch(0.55, 0.21, 276.935),
            danger: oklch(0.57, 0.22, 22.216),
            warning: oklch(0.59, 0.16, 72.0),
            font_sans: "Geist".into(),
            font_mono: "Geist Mono".into(),
            ui_text_size: 13.0,
            composer_text_size: 13.0,
            mono_text_size: 11.5,
            density: 1.0,
            glass: if cfg!(target_os = "macos") {
                grey(250).opacity(0.92)
            } else {
                grey(242)
            },
        }
    }

    pub fn of(cx: &App) -> &Theme {
        cx.global::<Theme>()
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::dark()
    }
}

impl Global for Theme {}

/// A neutral (chroma 0) oklch tone as Hsla. Chroma 0 means r == g == b exactly,
/// so this goes straight to an achromatic Hsla (skipping the hue math avoids
/// float-noise saturation).
pub fn neutral(lightness: f32) -> Hsla {
    let [v, _, _] = oklch_to_srgb(lightness, 0.0, 0.0);
    hsla(0.0, 0.0, v, 1.0)
}

/// A soft-white wash keeps hover and selection visible without hiding the blur.
pub fn wash(alpha: f32) -> Hsla {
    hsla(0.0, 0.0, 0.92, alpha)
}

/// White at the given alpha — the hairline/wash primitive.
pub fn white_alpha(alpha: f32) -> Hsla {
    hsla(0.0, 0.0, 1.0, alpha)
}

pub fn black_alpha(alpha: f32) -> Hsla {
    hsla(0.0, 0.0, 0.0, alpha)
}

/// An exact achromatic tone from an 8-bit channel value (`grey(13)` ≡ `#0d0d0d`)
/// — for surfaces matched against reference-screenshot samples.
pub fn grey(value: u8) -> Hsla {
    hsla(0.0, 0.0, value as f32 / 255.0, 1.0)
}

/// Convert an oklch color (CSS notation: L 0..1, C, H in degrees) to gpui Hsla.
pub fn oklch(l: f32, c: f32, h_deg: f32) -> Hsla {
    let [r, g, b] = oklch_to_srgb(l, c, h_deg);
    let (h, s, l) = rgb_to_hsl(r, g, b);
    hsla(h, s, l, 1.0)
}

/// oklch → sRGB (each 0..1, clamped/gamut-clipped per channel).
/// Reference: Björn Ottosson's OKLab definition (the same matrices CSS Color 4 uses).
pub(crate) fn oklch_to_srgb(l: f32, c: f32, h_deg: f32) -> [f32; 3] {
    let h = h_deg.to_radians();
    let a = c * h.cos();
    let b = c * h.sin();

    // OKLab → LMS (cube roots undone)
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);

    // LMS → linear sRGB
    let r = 4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_93 * s3;
    let g = -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_4 * s3;
    let b = -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3;

    [gamma_encode(r), gamma_encode(g), gamma_encode(b)]
}

fn gamma_encode(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB (0..1 components) → HSL, all components 0..1 (gpui's Hsla convention).
pub(crate) fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let delta = max - min;
    if delta < f32::EPSILON {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        delta / (2.0 - max - min)
    } else {
        delta / (max + min)
    };
    let h = if (max - r).abs() < f32::EPSILON {
        ((g - b) / delta).rem_euclid(6.0)
    } else if (max - g).abs() < f32::EPSILON {
        (b - r) / delta + 2.0
    } else {
        (r - g) / delta + 4.0
    } / 6.0;
    (h, s, l)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srgb_u8(c: [f32; 3]) -> [u8; 3] {
        [
            (c[0] * 255.0).round() as u8,
            (c[1] * 255.0).round() as u8,
            (c[2] * 255.0).round() as u8,
        ]
    }

    #[test]
    fn neutral_950_is_0a0a0a() {
        // oklch(0.145 0 0) is Tailwind neutral-950, comet's app background.
        let rgb = srgb_u8(oklch_to_srgb(0.145, 0.0, 0.0));
        assert_eq!(rgb, [10, 10, 10]);
    }

    #[test]
    fn oklch_accents_match_reference() {
        // Reference values computed independently (CSS Color 4 matrices).
        assert_eq!(
            srgb_u8(oklch_to_srgb(0.673, 0.182, 276.935)),
            [124, 134, 255]
        ); // indigo-400
        assert_eq!(
            srgb_u8(oklch_to_srgb(0.704, 0.191, 22.216)),
            [255, 100, 103]
        ); // red-400
        assert_eq!(srgb_u8(oklch_to_srgb(0.828, 0.189, 84.429)), [255, 185, 0]); // amber-400
    }

    #[test]
    fn preferences_follow_system_light_but_can_force_dark() {
        let system = DesktopPreferences::default();
        let light = Theme::from_preferences(&system, WindowAppearance::Light);
        assert!(light.bg.l > light.text.l);

        let forced = DesktopPreferences {
            appearance: AppearancePreference::Dark,
            ..DesktopPreferences::default()
        };
        let dark = Theme::from_preferences(&forced, WindowAppearance::Light);
        assert!(dark.bg.l < dark.text.l);
    }

    #[test]
    fn neutral_scale_is_ordered() {
        let t = Theme::dark();
        assert!(t.bg.l < t.surface.l);
        assert!(t.surface.l < t.surface_raised.l);
        assert!(t.surface_raised.l < t.text_faint.l);
        assert!(t.text_faint.l < t.text_muted.l);
        assert!(t.text_muted.l < t.text.l);
        // Monochrome: neutrals carry no saturation.
        for c in [
            t.bg,
            t.surface,
            t.surface_raised,
            t.text,
            t.text_muted,
            t.text_faint,
        ] {
            assert_eq!(c.s, 0.0);
            assert_eq!(c.a, 1.0);
        }
    }

    #[test]
    fn hairlines_are_white_and_washes_are_mid_grey() {
        let t = Theme::dark();
        // Hairlines stay white — they only need to read on dark surfaces.
        for c in [t.border, t.border_strong] {
            assert_eq!(c.l, 1.0, "hairlines are white");
            assert!(c.a > 0.0 && c.a < 0.25, "low alpha, got {}", c.a);
        }
        // Washes are translucent soft-white with enough alpha to read at the
        // glass scrim's brightness ceiling.
        for c in [t.element_hover, t.element_active] {
            assert_eq!(c.l, 0.92, "washes are soft-white");
            assert!(c.a >= 0.05 && c.a < 0.35, "alpha in band, got {}", c.a);
        }
        assert!(t.border.a < t.border_strong.a);
        // Hover intentionally equals the active fill (selection differs by
        // its ring, not brightness — user request).
        assert!(t.element_hover.a <= t.element_active.a);
    }

    #[test]
    fn accent_hues_land_in_their_bands() {
        let t = Theme::dark();
        // Hsla hue is 0..1 of the wheel. Indigo ≈ 230-250°, red < 15°, amber ≈ 40-55°.
        let deg = |c: Hsla| c.h * 360.0;
        assert!(
            (215.0..265.0).contains(&deg(t.accent)),
            "indigo hue {}",
            deg(t.accent)
        );
        assert!(
            deg(t.danger) < 15.0 || deg(t.danger) > 345.0,
            "red hue {}",
            deg(t.danger)
        );
        assert!(
            (35.0..60.0).contains(&deg(t.warning)),
            "amber hue {}",
            deg(t.warning)
        );
    }
}
