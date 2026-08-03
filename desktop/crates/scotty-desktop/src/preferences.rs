use std::io;
use std::path::{Path, PathBuf};

use gpui::{App, Global};
use serde::{Deserialize, Serialize};

use crate::theme::Theme;

const FILE_NAME: &str = "preferences.json";
const DEFAULT_UI_TEXT_SIZE: f32 = 13.0;
const DEFAULT_COMPOSER_TEXT_SIZE: f32 = 13.0;
const DEFAULT_MONO_TEXT_SIZE: f32 = 11.5;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppearancePreference {
    #[default]
    System,
    Dark,
}

impl AppearancePreference {
    pub const ALL: [Self; 2] = [Self::System, Self::Dark];

    pub fn label(self) -> &'static str {
        match self {
            Self::System => "System",
            Self::Dark => "Dark",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiFontPreference {
    #[default]
    Geist,
    System,
}

impl UiFontPreference {
    pub const ALL: [Self; 2] = [Self::Geist, Self::System];

    pub fn label(self) -> &'static str {
        match self {
            Self::Geist => "Geist",
            Self::System => "System UI",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MonoFontPreference {
    #[default]
    GeistMono,
    System,
}

impl MonoFontPreference {
    pub const ALL: [Self; 2] = [Self::GeistMono, Self::System];

    pub fn label(self) -> &'static str {
        match self {
            Self::GeistMono => "Geist Mono",
            Self::System => "System Mono",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DensityPreference {
    Compact,
    #[default]
    Comfortable,
}

impl DensityPreference {
    pub const ALL: [Self; 2] = [Self::Compact, Self::Comfortable];

    pub fn label(self) -> &'static str {
        match self {
            Self::Compact => "Compact",
            Self::Comfortable => "Comfortable",
        }
    }

    pub fn scale(self) -> f32 {
        match self {
            Self::Compact => 0.82,
            Self::Comfortable => 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub appearance: AppearancePreference,
    pub ui_font: UiFontPreference,
    pub mono_font: MonoFontPreference,
    pub ui_text_size: f32,
    pub composer_text_size: f32,
    pub mono_text_size: f32,
    pub density: DensityPreference,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            appearance: AppearancePreference::System,
            ui_font: UiFontPreference::Geist,
            mono_font: MonoFontPreference::GeistMono,
            ui_text_size: DEFAULT_UI_TEXT_SIZE,
            composer_text_size: DEFAULT_COMPOSER_TEXT_SIZE,
            mono_text_size: DEFAULT_MONO_TEXT_SIZE,
            density: DensityPreference::Comfortable,
        }
    }
}

impl DesktopPreferences {
    pub fn clamped(mut self) -> Self {
        self.ui_text_size = clamp_or(self.ui_text_size, 11.0, 16.0, DEFAULT_UI_TEXT_SIZE);
        self.composer_text_size = clamp_or(
            self.composer_text_size,
            11.0,
            18.0,
            DEFAULT_COMPOSER_TEXT_SIZE,
        );
        self.mono_text_size = clamp_or(self.mono_text_size, 9.0, 16.0, DEFAULT_MONO_TEXT_SIZE);
        self
    }

    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<Self>(&text) {
                Ok(preferences) => preferences.clamped(),
                Err(error) => {
                    tracing::warn!(%error, "desktop preferences are invalid; using defaults");
                    Self::default()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!(%error, "failed to read desktop preferences; using defaults");
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory")
        })?;
        std::fs::create_dir_all(parent)?;
        let temporary = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        std::fs::write(&temporary, json)?;
        std::fs::rename(temporary, path)
    }
}

pub struct PreferencesState {
    values: DesktopPreferences,
    path: PathBuf,
}

impl Global for PreferencesState {}

pub fn init(cx: &mut App) {
    let path = preferences_path();
    let values = DesktopPreferences::load(&path);
    let theme = Theme::from_preferences(&values, cx.window_appearance());
    cx.set_global(PreferencesState { values, path });
    cx.set_global(theme);
}

pub fn get(cx: &App) -> &DesktopPreferences {
    &cx.global::<PreferencesState>().values
}

pub fn update(cx: &mut App, change: impl FnOnce(&mut DesktopPreferences)) {
    let (values, path) = {
        let state = cx.global_mut::<PreferencesState>();
        change(&mut state.values);
        state.values = state.values.clone().clamped();
        (state.values.clone(), state.path.clone())
    };
    if let Err(error) = values.save(&path) {
        tracing::warn!(%error, "failed to save desktop preferences");
    }
    apply_theme(cx);
}

pub fn apply_theme(cx: &mut App) {
    let theme = Theme::from_preferences(get(cx), cx.window_appearance());
    *cx.global_mut::<Theme>() = theme;
    cx.refresh_windows();
}

pub fn preferences_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SCOTTY_DESKTOP_DATA_DIR") {
        return PathBuf::from(path).join(FILE_NAME);
    }
    if cfg!(target_os = "macos") {
        return home_dir()
            .join("Library")
            .join("Application Support")
            .join("Scotty")
            .join(FILE_NAME);
    }
    if cfg!(target_os = "windows") {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home_dir)
            .join("Scotty")
            .join(FILE_NAME);
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"))
        .join("scotty")
        .join(FILE_NAME)
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn clamp_or(value: f32, min: f32, max: f32, default: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_round_trip_and_clamp_sizes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(FILE_NAME);
        let preferences = DesktopPreferences {
            appearance: AppearancePreference::Dark,
            ui_font: UiFontPreference::System,
            mono_font: MonoFontPreference::System,
            ui_text_size: 99.0,
            composer_text_size: 15.0,
            mono_text_size: 12.5,
            density: DensityPreference::Compact,
        };
        preferences.save(&path).unwrap();

        assert_eq!(
            DesktopPreferences::load(&path),
            DesktopPreferences {
                ui_text_size: 16.0,
                ..preferences
            }
        );
    }

    #[test]
    fn missing_or_invalid_preferences_use_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(FILE_NAME);
        assert_eq!(
            DesktopPreferences::load(&path),
            DesktopPreferences::default()
        );

        std::fs::write(&path, "{not-json").unwrap();
        assert_eq!(
            DesktopPreferences::load(&path),
            DesktopPreferences::default()
        );
    }
}
